//! Settlements: NEAR vendor payments, cross-chain swap rehearsals and their Chain Signatures
//! authorization (tracks: defi, agents, business).
//!
//! An agent asks the treasury to settle a vendor invoice or a cross-chain swap with a
//! `CrossChainIntentRequest`. The flow is:
//!
//! 1. The contract rebuilds the canonical request message (a `token_diff`-shaped body plus an
//!    `aegis` envelope binding chain, recipient, route contract and quote hash) and the NEP-413
//!    payload `{message, nonce, recipient: <this contract>}`. This signature authorizes the
//!    treasury; the message is not itself submitted to `intents.near`.
//! 2. It verifies the agent's ed25519 signature over `sha256(2^31+413 || borsh(payload))`
//!    against the agent's registered key (`env::ed25519_verify`), then the nonce, deadline,
//!    recipient allow-list, price floor, TEE proof and every policy limit. The NEP-413 key is the
//!    agent's FunctionCall key, the same key that signs the transaction, so the signature adds no
//!    authentication of its own. It gives the request a stable, wallet-verifiable hash that the
//!    audit proof is bound to, and its nonce makes each request single-use.
//! 3. A NEAR AI audit must use the DAO-pinned prompt and, as its user message, the audit facts the
//!    contract builds for the request (`facts.rs`, `get_intent_audit_facts`).
//! 4. Rejections commit strikes / quarantine and return `rejected` (no panic).
//! 5. Approvals:
//!    * a vendor payment on `near` is paid out immediately: a real NEAR transfer from the
//!      treasury to the allow-listed recipient, settled (or refunded) in the callback;
//!    * a cross-chain swap is a dry-run rehearsal (Rule Q-007: 1Click quotes are `dry: true`).
//!      The contract reserves the funds and asks the Chain Signatures MPC contract to sign an
//!      EVM-verifiable authorization of the exact route. Confirmation releases the reservation,
//!      because no funds moved. Live 1Click quotes are rejected: the treasury does not deposit
//!      into 1Click itself. Real cross-chain spending goes through `evm.rs`.

use std::collections::BTreeMap;

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, near, require, serde_json, AccountId, Gas, NearToken, Promise};

use crate::attestation::{AttestationError, ExecutionProof, ExecutionReceipt, ReceiptExpectation};
use crate::codec::{
    decode_ed25519_signature, decode_nonce_b64, ed25519_key_bytes, format_iso8601_millis, from_hex, is_hash32_hex, is_safe_ascii,
    is_valid_asset_id, is_valid_chain_id, parse_hash32, to_hex,
};
use crate::events::AegisEvent;
use crate::facts::{intent_facts, AuditFacts, IntentFactsInput, RecipientStatus};
use crate::policy::{evaluate_spend, max_severity, PolicyDecision, PolicyViolation, PriceCheck, SpendRequest};
use crate::subaccounts::{AgentRecord, AgentRole, AgentStatus};
use crate::{AegisCore, AegisCoreExt};

/// NEP-413 prefix tag: 2^31 + 413.
pub const NEP413_TAG: u32 = 2_147_484_061;
pub const SETTLEMENT_DOMAIN: &[u8] = b"AEGIS_SETTLEMENT_V1";
pub const EIP191_PREFIX_32: &[u8] = b"\x19Ethereum Signed Message:\n32";
pub const WNEAR: &str = "nep141:wrap.near";
const NS: u64 = 1_000_000_000;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IntentKind {
    Swap,
    LiquidityDeployment,
    VendorPayment,
}

impl IntentKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            IntentKind::Swap => "swap",
            IntentKind::LiquidityDeployment => "liquidity_deployment",
            IntentKind::VendorPayment => "vendor_payment",
        }
    }
}

/// A 1Click quote the request is bound to (`POST /v0/quote`, `dry: true` per Rule Q-007).
/// Agent-supplied and not authenticated on-chain: it is an audit trail, while value protection
/// comes from the price floor, the recipient allow-list and the slippage limit.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuoteBinding {
    pub provider: String,
    /// Hex sha256 of the canonical JSON of the 1Click response (`quote`, `quoteRequest`, `signature`).
    pub quote_hash: String,
    pub correlation_id: String,
    pub amount_in: U128,
    pub amount_out: U128,
    pub min_amount_out: U128,
    pub expires_at_ns: U64,
    pub dry: bool,
    pub deposit_address: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrossChainIntentRequest {
    pub kind: IntentKind,
    /// 1Click `blockchain` id of the destination (`near`, `arb`, `base`, ...).
    pub destination_chain: String,
    pub origin_asset: String,
    pub destination_asset: String,
    /// Amount of `origin_asset` (yoctoNEAR for wNEAR) taken from the treasury.
    pub amount: U128,
    pub min_amount_out: U128,
    /// Address on the destination chain (a NEAR account id for `near`).
    pub recipient: String,
    /// Contract the settlement routes through (NEAR Intents verifier, DEX, ...).
    pub execution_contract: AccountId,
    pub slippage_bps: u32,
    pub deadline_ns: U64,
    pub quote: Option<QuoteBinding>,
    /// Standard base64 of the 32-byte NEP-413 nonce.
    pub nonce: String,
    /// `ed25519:<base58>` signature over the NEP-413 hash.
    pub signature: String,
    pub attestation: Option<ExecutionProof>,
    pub memo: Option<String>,
}

impl CrossChainIntentRequest {
    /// A NEAR-native vendor invoice: paid as a real NEAR transfer, no quote, no MPC.
    pub fn is_near_payment(&self) -> bool {
        self.destination_chain == "near" && self.kind == IntentKind::VendorPayment
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IntentStatus {
    Rejected,
    PendingApproval,
    Committed,
    Signing,
    Signed,
    AuthorizationFailed,
    /// A NEAR vendor payment is in flight.
    Paying,
    PaymentFailed,
    Settled,
    Cancelled,
}

impl IntentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            IntentStatus::Rejected => "rejected",
            IntentStatus::PendingApproval => "pending_approval",
            IntentStatus::Committed => "committed",
            IntentStatus::Signing => "signing",
            IntentStatus::Signed => "signed",
            IntentStatus::AuthorizationFailed => "authorization_failed",
            IntentStatus::Paying => "paying",
            IntentStatus::PaymentFailed => "payment_failed",
            IntentStatus::Settled => "settled",
            IntentStatus::Cancelled => "cancelled",
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MpcSignature {
    /// Hex of the 33-byte compressed R point.
    pub big_r: String,
    /// Hex of the 32-byte s scalar.
    pub s: String,
    pub recovery_id: u8,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MpcAuthorization {
    pub mpc_contract_id: AccountId,
    pub path: String,
    pub domain_id: u64,
    /// Hex sha256 settlement commitment.
    pub commitment: String,
    /// Hex keccak256 EIP-191 digest of the commitment: the 32 bytes the MPC network signs.
    pub payload: String,
    pub signature: Option<MpcSignature>,
    pub error: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentRecord {
    pub intent_id: U64,
    pub agent_id: AccountId,
    pub kind: IntentKind,
    pub destination_chain: String,
    pub origin_asset: String,
    pub destination_asset: String,
    pub amount: U128,
    pub min_amount_out: U128,
    pub recipient: String,
    pub execution_contract: AccountId,
    pub slippage_bps: u32,
    pub deadline_ns: U64,
    pub intent_message: String,
    pub nep413_hash: String,
    pub nonce: String,
    pub quote: Option<QuoteBinding>,
    pub attestation_hash: Option<String>,
    pub decision: PolicyDecision,
    pub status: IntentStatus,
    /// `true` for dry-run rehearsals (no funds moved), `false` for real payments.
    pub dry_run: bool,
    pub mpc: Option<MpcAuthorization>,
    pub memo: Option<String>,
    pub created_at_ns: U64,
    pub settled_at_ns: Option<U64>,
    pub settlement_ref: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementOutcome {
    pub intent_id: U64,
    pub status: IntentStatus,
    pub nep413_hash: String,
    pub decision: PolicyDecision,
    pub quarantined: bool,
}

/// Read-only verdict of the policy engine on a (signed) request.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentAssessment {
    pub intent_message: String,
    pub nep413_hash: String,
    pub signature_valid: bool,
    pub attestation_hash: Option<String>,
    pub velocity_requests: u32,
    pub decision: PolicyDecision,
    /// sha256 of the audit facts a NEAR AI audit of this request must carry as its user message.
    pub audit_facts_hash: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct AegisEnvelope<'a> {
    chain: &'a str,
    contract: &'a str,
    kind: &'a str,
    memo: &'a str,
    quote_hash: &'a str,
    recipient: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct TokenDiffIntent<'a> {
    diff: BTreeMap<&'a str, String>,
    intent: &'static str,
}

/// Field order is alphabetical so the JSON equals a sorted-key canonical stringify.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct IntentsMessage<'a> {
    aegis: AegisEnvelope<'a>,
    deadline: String,
    intents: [TokenDiffIntent<'a>; 1],
    signer_id: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct MpcPayload<'a> {
    #[serde(rename = "Ecdsa")]
    ecdsa: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct MpcSignRequest<'a> {
    path: &'a str,
    payload_v2: MpcPayload<'a>,
    domain_id: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct MpcSignArgs<'a> {
    request: MpcSignRequest<'a>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct MpcAffinePoint {
    affine_point: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct MpcScalar {
    scalar: String,
}

/// Shape of the MPC contract's `SignatureResponse` for secp256k1 domains.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct MpcSignatureResponse {
    scheme: String,
    big_r: Option<MpcAffinePoint>,
    s: Option<MpcScalar>,
    recovery_id: Option<u8>,
}

/// JSON args of `v1.signer[-prod.testnet].sign` for a 32-byte secp256k1 payload.
pub(crate) fn mpc_sign_args(path: &str, payload_hex: &str, domain_id: u64) -> Vec<u8> {
    let args = MpcSignArgs { request: MpcSignRequest { path, payload_v2: MpcPayload { ecdsa: payload_hex }, domain_id } };
    serde_json::to_vec(&args).unwrap_or_else(|_| env::panic_str("AEGIS_E_SERIALIZE"))
}

/// Parses the promise result of an MPC `sign` call.
pub(crate) fn parse_mpc_result(result: Result<Vec<u8>, near_sdk::PromiseError>) -> Result<MpcSignature, String> {
    match result {
        Ok(bytes) => match serde_json::from_slice::<MpcSignatureResponse>(&bytes) {
            Ok(resp) => match (resp.scheme.as_str(), resp.big_r, resp.s, resp.recovery_id) {
                ("Secp256k1", Some(r), Some(s), Some(v))
                    if from_hex(&r.affine_point).map(|b| b.len() == 33).unwrap_or(false)
                        && from_hex(&s.scalar).map(|b| b.len() == 32).unwrap_or(false)
                        && v <= 3 =>
                {
                    Ok(MpcSignature { big_r: r.affine_point.to_lowercase(), s: s.scalar.to_lowercase(), recovery_id: v })
                }
                _ => Err("unexpected_signature_scheme".to_string()),
            },
            Err(_) => Err("unparseable_mpc_response".to_string()),
        },
        Err(_) => Err("mpc_sign_failed".to_string()),
    }
}

/// Canonical message an agent signs (see module docs).
pub fn build_intent_message(signer_id: &str, req: &CrossChainIntentRequest) -> String {
    let mut diff = BTreeMap::new();
    diff.insert(req.origin_asset.as_str(), format!("-{}", req.amount.0));
    diff.insert(req.destination_asset.as_str(), req.min_amount_out.0.to_string());
    let msg = IntentsMessage {
        aegis: AegisEnvelope {
            chain: &req.destination_chain,
            contract: req.execution_contract.as_str(),
            kind: req.kind.as_str(),
            memo: req.memo.as_deref().unwrap_or(""),
            quote_hash: req.quote.as_ref().map(|q| q.quote_hash.as_str()).unwrap_or(""),
            recipient: &req.recipient,
        },
        deadline: format_iso8601_millis(req.deadline_ns.0),
        intents: [TokenDiffIntent { diff, intent: "token_diff" }],
        signer_id,
    };
    serde_json::to_string(&msg).unwrap_or_else(|_| env::panic_str("AEGIS_E_SERIALIZE"))
}

fn push_str(buf: &mut Vec<u8>, s: &str) {
    buf.extend_from_slice(&(s.len() as u32).to_le_bytes());
    buf.extend_from_slice(s.as_bytes());
}

/// `sha256(u32_le(2^31 + 413) || borsh({message, nonce, recipient, callback_url: None}))`.
pub fn nep413_hash(message: &str, nonce: &[u8; 32], recipient: &str) -> [u8; 32] {
    let mut buf = Vec::with_capacity(message.len() + recipient.len() + 48);
    buf.extend_from_slice(&NEP413_TAG.to_le_bytes());
    push_str(&mut buf, message);
    buf.extend_from_slice(nonce);
    push_str(&mut buf, recipient);
    buf.push(0);
    env::sha256_array(buf)
}

/// Domain-separated commitment over everything an off-chain executor must honour.
pub fn settlement_commitment(record: &IntentRecord) -> [u8; 32] {
    let nep413 = parse_hash32(&record.nep413_hash).unwrap_or([0u8; 32]);
    let quote = record.quote.as_ref().and_then(|q| parse_hash32(&q.quote_hash)).unwrap_or([0u8; 32]);
    let mut buf = Vec::with_capacity(256);
    buf.extend_from_slice(SETTLEMENT_DOMAIN);
    buf.extend_from_slice(&record.intent_id.0.to_le_bytes());
    buf.extend_from_slice(&nep413);
    buf.extend_from_slice(&quote);
    push_str(&mut buf, &record.destination_chain);
    push_str(&mut buf, &record.recipient);
    buf.extend_from_slice(&record.amount.0.to_le_bytes());
    buf.extend_from_slice(&record.min_amount_out.0.to_le_bytes());
    env::sha256_array(buf)
}

/// EIP-191 digest of the commitment, verifiable on any EVM chain with `ecrecover`.
pub fn mpc_payload(commitment: &[u8; 32]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(EIP191_PREFIX_32.len() + 32);
    buf.extend_from_slice(EIP191_PREFIX_32);
    buf.extend_from_slice(commitment);
    env::keccak256_array(buf)
}

fn validate_request_shape(req: &CrossChainIntentRequest) {
    require!(is_valid_chain_id(&req.destination_chain), "AEGIS_E_INTENT: invalid destination_chain");
    require!(
        is_valid_asset_id(&req.origin_asset) && is_valid_asset_id(&req.destination_asset),
        "AEGIS_E_INTENT: invalid asset id"
    );
    if req.is_near_payment() {
        require!(req.origin_asset == WNEAR && req.destination_asset == WNEAR, "AEGIS_E_INTENT: NEAR payments are in wNEAR/NEAR");
        require!(req.min_amount_out == req.amount, "AEGIS_E_INTENT: NEAR payments deliver the full amount");
        require!(req.recipient.parse::<AccountId>().is_ok(), "AEGIS_E_INTENT: NEAR payment recipient must be an account id");
    } else {
        require!(req.origin_asset != req.destination_asset, "AEGIS_E_INTENT: origin and destination asset must differ");
    }
    require!(req.amount.0 > 0 && req.min_amount_out.0 > 0, "AEGIS_E_INTENT: amounts must be > 0");
    require!(!req.recipient.is_empty() && is_safe_ascii(&req.recipient, 128), "AEGIS_E_INTENT: invalid recipient");
    require!(req.slippage_bps <= 10_000, "AEGIS_E_INTENT: slippage_bps must be <= 10000");
    require!(decode_nonce_b64(&req.nonce).is_some(), "AEGIS_E_INTENT: nonce must be base64 of 32 bytes");
    require!(req.memo.as_deref().map(|m| is_safe_ascii(m, 128)).unwrap_or(true), "AEGIS_E_INTENT: invalid memo");
    if let Some(q) = &req.quote {
        require!(is_hash32_hex(&q.quote_hash), "AEGIS_E_INTENT: quote_hash must be 32-byte hex");
        require!(
            is_safe_ascii(&q.provider, 32) && is_safe_ascii(&q.correlation_id, 64),
            "AEGIS_E_INTENT: invalid quote metadata"
        );
        require!(
            q.deposit_address.as_deref().map(|d| is_safe_ascii(d, 128)).unwrap_or(true),
            "AEGIS_E_INTENT: invalid deposit address"
        );
    }
}

impl AegisCore {
    /// Read-only evaluation shared by `request_intent_settlement`, `evaluate_intent` and
    /// `get_intent_audit_facts`. Returns the assessment, the velocity window the agent would move
    /// to, the verified TEE receipt summary (recorded only if the request is approved), and the
    /// audit facts the contract built for the request.
    fn assess_intent(
        &self,
        agent: &AgentRecord,
        req: &CrossChainIntentRequest,
    ) -> (IntentAssessment, u64, u32, Option<ExecutionReceipt>, AuditFacts) {
        validate_request_shape(req);
        let now = env::block_timestamp();
        let epoch = env::epoch_height();
        let mut violations: Vec<PolicyViolation> = Vec::new();

        let message = build_intent_message(agent.agent_id.as_str(), req);
        let nonce = decode_nonce_b64(&req.nonce).unwrap_or([0u8; 32]);
        let hash = nep413_hash(&message, &nonce, env::current_account_id().as_str());
        let hash_hex = to_hex(&hash);

        let signature_valid = match (decode_ed25519_signature(&req.signature), ed25519_key_bytes(&agent.public_key)) {
            (Some(sig), Some(pk)) => env::ed25519_verify(&sig, hash, &pk),
            _ => false,
        };
        if !signature_valid {
            violations.push(PolicyViolation::InvalidIntentSignature);
        } else if self.used_nonces.contains(&format!("{}:{}", agent.agent_id, req.nonce)) {
            violations.push(PolicyViolation::NonceReused);
        }

        let horizon = self.config.max_intent_horizon_sec.saturating_mul(NS);
        if req.deadline_ns.0 <= now {
            violations.push(PolicyViolation::DeadlineInvalid { reason: "deadline_in_past".to_string() });
        } else if req.deadline_ns.0 > now.saturating_add(horizon) {
            violations.push(PolicyViolation::DeadlineInvalid { reason: "deadline_beyond_horizon".to_string() });
        }

        let near_payment = req.is_near_payment();
        let mut effective_slippage = req.slippage_bps;
        match &req.quote {
            Some(q) => {
                if !q.dry {
                    violations
                        .push(PolicyViolation::QuoteInvalid { reason: "live_quote_not_executable_by_treasury".to_string() });
                }
                if q.amount_in != req.amount {
                    violations.push(PolicyViolation::QuoteInvalid { reason: "amount_in_mismatch".to_string() });
                }
                if q.min_amount_out != req.min_amount_out {
                    violations.push(PolicyViolation::QuoteInvalid { reason: "min_amount_out_mismatch".to_string() });
                }
                if q.min_amount_out.0 > q.amount_out.0 || q.amount_out.0 == 0 {
                    violations.push(PolicyViolation::QuoteInvalid { reason: "inconsistent_amounts".to_string() });
                } else {
                    let implied = (q.amount_out.0 - q.min_amount_out.0) * 10_000 / q.amount_out.0;
                    effective_slippage = effective_slippage.max(implied.min(10_000) as u32);
                }
                if q.expires_at_ns.0 <= now {
                    violations.push(PolicyViolation::QuoteInvalid { reason: "quote_expired".to_string() });
                }
            }
            None if req.destination_chain != "near" => {
                violations.push(PolicyViolation::QuoteInvalid { reason: "cross_chain_requires_quote".to_string() });
            }
            None => {}
        }

        let assets = if near_payment {
            vec![req.origin_asset.as_str()]
        } else {
            vec![req.origin_asset.as_str(), req.destination_asset.as_str()]
        };
        let blocked = self.blocked_reason(&req.destination_chain, &req.recipient);
        let spend = SpendRequest {
            amount: req.amount.0,
            destination_chain: Some(&req.destination_chain),
            execution_contract: if near_payment { None } else { Some(&req.execution_contract) },
            assets,
            slippage_bps: if near_payment { None } else { Some(effective_slippage) },
            available_liquidity: self.available_liquidity(),
            recipient: Some((&req.destination_chain, &req.recipient)),
            recipient_is_agent: false,
            recipient_blocked: blocked.as_deref(),
            price: (req.destination_chain != "near").then_some(PriceCheck {
                origin_asset: &req.origin_asset,
                destination_asset: &req.destination_asset,
                amount: req.amount.0,
                min_amount_out: req.min_amount_out.0,
            }),
        };
        let (spend_violations, limits) = evaluate_spend(&self.policy, self.paused, agent, &self.treasury, epoch, &spend);
        violations.extend(spend_violations);

        // The auditor judges facts the contract computed, never facts the agent wrote.
        let facts = intent_facts(
            &IntentFactsInput {
                agent: agent.agent_id.as_str(),
                kind: req.kind.as_str(),
                chain: &req.destination_chain,
                recipient: &req.recipient,
                amount: req.amount.0,
                min_amount_out: req.min_amount_out.0,
                origin_asset: &req.origin_asset,
                destination_asset: &req.destination_asset,
                execution_contract: req.execution_contract.as_str(),
                memo: req.memo.as_deref().unwrap_or(""),
                quote_dry_run: req.quote.as_ref().map(|q| q.dry),
            },
            &RecipientStatus {
                allow_listed: self.policy.allows_recipient(&req.destination_chain, &req.recipient),
                blocked_reason: blocked.as_deref(),
            },
            &violations,
        );

        let mut attestation_hash = None;
        let mut attested_receipt = None;
        match &req.attestation {
            Some(proof) => {
                let exp = ReceiptExpectation {
                    subject_kind: "intent",
                    subject_id: 0,
                    agent_id: &agent.agent_id,
                    schema_hash: None,
                    input_hash: Some(&hash_hex),
                    verdict: "approve",
                    min_confidence_bps: 0,
                    prompt_hash: self.policy.audit_prompt_hash.as_deref(),
                    user_message: Some((facts.facts_hash.as_str(), AttestationError::FactsMismatch)),
                };
                match self.verify_proof(proof, &exp) {
                    Ok((h, receipt)) => {
                        attestation_hash = Some(h);
                        attested_receipt = Some(receipt);
                    }
                    Err(e) => violations.push(PolicyViolation::InvalidTeeAttestation { reason: e.reason().to_string() }),
                }
            }
            None if limits.require_tee_attestation => violations.push(PolicyViolation::MissingTeeAttestation),
            None => {}
        }

        let window_ns = u64::from(self.policy.velocity_window_sec) * NS;
        let (window_start, requests) = if now.saturating_sub(agent.spend.window_start_ns.0) > window_ns {
            (now, 1)
        } else {
            (agent.spend.window_start_ns.0, agent.spend.requests_in_window + 1)
        };
        if requests > self.policy.velocity_limit {
            violations.push(PolicyViolation::VelocityExceeded {
                requests,
                limit: self.policy.velocity_limit,
                window_sec: self.policy.velocity_window_sec,
            });
        }

        // Under the `hold` rule an unknown recipient is the DAO's call, not a violation: when it is
        // the only finding, the request is approved into `PendingApproval` instead of rejected.
        let held =
            !violations.is_empty() && violations.iter().all(|v| matches!(v, PolicyViolation::RecipientNeedsApproval { .. }));
        if held {
            violations.clear();
        }
        let approved = violations.is_empty();
        let mut approval_reasons = Vec::new();
        if approved && req.amount.0 >= self.policy.dao_approval_threshold.0 {
            approval_reasons.push("amount_at_or_above_dao_threshold".to_string());
        }
        if held {
            approval_reasons.push("recipient_needs_approval".to_string());
        }
        let decision = PolicyDecision {
            approved,
            severity: max_severity(&violations),
            requires_dao_approval: !approval_reasons.is_empty(),
            approval_reasons,
            violations,
            limits,
        };
        let assessment = IntentAssessment {
            intent_message: message,
            nep413_hash: hash_hex,
            signature_valid,
            attestation_hash,
            velocity_requests: requests,
            decision,
            audit_facts_hash: facts.facts_hash.clone(),
        };
        (assessment, window_start, requests, attested_receipt, facts)
    }

    fn release_intent_funds(&mut self, record: &IntentRecord) {
        let amount = record.amount.0;
        self.treasury.reserved_for_intents = self.treasury.reserved_for_intents.saturating_sub(amount);
        self.treasury.liquid += amount;
        if let Some(agent) = self.agents.get_mut(&record.agent_id) {
            agent.total_spent = U128(agent.total_spent.0.saturating_sub(amount));
        }
    }

    /// Pays an approved NEAR vendor invoice: a real transfer, settled in the callback.
    fn pay_vendor(&mut self, record: &mut IntentRecord) {
        let recipient: AccountId = record.recipient.parse().unwrap_or_else(|_| env::panic_str("AEGIS_E_INTENT: recipient"));
        Promise::new(recipient)
            .transfer(NearToken::from_yoctonear(record.amount.0))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(self.config.callback_gas_tgas))
                    .on_vendor_payment(record.intent_id),
            )
            .detach();
        record.status = IntentStatus::Paying;
    }

    /// Asks the MPC network to sign the settlement authorization (cross-chain intents only).
    fn request_mpc_authorization(&mut self, record: &mut IntentRecord) {
        let Some(mpc_contract_id) = self.config.mpc_contract_id.clone() else {
            return;
        };
        if record.destination_chain == "near" {
            return;
        }
        let commitment = settlement_commitment(record);
        let payload = mpc_payload(&commitment);
        let payload_hex = to_hex(&payload);
        let path = format!("aegis-treasury/{}", record.destination_chain);
        let args = mpc_sign_args(&path, &payload_hex, self.config.mpc_domain_id);
        Promise::new(mpc_contract_id.clone())
            .function_call("sign", args, NearToken::from_yoctonear(1), Gas::from_tgas(self.config.mpc_sign_gas_tgas))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(self.config.callback_gas_tgas))
                    .on_mpc_signature(record.intent_id),
            )
            .detach();
        record.status = IntentStatus::Signing;
        record.mpc = Some(MpcAuthorization {
            mpc_contract_id: mpc_contract_id.clone(),
            path: path.clone(),
            domain_id: self.config.mpc_domain_id,
            commitment: to_hex(&commitment),
            payload: payload_hex.clone(),
            signature: None,
            error: None,
        });
        AegisEvent::MpcSignatureRequested { intent_id: record.intent_id, mpc_contract_id, path, payload_hex }.emit();
    }

    /// Executes an approved settlement: pays a NEAR vendor or requests the MPC authorization.
    fn execute_committed(&mut self, record: &mut IntentRecord) {
        if record.kind == IntentKind::VendorPayment && record.destination_chain == "near" {
            self.pay_vendor(record);
        } else {
            self.request_mpc_authorization(record);
        }
    }

    fn intent_or_panic(&self, intent_id: u64) -> IntentRecord {
        self.intents.get(&intent_id).cloned().unwrap_or_else(|| env::panic_str("AEGIS_E_UNKNOWN_INTENT"))
    }
}

#[near]
impl AegisCore {
    /// Agents (scoped key) request a policy-checked settlement.
    pub fn request_intent_settlement(&mut self, request: CrossChainIntentRequest) -> SettlementOutcome {
        let agent = self.caller_agent("request_intent_settlement");
        // Frozen agents cannot even write audit records (prevents storage spam from leaked keys).
        require!(agent.status == AgentStatus::Active, "AEGIS_E_AGENT_NOT_ACTIVE");

        let (assessment, window_start, requests, attested_receipt, _facts) = self.assess_intent(&agent, &request);
        let now = env::block_timestamp();
        let epoch = env::epoch_height();

        let mut updated = agent.clone();
        updated.spend.window_start_ns = U64(window_start);
        updated.spend.requests_in_window = requests;
        self.agents.insert(updated.agent_id.clone(), updated.clone());
        if assessment.signature_valid {
            self.used_nonces.insert(format!("{}:{}", agent.agent_id, request.nonce));
        }

        let intent_id = self.next_intent_id;
        self.next_intent_id += 1;
        let decision = assessment.decision.clone();
        let mut record = IntentRecord {
            intent_id: U64(intent_id),
            agent_id: agent.agent_id.clone(),
            kind: request.kind,
            destination_chain: request.destination_chain.clone(),
            origin_asset: request.origin_asset.clone(),
            destination_asset: request.destination_asset.clone(),
            amount: request.amount,
            min_amount_out: request.min_amount_out,
            recipient: request.recipient.clone(),
            execution_contract: request.execution_contract.clone(),
            slippage_bps: request.slippage_bps,
            deadline_ns: request.deadline_ns,
            intent_message: assessment.intent_message.clone(),
            nep413_hash: assessment.nep413_hash.clone(),
            nonce: request.nonce.clone(),
            quote: request.quote.clone(),
            attestation_hash: assessment.attestation_hash.clone(),
            decision: decision.clone(),
            status: IntentStatus::Rejected,
            dry_run: !request.is_near_payment(),
            mpc: None,
            memo: request.memo.clone(),
            created_at_ns: U64(now),
            settled_at_ns: None,
            settlement_ref: None,
        };

        if !decision.approved {
            self.intents.insert(intent_id, record);
            let (_severity, quarantined) =
                self.apply_circuit_breaker(&agent.agent_id, "request_intent_settlement", &decision.violations);
            AegisEvent::IntentRejected {
                intent_id: U64(intent_id),
                agent_id: agent.agent_id.clone(),
                nep413_hash: assessment.nep413_hash.clone(),
                violation_codes: decision.violations.iter().map(|v| v.code().to_string()).collect(),
            }
            .emit();
            return SettlementOutcome {
                intent_id: U64(intent_id),
                status: IntentStatus::Rejected,
                nep413_hash: assessment.nep413_hash,
                decision,
                quarantined,
            };
        }

        if let (Some(proof), Some(h), Some(receipt)) = (&request.attestation, &assessment.attestation_hash, &attested_receipt) {
            self.record_attestation(h, proof, receipt);
        }
        let amount = request.amount.0;
        self.treasury.liquid -= amount;
        self.treasury.reserved_for_intents += amount;
        self.charge_epoch_spend(&mut updated, amount, epoch);
        updated.total_spent = U128(updated.total_spent.0 + amount);
        self.agents.insert(updated.agent_id.clone(), updated);

        record.status = if decision.requires_dao_approval { IntentStatus::PendingApproval } else { IntentStatus::Committed };
        if record.status == IntentStatus::Committed {
            self.execute_committed(&mut record);
        }
        AegisEvent::IntentCommitted {
            intent_id: U64(intent_id),
            agent_id: agent.agent_id.clone(),
            nep413_hash: assessment.nep413_hash.clone(),
            amount: request.amount,
            destination_chain: request.destination_chain.clone(),
            recipient: request.recipient.clone(),
            status: record.status.as_str().to_string(),
        }
        .emit();
        let status = record.status;
        self.intents.insert(intent_id, record);
        SettlementOutcome { intent_id: U64(intent_id), status, nep413_hash: assessment.nep413_hash, decision, quarantined: false }
    }

    /// Callback of a NEAR vendor payment.
    #[private]
    pub fn on_vendor_payment(&mut self, intent_id: U64) -> IntentStatus {
        require!(env::promise_results_count() == 1, "AEGIS_E_CALLBACK_ONLY");
        let mut record = self.intent_or_panic(intent_id.0);
        require!(record.status == IntentStatus::Paying, "AEGIS_E_INTENT_NOT_PAYING");
        let recipient: AccountId = record.recipient.parse().unwrap_or_else(|_| env::panic_str("AEGIS_E_INTENT: recipient"));
        if env::promise_result_checked(0, 64).is_ok() {
            self.treasury.reserved_for_intents = self.treasury.reserved_for_intents.saturating_sub(record.amount.0);
            self.treasury.total_operating_costs += record.amount.0;
            record.status = IntentStatus::Settled;
            record.settled_at_ns = Some(U64(env::block_timestamp()));
            record.settlement_ref = Some(format!("near-transfer:{}", env::block_height()));
            AegisEvent::VendorPaid { intent_id, recipient, amount: record.amount }.emit();
        } else {
            self.release_intent_funds(&record);
            record.status = IntentStatus::PaymentFailed;
            AegisEvent::VendorPaymentFailed { intent_id, recipient, amount: record.amount }.emit();
        }
        let status = record.status;
        self.intents.insert(intent_id.0, record);
        status
    }

    /// Callback of the MPC `sign` call.
    #[private]
    pub fn on_mpc_signature(&mut self, intent_id: U64) -> IntentStatus {
        require!(env::promise_results_count() == 1, "AEGIS_E_CALLBACK_ONLY");
        let mut record = self.intent_or_panic(intent_id.0);
        require!(record.status == IntentStatus::Signing, "AEGIS_E_INTENT_NOT_SIGNING");
        let (ok, detail) = match parse_mpc_result(env::promise_result_checked(0, 4096)) {
            Ok(sig) => {
                if let Some(mpc) = record.mpc.as_mut() {
                    mpc.signature = Some(sig);
                }
                record.status = IntentStatus::Signed;
                (true, "signed".to_string())
            }
            Err(reason) => {
                if let Some(mpc) = record.mpc.as_mut() {
                    mpc.error = Some(reason.clone());
                }
                record.status = IntentStatus::AuthorizationFailed;
                self.release_intent_funds(&record);
                (false, reason)
            }
        };
        AegisEvent::MpcSignatureResolved { intent_id, ok, detail }.emit();
        let status = record.status;
        self.intents.insert(intent_id.0, record);
        status
    }

    /// Sentinel (scoped key) or owner closes an authorized cross-chain rehearsal. Dry-run
    /// settlements moved no funds, so the reservation returns to liquidity.
    pub fn confirm_intent_settlement(&mut self, intent_id: U64, settlement_ref: String) -> IntentRecord {
        if !self.is_owner_call() {
            let agent = self.caller_agent("confirm_intent_settlement");
            require!(agent.role == AgentRole::Sentinel && agent.status == AgentStatus::Active, "AEGIS_E_UNAUTHORIZED");
        }
        require!(!settlement_ref.is_empty() && is_safe_ascii(&settlement_ref, 128), "AEGIS_E_INVALID_SETTLEMENT_REF");
        let mut record = self.intent_or_panic(intent_id.0);
        require!(record.destination_chain != "near", "AEGIS_E_NEAR_PAYMENTS_SETTLE_IN_CALLBACK");
        require!(matches!(record.status, IntentStatus::Signed | IntentStatus::Committed), "AEGIS_E_INTENT_NOT_AUTHORIZED");
        self.release_intent_funds(&record);
        record.status = IntentStatus::Settled;
        record.settled_at_ns = Some(U64(env::block_timestamp()));
        record.settlement_ref = Some(settlement_ref.clone());
        self.intents.insert(intent_id.0, record.clone());
        AegisEvent::IntentSettled { intent_id, settlement_ref, dry_run: record.dry_run }.emit();
        record
    }

    /// Owner / DAO approves a held settlement: above `dao_approval_threshold`, or to an unknown
    /// recipient under the `hold` rule.
    pub fn approve_intent(&mut self, intent_id: U64) -> IntentRecord {
        self.assert_owner();
        let mut record = self.intent_or_panic(intent_id.0);
        require!(record.status == IntentStatus::PendingApproval, "AEGIS_E_INTENT_NOT_PENDING");
        // A recipient blocked while the request waited is never paid, even with the DAO's approval.
        require!(self.blocked_reason(&record.destination_chain, &record.recipient).is_none(), "AEGIS_E_RECIPIENT_BLOCKED");
        record.status = IntentStatus::Committed;
        self.execute_committed(&mut record);
        self.intents.insert(intent_id.0, record.clone());
        record
    }

    /// Owner cancels an approved-but-unsettled intent and releases the reserved funds.
    pub fn cancel_intent(&mut self, intent_id: U64) -> IntentRecord {
        self.assert_owner();
        let mut record = self.intent_or_panic(intent_id.0);
        require!(
            matches!(record.status, IntentStatus::PendingApproval | IntentStatus::Committed | IntentStatus::Signed),
            "AEGIS_E_INTENT_NOT_CANCELLABLE"
        );
        self.release_intent_funds(&record);
        record.status = IntentStatus::Cancelled;
        self.intents.insert(intent_id.0, record.clone());
        AegisEvent::IntentCancelled { intent_id, released: record.amount }.emit();
        record
    }

    /// Dry-run of the full policy pipeline for `agent_id` (used by the Sentinel before execution).
    pub fn evaluate_intent(&self, agent_id: AccountId, request: CrossChainIntentRequest) -> IntentAssessment {
        let agent = self.agent_or_panic(&agent_id);
        self.assess_intent(&agent, &request).0
    }

    /// The facts document a NEAR AI audit of this settlement request must carry as its user
    /// message. The contract builds it from its own evaluation, so the paying agent cannot.
    pub fn get_intent_audit_facts(&self, agent_id: AccountId, request: CrossChainIntentRequest) -> AuditFacts {
        let agent = self.agent_or_panic(&agent_id);
        self.assess_intent(&agent, &request).4
    }

    /// Recipient allow-list check, for agents and UIs before they sign anything.
    pub fn is_recipient_allowed(&self, chain: String, recipient: String) -> bool {
        self.policy.allows_recipient(&chain, &recipient)
    }

    pub fn get_intent(&self, intent_id: U64) -> Option<IntentRecord> {
        self.intents.get(&intent_id.0).cloned()
    }

    /// Newest first.
    pub fn list_intents(&self, limit: Option<u32>) -> Vec<IntentRecord> {
        let limit = u64::from(limit.unwrap_or(20).min(crate::MAX_PAGE));
        let end = self.next_intent_id;
        let start = end.saturating_sub(limit);
        (start..end).rev().filter_map(|id| self.intents.get(&id).cloned()).collect()
    }
}

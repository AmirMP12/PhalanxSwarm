//! Chain Signatures spending on EVM chains (tracks: defi, agents, security).
//!
//! The treasury controls one EVM address per chain: the Chain Signatures key derived for
//! `(this contract, "phalanx-treasury/<chain>")`. An agent asks for a transfer from that address
//! with `request_evm_transfer`. The contract applies the EVM chain policy (allowed chain,
//! asset, per-transaction and per-epoch caps, fee ceiling), the recipient allow-list, velocity
//! limits and the TEE proof requirement, then builds the EIP-1559 transaction itself and asks
//! the MPC network to sign its hash. Agents never supply the bytes that get signed, so a signed
//! transaction can only pay the allow-listed recipient the approved amount.
//!
//! Nonce discipline. A signed EVM transaction never expires, so the contract owns the nonce:
//! `get_evm_nonce` names the next one, a request must use exactly that nonce, and only one
//! transfer per chain can be signed and unconfirmed at a time. An agent therefore cannot pre-sign
//! future nonces, and per-epoch caps bound what can actually leave. While a signed transfer is not
//! mined, the owner or a Sentinel can `cancel_evm_transfer`: the contract signs a zero-value
//! replacement at the same nonce with higher fees. A signed transaction is public (its signature
//! is in the MPC receipt), so cancellation works only until someone broadcasts the original.
//!
//! The MPC callback assembles the signed raw transaction and its hash. Anyone can broadcast
//! `raw_tx`; a Sentinel (or the owner) then confirms the exact `tx_hash` that was mined, which
//! advances the nonce and settles the other transaction at that nonce (cancelled or superseded).

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise};

use crate::attestation::{AttestationError, ExecutionProof, ReceiptExpectation};
use crate::codec::{from_hex, is_evm_address, is_lower_evm_address, is_safe_ascii, is_valid_chain_id, to_hex};
use crate::events::PhalanxEvent;
use crate::facts::{evm_facts, AuditFacts, EvmFactsInput, RecipientStatus};
use crate::intents::{mpc_sign_args, parse_mpc_result, MpcSignature};
use crate::invoices::is_valid_invoice_ref;
use crate::policy::{max_severity, recipient_violation, EvmChainPolicy, PolicyViolation, Severity};
use crate::subaccounts::{AgentRecord, AgentRole, AgentStatus};
use crate::{PhalanxCore, PhalanxCoreExt};

pub const NATIVE_ASSET: &str = "native";
const ERC20_TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
const NS: u64 = 1_000_000_000;
/// Gas of a plain zero-value transfer: what a cancellation costs.
pub const CANCEL_GAS_LIMIT: u64 = 21_000;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmTransferRequest {
    /// Chain label of an `EvmChainPolicy` (`basesepolia`, `base`, ...).
    pub chain: String,
    /// Recipient `0x` address.
    pub to: String,
    /// `native` or a lower-case ERC-20 contract address.
    pub asset: String,
    /// Wei (native) or token base units.
    pub amount: U128,
    /// EVM nonce of the treasury address on that chain. Must equal `get_evm_nonce(chain).next_nonce`.
    pub nonce: U64,
    pub gas_limit: U64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub memo: Option<String>,
    /// Sentinel proof bound to the transaction's signing hash (subject `evm`).
    pub attestation: Option<ExecutionProof>,
    /// Vendor's invoice number (required when the DAO sets `require_invoice_ref`).
    #[serde(default)]
    pub invoice_ref: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvmTxStatus {
    Rejected,
    Signing,
    Signed,
    AuthorizationFailed,
    Confirmed,
    /// A transfer whose cancellation was mined: it can never be mined itself.
    Cancelled,
    /// A cancellation that was not needed: the transfer it targeted was mined first.
    Superseded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvmTxKind {
    Transfer,
    /// A zero-value replacement at the same nonce as the transfer it cancels.
    Cancel,
}

/// The nonce the contract tracks for the treasury address on one EVM chain.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmNonceState {
    /// Next nonce the treasury address signs on this chain.
    pub next_nonce: U64,
    /// The signed transfer holding `next_nonce` until it is confirmed or cancelled.
    pub outstanding_tx: Option<U64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmTxRecord {
    pub tx_id: U64,
    pub agent_id: AccountId,
    pub chain: String,
    pub chain_id: U64,
    pub to: String,
    pub asset: String,
    pub amount: U128,
    pub nonce: U64,
    pub gas_limit: U64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    /// `to` field of the signed transaction (the token contract for ERC-20 transfers).
    pub tx_to: String,
    /// Native value of the signed transaction, wei.
    pub tx_value: U128,
    /// Hex calldata (empty for native transfers).
    pub data: String,
    /// keccak256 of the unsigned EIP-1559 transaction: the 32 bytes the MPC network signs.
    pub signing_hash: String,
    pub path: String,
    pub mpc_contract_id: Option<AccountId>,
    pub signature: Option<MpcSignature>,
    /// `0x`-prefixed signed raw transaction, ready for `eth_sendRawTransaction`. Its sender is
    /// the Chain Signatures key derived for (this contract, `path`).
    pub raw_tx: Option<String>,
    pub tx_hash: Option<String>,
    pub attestation_hash: Option<String>,
    pub severity: Severity,
    pub violations: Vec<PolicyViolation>,
    pub status: EvmTxStatus,
    pub error: Option<String>,
    pub memo: Option<String>,
    pub invoice_ref: Option<String>,
    /// `transfer`, or `cancel` (a zero-value replacement at the same nonce).
    pub kind: EvmTxKind,
    /// For a cancel: the transfer it replaces.
    pub replaces: Option<U64>,
    /// For a transfer: the cancel signed to replace it, if any.
    pub replaced_by: Option<U64>,
    /// NEAR epoch the transfer was charged to (the charge is released if it is cancelled).
    pub epoch: U64,
    pub created_at_ns: U64,
    pub confirmed_at_ns: Option<U64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmTransferOutcome {
    pub tx_id: U64,
    pub status: EvmTxStatus,
    pub signing_hash: String,
    pub severity: Severity,
    pub violations: Vec<PolicyViolation>,
    pub quarantined: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmTxPreview {
    pub chain_id: U64,
    pub tx_to: String,
    pub tx_value: U128,
    pub data: String,
    pub unsigned_tx: String,
    pub signing_hash: String,
}

/// Per-epoch spend of one `(chain, asset)` pair.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EvmSpend {
    pub epoch: u64,
    pub spent: u128,
}

// RLP (Ethereum Yellow Paper, appendix B)

fn rlp_len_prefix(out: &mut Vec<u8>, len: usize, offset: u8) {
    if len < 56 {
        out.push(offset + len as u8);
    } else {
        let be = (len as u64).to_be_bytes();
        let start = be.iter().position(|b| *b != 0).unwrap_or(7);
        out.push(offset + 55 + (8 - start) as u8);
        out.extend_from_slice(&be[start..]);
    }
}

pub fn rlp_bytes(out: &mut Vec<u8>, data: &[u8]) {
    if data.len() == 1 && data[0] < 0x80 {
        out.push(data[0]);
    } else {
        rlp_len_prefix(out, data.len(), 0x80);
        out.extend_from_slice(data);
    }
}

/// A big-endian unsigned integer without leading zeros (zero is the empty string).
pub fn rlp_uint_be(out: &mut Vec<u8>, be: &[u8]) {
    let start = be.iter().position(|b| *b != 0).unwrap_or(be.len());
    rlp_bytes(out, &be[start..]);
}

pub fn rlp_uint(out: &mut Vec<u8>, v: u128) {
    rlp_uint_be(out, &v.to_be_bytes());
}

pub fn rlp_list(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 9);
    rlp_len_prefix(&mut out, payload.len(), 0xc0);
    out.extend_from_slice(payload);
    out
}

/// The unsigned EIP-1559 field list `[chain_id, nonce, tip, max_fee, gas, to, value, data, []]`.
#[allow(clippy::too_many_arguments)]
pub fn eip1559_fields(
    chain_id: u64,
    nonce: u64,
    max_priority_fee_per_gas: u128,
    max_fee_per_gas: u128,
    gas_limit: u64,
    to: &[u8; 20],
    value: u128,
    data: &[u8],
) -> Vec<u8> {
    let mut p = Vec::with_capacity(128 + data.len());
    rlp_uint(&mut p, u128::from(chain_id));
    rlp_uint(&mut p, u128::from(nonce));
    rlp_uint(&mut p, max_priority_fee_per_gas);
    rlp_uint(&mut p, max_fee_per_gas);
    rlp_uint(&mut p, u128::from(gas_limit));
    rlp_bytes(&mut p, to);
    rlp_uint(&mut p, value);
    rlp_bytes(&mut p, data);
    p.push(0xc0); // empty access list
    p
}

/// `0x02 || rlp(fields)`.
pub fn typed_tx(fields: &[u8]) -> Vec<u8> {
    let mut out = vec![0x02];
    out.extend(rlp_list(fields));
    out
}

/// `0x02 || rlp(fields ++ [y_parity, r, s])`.
pub fn signed_typed_tx(fields: &[u8], y_parity: u8, r: &[u8], s: &[u8]) -> Vec<u8> {
    let mut p = fields.to_vec();
    rlp_uint(&mut p, u128::from(y_parity));
    rlp_uint_be(&mut p, r);
    rlp_uint_be(&mut p, s);
    typed_tx(&p)
}

/// ERC-20 `transfer(address,uint256)` calldata.
pub fn erc20_transfer_data(to: &[u8; 20], amount: u128) -> Vec<u8> {
    let mut data = Vec::with_capacity(68);
    data.extend_from_slice(&ERC20_TRANSFER_SELECTOR);
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(to);
    data.extend_from_slice(&[0u8; 16]);
    data.extend_from_slice(&amount.to_be_bytes());
    data
}

fn address20(s: &str) -> [u8; 20] {
    from_hex(s).and_then(|b| b.try_into().ok()).unwrap_or_else(|| env::panic_str("PHALANX_E_EVM: invalid address"))
}

/// Everything the MPC network signs for a request under a chain policy.
pub struct BuiltTx {
    pub tx_to: String,
    pub tx_value: u128,
    pub data: Vec<u8>,
    pub fields: Vec<u8>,
    pub signing_hash: [u8; 32],
}

pub fn build_evm_tx(chain: &EvmChainPolicy, req: &EvmTransferRequest) -> BuiltTx {
    let recipient = address20(&req.to);
    let (tx_to, tx_value, data) = if req.asset == NATIVE_ASSET {
        (req.to.to_ascii_lowercase(), req.amount.0, Vec::new())
    } else {
        (req.asset.clone(), 0, erc20_transfer_data(&recipient, req.amount.0))
    };
    let fields = eip1559_fields(
        chain.chain_id,
        req.nonce.0,
        req.max_priority_fee_per_gas.0,
        req.max_fee_per_gas.0,
        req.gas_limit.0,
        &address20(&tx_to),
        tx_value,
        &data,
    );
    let signing_hash = env::keccak256_array(typed_tx(&fields));
    BuiltTx { tx_to, tx_value, data, fields, signing_hash }
}

fn validate_evm_request(req: &EvmTransferRequest) {
    require!(is_valid_chain_id(&req.chain), "PHALANX_E_EVM: invalid chain");
    require!(is_evm_address(&req.to), "PHALANX_E_EVM: `to` must be a 0x address");
    require!(
        req.asset == NATIVE_ASSET || is_lower_evm_address(&req.asset),
        "PHALANX_E_EVM: asset is `native` or a lower-case 0x token"
    );
    require!(req.amount.0 > 0, "PHALANX_E_EVM: amount must be > 0");
    require!((21_000..=2_000_000).contains(&req.gas_limit.0), "PHALANX_E_EVM: gas_limit must be 21000..=2000000");
    require!(req.max_fee_per_gas.0 > 0, "PHALANX_E_EVM: max_fee_per_gas must be > 0");
    require!(req.max_priority_fee_per_gas.0 <= req.max_fee_per_gas.0, "PHALANX_E_EVM: tip must be <= max fee");
    require!(req.memo.as_deref().map(|m| is_safe_ascii(m, 128)).unwrap_or(true), "PHALANX_E_EVM: invalid memo");
    require!(
        req.invoice_ref.as_deref().map(is_valid_invoice_ref).unwrap_or(true),
        "PHALANX_E_EVM: invoice_ref is 1-64 printable characters"
    );
}

/// Everything `request_evm_transfer` decides before it looks at the TEE proof. Read-only.
struct EvmPreAssessment {
    violations: Vec<PolicyViolation>,
    chain_policy: Option<EvmChainPolicy>,
    built: Option<BuiltTx>,
    signing_hash: String,
    facts: AuditFacts,
}

impl PhalanxCore {
    fn evm_spend_key(chain: &str, asset: &str) -> String {
        format!("{chain}:{asset}")
    }

    fn evm_spent(&self, chain: &str, asset: &str, epoch: u64) -> u128 {
        self.evm_spend.get(&Self::evm_spend_key(chain, asset)).filter(|s| s.epoch == epoch).map(|s| s.spent).unwrap_or(0)
    }

    fn set_evm_spent(&mut self, chain: &str, asset: &str, epoch: u64, spent: u128) {
        self.evm_spend.insert(Self::evm_spend_key(chain, asset), EvmSpend { epoch, spent });
    }

    /// Gives back a transfer's charge against its epoch cap (MPC failure or cancellation).
    fn release_evm_spend(&mut self, record: &EvmTxRecord) {
        let spent = self.evm_spent(&record.chain, &record.asset, record.epoch.0);
        if spent > 0 {
            self.set_evm_spent(&record.chain, &record.asset, record.epoch.0, spent.saturating_sub(record.amount.0));
        }
    }

    fn evm_tx_or_panic(&self, tx_id: u64) -> EvmTxRecord {
        self.evm_txs.get(&tx_id).cloned().unwrap_or_else(|| env::panic_str("PHALANX_E_UNKNOWN_EVM_TX"))
    }

    pub(crate) fn evm_nonce(&self, chain: &str) -> EvmNonceState {
        self.evm_nonces.get(chain).cloned().unwrap_or(EvmNonceState { next_nonce: U64(0), outstanding_tx: None })
    }

    /// Frees the chain's nonce slot if `tx_id` holds it (its signature failed, the nonce is unused).
    fn release_nonce_slot(&mut self, chain: &str, tx_id: U64) {
        let mut state = self.evm_nonce(chain);
        if state.outstanding_tx == Some(tx_id) {
            state.outstanding_tx = None;
            self.evm_nonces.insert(chain.to_string(), state);
        }
    }

    /// Policy, recipient, nonce and fee checks plus the audit facts, before the TEE proof is read.
    fn evm_pre_assessment(&self, agent: &AgentRecord, request: &EvmTransferRequest, epoch: u64) -> EvmPreAssessment {
        validate_evm_request(request);
        let mut violations = Vec::new();
        if self.paused {
            violations.push(PolicyViolation::ProtocolPaused);
        }
        let chain_policy = self.policy.evm_chain(&request.chain).cloned();
        let built = chain_policy.as_ref().map(|c| build_evm_tx(c, request));
        let blocked = self.blocked_reason(&request.chain, &request.to);
        let mut asset_symbol = String::new();
        match &chain_policy {
            None => violations.push(PolicyViolation::EvmChainNotAllowed { chain: request.chain.clone() }),
            Some(chain) => {
                if let Some(v) = recipient_violation(&self.policy, &request.chain, &request.to, false, blocked.as_deref()) {
                    violations.push(v);
                }
                let limits = if request.asset == NATIVE_ASSET {
                    asset_symbol = NATIVE_ASSET.to_string();
                    Some((chain.max_value_wei.0, chain.epoch_cap_wei.0))
                } else {
                    chain.tokens.iter().find(|t| t.token == request.asset).map(|t| {
                        asset_symbol = t.symbol.clone();
                        (t.max_amount.0, t.epoch_cap.0)
                    })
                };
                match limits {
                    None => violations.push(PolicyViolation::EvmAssetNotAllowed { asset: request.asset.clone() }),
                    Some((max, cap)) => {
                        if request.amount.0 > max {
                            violations.push(PolicyViolation::EvmAmountExceedsLimit { amount: request.amount, limit: U128(max) });
                        }
                        let spent = self.evm_spent(&request.chain, &request.asset, epoch);
                        if spent.saturating_add(request.amount.0) > cap {
                            violations.push(PolicyViolation::EvmEpochCapExceeded {
                                spent: U128(spent),
                                amount: request.amount,
                                cap: U128(cap),
                            });
                        }
                    }
                }
                let fee = u128::from(request.gas_limit.0).saturating_mul(request.max_fee_per_gas.0);
                if fee > chain.max_fee_wei.0 {
                    violations.push(PolicyViolation::EvmFeeTooHigh { fee: U128(fee), cap: chain.max_fee_wei });
                }
            }
        }

        // The contract owns the nonce: one signed, unconfirmed transfer per chain, at the next nonce.
        let nonce_state = self.evm_nonce(&request.chain);
        if let Some(tx_id) = nonce_state.outstanding_tx {
            violations.push(PolicyViolation::EvmTransferOutstanding { tx_id });
        } else if request.nonce != nonce_state.next_nonce {
            violations.push(PolicyViolation::EvmNonceMismatch { expected: nonce_state.next_nonce, got: request.nonce });
        }

        if self.policy.require_invoice_ref && request.invoice_ref.is_none() {
            violations.push(PolicyViolation::InvoiceRefMissing);
        }

        let signing_hash = built.as_ref().map(|b| to_hex(&b.signing_hash)).unwrap_or_default();
        let facts = evm_facts(
            &EvmFactsInput {
                agent: agent.agent_id.as_str(),
                chain: &request.chain,
                chain_id: chain_policy.as_ref().map(|c| c.chain_id).unwrap_or(0),
                to: &request.to,
                asset: &request.asset,
                asset_symbol: &asset_symbol,
                amount: request.amount.0,
                fee_ceiling_wei: u128::from(request.gas_limit.0).saturating_mul(request.max_fee_per_gas.0),
                nonce: request.nonce.0,
                memo: request.memo.as_deref().unwrap_or(""),
                invoice_ref: request.invoice_ref.as_deref(),
            },
            &RecipientStatus {
                allow_listed: self.policy.allows_recipient(&request.chain, &request.to),
                blocked_reason: blocked.as_deref(),
            },
            &violations,
        );
        // Not part of the audit facts: it depends on payments made since the audit.
        if let Some(r) = request.invoice_ref.as_deref() {
            if let Some(p) = self.invoice_payment(&request.chain, &request.to, r) {
                violations.push(PolicyViolation::InvoiceAlreadyPaid {
                    invoice_ref: r.to_string(),
                    subject: p.subject,
                    subject_id: p.subject_id,
                });
            }
        }
        EvmPreAssessment { violations, chain_policy, built, signing_hash, facts }
    }

    /// Asks the MPC network to sign `signing_hash` for `path`; `on_evm_signature` assembles the tx.
    fn request_evm_signature(&self, mpc_contract_id: AccountId, path: &str, signing_hash: &str, tx_id: U64, epoch: U64) {
        let args = mpc_sign_args(path, signing_hash, self.config.mpc_domain_id);
        Promise::new(mpc_contract_id)
            .function_call("sign", args, NearToken::from_yoctonear(1), Gas::from_tgas(self.config.mpc_sign_gas_tgas))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(self.config.callback_gas_tgas))
                    .on_evm_signature(tx_id, epoch),
            )
            .detach();
    }
}

#[near]
impl PhalanxCore {
    /// Agents (scoped key) request a policy-checked transfer from the treasury's EVM address.
    pub fn request_evm_transfer(&mut self, request: EvmTransferRequest) -> EvmTransferOutcome {
        let agent = self.caller_agent("request_evm_transfer");
        require!(agent.status == AgentStatus::Active, "PHALANX_E_AGENT_NOT_ACTIVE");
        let mpc_contract_id = self.config.mpc_contract_id.clone().unwrap_or_else(|| env::panic_str("PHALANX_E_MPC_DISABLED"));
        let now = env::block_timestamp();
        let epoch = env::epoch_height();
        let EvmPreAssessment { mut violations, chain_policy, built, signing_hash, facts } =
            self.evm_pre_assessment(&agent, &request, epoch);

        let require_tee = self.policy.require_tee_attestation || agent.policy.require_tee_attestation;
        let mut attested = None;
        match (&request.attestation, built.is_some()) {
            (Some(proof), true) => {
                let exp = ReceiptExpectation {
                    subject_kind: "evm",
                    subject_id: 0,
                    agent_id: &agent.agent_id,
                    schema_hash: None,
                    input_hash: Some(&signing_hash),
                    verdict: "approve",
                    min_confidence_bps: 0,
                    prompt_hash: self.policy.audit_prompt_hash.as_deref(),
                    user_message: Some((facts.facts_hash.as_str(), AttestationError::FactsMismatch)),
                };
                match self.verify_proof(proof, &exp) {
                    Ok(v) => attested = Some(v),
                    Err(e) => violations.push(PolicyViolation::InvalidTeeAttestation { reason: e.reason().to_string() }),
                }
            }
            (None, true) if require_tee => violations.push(PolicyViolation::MissingTeeAttestation),
            _ => {}
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
        let mut updated = agent.clone();
        updated.spend.window_start_ns = U64(window_start);
        updated.spend.requests_in_window = requests;
        self.agents.insert(updated.agent_id.clone(), updated);

        let tx_id = self.next_evm_tx_id;
        self.next_evm_tx_id += 1;
        let path = format!("phalanx-treasury/{}", request.chain);
        let severity = max_severity(&violations);
        let mut record = EvmTxRecord {
            tx_id: U64(tx_id),
            agent_id: agent.agent_id.clone(),
            chain: request.chain.clone(),
            chain_id: U64(chain_policy.as_ref().map(|c| c.chain_id).unwrap_or(0)),
            to: request.to.to_ascii_lowercase(),
            asset: request.asset.clone(),
            amount: request.amount,
            nonce: request.nonce,
            gas_limit: request.gas_limit,
            max_fee_per_gas: request.max_fee_per_gas,
            max_priority_fee_per_gas: request.max_priority_fee_per_gas,
            tx_to: built.as_ref().map(|b| b.tx_to.clone()).unwrap_or_default(),
            tx_value: U128(built.as_ref().map(|b| b.tx_value).unwrap_or(0)),
            data: built.as_ref().map(|b| to_hex(&b.data)).unwrap_or_default(),
            signing_hash: signing_hash.clone(),
            path: path.clone(),
            mpc_contract_id: None,
            signature: None,
            raw_tx: None,
            tx_hash: None,
            attestation_hash: attested.as_ref().map(|(h, _)| h.clone()),
            severity,
            violations: violations.clone(),
            status: EvmTxStatus::Rejected,
            error: None,
            memo: request.memo.clone(),
            invoice_ref: request.invoice_ref.clone(),
            kind: EvmTxKind::Transfer,
            replaces: None,
            replaced_by: None,
            epoch: U64(epoch),
            created_at_ns: U64(now),
            confirmed_at_ns: None,
        };

        if !violations.is_empty() {
            self.evm_txs.insert(tx_id, record);
            let (severity, quarantined) = self.apply_circuit_breaker(&agent.agent_id, "request_evm_transfer", &violations);
            PhalanxEvent::EvmTransferRejected {
                tx_id: U64(tx_id),
                agent_id: agent.agent_id.clone(),
                violation_codes: violations.iter().map(|v| v.code().to_string()).collect(),
            }
            .emit();
            return EvmTransferOutcome {
                tx_id: U64(tx_id),
                status: EvmTxStatus::Rejected,
                signing_hash,
                severity,
                violations,
                quarantined,
            };
        }

        if let (Some(proof), Some((h, receipt))) = (&request.attestation, &attested) {
            self.record_attestation(h, proof, receipt);
        }
        let spent = self.evm_spent(&request.chain, &request.asset, epoch);
        self.set_evm_spent(&request.chain, &request.asset, epoch, spent + request.amount.0);
        if let Some(invoice) = request.invoice_ref.as_deref() {
            self.record_invoice(&request.chain, &request.to, invoice, "evm", tx_id, request.amount.0, &agent.agent_id);
        }
        // This transfer holds the chain's next nonce until it is confirmed or cancelled.
        self.evm_nonces
            .insert(request.chain.clone(), EvmNonceState { next_nonce: request.nonce, outstanding_tx: Some(U64(tx_id)) });
        self.request_evm_signature(mpc_contract_id.clone(), &path, &signing_hash, U64(tx_id), U64(epoch));
        record.status = EvmTxStatus::Signing;
        record.mpc_contract_id = Some(mpc_contract_id);
        PhalanxEvent::EvmTransferRequested {
            tx_id: U64(tx_id),
            agent_id: agent.agent_id.clone(),
            chain: request.chain.clone(),
            chain_id: record.chain_id,
            to: record.to.clone(),
            asset: request.asset.clone(),
            amount: request.amount,
            signing_hash: signing_hash.clone(),
        }
        .emit();
        self.evm_txs.insert(tx_id, record);
        EvmTransferOutcome {
            tx_id: U64(tx_id),
            status: EvmTxStatus::Signing,
            signing_hash,
            severity: Severity::None,
            violations: vec![],
            quarantined: false,
        }
    }

    /// Callback of the MPC `sign` call: assembles the signed raw transaction.
    #[private]
    pub fn on_evm_signature(&mut self, tx_id: U64, epoch: U64) -> EvmTxStatus {
        require!(env::promise_results_count() == 1, "PHALANX_E_CALLBACK_ONLY");
        let mut record = self.evm_tx_or_panic(tx_id.0);
        require!(record.status == EvmTxStatus::Signing, "PHALANX_E_EVM_TX_NOT_SIGNING");
        match parse_mpc_result(env::promise_result_checked(0, 4096)) {
            Ok(sig) => {
                let big_r = from_hex(&sig.big_r).unwrap_or_default();
                let s = from_hex(&sig.s).unwrap_or_default();
                let r = big_r.get(1..33).unwrap_or(&[]).to_vec();
                let chain = self.policy.evm_chain(&record.chain).cloned();
                let fields = eip1559_fields(
                    record.chain_id.0,
                    record.nonce.0,
                    record.max_priority_fee_per_gas.0,
                    record.max_fee_per_gas.0,
                    record.gas_limit.0,
                    &address20(&record.tx_to),
                    record.tx_value.0,
                    &from_hex(&record.data).unwrap_or_default(),
                );
                let y_parity = sig.recovery_id & 1;
                let raw = signed_typed_tx(&fields, y_parity, &r, &s);
                record.tx_hash = Some(format!("0x{}", to_hex(&env::keccak256_array(&raw))));
                record.raw_tx = Some(format!("0x{}", to_hex(&raw)));
                record.signature = Some(sig);
                record.status = EvmTxStatus::Signed;
                if chain.is_none() {
                    record.error = Some("chain_policy_removed_after_request".to_string());
                }
                // A cancel signed after its transfer was already confirmed is not needed.
                if record.kind == EvmTxKind::Cancel {
                    let original = record.replaces.and_then(|id| self.evm_txs.get(&id.0).cloned());
                    if original.is_some_and(|o| o.status == EvmTxStatus::Confirmed) {
                        record.status = EvmTxStatus::Superseded;
                    }
                }
                PhalanxEvent::EvmTransferSigned {
                    tx_id,
                    tx_hash: record.tx_hash.clone().unwrap_or_default(),
                    path: record.path.clone(),
                }
                .emit();
            }
            Err(reason) => {
                record.error = Some(reason);
                record.status = EvmTxStatus::AuthorizationFailed;
                match record.kind {
                    EvmTxKind::Transfer => {
                        let spent = self.evm_spent(&record.chain, &record.asset, epoch.0);
                        self.set_evm_spent(&record.chain, &record.asset, epoch.0, spent.saturating_sub(record.amount.0));
                        // Nothing was signed, so the nonce is unused and the slot is free again.
                        self.release_nonce_slot(&record.chain, tx_id);
                        self.release_invoice(&record.chain, &record.to, record.invoice_ref.as_deref(), "evm", tx_id.0);
                    }
                    EvmTxKind::Cancel => {
                        // The transfer stays outstanding; another cancel may be requested.
                        if let Some(original_id) = record.replaces {
                            if let Some(original) = self.evm_txs.get_mut(&original_id.0) {
                                if original.replaced_by == Some(tx_id) {
                                    original.replaced_by = None;
                                }
                            }
                        }
                    }
                }
            }
        }
        let status = record.status;
        self.evm_txs.insert(tx_id.0, record);
        status
    }

    /// Sentinel (scoped key) or owner confirms that the exact signed transaction was mined. This
    /// uses up the nonce: the chain's next nonce advances, and the other transaction signed at the
    /// same nonce, if any, is settled (`cancelled` or `superseded`).
    pub fn confirm_evm_transfer(&mut self, tx_id: U64, tx_hash: String) -> EvmTxRecord {
        let confirmed_by = if self.is_owner_call() {
            self.owner_id.clone()
        } else {
            let agent = self.caller_agent("confirm_evm_transfer");
            require!(agent.role == AgentRole::Sentinel && agent.status == AgentStatus::Active, "PHALANX_E_UNAUTHORIZED");
            agent.agent_id
        };
        let mut record = self.evm_tx_or_panic(tx_id.0);
        require!(record.status == EvmTxStatus::Signed, "PHALANX_E_EVM_TX_NOT_SIGNED");
        require!(record.tx_hash.as_deref() == Some(tx_hash.to_ascii_lowercase().as_str()), "PHALANX_E_EVM_TX_HASH_MISMATCH");
        let state = self.evm_nonce(&record.chain);
        require!(record.nonce == state.next_nonce, "PHALANX_E_EVM_NONCE: this transaction's nonce is not the chain's next nonce");
        record.status = EvmTxStatus::Confirmed;
        record.confirmed_at_ns = Some(U64(env::block_timestamp()));

        let sibling = match record.kind {
            EvmTxKind::Transfer => record.replaced_by,
            EvmTxKind::Cancel => record.replaces,
        };
        if let Some(sibling_id) = sibling {
            if let Some(mut other) = self.evm_txs.get(&sibling_id.0).cloned() {
                match record.kind {
                    // The transfer was mined first: its cancel can never be.
                    EvmTxKind::Transfer => {
                        if matches!(other.status, EvmTxStatus::Signing | EvmTxStatus::Signed) {
                            other.status = EvmTxStatus::Superseded;
                        }
                    }
                    // The cancel was mined: the transfer can never be, and its epoch charge is returned.
                    EvmTxKind::Cancel => {
                        other.status = EvmTxStatus::Cancelled;
                        self.release_evm_spend(&other);
                        self.release_invoice(&other.chain, &other.to, other.invoice_ref.as_deref(), "evm", sibling_id.0);
                        PhalanxEvent::EvmTransferCancelled { tx_id: sibling_id, cancel_tx_id: tx_id }.emit();
                        self.record_security_event(
                            "evm_transfer_cancelled",
                            Some(&other.agent_id),
                            Severity::Notice,
                            vec![],
                            format!("evm tx {} replaced by cancel {} at nonce {}", sibling_id.0, tx_id.0, record.nonce.0),
                        );
                    }
                }
                self.evm_txs.insert(sibling_id.0, other);
            }
        }
        self.evm_nonces.insert(record.chain.clone(), EvmNonceState { next_nonce: U64(record.nonce.0 + 1), outstanding_tx: None });
        self.evm_txs.insert(tx_id.0, record.clone());
        PhalanxEvent::EvmTransferConfirmed { tx_id, tx_hash: tx_hash.to_ascii_lowercase(), confirmed_by }.emit();
        record
    }

    /// Owner or Sentinel cancels a signed transfer that has not been mined: the contract signs a
    /// zero-value transfer to the same recipient at the same nonce, with fees at least 10% higher
    /// so mempools replace the original. Whichever of the two is mined is then confirmed.
    pub fn cancel_evm_transfer(
        &mut self,
        tx_id: U64,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
    ) -> EvmTransferOutcome {
        let requested_by = if self.is_owner_call() {
            self.owner_id.clone()
        } else {
            let agent = self.caller_agent("cancel_evm_transfer");
            require!(agent.role == AgentRole::Sentinel && agent.status == AgentStatus::Active, "PHALANX_E_UNAUTHORIZED");
            agent.agent_id
        };
        let mpc_contract_id = self.config.mpc_contract_id.clone().unwrap_or_else(|| env::panic_str("PHALANX_E_MPC_DISABLED"));
        let mut original = self.evm_tx_or_panic(tx_id.0);
        require!(original.kind == EvmTxKind::Transfer, "PHALANX_E_EVM_CANCEL: only transfers can be cancelled");
        require!(original.status == EvmTxStatus::Signed, "PHALANX_E_EVM_CANCEL: the transfer is not signed");
        require!(original.replaced_by.is_none(), "PHALANX_E_EVM_CANCEL: a cancel is already in flight");
        require!(
            self.evm_nonce(&original.chain).outstanding_tx == Some(tx_id),
            "PHALANX_E_EVM_CANCEL: not the chain's outstanding transfer"
        );
        let chain = self
            .policy
            .evm_chain(&original.chain)
            .cloned()
            .unwrap_or_else(|| env::panic_str("PHALANX_E_EVM_CHAIN_NOT_CONFIGURED"));
        // Mempools replace a pending transaction only when both fees rise by at least 10%.
        require!(
            max_fee_per_gas.0.saturating_mul(10) >= original.max_fee_per_gas.0.saturating_mul(11),
            "PHALANX_E_EVM_CANCEL: max_fee_per_gas must be at least 110% of the transfer's"
        );
        require!(
            max_priority_fee_per_gas.0 > 0
                && max_priority_fee_per_gas.0.saturating_mul(10) >= original.max_priority_fee_per_gas.0.saturating_mul(11),
            "PHALANX_E_EVM_CANCEL: max_priority_fee_per_gas must be at least 110% of the transfer's"
        );
        require!(max_priority_fee_per_gas.0 <= max_fee_per_gas.0, "PHALANX_E_EVM_CANCEL: tip must be <= max fee");
        require!(
            u128::from(CANCEL_GAS_LIMIT).saturating_mul(max_fee_per_gas.0) <= chain.max_fee_wei.0,
            "PHALANX_E_EVM_CANCEL: fee above the chain's max_fee_wei"
        );

        // A zero-value transfer without calldata uses up the nonce and moves no funds.
        let fields = eip1559_fields(
            chain.chain_id,
            original.nonce.0,
            max_priority_fee_per_gas.0,
            max_fee_per_gas.0,
            CANCEL_GAS_LIMIT,
            &address20(&original.to),
            0,
            &[],
        );
        let signing_hash = to_hex(&env::keccak256_array(typed_tx(&fields)));
        let cancel_id = U64(self.next_evm_tx_id);
        self.next_evm_tx_id += 1;
        let record = EvmTxRecord {
            tx_id: cancel_id,
            agent_id: original.agent_id.clone(),
            chain: original.chain.clone(),
            chain_id: U64(chain.chain_id),
            to: original.to.clone(),
            asset: NATIVE_ASSET.to_string(),
            amount: U128(0),
            nonce: original.nonce,
            gas_limit: U64(CANCEL_GAS_LIMIT),
            max_fee_per_gas,
            max_priority_fee_per_gas,
            tx_to: original.to.clone(),
            tx_value: U128(0),
            data: String::new(),
            signing_hash: signing_hash.clone(),
            path: original.path.clone(),
            mpc_contract_id: Some(mpc_contract_id.clone()),
            signature: None,
            raw_tx: None,
            tx_hash: None,
            attestation_hash: None,
            severity: Severity::None,
            violations: vec![],
            status: EvmTxStatus::Signing,
            error: None,
            memo: Some(format!("cancels evm tx {}", tx_id.0)),
            invoice_ref: None,
            kind: EvmTxKind::Cancel,
            replaces: Some(tx_id),
            replaced_by: None,
            epoch: original.epoch,
            created_at_ns: U64(env::block_timestamp()),
            confirmed_at_ns: None,
        };
        original.replaced_by = Some(cancel_id);
        let path = original.path.clone();
        let epoch = original.epoch;
        let agent_id = original.agent_id.clone();
        self.evm_txs.insert(tx_id.0, original);
        self.evm_txs.insert(cancel_id.0, record);
        self.request_evm_signature(mpc_contract_id, &path, &signing_hash, cancel_id, epoch);
        PhalanxEvent::EvmCancelRequested { tx_id, cancel_tx_id: cancel_id, requested_by: requested_by.clone() }.emit();
        self.record_security_event(
            "evm_cancel_requested",
            Some(&agent_id),
            Severity::Notice,
            vec![],
            format!("{requested_by} cancels evm tx {} with cancel {}", tx_id.0, cancel_id.0),
        );
        EvmTransferOutcome {
            tx_id: cancel_id,
            status: EvmTxStatus::Signing,
            signing_hash,
            severity: Severity::None,
            violations: vec![],
            quarantined: false,
        }
    }

    /// Owner-only: sets the next nonce of a chain's treasury address (for example after a
    /// transaction the contract did not sign used one). Refused while a transfer is outstanding.
    pub fn set_evm_nonce(&mut self, chain: String, next_nonce: U64) -> EvmNonceState {
        self.assert_owner();
        require!(is_valid_chain_id(&chain), "PHALANX_E_EVM: invalid chain");
        require!(self.evm_nonce(&chain).outstanding_tx.is_none(), "PHALANX_E_EVM_NONCE: a transfer is outstanding");
        let state = EvmNonceState { next_nonce, outstanding_tx: None };
        self.evm_nonces.insert(chain.clone(), state.clone());
        PhalanxEvent::PolicyUpdated { scope: format!("evm_nonce:{chain}") }.emit();
        state
    }

    /// Parity helper: the transaction the contract would sign for `request` (no policy checks).
    pub fn preview_evm_transfer(&self, request: EvmTransferRequest) -> EvmTxPreview {
        validate_evm_request(&request);
        let chain = self
            .policy
            .evm_chain(&request.chain)
            .cloned()
            .unwrap_or_else(|| env::panic_str("PHALANX_E_EVM_CHAIN_NOT_CONFIGURED"));
        let built = build_evm_tx(&chain, &request);
        EvmTxPreview {
            chain_id: U64(chain.chain_id),
            tx_to: built.tx_to,
            tx_value: U128(built.tx_value),
            data: to_hex(&built.data),
            unsigned_tx: format!("0x{}", to_hex(&typed_tx(&built.fields))),
            signing_hash: to_hex(&built.signing_hash),
        }
    }

    /// The facts document a NEAR AI audit of this EVM transfer must carry as its user message.
    pub fn get_evm_audit_facts(&self, agent_id: AccountId, request: EvmTransferRequest) -> AuditFacts {
        let agent = self.agent_or_panic(&agent_id);
        self.evm_pre_assessment(&agent, &request, env::epoch_height()).facts
    }

    /// The next nonce the treasury address signs on `chain`, and the transfer holding it.
    pub fn get_evm_nonce(&self, chain: String) -> EvmNonceState {
        self.evm_nonce(&chain)
    }

    pub fn get_evm_tx(&self, tx_id: U64) -> Option<EvmTxRecord> {
        self.evm_txs.get(&tx_id.0).cloned()
    }

    /// Newest first.
    pub fn list_evm_txs(&self, limit: Option<u32>) -> Vec<EvmTxRecord> {
        let limit = u64::from(limit.unwrap_or(20).min(crate::MAX_PAGE));
        let end = self.next_evm_tx_id;
        let start = end.saturating_sub(limit);
        (start..end).rev().filter_map(|id| self.evm_txs.get(&id).cloned()).collect()
    }

    /// Amount of `asset` sent on `chain` in the current epoch.
    pub fn get_evm_spend(&self, chain: String, asset: String) -> U128 {
        U128(self.evm_spent(&chain, &asset, env::epoch_height()))
    }
}

//! Audit facts: the document a NEAR AI audit of a settlement or an EVM transfer must judge.
//!
//! The pinned audit prompt stops an agent from writing its own instructions. Audit facts stop it
//! from writing its own evidence. The contract builds them from its own evaluation of the request:
//! the request fields, the recipient check, and the policy findings that depend only on the request
//! and the DAO's policy. A NEAR AI audit counts only if its user message is exactly this document,
//! so an approval over invented facts is rejected as a forgery (`facts_mismatch`).
//!
//! Checks that change from one block to the next (epoch spend, liquidity, velocity, deadlines,
//! quote expiry, nonces, the pause switch) are left out, so a request audited a few seconds before
//! it is submitted still matches. Agents read the document with the `get_*_audit_facts` views.

use near_sdk::serde::Serialize;
use near_sdk::{env, near, serde_json};

use crate::codec::to_hex;
use crate::policy::PolicyViolation;
use crate::ONE_NEAR;

/// Schema tag written into every facts document.
pub const AUDIT_FACTS_SCHEMA: &str = "phalanx.audit-facts.v1";

/// What an auditor must be shown, and its hash.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditFacts {
    /// `intent` or `evm`.
    pub subject: String,
    /// The exact user message a NEAR AI audit must carry: canonical JSON with sorted keys.
    pub facts: String,
    /// Hex sha256 of `facts`.
    pub facts_hash: String,
}

impl AuditFacts {
    fn new(subject: &str, facts: String) -> Self {
        let facts_hash = to_hex(&env::sha256_array(facts.as_bytes()));
        Self { subject: subject.to_string(), facts, facts_hash }
    }
}

/// Findings that depend only on the request and the DAO's policy, so they are the same when the
/// agent asks for the audit and when it submits the request.
pub fn is_stable_finding(v: &PolicyViolation) -> bool {
    match v {
        PolicyViolation::QuoteInvalid { reason } => reason != "quote_expired",
        PolicyViolation::AmountExceedsTxLimit { .. }
        | PolicyViolation::ChainNotAllowed { .. }
        | PolicyViolation::ContractNotAllowed { .. }
        | PolicyViolation::AssetNotAllowed { .. }
        | PolicyViolation::SlippageTooHigh { .. }
        | PolicyViolation::RecipientNotAllowed { .. }
        | PolicyViolation::RecipientBlocked { .. }
        | PolicyViolation::RecipientNeedsApproval { .. }
        | PolicyViolation::PriceBelowFloor { .. }
        | PolicyViolation::NoPriceFloor { .. }
        | PolicyViolation::EvmChainNotAllowed { .. }
        | PolicyViolation::EvmAssetNotAllowed { .. }
        | PolicyViolation::EvmAmountExceedsLimit { .. }
        | PolicyViolation::EvmFeeTooHigh { .. }
        | PolicyViolation::InvoiceRefMissing => true,
        _ => false,
    }
}

/// The stable findings among `violations`, as `code` or `code:reason`.
pub fn stable_findings(violations: &[PolicyViolation]) -> Vec<String> {
    violations
        .iter()
        .filter(|v| is_stable_finding(v))
        .map(|v| match v {
            PolicyViolation::QuoteInvalid { reason } => format!("quote_invalid:{reason}"),
            other => other.code().to_string(),
        })
        .collect()
}

/// yoctoNEAR as NEAR with three decimals, truncated (`2000000000000000000000000` -> `2.000`).
pub fn format_near_3(yocto: u128) -> String {
    let whole = yocto / ONE_NEAR;
    let milli = (yocto % ONE_NEAR) / (ONE_NEAR / 1_000);
    format!("{whole}.{milli:03}")
}

/// What the contract knows about a recipient, for the auditor.
pub struct RecipientStatus<'a> {
    pub allow_listed: bool,
    pub blocked_reason: Option<&'a str>,
}

impl RecipientStatus<'_> {
    /// `block` when blocked (even if allow-listed), `allow` when allow-listed, otherwise `warn`.
    fn verdict(&self) -> &'static str {
        if self.blocked_reason.is_some() {
            "block"
        } else if self.allow_listed {
            "allow"
        } else {
            "warn"
        }
    }
}

// Field order is alphabetical in every struct below, so the JSON equals a sorted-key stringify.

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct RecipientFacts<'a> {
    allow_listed: bool,
    blocked_reason: Option<&'a str>,
    verdict: &'static str,
}

impl<'a> From<&RecipientStatus<'a>> for RecipientFacts<'a> {
    fn from(r: &RecipientStatus<'a>) -> Self {
        Self { allow_listed: r.allow_listed, blocked_reason: r.blocked_reason, verdict: r.verdict() }
    }
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct IntentRequestFacts<'a> {
    amount: String,
    amount_near: String,
    chain: &'a str,
    destination_asset: &'a str,
    execution_contract: &'a str,
    invoice_ref: Option<&'a str>,
    kind: &'a str,
    memo: &'a str,
    min_amount_out: String,
    origin_asset: &'a str,
    quote_dry_run: Option<bool>,
    recipient: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct IntentFacts<'a> {
    agent: &'a str,
    dao_review_required: bool,
    findings: Vec<String>,
    recipient: RecipientFacts<'a>,
    request: IntentRequestFacts<'a>,
    schema: &'static str,
    subject: &'static str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct EvmRequestFacts<'a> {
    amount: String,
    asset: &'a str,
    asset_symbol: &'a str,
    chain: &'a str,
    chain_id: u64,
    fee_ceiling_wei: String,
    invoice_ref: Option<&'a str>,
    memo: &'a str,
    nonce: u64,
    to: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct EvmFacts<'a> {
    agent: &'a str,
    findings: Vec<String>,
    recipient: RecipientFacts<'a>,
    request: EvmRequestFacts<'a>,
    schema: &'static str,
    subject: &'static str,
}

/// The fields of a settlement request the auditor sees.
pub struct IntentFactsInput<'a> {
    pub agent: &'a str,
    pub kind: &'a str,
    pub chain: &'a str,
    pub recipient: &'a str,
    pub amount: u128,
    pub min_amount_out: u128,
    pub origin_asset: &'a str,
    pub destination_asset: &'a str,
    pub execution_contract: &'a str,
    pub memo: &'a str,
    pub quote_dry_run: Option<bool>,
    pub invoice_ref: Option<&'a str>,
}

pub fn intent_facts(input: &IntentFactsInput, recipient: &RecipientStatus, violations: &[PolicyViolation]) -> AuditFacts {
    let findings = stable_findings(violations);
    let dao_review_required = violations.iter().any(|v| matches!(v, PolicyViolation::RecipientNeedsApproval { .. }));
    let doc = IntentFacts {
        agent: input.agent,
        dao_review_required,
        findings,
        recipient: recipient.into(),
        request: IntentRequestFacts {
            amount: input.amount.to_string(),
            amount_near: format_near_3(input.amount),
            chain: input.chain,
            destination_asset: input.destination_asset,
            execution_contract: input.execution_contract,
            invoice_ref: input.invoice_ref,
            kind: input.kind,
            memo: input.memo,
            min_amount_out: input.min_amount_out.to_string(),
            origin_asset: input.origin_asset,
            quote_dry_run: input.quote_dry_run,
            recipient: input.recipient,
        },
        schema: AUDIT_FACTS_SCHEMA,
        subject: "intent",
    };
    AuditFacts::new("intent", serde_json::to_string(&doc).unwrap_or_else(|_| env::panic_str("PHALANX_E_SERIALIZE")))
}

/// The fields of an EVM transfer the auditor sees.
pub struct EvmFactsInput<'a> {
    pub agent: &'a str,
    pub chain: &'a str,
    pub chain_id: u64,
    pub to: &'a str,
    pub asset: &'a str,
    pub asset_symbol: &'a str,
    pub amount: u128,
    pub fee_ceiling_wei: u128,
    pub nonce: u64,
    pub memo: &'a str,
    pub invoice_ref: Option<&'a str>,
}

pub fn evm_facts(input: &EvmFactsInput, recipient: &RecipientStatus, violations: &[PolicyViolation]) -> AuditFacts {
    let doc = EvmFacts {
        agent: input.agent,
        findings: stable_findings(violations),
        recipient: recipient.into(),
        request: EvmRequestFacts {
            amount: input.amount.to_string(),
            asset: input.asset,
            asset_symbol: input.asset_symbol,
            chain: input.chain,
            chain_id: input.chain_id,
            fee_ceiling_wei: input.fee_ceiling_wei.to_string(),
            invoice_ref: input.invoice_ref,
            memo: input.memo,
            nonce: input.nonce,
            to: input.to.to_ascii_lowercase(),
        },
        schema: AUDIT_FACTS_SCHEMA,
        subject: "evm",
    };
    AuditFacts::new("evm", serde_json::to_string(&doc).unwrap_or_else(|_| env::panic_str("PHALANX_E_SERIALIZE")))
}

#[cfg(test)]
mod facts_tests {
    use super::*;

    #[test]
    fn near_amounts_are_truncated_to_three_decimals() {
        assert_eq!(format_near_3(2 * ONE_NEAR), "2.000");
        assert_eq!(format_near_3(ONE_NEAR / 5), "0.200");
        assert_eq!(format_near_3(ONE_NEAR * 3 / 2 + 999), "1.500");
        assert_eq!(format_near_3(0), "0.000");
    }

    #[test]
    fn volatile_checks_are_not_facts() {
        let stable = PolicyViolation::RecipientNotAllowed { chain: "arb".into(), recipient: "0xabc".into() };
        let volatile = PolicyViolation::VelocityExceeded { requests: 6, limit: 5, window_sec: 60 };
        let expired = PolicyViolation::QuoteInvalid { reason: "quote_expired".into() };
        let live = PolicyViolation::QuoteInvalid { reason: "live_quote_not_executable_by_treasury".into() };
        assert_eq!(
            stable_findings(&[stable, volatile, expired, live]),
            vec!["recipient_not_allowed".to_string(), "quote_invalid:live_quote_not_executable_by_treasury".to_string()]
        );
    }
}

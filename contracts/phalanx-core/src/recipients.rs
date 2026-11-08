//! Shared recipient blocklist and pre-flight checks (track: security).
//!
//! The allow-list says where money may go. The blocklist says where it must never go, even when
//! the recipient is also allow-listed (a vendor whose account was taken over). The DAO or an active
//! Sentinel reports a recipient with the hash of its evidence, and paying it is critical for every
//! agent from then on, so one incident protects the whole swarm.
//!
//! `check_recipient` answers allow, warn or block, with reasons, before an agent signs anything.
//! The SDK's pre-flight refuses to sign on block and escalates to a human (the DAO) on warn. The
//! contract enforces the same rule whether or not an agent ran the pre-flight.

use near_sdk::json_types::U64;
use near_sdk::{env, near, require, AccountId};

use crate::codec::{is_hash32_hex, is_safe_ascii, is_valid_chain_id, is_valid_recipient_entry, recipient_key};
use crate::events::PhalanxEvent;
use crate::policy::{Severity, UnknownRecipientRule};
use crate::subaccounts::{AgentRole, AgentStatus};
use crate::{PhalanxCore, PhalanxCoreExt, MAX_PAGE};

/// Upper bound for blocklist entries, so a Sentinel key cannot grow storage without limit.
pub const MAX_BLOCKED_RECIPIENTS: u32 = 128;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockedRecipient {
    /// `<chain>:<address>`, EVM addresses lower-case (the allow-list key format).
    pub recipient: String,
    pub reason: String,
    /// Hex sha256 of the evidence: the rejected request, an incident report, ...
    pub evidence_hash: String,
    pub reported_by: AccountId,
    pub at_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecipientVerdict {
    Allow,
    Warn,
    Block,
}

/// The answer an agent gets before it signs a payment.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecipientCheck {
    pub chain: String,
    pub recipient: String,
    pub verdict: RecipientVerdict,
    pub reasons: Vec<String>,
    pub allow_listed: bool,
    pub registered_agent: bool,
    pub blocked: Option<BlockedRecipient>,
    /// What paying an unknown recipient triggers right now.
    pub unknown_recipient: UnknownRecipientRule,
}

impl PhalanxCore {
    /// Blocklist reason for `chain:recipient`, if it is blocked.
    pub(crate) fn blocked_reason(&self, chain: &str, recipient: &str) -> Option<String> {
        self.blocked_recipients.get(&recipient_key(chain, recipient)).map(|b| b.reason.clone())
    }
}

#[near]
impl PhalanxCore {
    /// The owner (DAO) or an active Sentinel adds a recipient to the shared blocklist.
    pub fn block_recipient(
        &mut self,
        chain: String,
        recipient: String,
        reason: String,
        evidence_hash: String,
    ) -> BlockedRecipient {
        let reported_by = if self.is_owner_call() {
            self.owner_id.clone()
        } else {
            let agent = self.caller_agent("block_recipient");
            require!(agent.role == AgentRole::Sentinel, "PHALANX_E_UNAUTHORIZED");
            require!(agent.status == AgentStatus::Active, "PHALANX_E_AGENT_NOT_ACTIVE");
            agent.agent_id
        };
        require!(is_valid_chain_id(&chain), "PHALANX_E_BLOCKLIST: invalid chain");
        let key = recipient_key(&chain, &recipient);
        require!(is_valid_recipient_entry(&key), "PHALANX_E_BLOCKLIST: recipients are `<chain>:<address>`");
        require!(!reason.is_empty() && is_safe_ascii(&reason, 160), "PHALANX_E_INVALID_REASON");
        require!(is_hash32_hex(&evidence_hash), "PHALANX_E_INVALID_EVIDENCE_HASH");
        require!(
            self.blocked_recipients.contains_key(&key) || self.blocked_recipients.len() < MAX_BLOCKED_RECIPIENTS,
            "PHALANX_E_BLOCKLIST_FULL"
        );
        let entry = BlockedRecipient {
            recipient: key.clone(),
            reason: reason.clone(),
            evidence_hash: evidence_hash.to_lowercase(),
            reported_by: reported_by.clone(),
            at_ns: U64(env::block_timestamp()),
        };
        self.blocked_recipients.insert(key.clone(), entry.clone());
        PhalanxEvent::RecipientBlocked {
            recipient: key.clone(),
            reason: reason.clone(),
            evidence_hash: entry.evidence_hash.clone(),
            reported_by: reported_by.clone(),
        }
        .emit();
        self.record_security_event(
            "recipient_blocked",
            None,
            Severity::Notice,
            vec!["recipient_blocked".to_string()],
            format!("{key} blocked by {reported_by}: {reason}"),
        );
        entry
    }

    /// Owner-only: removes a blocklist entry (a false positive, a vendor that recovered its account).
    pub fn unblock_recipient(&mut self, chain: String, recipient: String) -> bool {
        self.assert_owner();
        let key = recipient_key(&chain, &recipient);
        let removed = self.blocked_recipients.remove(&key).is_some();
        if removed {
            PhalanxEvent::RecipientUnblocked { recipient: key.clone(), by: self.owner_id.clone() }.emit();
            self.record_security_event("recipient_unblocked", None, Severity::None, vec![], format!("{key} unblocked by owner"));
        }
        removed
    }

    pub fn list_blocked_recipients(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<BlockedRecipient> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize;
        self.blocked_recipients.values().skip(from).take(limit).cloned().collect()
    }

    /// Pre-flight for agents and UIs: allow, warn (unknown recipient) or block, with reasons.
    pub fn check_recipient(&self, chain: String, recipient: String) -> RecipientCheck {
        let blocked = self.blocked_recipients.get(&recipient_key(&chain, &recipient)).cloned();
        let allow_listed = self.policy.allows_recipient(&chain, &recipient);
        let registered_agent = chain == "near"
            && recipient
                .parse::<AccountId>()
                .ok()
                .and_then(|id| self.agents.get(&id).map(|a| a.status == AgentStatus::Active))
                .unwrap_or(false);
        let rule = self.policy.unknown_recipient;
        let mut reasons = Vec::new();
        let verdict = if let Some(b) = &blocked {
            reasons.push(format!(
                "on the shared blocklist: {} (reported by {}, evidence {})",
                b.reason, b.reported_by, b.evidence_hash
            ));
            if allow_listed {
                reasons.push("also on the DAO allow-list: the blocklist wins".to_string());
            }
            RecipientVerdict::Block
        } else if allow_listed {
            reasons.push("on the DAO allow-list".to_string());
            RecipientVerdict::Allow
        } else if registered_agent {
            reasons.push("registered agent: allowed for agent-to-agent payments (pay_from_balance) only".to_string());
            RecipientVerdict::Allow
        } else {
            reasons.push("not on the DAO allow-list".to_string());
            reasons.push(
                match rule {
                    UnknownRecipientRule::Quarantine => "paying it quarantines the agent: ask the DAO to allow-list it first",
                    UnknownRecipientRule::Hold => "a settlement to it waits for DAO approval; other payments are rejected",
                }
                .to_string(),
            );
            RecipientVerdict::Warn
        };
        RecipientCheck { chain, recipient, verdict, reasons, allow_listed, registered_agent, blocked, unknown_recipient: rule }
    }
}

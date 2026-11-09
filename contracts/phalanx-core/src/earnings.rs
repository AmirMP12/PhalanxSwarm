//! Agent earnings (tracks: agents, swarms).
//!
//! Escrow payouts are credited to an on-chain balance per agent instead of being sent to the
//! agent's sub-account (whose only key is the scoped FunctionCall key, so it could never spend
//! them). Agents spend their balance with the same key:
//!
//! * `pay_from_balance`: pay another registered agent (an internal transfer, e.g. a worker
//!   subcontracting route data) or an allow-listed NEAR vendor (a real NEAR transfer). The
//!   recipient rule (allow-list, shared blocklist, `unknown_recipient`) and the per-transaction
//!   limit apply exactly as they do to a treasury settlement.
//! * `withdraw_earnings`: send earnings to the owner-set `payout_account` (the operator, or the
//!   agent's own sub-account to top up its gas).

use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise};

use crate::codec::is_safe_ascii;
use crate::events::PhalanxEvent;
use crate::policy::{recipient_violation, PolicyViolation, Severity};
use crate::subaccounts::AgentStatus;
use crate::{PhalanxCore, PhalanxCoreExt};

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentOutcome {
    pub paid: bool,
    /// `true` when the recipient is a registered agent (balance credit, no transfer).
    pub internal: bool,
    pub amount: U128,
    pub recipient: AccountId,
    pub severity: Severity,
    pub violations: Vec<PolicyViolation>,
    pub quarantined: bool,
}

#[near]
impl PhalanxCore {
    /// An agent pays another agent or an allow-listed NEAR vendor from its own earnings.
    pub fn pay_from_balance(&mut self, recipient: AccountId, amount: U128, memo: Option<String>) -> PaymentOutcome {
        let agent = self.caller_agent("pay_from_balance");
        require!(agent.status == AgentStatus::Active, "PHALANX_E_AGENT_NOT_ACTIVE");
        require!(amount.0 > 0, "PHALANX_E_ZERO_AMOUNT");
        require!(recipient != agent.agent_id, "PHALANX_E_SELF_PAYMENT");
        require!(memo.as_deref().map(|m| is_safe_ascii(m, 128)).unwrap_or(true), "PHALANX_E_INVALID_MEMO");

        let recipient_agent = self.agents.get(&recipient).map(|a| a.status == AgentStatus::Active).unwrap_or(false);
        let mut violations = Vec::new();
        if self.paused {
            violations.push(PolicyViolation::ProtocolPaused);
        }
        let max_tx = self.policy.max_tx_amount_yocto.0.min(agent.policy.max_tx_amount_yocto.0);
        if amount.0 > max_tx {
            violations.push(PolicyViolation::AmountExceedsTxLimit { amount, limit: U128(max_tx) });
        }
        let blocked = self.blocked_reason("near", recipient.as_str());
        if let Some(v) = recipient_violation(&self.policy, "near", recipient.as_str(), recipient_agent, blocked.as_deref()) {
            violations.push(v);
        }
        if amount.0 > agent.balance.0 {
            violations.push(PolicyViolation::InsufficientAgentBalance { balance: agent.balance, amount });
        }
        if !violations.is_empty() {
            let (severity, quarantined) = self.apply_circuit_breaker(&agent.agent_id, "pay_from_balance", &violations);
            return PaymentOutcome {
                paid: false,
                internal: recipient_agent,
                amount,
                recipient,
                severity,
                violations,
                quarantined,
            };
        }

        let mut payer = agent.clone();
        payer.balance = U128(payer.balance.0 - amount.0);
        self.agents.insert(payer.agent_id.clone(), payer);
        if recipient_agent {
            self.credit_agent(&recipient, amount.0, &format!("payment from {}", agent.agent_id));
        } else {
            self.treasury.agent_balances -= amount.0;
            Promise::new(recipient.clone())
                .transfer(NearToken::from_yoctonear(amount.0))
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(Gas::from_tgas(self.config.callback_gas_tgas))
                        .on_agent_transfer(agent.agent_id.clone(), recipient.clone(), amount),
                )
                .detach();
        }
        PhalanxEvent::AgentPaid { from: agent.agent_id.clone(), to: recipient.clone(), amount, internal: recipient_agent, memo }
            .emit();
        PaymentOutcome {
            paid: true,
            internal: recipient_agent,
            amount,
            recipient,
            severity: Severity::None,
            violations: vec![],
            quarantined: false,
        }
    }

    /// Sends earnings to the agent's owner-set payout account.
    pub fn withdraw_earnings(&mut self, amount: U128) -> U128 {
        let agent = self.caller_agent("withdraw_earnings");
        require!(agent.status == AgentStatus::Active, "PHALANX_E_AGENT_NOT_ACTIVE");
        require!(!self.paused, "PHALANX_E_PAUSED");
        require!(amount.0 > 0 && amount.0 <= agent.balance.0, "PHALANX_E_INSUFFICIENT_AGENT_BALANCE");
        let mut a = agent.clone();
        a.balance = U128(a.balance.0 - amount.0);
        self.agents.insert(a.agent_id.clone(), a);
        self.treasury.agent_balances -= amount.0;
        Promise::new(agent.payout_account.clone())
            .transfer(NearToken::from_yoctonear(amount.0))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(self.config.callback_gas_tgas))
                    .on_agent_transfer(agent.agent_id.clone(), agent.payout_account.clone(), amount),
            )
            .detach();
        PhalanxEvent::EarningsWithdrawn { agent_id: agent.agent_id, payout_account: agent.payout_account, amount }.emit();
        amount
    }

    /// Callback of an earnings transfer; a bounced transfer is credited back to the agent.
    #[private]
    pub fn on_agent_transfer(&mut self, agent_id: AccountId, to: AccountId, amount: U128) -> bool {
        require!(env::promise_results_count() == 1, "PHALANX_E_CALLBACK_ONLY");
        let ok = env::promise_result_checked(0, 64).is_ok();
        if !ok {
            if let Some(mut agent) = self.agents.get(&agent_id).cloned() {
                agent.balance = U128(agent.balance.0 + amount.0);
                self.agents.insert(agent_id.clone(), agent);
                self.treasury.agent_balances += amount.0;
            }
            PhalanxEvent::PaymentFailed { agent_id, to, amount }.emit();
        }
        ok
    }
}

// Standard accounting export schemas for enterprise integration (tracks: business, realworld).
//
// The accounting reconciliation is computed off-chain and via MCP from the
// contract's event log and treasury ledger. Each on-chain event (revenue, escrow lock/release,
// agent payout, vendor payment, distribution, refund) produces balanced double-entry journal
// legs. The MCP tool `phalanx_export_accounting` and Next.js route `/api/accounting/export`
// format these into reconciled General Ledger entries, trial balances, CSV, and QuickBooks IIF.

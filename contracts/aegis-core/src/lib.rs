//! # PhalanxSwarm Protocol: `aegis-core`
//!
//! An autonomous business treasury operated by a swarm of AI agents, where humans only set
//! the constraints:
//!
//! * `lib.rs`: treasury ledger, revenue intake, programmable revenue splits (SputnikDAO /
//!   Trezu compatible stakeholder accounts), governance and dashboard views.
//! * `policy.rs`: AI security policy engine and anomaly circuit breaker.
//! * `recipients.rs`: shared recipient blocklist and the allow / warn / block pre-flight.
//! * `subaccounts.rs`: agent sub-accounts and scoped FunctionCall keys.
//! * `swarm_market.rs`: task RFPs, sealed / reverse-Dutch bidding, escrow and settlement.
//! * `attestation.rs`: TEE proofs verified on-chain: NEAR AI signed completions and enclave receipts.
//! * `facts.rs`: the audit facts the contract builds itself; a NEAR AI audit must judge exactly these.
//! * `intents.rs`: NEP-413 signed settlement requests, NEAR vendor payments, Chain Signatures
//!   authorizations of cross-chain rehearsals.
//! * `evm.rs`: EIP-1559 transfers the contract builds and signs through Chain Signatures.
//! * `earnings.rs`: agents' spendable earnings, agent-to-agent payments and withdrawals.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::store::{IterableMap, LookupMap, LookupSet, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise};

pub mod attestation;
pub mod codec;
pub mod earnings;
pub mod events;
pub mod evm;
pub mod facts;
pub mod intents;
pub mod policy;
pub mod recipients;
pub mod subaccounts;
pub mod swarm_market;

#[cfg(test)]
mod tests;

use attestation::{AttestationRecord, EnclaveRecord};
use codec::is_safe_ascii;
use events::{AegisEvent, PayoutLeg};
use evm::{EvmNonceState, EvmSpend, EvmTxRecord};
use intents::IntentRecord;
use policy::{GlobalPolicy, SecurityEvent, Severity};
use recipients::BlockedRecipient;
use subaccounts::AgentRecord;
use swarm_market::{Escrow, TaskRfp, TaskView};

pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// Protocol storage price: 10^19 yoctoNEAR per byte.
pub const STORAGE_BYTE_COST: u128 = 10_000_000_000_000_000_000;
pub const SECURITY_EVENT_CAPACITY: u32 = 128;
pub const MAX_PAGE: u32 = 50;
pub const CONTRACT_VERSION: &str = "2.3.0";
pub const MAX_REVENUE_SPLITS: usize = 8;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
pub(crate) enum StorageKey {
    Agents,
    AgentByKey,
    Tasks,
    Bids,
    Escrows,
    Enclaves,
    Attestations,
    AttestationLog,
    Intents,
    UsedNonces,
    SecurityEvents,
    Distributions,
    EvmTxs,
    EvmSpend,
    BlockedRecipients,
    EvmNonces,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolConfig {
    /// Chain Signatures MPC contract (`v1.signer-prod.testnet` / `v1.signer`). `None` disables MPC.
    pub mpc_contract_id: Option<AccountId>,
    /// MPC domain: 0 = secp256k1 (ECDSA).
    pub mpc_domain_id: u64,
    pub mpc_sign_gas_tgas: u64,
    pub callback_gas_tgas: u64,
    /// NEAR Intents verifier contract settlements route through.
    pub intents_contract_id: AccountId,
    /// Liquidity that agents and distributions can never touch.
    pub min_operating_reserve: U128,
    pub min_distribution: U128,
    pub max_receipt_age_sec: u64,
    pub max_intent_horizon_sec: u64,
    pub subaccount_min_deposit: U128,
}

impl ProtocolConfig {
    pub fn default_config() -> Self {
        Self {
            mpc_contract_id: None,
            mpc_domain_id: 0,
            mpc_sign_gas_tgas: 50,
            callback_gas_tgas: 20,
            intents_contract_id: "intents.near".parse().unwrap_or_else(|_| env::panic_str("AEGIS_E_CONFIG")),
            min_operating_reserve: U128(2 * ONE_NEAR),
            min_distribution: U128(ONE_NEAR / 10),
            max_receipt_age_sec: 3_600,
            max_intent_horizon_sec: 3_600,
            subaccount_min_deposit: U128(ONE_NEAR / 10),
        }
    }

    pub fn validate(&self) {
        require!((5..=250).contains(&self.mpc_sign_gas_tgas), "AEGIS_E_CONFIG: mpc_sign_gas_tgas must be 5..=250");
        require!((5..=100).contains(&self.callback_gas_tgas), "AEGIS_E_CONFIG: callback_gas_tgas must be 5..=100");
        require!((60..=86_400).contains(&self.max_receipt_age_sec), "AEGIS_E_CONFIG: max_receipt_age_sec");
        require!((60..=86_400).contains(&self.max_intent_horizon_sec), "AEGIS_E_CONFIG: max_intent_horizon_sec");
        require!(
            self.subaccount_min_deposit.0 >= 2_000_000_000_000_000_000_000,
            "AEGIS_E_CONFIG: subaccount_min_deposit must cover account storage (>= 0.002 NEAR)"
        );
    }
}

/// Internal ledger, yoctoNEAR. Exposed through `TreasuryReport`.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Treasury {
    pub liquid: u128,
    pub reserved_for_tasks: u128,
    pub escrow_locked: u128,
    pub reserved_for_intents: u128,
    pub total_capital_in: u128,
    pub total_revenue: u128,
    pub total_operating_costs: u128,
    pub total_deployed_capital: u128,
    pub total_distributed: u128,
    pub total_retained: u128,
    pub epoch: u64,
    pub epoch_spent: u128,
    /// Earnings held for agents (a liability, not treasury liquidity).
    pub agent_balances: u128,
    /// Gas allowances of active contract-account agent keys: gas they may still burn.
    pub contract_key_allowances: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreasuryReport {
    pub liquid: U128,
    /// Liquid minus the operating reserve: what agents may still spend.
    pub available: U128,
    pub reserved_for_tasks: U128,
    pub escrow_locked: U128,
    pub reserved_for_intents: U128,
    pub total_capital_in: U128,
    pub total_revenue: U128,
    pub total_operating_costs: U128,
    pub total_deployed_capital: U128,
    pub total_distributed: U128,
    pub total_retained: U128,
    /// Revenue minus operating costs (agent payouts and vendor payments).
    pub net_profit: U128,
    pub distributable_profit: U128,
    pub epoch: U64,
    pub epoch_spent: U128,
    pub agent_balances: U128,
    pub contract_key_allowances: U128,
    pub account_balance: U128,
    pub storage_usage: U64,
    /// Account balance minus storage staking and every obligation: what really backs `liquid`.
    pub solvent_liquidity: U128,
    /// Part of `liquid` the account balance does not cover (gas burned, failed refunds). 0 when solvent.
    pub unbacked_liquidity: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StakeholderKind {
    /// A SputnikDAO / Trezu multisig treasury.
    DaoTreasury,
    Operator,
    Investor,
    /// Retained inside the AegisCore treasury.
    Reserve,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevenueSplit {
    pub account_id: AccountId,
    pub bps: u32,
    pub label: String,
    pub kind: StakeholderKind,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DistributionRecord {
    pub distribution_id: U64,
    pub total: U128,
    pub retained: U128,
    pub payouts: Vec<PayoutLeg>,
    pub failed: U128,
    pub triggered_by: AccountId,
    pub at_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContractInfo {
    pub name: String,
    pub version: String,
    pub event_standard: String,
    pub event_version: String,
    pub nep413_recipient: AccountId,
}

/// Everything the command-center UI renders, in one view call.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dashboard {
    pub info: ContractInfo,
    pub owner_id: AccountId,
    pub paused: bool,
    pub config: ProtocolConfig,
    pub policy: GlobalPolicy,
    pub treasury: TreasuryReport,
    pub agents: Vec<AgentRecord>,
    pub tasks: Vec<TaskView>,
    pub intents: Vec<IntentRecord>,
    pub security_events: Vec<SecurityEvent>,
    pub revenue_splits: Vec<RevenueSplit>,
    pub distributions: Vec<DistributionRecord>,
    pub enclaves: Vec<EnclaveRecord>,
    pub attestations: Vec<AttestationRecord>,
    pub evm_txs: Vec<EvmTxRecord>,
    pub blocked_recipients: Vec<BlockedRecipient>,
    pub policy_version: U64,
    pub block_height: U64,
    pub block_timestamp_ns: U64,
    pub epoch_height: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct AegisCore {
    pub(crate) owner_id: AccountId,
    pub(crate) config: ProtocolConfig,
    pub(crate) policy: GlobalPolicy,
    pub(crate) treasury: Treasury,
    pub(crate) paused: bool,
    pub(crate) agents: IterableMap<AccountId, AgentRecord>,
    pub(crate) agent_by_key: LookupMap<String, AccountId>,
    pub(crate) tasks: LookupMap<u64, TaskRfp>,
    pub(crate) bids: LookupMap<u64, Vec<swarm_market::AgentBid>>,
    pub(crate) escrows: LookupMap<u64, Escrow>,
    pub(crate) enclaves: IterableMap<String, EnclaveRecord>,
    pub(crate) attestations: LookupMap<String, AttestationRecord>,
    pub(crate) attestation_log: Vector<String>,
    pub(crate) intents: LookupMap<u64, IntentRecord>,
    pub(crate) used_nonces: LookupSet<String>,
    pub(crate) security_events: Vector<SecurityEvent>,
    pub(crate) revenue_splits: Vec<RevenueSplit>,
    pub(crate) distributions: Vector<DistributionRecord>,
    pub(crate) evm_txs: LookupMap<u64, EvmTxRecord>,
    pub(crate) evm_spend: LookupMap<String, EvmSpend>,
    pub(crate) next_task_id: u64,
    pub(crate) next_intent_id: u64,
    pub(crate) next_event_seq: u64,
    pub(crate) next_evm_tx_id: u64,
    pub(crate) blocked_recipients: IterableMap<String, BlockedRecipient>,
    /// Bumped by every change to the global policy (stale DAO proposals are rejected).
    pub(crate) policy_version: u64,
    /// Per EVM chain: the next nonce the treasury address will sign and the transfer holding it.
    pub(crate) evm_nonces: LookupMap<String, EvmNonceState>,
}

fn validate_splits(splits: &[RevenueSplit]) {
    require!(!splits.is_empty() && splits.len() <= MAX_REVENUE_SPLITS, "AEGIS_E_SPLITS: 1..=8 entries");
    let total: u32 = splits.iter().map(|s| s.bps).sum();
    require!(total == 10_000, "AEGIS_E_SPLITS: bps must sum to 10000");
    require!(splits.iter().all(|s| s.bps > 0), "AEGIS_E_SPLITS: bps must be > 0");
    require!(splits.iter().all(|s| is_safe_ascii(&s.label, 32) && !s.label.is_empty()), "AEGIS_E_SPLITS: label");
    require!(splits.iter().filter(|s| s.kind == StakeholderKind::Reserve).count() <= 1, "AEGIS_E_SPLITS: at most one reserve");
}

impl AegisCore {
    /// True when the predecessor is the owner and the call is not signed by an agent key
    /// (relevant when the contract owns itself and agents hold contract-account keys).
    pub(crate) fn is_owner_call(&self) -> bool {
        let predecessor = env::predecessor_account_id();
        if predecessor != self.owner_id {
            return false;
        }
        if predecessor == env::current_account_id() {
            let pk = String::from(&env::signer_account_pk());
            return !self.agent_by_key.contains_key(&pk);
        }
        true
    }

    pub(crate) fn assert_owner(&self) {
        require!(self.is_owner_call(), "AEGIS_E_OWNER_ONLY");
    }

    /// Account balance minus storage staking and every obligation. Gas burned by
    /// contract-account agent keys comes out of this number, never out of an obligation.
    pub(crate) fn solvent_liquidity(&self) -> u128 {
        let t = &self.treasury;
        let storage = u128::from(env::storage_usage()).saturating_mul(STORAGE_BYTE_COST);
        let obligations =
            t.reserved_for_tasks + t.escrow_locked + t.reserved_for_intents + t.agent_balances + t.contract_key_allowances;
        env::account_balance().as_yoctonear().saturating_sub(storage).saturating_sub(obligations)
    }

    /// What agents may still spend: ledger liquidity, capped by what the balance really backs,
    /// minus the operating reserve.
    pub(crate) fn available_liquidity(&self) -> u128 {
        self.treasury.liquid.min(self.solvent_liquidity()).saturating_sub(self.config.min_operating_reserve.0)
    }

    pub(crate) fn charge_epoch_spend(&mut self, agent: &mut AgentRecord, amount: u128, epoch: u64) {
        if agent.spend.epoch.0 != epoch {
            agent.spend.epoch = U64(epoch);
            agent.spend.spent_in_epoch = U128(0);
        }
        agent.spend.spent_in_epoch = U128(agent.spend.spent_in_epoch.0 + amount);
        if self.treasury.epoch != epoch {
            self.treasury.epoch = epoch;
            self.treasury.epoch_spent = 0;
        }
        self.treasury.epoch_spent += amount;
    }

    fn distributable_profit(&self) -> u128 {
        let t = &self.treasury;
        t.total_revenue
            .saturating_sub(t.total_operating_costs)
            .saturating_sub(t.total_distributed)
            .saturating_sub(t.total_retained)
            .min(self.available_liquidity())
    }

    fn treasury_report(&self) -> TreasuryReport {
        let t = &self.treasury;
        TreasuryReport {
            liquid: U128(t.liquid),
            available: U128(self.available_liquidity()),
            reserved_for_tasks: U128(t.reserved_for_tasks),
            escrow_locked: U128(t.escrow_locked),
            reserved_for_intents: U128(t.reserved_for_intents),
            total_capital_in: U128(t.total_capital_in),
            total_revenue: U128(t.total_revenue),
            total_operating_costs: U128(t.total_operating_costs),
            total_deployed_capital: U128(t.total_deployed_capital),
            total_distributed: U128(t.total_distributed),
            total_retained: U128(t.total_retained),
            net_profit: U128(t.total_revenue.saturating_sub(t.total_operating_costs)),
            distributable_profit: U128(self.distributable_profit()),
            epoch: U64(t.epoch),
            epoch_spent: U128(t.epoch_spent),
            agent_balances: U128(t.agent_balances),
            contract_key_allowances: U128(t.contract_key_allowances),
            account_balance: U128(env::account_balance().as_yoctonear()),
            storage_usage: U64(env::storage_usage()),
            solvent_liquidity: U128(self.solvent_liquidity()),
            unbacked_liquidity: U128(t.liquid.saturating_sub(self.solvent_liquidity())),
        }
    }

    fn info(&self) -> ContractInfo {
        ContractInfo {
            name: "aegis-core".to_string(),
            version: CONTRACT_VERSION.to_string(),
            event_standard: "aegis".to_string(),
            event_version: "1.0.0".to_string(),
            nep413_recipient: env::current_account_id(),
        }
    }
}

#[near]
impl AegisCore {
    /// Initializes the treasury. `#[private]`: only the contract account can initialize itself,
    /// so deploy + init happen in one batch transaction and cannot be front-run.
    #[init]
    #[private]
    pub fn new(
        owner_id: AccountId,
        config: Option<ProtocolConfig>,
        policy: Option<GlobalPolicy>,
        revenue_splits: Option<Vec<RevenueSplit>>,
    ) -> Self {
        let config = config.unwrap_or_else(ProtocolConfig::default_config);
        config.validate();
        let policy =
            policy.unwrap_or_else(|| GlobalPolicy::default_with(&config.intents_contract_id, config.mpc_contract_id.as_ref()));
        policy.validate();
        let revenue_splits = revenue_splits.unwrap_or_else(|| {
            vec![
                RevenueSplit {
                    account_id: owner_id.clone(),
                    bps: 7_000,
                    label: "dao_treasury".to_string(),
                    kind: StakeholderKind::DaoTreasury,
                },
                RevenueSplit {
                    account_id: env::current_account_id(),
                    bps: 3_000,
                    label: "reserve".to_string(),
                    kind: StakeholderKind::Reserve,
                },
            ]
        });
        validate_splits(&revenue_splits);
        Self {
            owner_id,
            config,
            policy,
            treasury: Treasury { epoch: env::epoch_height(), ..Default::default() },
            paused: false,
            agents: IterableMap::new(StorageKey::Agents),
            agent_by_key: LookupMap::new(StorageKey::AgentByKey),
            tasks: LookupMap::new(StorageKey::Tasks),
            bids: LookupMap::new(StorageKey::Bids),
            escrows: LookupMap::new(StorageKey::Escrows),
            enclaves: IterableMap::new(StorageKey::Enclaves),
            attestations: LookupMap::new(StorageKey::Attestations),
            attestation_log: Vector::new(StorageKey::AttestationLog),
            intents: LookupMap::new(StorageKey::Intents),
            used_nonces: LookupSet::new(StorageKey::UsedNonces),
            security_events: Vector::new(StorageKey::SecurityEvents),
            revenue_splits,
            distributions: Vector::new(StorageKey::Distributions),
            evm_txs: LookupMap::new(StorageKey::EvmTxs),
            evm_spend: LookupMap::new(StorageKey::EvmSpend),
            next_task_id: 0,
            next_intent_id: 0,
            next_event_seq: 0,
            next_evm_tx_id: 0,
            blocked_recipients: IterableMap::new(StorageKey::BlockedRecipients),
            policy_version: 0,
            evm_nonces: LookupMap::new(StorageKey::EvmNonces),
        }
    }

    /// Capital injection (investors, DAO). Not counted as revenue.
    #[payable]
    pub fn fund_treasury(&mut self, memo: Option<String>) -> TreasuryReport {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "AEGIS_E_ZERO_DEPOSIT");
        require!(memo.as_deref().map(|m| is_safe_ascii(m, 128)).unwrap_or(true), "AEGIS_E_INVALID_MEMO");
        self.treasury.liquid += amount;
        self.treasury.total_capital_in += amount;
        AegisEvent::TreasuryFunded {
            from: env::predecessor_account_id(),
            amount: U128(amount),
            kind: "capital".to_string(),
            memo,
        }
        .emit();
        self.treasury_report()
    }

    /// A customer pays the autonomous business for its services.
    #[payable]
    pub fn deposit_revenue(&mut self, customer_ref: String, memo: Option<String>) -> TreasuryReport {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "AEGIS_E_ZERO_DEPOSIT");
        require!(!customer_ref.is_empty() && is_safe_ascii(&customer_ref, 64), "AEGIS_E_INVALID_CUSTOMER_REF");
        require!(memo.as_deref().map(|m| is_safe_ascii(m, 128)).unwrap_or(true), "AEGIS_E_INVALID_MEMO");
        self.treasury.liquid += amount;
        self.treasury.total_revenue += amount;
        AegisEvent::TreasuryFunded {
            from: env::predecessor_account_id(),
            amount: U128(amount),
            kind: "revenue".to_string(),
            memo: Some(match memo {
                Some(m) => format!("{customer_ref}: {m}"),
                None => customer_ref,
            }),
        }
        .emit();
        self.treasury_report()
    }

    /// Owner / DAO sets how profit is split. Basis points must sum to 10000.
    pub fn set_revenue_splits(&mut self, splits: Vec<RevenueSplit>) {
        self.assert_owner();
        validate_splits(&splits);
        self.revenue_splits = splits;
        AegisEvent::PolicyUpdated { scope: "revenue_splits".to_string() }.emit();
    }

    /// Permissionless keeper call: distributes undistributed profit according to the splits.
    /// Amounts are fully determined on-chain, so anyone may trigger it.
    pub fn distribute_revenue(&mut self) -> DistributionRecord {
        require!(!self.paused, "AEGIS_E_PAUSED");
        let profit = self.distributable_profit();
        require!(profit > 0 && profit >= self.config.min_distribution.0, "AEGIS_E_BELOW_MIN_DISTRIBUTION");

        let splits = self.revenue_splits.clone();
        let mut legs: Vec<PayoutLeg> = Vec::new();
        let mut retained = 0u128;
        let mut allocated = 0u128;
        for (i, split) in splits.iter().enumerate() {
            let share = if i + 1 == splits.len() { profit - allocated } else { profit * u128::from(split.bps) / 10_000 };
            allocated += share;
            if share == 0 {
                continue;
            }
            if split.kind == StakeholderKind::Reserve {
                retained += share;
            } else {
                legs.push(PayoutLeg { account_id: split.account_id.clone(), amount: U128(share), label: split.label.clone() });
            }
        }
        let paid = profit - retained;
        self.treasury.liquid -= paid;
        self.treasury.total_distributed += paid;
        self.treasury.total_retained += retained;

        let distribution_id = U64(u64::from(self.distributions.len()));
        let mut joint: Option<Promise> = None;
        for leg in &legs {
            let p = Promise::new(leg.account_id.clone()).transfer(NearToken::from_yoctonear(leg.amount.0));
            joint = Some(match joint {
                None => p,
                Some(j) => j.and(p),
            });
        }
        if let Some(j) = joint {
            j.then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(self.config.callback_gas_tgas))
                    .on_distribution_settled(distribution_id, legs.clone()),
            )
            .detach();
        }

        let record = DistributionRecord {
            distribution_id,
            total: U128(profit),
            retained: U128(retained),
            payouts: legs.clone(),
            failed: U128(0),
            triggered_by: env::predecessor_account_id(),
            at_ns: U64(env::block_timestamp()),
        };
        self.distributions.push(record.clone());
        AegisEvent::RevenueDistributed { distribution_id, total: U128(profit), retained: U128(retained), payouts: legs }.emit();
        record
    }

    /// Callback of the distribution transfers; failed legs are credited back to the treasury.
    #[private]
    pub fn on_distribution_settled(&mut self, distribution_id: U64, legs: Vec<PayoutLeg>) -> U128 {
        let count = env::promise_results_count();
        require!(count >= 1 && count as usize == legs.len(), "AEGIS_E_CALLBACK_ONLY");
        let mut failed = 0u128;
        for (i, leg) in legs.iter().enumerate() {
            if env::promise_result_checked(i as u64, 64).is_err() {
                failed += leg.amount.0;
            }
        }
        if failed > 0 {
            self.treasury.liquid += failed;
            self.treasury.total_distributed = self.treasury.total_distributed.saturating_sub(failed);
            let index = distribution_id.0 as u32;
            if let Some(record) = self.distributions.get_mut(index) {
                record.failed = U128(failed);
            }
            self.record_security_event(
                "distribution_leg_failed",
                None,
                Severity::Notice,
                vec![],
                format!("distribution {} returned {} yocto", distribution_id.0, failed),
            );
        }
        U128(failed)
    }

    pub fn update_config(&mut self, config: ProtocolConfig) {
        self.assert_owner();
        config.validate();
        self.config = config;
        AegisEvent::PolicyUpdated { scope: "config".to_string() }.emit();
    }

    /// Hands governance to a new owner (for example a SputnikDAO / Trezu multisig).
    pub fn transfer_ownership(&mut self, new_owner_id: AccountId) {
        self.assert_owner();
        let detail = format!("owner {} -> {}", self.owner_id, new_owner_id);
        self.owner_id = new_owner_id;
        AegisEvent::PolicyUpdated { scope: "owner".to_string() }.emit();
        self.record_security_event("ownership_transferred", None, Severity::Notice, vec![], detail);
    }

    /// Upgrades the contract bytecode. Owner-only (SputnikDAO / Trezu multisig).
    ///
    /// Deploys new WASM bytecode to the contract account via a Promise batch and
    /// optionally calls `migrate()` with provided arguments in the same transaction.
    pub fn upgrade_contract(&mut self, code: Base64VecU8, migrate_args: Option<Base64VecU8>) -> Promise {
        self.assert_owner();
        require!(!code.0.is_empty(), "AEGIS_E_UPGRADE: code must not be empty");
        let current = env::current_account_id();
        let promise = Promise::new(current).deploy_contract(code.0);
        AegisEvent::PolicyUpdated { scope: "contract_upgraded".to_string() }.emit();
        self.record_security_event(
            "contract_upgraded",
            None,
            Severity::Notice,
            vec![],
            format!("contract bytecode upgraded by owner {}", self.owner_id),
        );
        if let Some(args) = migrate_args {
            promise.function_call("migrate".to_string(), args.0, NearToken::from_yoctonear(0), Gas::from_tgas(30))
        } else {
            promise
        }
    }

    // Views

    pub fn contract_info(&self) -> ContractInfo {
        self.info()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn get_config(&self) -> ProtocolConfig {
        self.config.clone()
    }

    pub fn get_treasury(&self) -> TreasuryReport {
        self.treasury_report()
    }

    pub fn get_revenue_splits(&self) -> Vec<RevenueSplit> {
        self.revenue_splits.clone()
    }

    /// Newest first.
    pub fn list_distributions(&self, limit: Option<u32>) -> Vec<DistributionRecord> {
        let limit = limit.unwrap_or(10).min(MAX_PAGE) as usize;
        let len = self.distributions.len();
        (0..len).rev().take(limit).filter_map(|i| self.distributions.get(i).cloned()).collect()
    }

    pub fn get_dashboard(&self) -> Dashboard {
        Dashboard {
            info: self.info(),
            owner_id: self.owner_id.clone(),
            paused: self.paused,
            config: self.config.clone(),
            policy: self.policy.clone(),
            treasury: self.treasury_report(),
            agents: self.list_agents(),
            tasks: self.list_tasks(Some(20)),
            intents: self.list_intents(Some(20)),
            security_events: self.get_security_events(Some(40)),
            revenue_splits: self.revenue_splits.clone(),
            distributions: self.list_distributions(Some(10)),
            enclaves: self.list_enclaves(),
            attestations: self.list_attestations(Some(20)),
            evm_txs: self.list_evm_txs(Some(20)),
            blocked_recipients: self.list_blocked_recipients(None, Some(MAX_PAGE)),
            policy_version: U64(self.policy_version),
            block_height: U64(env::block_height()),
            block_timestamp_ns: U64(env::block_timestamp()),
            epoch_height: U64(env::epoch_height()),
        }
    }
}

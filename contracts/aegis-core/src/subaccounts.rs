//! Sub-account spawner & scoped FunctionCall key provisioning (tracks: swarms, security).
//!
//! `register_and_spawn_agent` gives every agent its own identity without ever handing out
//! a FullAccess key:
//!
//! * `SpawnMode::SubAccount`: creates `<handle>.<contract>` whose only key is a FunctionCall
//!   key that may call this contract, and only the methods of the agent's role.
//! * `SpawnMode::ContractKey`: adds the same scoped FunctionCall key to the contract account
//!   itself. The agent is identified by `env::signer_account_pk()`, its gas is sponsored by
//!   the treasury up to `allowance_cap` (booked as an obligation, see `Treasury`), and the
//!   circuit breaker can delete the key on-chain.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId, Allowance, CurveType, Gas, NearToken, Promise, PublicKey};

use crate::events::AegisEvent;
use crate::policy::{AgentPolicy, Severity};
use crate::{AegisCore, AegisCoreExt, ONE_NEAR};

/// Methods every agent key may call: bid, prove work, request settlements and spend earnings.
pub const WORKER_METHODS: [&str; 6] = [
    "submit_bid",
    "execute_verified_task",
    "request_intent_settlement",
    "request_evm_transfer",
    "pay_from_balance",
    "withdraw_earnings",
];
/// Extra methods for the orchestrator role (task decomposition and auction control).
pub const ORCHESTRATOR_METHODS: [&str; 2] = ["post_task_rfp", "close_auction"];
/// Extra methods for the sentinel role (settlement confirmation and emergency brakes).
pub const SENTINEL_METHODS: [&str; 4] = ["confirm_intent_settlement", "confirm_evm_transfer", "report_agent", "set_protocol_paused"];

pub const MAX_AGENTS: u32 = 32;
/// Upper bound for the gas allowance attached to a single agent key.
pub const MAX_ALLOWANCE: u128 = 5 * ONE_NEAR;
pub const INITIAL_REPUTATION_BPS: u32 = 5_000;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Orchestrator,
    YieldStrategist,
    Sentinel,
    ComputeWorker,
}

impl AgentRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentRole::Orchestrator => "orchestrator",
            AgentRole::YieldStrategist => "yield_strategist",
            AgentRole::Sentinel => "sentinel",
            AgentRole::ComputeWorker => "compute_worker",
        }
    }

    /// Roles that may bid on swarm tasks. Orchestrators post tasks; sentinels audit them.
    pub fn can_bid(&self) -> bool {
        matches!(self, AgentRole::YieldStrategist | AgentRole::ComputeWorker)
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpawnMode {
    SubAccount,
    ContractKey,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentStatus {
    /// Sub-account creation / key provisioning receipt still in flight.
    Provisioning,
    Active,
    Quarantined {
        reason: String,
        at_ns: U64,
        block_height: U64,
    },
    Revoked {
        at_ns: U64,
    },
}

impl AgentStatus {
    pub fn label(&self) -> &'static str {
        match self {
            AgentStatus::Provisioning => "provisioning",
            AgentStatus::Active => "active",
            AgentStatus::Quarantined { .. } => "quarantined",
            AgentStatus::Revoked { .. } => "revoked",
        }
    }
}

/// Per-agent spend accounting for epoch caps and the velocity circuit breaker.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpendWindow {
    pub epoch: U64,
    pub spent_in_epoch: U128,
    pub window_start_ns: U64,
    pub requests_in_window: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentRecord {
    pub agent_id: AccountId,
    pub handle: String,
    pub role: AgentRole,
    pub public_key: PublicKey,
    pub spawn_mode: SpawnMode,
    pub status: AgentStatus,
    /// Whether the scoped key is believed to exist on-chain.
    pub key_active: bool,
    /// Exact method list written into the FunctionCall access key.
    pub allowed_methods: Vec<String>,
    /// Gas allowance written into the FunctionCall access key, yoctoNEAR.
    pub allowance_cap: U128,
    /// Where `withdraw_earnings` sends this agent's balance (set by the owner at spawn).
    pub payout_account: AccountId,
    pub policy: AgentPolicy,
    pub spend: SpendWindow,
    pub reputation_bps: u32,
    pub tasks_completed: u32,
    pub tasks_failed: u32,
    /// Strike counter used by the circuit breaker.
    pub violations: u32,
    /// Spendable earnings held by the treasury for this agent (escrow payouts, agent payments).
    pub balance: U128,
    pub total_earned: U128,
    /// Treasury funds this agent committed through settlements.
    pub total_spent: U128,
    pub created_at_ns: U64,
}

pub fn methods_for_role(role: AgentRole) -> Vec<String> {
    let mut methods: Vec<String> = WORKER_METHODS.iter().map(|m| m.to_string()).collect();
    match role {
        AgentRole::Orchestrator => methods.extend(ORCHESTRATOR_METHODS.iter().map(|m| m.to_string())),
        AgentRole::Sentinel => methods.extend(SENTINEL_METHODS.iter().map(|m| m.to_string())),
        AgentRole::YieldStrategist | AgentRole::ComputeWorker => {}
    }
    methods
}

pub(crate) fn key_allowance(cap: u128) -> Allowance {
    Allowance::limited(NearToken::from_yoctonear(cap)).unwrap_or_else(|| env::panic_str("AEGIS_E_ZERO_ALLOWANCE"))
}

/// NEAR account-id rules for one label: 2-32 chars of `[a-z0-9]`, single `-`/`_` separators.
pub fn validate_handle(handle: &str) {
    let bytes = handle.as_bytes();
    require!((2..=32).contains(&bytes.len()), "AEGIS_E_INVALID_HANDLE: length must be 2..=32");
    let is_sep = |c: u8| c == b'-' || c == b'_';
    require!(!is_sep(bytes[0]) && !is_sep(bytes[bytes.len() - 1]), "AEGIS_E_INVALID_HANDLE: separator at edge");
    let mut prev_sep = false;
    for &c in bytes {
        let sep = is_sep(c);
        require!(sep || c.is_ascii_lowercase() || c.is_ascii_digit(), "AEGIS_E_INVALID_HANDLE: charset");
        require!(!(sep && prev_sep), "AEGIS_E_INVALID_HANDLE: double separator");
        prev_sep = sep;
    }
}

impl AegisCore {
    /// Resolves the calling agent from the predecessor (sub-account mode) or from the
    /// signing key (contract-key mode).
    pub(crate) fn resolve_agent_caller(&self) -> Option<AgentRecord> {
        let predecessor = env::predecessor_account_id();
        if predecessor == env::current_account_id() {
            let pk = String::from(&env::signer_account_pk());
            let agent_id = self.agent_by_key.get(&pk)?;
            let agent = self.agents.get(agent_id)?;
            (agent.spawn_mode == SpawnMode::ContractKey).then(|| agent.clone())
        } else {
            let agent = self.agents.get(&predecessor)?;
            (agent.spawn_mode == SpawnMode::SubAccount).then(|| agent.clone())
        }
    }

    /// Like `resolve_agent_caller`, but panics for non-agents and re-checks the key scope
    /// (defense in depth: the protocol already enforces the FunctionCall method list).
    pub(crate) fn caller_agent(&self, method: &str) -> AgentRecord {
        let agent = self.resolve_agent_caller().unwrap_or_else(|| env::panic_str("AEGIS_E_UNKNOWN_AGENT"));
        require!(agent.allowed_methods.iter().any(|m| m == method), "AEGIS_E_METHOD_NOT_IN_KEY_SCOPE");
        agent
    }

    pub(crate) fn agent_or_panic(&self, agent_id: &AccountId) -> AgentRecord {
        self.agents.get(agent_id).cloned().unwrap_or_else(|| env::panic_str("AEGIS_E_UNKNOWN_AGENT"))
    }

    /// Credits spendable earnings to an agent (escrow payouts and agent-to-agent payments).
    pub(crate) fn credit_agent(&mut self, agent_id: &AccountId, amount: u128, source: &str) {
        let mut agent = self.agent_or_panic(agent_id);
        agent.balance = U128(agent.balance.0 + amount);
        agent.total_earned = U128(agent.total_earned.0 + amount);
        self.agents.insert(agent_id.clone(), agent);
        AegisEvent::EarningsCredited { agent_id: agent_id.clone(), amount: U128(amount), source: source.to_string() }.emit();
    }
}

#[near]
impl AegisCore {
    /// Owner-only. Registers an agent and provisions its scoped FunctionCall key.
    ///
    /// Sub-account mode requires an attached deposit (>= `config.subaccount_min_deposit`)
    /// that funds the new account's storage and gas; contract-key mode takes no deposit and its
    /// gas allowance is booked as a treasury obligation. `initial_reputation_bps` lets the owner
    /// start unvetted third parties below vetted agents (default 5000).
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn register_and_spawn_agent(
        &mut self,
        agent_handle: String,
        role: AgentRole,
        public_key: PublicKey,
        allowance_cap: U128,
        spawn_mode: Option<SpawnMode>,
        payout_account: Option<AccountId>,
        policy: Option<AgentPolicy>,
        initial_reputation_bps: Option<u32>,
    ) -> AgentRecord {
        self.assert_owner();
        validate_handle(&agent_handle);
        require!(self.agents.len() < MAX_AGENTS, "AEGIS_E_TOO_MANY_AGENTS");
        require!(public_key.curve_type() == CurveType::ED25519, "AEGIS_E_ED25519_KEY_REQUIRED");
        require!(allowance_cap.0 > 0 && allowance_cap.0 <= MAX_ALLOWANCE, "AEGIS_E_INVALID_ALLOWANCE: must be in (0, 5 NEAR]");
        let reputation = initial_reputation_bps.unwrap_or(INITIAL_REPUTATION_BPS);
        require!(reputation <= 10_000, "AEGIS_E_INVALID_REPUTATION");

        let contract_id = env::current_account_id();
        let agent_id: AccountId = format!("{agent_handle}.{contract_id}")
            .parse()
            .unwrap_or_else(|_| env::panic_str("AEGIS_E_INVALID_HANDLE: resulting account id is invalid"));
        require!(self.agents.get(&agent_id).is_none(), "AEGIS_E_AGENT_EXISTS");
        let pk_str = String::from(&public_key);
        require!(!self.agent_by_key.contains_key(&pk_str), "AEGIS_E_KEY_ALREADY_REGISTERED");

        let mode = spawn_mode.unwrap_or(SpawnMode::SubAccount);
        let deposit = env::attached_deposit();
        match mode {
            SpawnMode::SubAccount => require!(
                deposit.as_yoctonear() >= self.config.subaccount_min_deposit.0,
                "AEGIS_E_DEPOSIT_TOO_LOW: sub-account spawn needs config.subaccount_min_deposit"
            ),
            SpawnMode::ContractKey => {
                require!(deposit.is_zero(), "AEGIS_E_NO_DEPOSIT_FOR_CONTRACT_KEY");
                // The key burns gas from the contract balance: reserve its full allowance.
                require!(allowance_cap.0 <= self.available_liquidity(), "AEGIS_E_INSUFFICIENT_LIQUIDITY_FOR_GAS_ALLOWANCE");
                self.treasury.contract_key_allowances += allowance_cap.0;
            }
        }

        let policy = policy.unwrap_or_else(|| AgentPolicy::default_for_role(role));
        policy.validate();
        let methods = methods_for_role(role);
        let now = env::block_timestamp();
        let record = AgentRecord {
            agent_id: agent_id.clone(),
            handle: agent_handle,
            role,
            public_key: public_key.clone(),
            spawn_mode: mode,
            status: AgentStatus::Provisioning,
            key_active: false,
            allowed_methods: methods.clone(),
            allowance_cap,
            payout_account: payout_account.unwrap_or_else(|| agent_id.clone()),
            policy,
            spend: SpendWindow {
                epoch: U64(env::epoch_height()),
                spent_in_epoch: U128(0),
                window_start_ns: U64(now),
                requests_in_window: 0,
            },
            reputation_bps: reputation,
            tasks_completed: 0,
            tasks_failed: 0,
            violations: 0,
            balance: U128(0),
            total_earned: U128(0),
            total_spent: U128(0),
            created_at_ns: U64(now),
        };
        self.agents.insert(agent_id.clone(), record.clone());
        self.agent_by_key.insert(pk_str.clone(), agent_id.clone());

        let methods_csv = methods.join(",");
        let allowance = key_allowance(allowance_cap.0);
        let provision =
            match mode {
                SpawnMode::SubAccount => Promise::new(agent_id.clone())
                    .create_account()
                    .transfer(deposit)
                    .add_access_key_allowance(public_key, allowance, contract_id.clone(), methods_csv),
                SpawnMode::ContractKey => Promise::new(contract_id.clone()).add_access_key_allowance(
                    public_key,
                    allowance,
                    contract_id.clone(),
                    methods_csv,
                ),
            };
        provision
            .then(
                Self::ext(contract_id)
                    .with_static_gas(Gas::from_tgas(self.config.callback_gas_tgas))
                    .on_agent_spawned(agent_id.clone(), U128(deposit.as_yoctonear())),
            )
            .detach();

        AegisEvent::AgentSpawnRequested {
            agent_id,
            role,
            spawn_mode: mode,
            public_key: pk_str,
            allowed_methods: methods,
            allowance_cap,
        }
        .emit();
        record
    }

    /// Callback of the provisioning receipt.
    #[private]
    pub fn on_agent_spawned(&mut self, agent_id: AccountId, deposit: U128) -> bool {
        require!(env::promise_results_count() == 1, "AEGIS_E_CALLBACK_ONLY");
        let ok = env::promise_result_checked(0, 64).is_ok();
        let Some(mut agent) = self.agents.get(&agent_id).cloned() else {
            return false;
        };
        if ok {
            agent.status = AgentStatus::Active;
            agent.key_active = true;
            let role = agent.role;
            self.agents.insert(agent_id.clone(), agent);
            AegisEvent::AgentSpawned { agent_id, role }.emit();
            true
        } else {
            // The failed receipt refunded the deposit to this contract; hand it back to the owner.
            self.agents.remove(&agent_id);
            self.agent_by_key.remove(&String::from(&agent.public_key));
            if agent.spawn_mode == SpawnMode::ContractKey {
                self.treasury.contract_key_allowances = self.treasury.contract_key_allowances.saturating_sub(agent.allowance_cap.0);
            }
            if deposit.0 > 0 {
                Promise::new(self.owner_id.clone()).transfer(NearToken::from_yoctonear(deposit.0)).detach();
            }
            AegisEvent::AgentSpawnFailed { agent_id: agent_id.clone(), refunded: deposit }.emit();
            self.record_security_event(
                "agent_spawn_failed",
                Some(&agent_id),
                Severity::Notice,
                vec![],
                "provisioning receipt failed".to_string(),
            );
            false
        }
    }

    /// Owner-only permanent removal. Contract-key agents lose their key on-chain.
    pub fn revoke_agent(&mut self, agent_id: AccountId) {
        self.assert_owner();
        let mut agent = self.agent_or_panic(&agent_id);
        require!(!matches!(agent.status, AgentStatus::Revoked { .. }), "AEGIS_E_ALREADY_REVOKED");
        self.delete_contract_key(&mut agent);
        agent.status = AgentStatus::Revoked { at_ns: U64(env::block_timestamp()) };
        self.agents.insert(agent_id.clone(), agent);
        AegisEvent::AgentRevoked { agent_id: agent_id.clone() }.emit();
        self.record_security_event("revoked", Some(&agent_id), Severity::Warning, vec![], "owner revoked agent".to_string());
    }

    pub fn get_agent(&self, agent_id: AccountId) -> Option<AgentRecord> {
        self.agents.get(&agent_id).cloned()
    }

    pub fn get_agent_by_key(&self, public_key: PublicKey) -> Option<AgentRecord> {
        let id = self.agent_by_key.get(&String::from(&public_key))?;
        self.agents.get(id).cloned()
    }

    pub fn list_agents(&self) -> Vec<AgentRecord> {
        self.agents.values().cloned().collect()
    }

    /// The exact FunctionCall method list a key for `role` receives.
    pub fn get_role_scope(&self, role: AgentRole) -> Vec<String> {
        methods_for_role(role)
    }
}

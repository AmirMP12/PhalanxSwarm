//! AI Security & Defense Policy Engine (track: security).
//!
//! * Global + per-agent limits: `max_tx_amount_yocto`, `epoch_spending_cap_yocto`,
//!   `allowed_target_chains`, `allowed_contract_ids`, an asset allow-list, a slippage ceiling
//!   and `require_tee_attestation`.
//! * Destination allow-list: every payment, settlement and EVM transfer names a recipient, and
//!   the recipient must be in `allowed_recipients` (`<chain>:<address>`). Registered agents are
//!   the only implicit recipients, and only for agent-to-agent payments. This is the control that
//!   stops a fooled or compromised agent from paying an attacker an amount inside its limits.
//! * Price floors: a cross-chain swap's `min_amount_out` must clear a DAO-set floor for its
//!   asset pair. The contract never trusts the agent-supplied quote for value protection.
//! * EVM limits: per-chain caps for transfers the contract signs through Chain Signatures.
//! * Anomaly circuit breaker: critical violations (unauthorized destination, velocity burst,
//!   forged signatures or attestations, gross overspend) freeze the agent immediately
//!   (`AgentStatus::Quarantined`); warnings count as strikes and freeze it after
//!   `quarantine_after_strikes`.
//! * Rejections never panic. A panic would roll back the quarantine, so the engine commits
//!   the freeze plus a NEP-297 event and returns a `rejected` outcome instead.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId, Promise};

use crate::codec::{is_lower_evm_address, is_safe_ascii, is_valid_recipient_entry, recipient_key};
use crate::events::AegisEvent;
use crate::subaccounts::{key_allowance, AgentRecord, AgentRole, AgentStatus, SpawnMode};
use crate::{AegisCore, AegisCoreExt, Treasury, ONE_NEAR, SECURITY_EVENT_CAPACITY};

pub const MAX_RECIPIENTS: usize = 64;
pub const MAX_PRICE_FLOORS: usize = 32;
pub const MAX_EVM_CHAINS: usize = 8;
pub const MAX_EVM_TOKENS: usize = 8;

/// Minimum output per `unit_in` of the origin asset, e.g. at least 1 USDC (1_000_000) per
/// 1 wNEAR (10^24). Swaps on a pair without a floor are rejected.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceFloor {
    pub origin_asset: String,
    pub destination_asset: String,
    pub unit_in: U128,
    pub min_out_per_unit: U128,
}

/// An ERC-20 token the treasury may send on an EVM chain.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmTokenPolicy {
    /// Lower-case `0x` contract address.
    pub token: String,
    pub symbol: String,
    pub max_amount: U128,
    pub epoch_cap: U128,
}

/// Limits for transfers the contract signs on one EVM chain through Chain Signatures.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmChainPolicy {
    /// Chain label used in recipients and MPC paths (`basesepolia`, `base`, `arb`, ...).
    pub chain: String,
    /// EIP-155 chain id written into the signed transaction.
    pub chain_id: u64,
    /// Native-coin limits, wei.
    pub max_value_wei: U128,
    pub epoch_cap_wei: U128,
    /// Ceiling for `gas_limit * max_fee_per_gas`, so an agent cannot burn the account on fees.
    pub max_fee_wei: U128,
    pub tokens: Vec<EvmTokenPolicy>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GlobalPolicy {
    /// Hard ceiling for any single spend (intent settlement or task budget), yoctoNEAR.
    pub max_tx_amount_yocto: U128,
    /// Ceiling for the sum of all agent spends inside one NEAR epoch, yoctoNEAR.
    pub epoch_spending_cap_yocto: U128,
    /// 1Click `blockchain` identifiers settlements may target (`near`, `eth`, `arb`, ...).
    pub allowed_target_chains: Vec<String>,
    /// Contracts a settlement may route through (NEAR Intents verifier, MPC signer, ...).
    pub allowed_contract_ids: Vec<AccountId>,
    /// NEAR Intents asset ids (`nep141:...`) the treasury may sell or buy.
    pub allowed_assets: Vec<String>,
    /// Every settlement must carry a TEE proof from a registered enclave or attested model.
    pub require_tee_attestation: bool,
    pub max_slippage_bps: u32,
    /// Max settlement requests per agent inside `velocity_window_sec` before the breaker trips.
    pub velocity_limit: u32,
    pub velocity_window_sec: u32,
    pub auto_quarantine: bool,
    pub quarantine_after_strikes: u32,
    /// Settlements at or above this amount wait for owner / DAO approval.
    pub dao_approval_threshold: U128,
    /// Destinations money may go to: `<chain>:<address>` (EVM addresses lower-case).
    pub allowed_recipients: Vec<String>,
    pub price_floors: Vec<PriceFloor>,
    pub evm_chains: Vec<EvmChainPolicy>,
}

impl GlobalPolicy {
    pub fn default_with(intents_contract: &AccountId, mpc_contract: Option<&AccountId>) -> Self {
        let mut contracts = vec![intents_contract.clone()];
        if let Some(mpc) = mpc_contract {
            contracts.push(mpc.clone());
        }
        let wnear = "nep141:wrap.near".to_string();
        let floor = |dest: &str| PriceFloor {
            origin_asset: wnear.clone(),
            destination_asset: dest.to_string(),
            unit_in: U128(ONE_NEAR),
            // 1 USDC (6 decimals) per wNEAR: rejects absurd `min_amount_out` values, not normal slippage.
            min_out_per_unit: U128(1_000_000),
        };
        Self {
            max_tx_amount_yocto: U128(25 * ONE_NEAR),
            epoch_spending_cap_yocto: U128(100 * ONE_NEAR),
            allowed_target_chains: ["near", "arb", "base", "sol", "eth", "btc"].iter().map(|c| c.to_string()).collect(),
            allowed_contract_ids: contracts,
            allowed_assets: vec![
                wnear.clone(),
                "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1".to_string(),
                "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near".to_string(),
                "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near".to_string(),
                "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near".to_string(),
                "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near".to_string(),
            ],
            require_tee_attestation: true,
            max_slippage_bps: 100,
            velocity_limit: 5,
            velocity_window_sec: 60,
            auto_quarantine: true,
            quarantine_after_strikes: 3,
            dao_approval_threshold: U128(50 * ONE_NEAR),
            // Empty by default: nothing can leave the treasury until the DAO names destinations.
            allowed_recipients: vec![],
            price_floors: vec![
                floor("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"),
                floor("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"),
                floor("nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near"),
                floor("nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near"),
                floor("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
            ],
            evm_chains: vec![],
        }
    }

    pub fn validate(&self) {
        require!(self.max_tx_amount_yocto.0 > 0, "AEGIS_E_POLICY: max_tx_amount_yocto must be > 0");
        require!(
            self.epoch_spending_cap_yocto.0 >= self.max_tx_amount_yocto.0,
            "AEGIS_E_POLICY: epoch_spending_cap_yocto must be >= max_tx_amount_yocto"
        );
        require!(self.max_slippage_bps <= 2_000, "AEGIS_E_POLICY: max_slippage_bps must be <= 2000");
        require!(self.velocity_limit >= 1 && self.velocity_window_sec >= 1, "AEGIS_E_POLICY: velocity window");
        require!(self.quarantine_after_strikes >= 1, "AEGIS_E_POLICY: quarantine_after_strikes must be >= 1");
        require!(self.allowed_target_chains.len() <= 32 && self.allowed_assets.len() <= 64, "AEGIS_E_POLICY: list too long");
        require!(self.allowed_contract_ids.len() <= 32, "AEGIS_E_POLICY: list too long");
        for c in &self.allowed_target_chains {
            require!(crate::codec::is_valid_chain_id(c), "AEGIS_E_POLICY: invalid chain id");
        }
        for a in &self.allowed_assets {
            require!(crate::codec::is_valid_asset_id(a), "AEGIS_E_POLICY: invalid asset id");
        }
        require!(self.allowed_recipients.len() <= MAX_RECIPIENTS, "AEGIS_E_POLICY: too many recipients");
        for r in &self.allowed_recipients {
            require!(is_valid_recipient_entry(r), "AEGIS_E_POLICY: recipients are `<chain>:<address>`, EVM addresses lower-case");
        }
        require!(self.price_floors.len() <= MAX_PRICE_FLOORS, "AEGIS_E_POLICY: too many price floors");
        for f in &self.price_floors {
            require!(
                crate::codec::is_valid_asset_id(&f.origin_asset) && crate::codec::is_valid_asset_id(&f.destination_asset),
                "AEGIS_E_POLICY: price floor asset id"
            );
            require!(f.unit_in.0 > 0 && f.min_out_per_unit.0 > 0, "AEGIS_E_POLICY: price floor must be > 0");
        }
        require!(self.evm_chains.len() <= MAX_EVM_CHAINS, "AEGIS_E_POLICY: too many EVM chains");
        for c in &self.evm_chains {
            require!(crate::codec::is_valid_chain_id(&c.chain) && c.chain_id > 0, "AEGIS_E_POLICY: EVM chain");
            require!(c.max_value_wei.0 <= c.epoch_cap_wei.0, "AEGIS_E_POLICY: EVM max_value_wei must be <= epoch_cap_wei");
            require!(c.tokens.len() <= MAX_EVM_TOKENS, "AEGIS_E_POLICY: too many EVM tokens");
            for t in &c.tokens {
                require!(is_lower_evm_address(&t.token), "AEGIS_E_POLICY: EVM token must be a lower-case 0x address");
                require!(is_safe_ascii(&t.symbol, 16) && !t.symbol.is_empty(), "AEGIS_E_POLICY: EVM token symbol");
                require!(t.max_amount.0 <= t.epoch_cap.0, "AEGIS_E_POLICY: EVM token max_amount must be <= epoch_cap");
            }
        }
        let mut chains: Vec<&str> = self.evm_chains.iter().map(|c| c.chain.as_str()).collect();
        chains.sort_unstable();
        chains.dedup();
        require!(chains.len() == self.evm_chains.len(), "AEGIS_E_POLICY: duplicate EVM chain");
    }

    pub fn evm_chain(&self, chain: &str) -> Option<&EvmChainPolicy> {
        self.evm_chains.iter().find(|c| c.chain == chain)
    }

    pub fn allows_recipient(&self, chain: &str, recipient: &str) -> bool {
        self.allowed_recipients.contains(&recipient_key(chain, recipient))
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentPolicy {
    pub max_tx_amount_yocto: U128,
    pub epoch_spending_cap_yocto: U128,
    /// Empty = inherit the global allow-list. Otherwise intersected with it.
    pub allowed_target_chains: Vec<String>,
    /// Empty = inherit the global allow-list. Otherwise intersected with it.
    pub allowed_contract_ids: Vec<AccountId>,
    pub require_tee_attestation: bool,
}

impl AgentPolicy {
    pub fn default_for_role(role: AgentRole) -> Self {
        let (max_tx, cap, chains): (u128, u128, &[&str]) = match role {
            AgentRole::Orchestrator => (20, 60, &[]),
            AgentRole::YieldStrategist => (15, 40, &["near", "arb", "base", "sol"]),
            AgentRole::Sentinel => (1, 2, &["near"]),
            AgentRole::ComputeWorker => (5, 10, &["near", "arb", "base"]),
        };
        Self {
            max_tx_amount_yocto: U128(max_tx * ONE_NEAR),
            epoch_spending_cap_yocto: U128(cap * ONE_NEAR),
            allowed_target_chains: chains.iter().map(|c| c.to_string()).collect(),
            allowed_contract_ids: vec![],
            require_tee_attestation: false,
        }
    }

    pub fn validate(&self) {
        require!(self.max_tx_amount_yocto.0 > 0, "AEGIS_E_POLICY: agent max_tx_amount_yocto must be > 0");
        require!(
            self.epoch_spending_cap_yocto.0 >= self.max_tx_amount_yocto.0,
            "AEGIS_E_POLICY: agent epoch_spending_cap_yocto must be >= max_tx_amount_yocto"
        );
        require!(
            self.allowed_target_chains.len() <= 32 && self.allowed_contract_ids.len() <= 32,
            "AEGIS_E_POLICY: list too long"
        );
        for c in &self.allowed_target_chains {
            require!(crate::codec::is_valid_chain_id(c), "AEGIS_E_POLICY: invalid chain id");
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// No violation.
    None,
    /// Rejected, but not the agent's fault (protocol paused, treasury illiquid, ...). No strike.
    Notice,
    /// Rejected and counted as a strike.
    Warning,
    /// Rejected and the agent is quarantined immediately.
    Critical,
}

impl Severity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Severity::None => "none",
            Severity::Notice => "notice",
            Severity::Warning => "warning",
            Severity::Critical => "critical",
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum PolicyViolation {
    ProtocolPaused,
    AgentNotActive { status: String },
    AmountExceedsTxLimit { amount: U128, limit: U128 },
    AgentEpochCapExceeded { spent: U128, amount: U128, cap: U128 },
    GlobalEpochCapExceeded { spent: U128, amount: U128, cap: U128 },
    ChainNotAllowed { chain: String },
    ContractNotAllowed { contract_id: String },
    AssetNotAllowed { asset: String },
    SlippageTooHigh { slippage_bps: u32, max_bps: u32 },
    VelocityExceeded { requests: u32, limit: u32, window_sec: u32 },
    MissingTeeAttestation,
    InvalidTeeAttestation { reason: String },
    InvalidIntentSignature,
    NonceReused,
    DeadlineInvalid { reason: String },
    QuoteInvalid { reason: String },
    InsufficientTreasuryLiquidity { available: U128, amount: U128 },
    RecipientNotAllowed { chain: String, recipient: String },
    PriceBelowFloor { min_amount_out: U128, floor: U128 },
    NoPriceFloor { origin_asset: String, destination_asset: String },
    EvmChainNotAllowed { chain: String },
    EvmAssetNotAllowed { asset: String },
    EvmAmountExceedsLimit { amount: U128, limit: U128 },
    EvmEpochCapExceeded { spent: U128, amount: U128, cap: U128 },
    EvmFeeTooHigh { fee: U128, cap: U128 },
    InsufficientAgentBalance { balance: U128, amount: U128 },
}

impl PolicyViolation {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ProtocolPaused => "protocol_paused",
            Self::AgentNotActive { .. } => "agent_not_active",
            Self::AmountExceedsTxLimit { .. } => "amount_exceeds_tx_limit",
            Self::AgentEpochCapExceeded { .. } => "agent_epoch_cap_exceeded",
            Self::GlobalEpochCapExceeded { .. } => "global_epoch_cap_exceeded",
            Self::ChainNotAllowed { .. } => "chain_not_allowed",
            Self::ContractNotAllowed { .. } => "contract_not_allowed",
            Self::AssetNotAllowed { .. } => "asset_not_allowed",
            Self::SlippageTooHigh { .. } => "slippage_too_high",
            Self::VelocityExceeded { .. } => "velocity_exceeded",
            Self::MissingTeeAttestation => "missing_tee_attestation",
            Self::InvalidTeeAttestation { .. } => "invalid_tee_attestation",
            Self::InvalidIntentSignature => "invalid_intent_signature",
            Self::NonceReused => "nonce_reused",
            Self::DeadlineInvalid { .. } => "deadline_invalid",
            Self::QuoteInvalid { .. } => "quote_invalid",
            Self::InsufficientTreasuryLiquidity { .. } => "insufficient_treasury_liquidity",
            Self::RecipientNotAllowed { .. } => "recipient_not_allowed",
            Self::PriceBelowFloor { .. } => "price_below_floor",
            Self::NoPriceFloor { .. } => "no_price_floor",
            Self::EvmChainNotAllowed { .. } => "evm_chain_not_allowed",
            Self::EvmAssetNotAllowed { .. } => "evm_asset_not_allowed",
            Self::EvmAmountExceedsLimit { .. } => "evm_amount_exceeds_limit",
            Self::EvmEpochCapExceeded { .. } => "evm_epoch_cap_exceeded",
            Self::EvmFeeTooHigh { .. } => "evm_fee_too_high",
            Self::InsufficientAgentBalance { .. } => "insufficient_agent_balance",
        }
    }

    pub fn severity(&self) -> Severity {
        match self {
            Self::ProtocolPaused
            | Self::AgentNotActive { .. }
            | Self::InsufficientTreasuryLiquidity { .. }
            | Self::InsufficientAgentBalance { .. } => Severity::Notice,
            // Attempting to move 4x the allowed amount in one shot is treated as an attack.
            Self::AmountExceedsTxLimit { amount, limit } | Self::EvmAmountExceedsLimit { amount, limit } => {
                if amount.0 >= limit.0.saturating_mul(4) {
                    Severity::Critical
                } else {
                    Severity::Warning
                }
            }
            Self::ChainNotAllowed { .. }
            | Self::ContractNotAllowed { .. }
            | Self::AssetNotAllowed { .. }
            | Self::VelocityExceeded { .. }
            | Self::InvalidTeeAttestation { .. }
            | Self::InvalidIntentSignature
            | Self::NonceReused
            | Self::RecipientNotAllowed { .. }
            | Self::PriceBelowFloor { .. }
            | Self::EvmChainNotAllowed { .. }
            | Self::EvmAssetNotAllowed { .. } => Severity::Critical,
            Self::AgentEpochCapExceeded { .. }
            | Self::GlobalEpochCapExceeded { .. }
            | Self::SlippageTooHigh { .. }
            | Self::MissingTeeAttestation
            | Self::DeadlineInvalid { .. }
            | Self::QuoteInvalid { .. }
            | Self::NoPriceFloor { .. }
            | Self::EvmEpochCapExceeded { .. }
            | Self::EvmFeeTooHigh { .. } => Severity::Warning,
        }
    }
}

pub fn max_severity(violations: &[PolicyViolation]) -> Severity {
    violations.iter().map(|v| v.severity()).max().unwrap_or(Severity::None)
}

/// The limits that applied to one decision, after intersecting global and agent policy.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectiveLimits {
    pub epoch: U64,
    pub max_tx_amount_yocto: U128,
    pub agent_epoch_cap: U128,
    pub agent_epoch_spent: U128,
    pub global_epoch_cap: U128,
    pub global_epoch_spent: U128,
    pub allowed_target_chains: Vec<String>,
    pub allowed_contract_ids: Vec<AccountId>,
    pub require_tee_attestation: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyDecision {
    pub approved: bool,
    pub severity: Severity,
    pub violations: Vec<PolicyViolation>,
    pub requires_dao_approval: bool,
    pub limits: EffectiveLimits,
}

/// Append-only (ring-buffered) security log, readable by the UI and auditors.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecurityEvent {
    pub seq: U64,
    pub kind: String,
    pub agent_id: Option<AccountId>,
    pub severity: Severity,
    pub codes: Vec<String>,
    pub detail: String,
    pub at_ns: U64,
    pub block_height: U64,
}

/// A swap whose output the price-floor table must cover.
pub struct PriceCheck<'a> {
    pub origin_asset: &'a str,
    pub destination_asset: &'a str,
    pub amount: u128,
    pub min_amount_out: u128,
}

/// A spend the policy engine is asked to judge.
pub struct SpendRequest<'a> {
    pub amount: u128,
    pub destination_chain: Option<&'a str>,
    pub execution_contract: Option<&'a AccountId>,
    pub assets: Vec<&'a str>,
    pub slippage_bps: Option<u32>,
    pub available_liquidity: u128,
    /// `(chain, recipient)` the money goes to; `None` for budget reservations.
    pub recipient: Option<(&'a str, &'a str)>,
    /// Registered, active agents are implicit recipients (agent-to-agent payments only).
    pub recipient_is_agent: bool,
    pub price: Option<PriceCheck<'a>>,
}

impl<'a> SpendRequest<'a> {
    /// A treasury reservation with no destination (task budgets).
    pub fn reservation(amount: u128, available_liquidity: u128) -> Self {
        Self {
            amount,
            destination_chain: None,
            execution_contract: None,
            assets: vec![],
            slippage_bps: None,
            available_liquidity,
            recipient: None,
            recipient_is_agent: false,
            price: None,
        }
    }
}

fn intersect<T: Clone + PartialEq>(global: &[T], agent: &[T]) -> Vec<T> {
    if agent.is_empty() {
        global.to_vec()
    } else {
        global.iter().filter(|g| agent.contains(g)).cloned().collect()
    }
}

/// `min_amount_out` must be at least `amount * min_out_per_unit / unit_in` for the pair.
pub fn check_price_floor(global: &GlobalPolicy, p: &PriceCheck) -> Option<PolicyViolation> {
    let Some(floor) = global.price_floors.iter().find(|f| f.origin_asset == p.origin_asset && f.destination_asset == p.destination_asset)
    else {
        return Some(PolicyViolation::NoPriceFloor {
            origin_asset: p.origin_asset.to_string(),
            destination_asset: p.destination_asset.to_string(),
        });
    };
    let lhs = p.min_amount_out.checked_mul(floor.unit_in.0);
    let rhs = p.amount.checked_mul(floor.min_out_per_unit.0);
    match (lhs, rhs) {
        (Some(l), Some(r)) if l >= r => None,
        _ => Some(PolicyViolation::PriceBelowFloor {
            min_amount_out: U128(p.min_amount_out),
            floor: U128(rhs.map(|r| r / floor.unit_in.0).unwrap_or(u128::MAX)),
        }),
    }
}

/// Pure policy evaluation: no state is read besides the arguments, no state is written.
pub fn evaluate_spend(
    global: &GlobalPolicy,
    paused: bool,
    agent: &AgentRecord,
    treasury: &Treasury,
    epoch: u64,
    req: &SpendRequest,
) -> (Vec<PolicyViolation>, EffectiveLimits) {
    let mut violations = Vec::new();
    if paused {
        violations.push(PolicyViolation::ProtocolPaused);
    }
    if agent.status != AgentStatus::Active {
        violations.push(PolicyViolation::AgentNotActive { status: agent.status.label().to_string() });
    }

    let max_tx = global.max_tx_amount_yocto.0.min(agent.policy.max_tx_amount_yocto.0);
    if req.amount > max_tx {
        violations.push(PolicyViolation::AmountExceedsTxLimit { amount: U128(req.amount), limit: U128(max_tx) });
    }

    let agent_spent = if agent.spend.epoch.0 == epoch { agent.spend.spent_in_epoch.0 } else { 0 };
    let agent_cap = agent.policy.epoch_spending_cap_yocto.0;
    if agent_spent.saturating_add(req.amount) > agent_cap {
        violations.push(PolicyViolation::AgentEpochCapExceeded {
            spent: U128(agent_spent),
            amount: U128(req.amount),
            cap: U128(agent_cap),
        });
    }

    let global_spent = if treasury.epoch == epoch { treasury.epoch_spent } else { 0 };
    let global_cap = global.epoch_spending_cap_yocto.0;
    if global_spent.saturating_add(req.amount) > global_cap {
        violations.push(PolicyViolation::GlobalEpochCapExceeded {
            spent: U128(global_spent),
            amount: U128(req.amount),
            cap: U128(global_cap),
        });
    }

    let chains = intersect(&global.allowed_target_chains, &agent.policy.allowed_target_chains);
    if let Some(chain) = req.destination_chain {
        if !chains.iter().any(|c| c == chain) {
            violations.push(PolicyViolation::ChainNotAllowed { chain: chain.to_string() });
        }
    }

    let contracts = intersect(&global.allowed_contract_ids, &agent.policy.allowed_contract_ids);
    if let Some(contract) = req.execution_contract {
        if !contracts.contains(contract) {
            violations.push(PolicyViolation::ContractNotAllowed { contract_id: contract.to_string() });
        }
    }

    for asset in &req.assets {
        if !global.allowed_assets.iter().any(|a| a == asset) {
            violations.push(PolicyViolation::AssetNotAllowed { asset: asset.to_string() });
        }
    }

    if let Some(slippage) = req.slippage_bps {
        if slippage > global.max_slippage_bps {
            violations.push(PolicyViolation::SlippageTooHigh { slippage_bps: slippage, max_bps: global.max_slippage_bps });
        }
    }

    if let Some((chain, recipient)) = req.recipient {
        if !req.recipient_is_agent && !global.allows_recipient(chain, recipient) {
            violations.push(PolicyViolation::RecipientNotAllowed { chain: chain.to_string(), recipient: recipient.to_string() });
        }
    }

    if let Some(price) = &req.price {
        if let Some(v) = check_price_floor(global, price) {
            violations.push(v);
        }
    }

    if req.amount > req.available_liquidity {
        violations.push(PolicyViolation::InsufficientTreasuryLiquidity {
            available: U128(req.available_liquidity),
            amount: U128(req.amount),
        });
    }

    let limits = EffectiveLimits {
        epoch: U64(epoch),
        max_tx_amount_yocto: U128(max_tx),
        agent_epoch_cap: U128(agent_cap),
        agent_epoch_spent: U128(agent_spent),
        global_epoch_cap: U128(global_cap),
        global_epoch_spent: U128(global_spent),
        allowed_target_chains: chains,
        allowed_contract_ids: contracts,
        require_tee_attestation: global.require_tee_attestation || agent.policy.require_tee_attestation,
    };
    (violations, limits)
}

// State transitions stay together so their source locations remain stable in reproducible WASM.
// Keep metadata-only edits above this boundary deliberate: Rust embeds panic source locations.
// Internal state transitions

impl AegisCore {
    pub(crate) fn record_security_event(
        &mut self,
        kind: &str,
        agent_id: Option<&AccountId>,
        severity: Severity,
        codes: Vec<String>,
        detail: String,
    ) {
        let seq = self.next_event_seq;
        self.next_event_seq += 1;
        let event = SecurityEvent {
            seq: U64(seq),
            kind: kind.to_string(),
            agent_id: agent_id.cloned(),
            severity,
            codes,
            detail,
            at_ns: U64(env::block_timestamp()),
            block_height: U64(env::block_height()),
        };
        if self.security_events.len() < SECURITY_EVENT_CAPACITY {
            self.security_events.push(event);
        } else {
            let slot = (seq % u64::from(SECURITY_EVENT_CAPACITY)) as u32;
            self.security_events.replace(slot, event);
        }
    }

    /// Deletes a contract-account agent key and stops counting its gas allowance as an obligation.
    pub(crate) fn delete_contract_key(&mut self, agent: &mut AgentRecord) -> bool {
        if agent.spawn_mode != SpawnMode::ContractKey || !agent.key_active {
            return false;
        }
        Promise::new(env::current_account_id()).delete_key(agent.public_key.clone()).detach();
        agent.key_active = false;
        self.treasury.contract_key_allowances = self.treasury.contract_key_allowances.saturating_sub(agent.allowance_cap.0);
        true
    }

    /// Freezes an agent. Contract-key agents also lose their access key on-chain.
    /// Returns `true` when an on-chain key revocation was scheduled.
    pub(crate) fn quarantine_agent(&mut self, agent_id: &AccountId, reason: String, codes: Vec<String>, automatic: bool) -> bool {
        let Some(mut agent) = self.agents.get(agent_id).cloned() else {
            env::panic_str("AEGIS_E_UNKNOWN_AGENT");
        };
        if matches!(agent.status, AgentStatus::Quarantined { .. } | AgentStatus::Revoked { .. }) {
            return false;
        }
        agent.status = AgentStatus::Quarantined {
            reason: reason.clone(),
            at_ns: U64(env::block_timestamp()),
            block_height: U64(env::block_height()),
        };
        let key_revoked = self.delete_contract_key(&mut agent);
        self.agents.insert(agent_id.clone(), agent);
        AegisEvent::AgentQuarantined {
            agent_id: agent_id.clone(),
            reason: reason.clone(),
            violation_codes: codes.clone(),
            automatic,
            key_revoked,
        }
        .emit();
        self.record_security_event("quarantine", Some(agent_id), Severity::Critical, codes, reason);
        key_revoked
    }

    /// Emits the violation, applies strikes and trips the circuit breaker when required.
    /// Returns the decision severity and whether the agent ended up quarantined.
    pub(crate) fn apply_circuit_breaker(
        &mut self,
        agent_id: &AccountId,
        method: &str,
        violations: &[PolicyViolation],
    ) -> (Severity, bool) {
        let severity = max_severity(violations);
        if severity == Severity::None {
            return (severity, false);
        }
        let codes: Vec<String> = violations.iter().map(|v| v.code().to_string()).collect();
        AegisEvent::PolicyViolation {
            agent_id: agent_id.clone(),
            method: method.to_string(),
            severity: severity.as_str().to_string(),
            violations: violations.to_vec(),
        }
        .emit();
        self.record_security_event(
            "policy_violation",
            Some(agent_id),
            severity,
            codes.clone(),
            format!("{method} rejected by policy engine"),
        );

        if severity < Severity::Warning {
            return (severity, false);
        }
        let Some(mut agent) = self.agents.get(agent_id).cloned() else {
            return (severity, false);
        };
        if agent.status != AgentStatus::Active {
            return (severity, false);
        }
        agent.violations += 1;
        let strikes = agent.violations;
        self.agents.insert(agent_id.clone(), agent);
        let trip =
            self.policy.auto_quarantine && (severity == Severity::Critical || strikes >= self.policy.quarantine_after_strikes);
        if trip {
            let reason = if severity == Severity::Critical {
                format!("circuit breaker: critical violation in {method}")
            } else {
                format!("circuit breaker: {strikes} policy strikes")
            };
            self.quarantine_agent(agent_id, reason, codes, true);
        }
        (severity, trip)
    }
}

// Governance and kill-switch methods

#[near]
impl AegisCore {
    /// Owner (human / DAO) replaces the global policy.
    pub fn update_global_policy(&mut self, policy: GlobalPolicy) {
        self.assert_owner();
        policy.validate();
        self.policy = policy;
        AegisEvent::PolicyUpdated { scope: "global".to_string() }.emit();
        self.record_security_event("policy_updated", None, Severity::None, vec![], "global policy updated".to_string());
    }

    /// Owner tightens or loosens the limits of one agent.
    pub fn set_agent_policy(&mut self, agent_id: AccountId, policy: AgentPolicy) {
        self.assert_owner();
        policy.validate();
        let mut agent = self.agents.get(&agent_id).cloned().unwrap_or_else(|| env::panic_str("AEGIS_E_UNKNOWN_AGENT"));
        agent.policy = policy;
        self.agents.insert(agent_id.clone(), agent);
        AegisEvent::PolicyUpdated { scope: format!("agent:{agent_id}") }.emit();
        self.record_security_event("policy_updated", Some(&agent_id), Severity::None, vec![], "agent policy updated".to_string());
    }

    /// Global kill switch. The owner can pause and resume; a Sentinel agent can only pause.
    pub fn set_protocol_paused(&mut self, paused: bool, reason: String) {
        require!(is_safe_ascii(&reason, 160), "AEGIS_E_INVALID_REASON");
        if !self.is_owner_call() {
            let agent = self.caller_agent("set_protocol_paused");
            require!(agent.role == AgentRole::Sentinel, "AEGIS_E_UNAUTHORIZED");
            require!(agent.status == AgentStatus::Active, "AEGIS_E_AGENT_NOT_ACTIVE");
            require!(paused, "AEGIS_E_ONLY_OWNER_CAN_RESUME");
        }
        self.paused = paused;
        AegisEvent::ProtocolPaused { paused, reason: reason.clone() }.emit();
        let severity = if paused { Severity::Critical } else { Severity::None };
        self.record_security_event("kill_switch", None, severity, vec![], reason);
    }

    /// Manual freeze by the owner.
    pub fn freeze_agent(&mut self, agent_id: AccountId, reason: String) -> bool {
        self.assert_owner();
        require!(is_safe_ascii(&reason, 160), "AEGIS_E_INVALID_REASON");
        self.quarantine_agent(&agent_id, format!("owner freeze: {reason}"), vec!["manual_freeze".to_string()], false)
    }

    /// Sentinel trips the breaker on another agent after an off-chain audit finding.
    pub fn report_agent(&mut self, agent_id: AccountId, reason: String, evidence_hash: String) -> bool {
        let reporter = self.caller_agent("report_agent");
        require!(reporter.role == AgentRole::Sentinel, "AEGIS_E_UNAUTHORIZED");
        require!(reporter.status == AgentStatus::Active, "AEGIS_E_AGENT_NOT_ACTIVE");
        require!(reporter.agent_id != agent_id, "AEGIS_E_SELF_REPORT");
        require!(is_safe_ascii(&reason, 160), "AEGIS_E_INVALID_REASON");
        require!(crate::codec::is_hash32_hex(&evidence_hash), "AEGIS_E_INVALID_EVIDENCE_HASH");
        let detail = format!("sentinel {} report: {} [evidence {}]", reporter.agent_id, reason, evidence_hash);
        self.quarantine_agent(&agent_id, detail, vec!["sentinel_report".to_string()], false)
    }

    /// Owner lifts a quarantine after review. Revoked contract keys are re-provisioned.
    pub fn reinstate_agent(&mut self, agent_id: AccountId) {
        self.assert_owner();
        let mut agent = self.agents.get(&agent_id).cloned().unwrap_or_else(|| env::panic_str("AEGIS_E_UNKNOWN_AGENT"));
        require!(matches!(agent.status, AgentStatus::Quarantined { .. }), "AEGIS_E_NOT_QUARANTINED");
        agent.status = AgentStatus::Active;
        agent.violations = 0;
        if agent.spawn_mode == SpawnMode::ContractKey && !agent.key_active {
            Promise::new(env::current_account_id())
                .add_access_key_allowance(
                    agent.public_key.clone(),
                    key_allowance(agent.allowance_cap.0),
                    env::current_account_id(),
                    agent.allowed_methods.join(","),
                )
                .detach();
            agent.key_active = true;
            self.treasury.contract_key_allowances += agent.allowance_cap.0;
        }
        self.agents.insert(agent_id.clone(), agent);
        AegisEvent::AgentReinstated { agent_id: agent_id.clone() }.emit();
        self.record_security_event("reinstated", Some(&agent_id), Severity::None, vec![], "owner reinstated agent".to_string());
    }

    pub fn get_global_policy(&self) -> GlobalPolicy {
        self.policy.clone()
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// Newest first.
    pub fn get_security_events(&self, limit: Option<u32>) -> Vec<SecurityEvent> {
        let limit = limit.unwrap_or(30).min(SECURITY_EVENT_CAPACITY);
        let mut events: Vec<SecurityEvent> = self.security_events.iter().cloned().collect();
        events.sort_by_key(|e| std::cmp::Reverse(e.seq.0));
        events.truncate(limit as usize);
        events
    }
}

//! NEP-297 events. Every state transition that matters to an indexer, auditor or
//! the PhalanxSwarm UI is logged as `EVENT_JSON:{"standard":"aegis","version":"1.0.0",...}`.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

use crate::policy::PolicyViolation;
use crate::subaccounts::{AgentRole, SpawnMode};
use crate::swarm_market::AuctionKind;

/// One payout leg of a revenue distribution.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayoutLeg {
    pub account_id: AccountId,
    pub amount: U128,
    pub label: String,
}

#[near(event_json(standard = "aegis"))]
pub enum AegisEvent {
    #[event_version("1.0.0")]
    TreasuryFunded { from: AccountId, amount: U128, kind: String, memo: Option<String> },
    #[event_version("1.0.0")]
    AgentSpawnRequested {
        agent_id: AccountId,
        role: AgentRole,
        spawn_mode: SpawnMode,
        public_key: String,
        allowed_methods: Vec<String>,
        allowance_cap: U128,
    },
    #[event_version("1.0.0")]
    AgentSpawned { agent_id: AccountId, role: AgentRole },
    #[event_version("1.0.0")]
    AgentSpawnFailed { agent_id: AccountId, refunded: U128 },
    #[event_version("1.0.0")]
    AgentQuarantined { agent_id: AccountId, reason: String, violation_codes: Vec<String>, automatic: bool, key_revoked: bool },
    #[event_version("1.0.0")]
    AgentReinstated { agent_id: AccountId },
    #[event_version("1.0.0")]
    AgentRevoked { agent_id: AccountId },
    #[event_version("1.0.0")]
    PolicyViolation { agent_id: AccountId, method: String, severity: String, violations: Vec<PolicyViolation> },
    #[event_version("1.0.0")]
    PolicyUpdated { scope: String },
    #[event_version("1.0.0")]
    ProtocolPaused { paused: bool, reason: String },
    #[event_version("1.0.0")]
    TaskPosted { task_id: U64, poster: AccountId, budget_ceiling: U128, auction: AuctionKind },
    #[event_version("1.0.0")]
    BidSubmitted { task_id: U64, agent_id: AccountId, phase: String },
    #[event_version("1.0.0")]
    AuctionClosed { task_id: U64, winner: Option<AccountId>, winning_price: Option<U128>, score_bps: Option<u32> },
    #[event_version("1.0.0")]
    EscrowLocked { task_id: U64, payee: AccountId, amount: U128 },
    #[event_version("1.0.0")]
    AttestationVerified { receipt_hash: String, enclave_id: String, agent_id: AccountId, subject: String },
    #[event_version("1.0.0")]
    AttestationRejected { agent_id: AccountId, subject: String, reason: String },
    #[event_version("1.0.0")]
    TaskSettled { task_id: U64, payee: AccountId, amount: U128, receipt_hash: String },
    #[event_version("1.0.0")]
    TaskClosedWithoutSettlement { task_id: U64, status: String, refunded: U128 },
    #[event_version("1.0.0")]
    PayoutFailed { task_id: U64, payee: AccountId, amount: U128 },
    #[event_version("1.0.0")]
    IntentCommitted {
        intent_id: U64,
        agent_id: AccountId,
        nep413_hash: String,
        amount: U128,
        destination_chain: String,
        recipient: String,
        status: String,
    },
    #[event_version("1.0.0")]
    IntentRejected { intent_id: U64, agent_id: AccountId, nep413_hash: String, violation_codes: Vec<String> },
    #[event_version("1.0.0")]
    MpcSignatureRequested { intent_id: U64, mpc_contract_id: AccountId, path: String, payload_hex: String },
    #[event_version("1.0.0")]
    MpcSignatureResolved { intent_id: U64, ok: bool, detail: String },
    #[event_version("1.0.0")]
    IntentSettled { intent_id: U64, settlement_ref: String, dry_run: bool },
    #[event_version("1.0.0")]
    IntentCancelled { intent_id: U64, released: U128 },
    #[event_version("1.0.0")]
    RevenueDistributed { distribution_id: U64, total: U128, retained: U128, payouts: Vec<PayoutLeg> },
    #[event_version("1.0.0")]
    EnclaveRegistered { enclave_id: String, measurement: String, vendor: String },
    #[event_version("1.0.0")]
    EarningsCredited { agent_id: AccountId, amount: U128, source: String },
    #[event_version("1.0.0")]
    AgentPaid { from: AccountId, to: AccountId, amount: U128, internal: bool, memo: Option<String> },
    #[event_version("1.0.0")]
    EarningsWithdrawn { agent_id: AccountId, payout_account: AccountId, amount: U128 },
    #[event_version("1.0.0")]
    PaymentFailed { agent_id: AccountId, to: AccountId, amount: U128 },
    #[event_version("1.0.0")]
    VendorPaid { intent_id: U64, recipient: AccountId, amount: U128 },
    #[event_version("1.0.0")]
    VendorPaymentFailed { intent_id: U64, recipient: AccountId, amount: U128 },
    #[event_version("1.0.0")]
    EvmTransferRequested {
        tx_id: U64,
        agent_id: AccountId,
        chain: String,
        chain_id: U64,
        to: String,
        asset: String,
        amount: U128,
        signing_hash: String,
    },
    #[event_version("1.0.0")]
    EvmTransferRejected { tx_id: U64, agent_id: AccountId, violation_codes: Vec<String> },
    #[event_version("1.0.0")]
    EvmTransferSigned { tx_id: U64, tx_hash: String, path: String },
    #[event_version("1.0.0")]
    EvmTransferConfirmed { tx_id: U64, tx_hash: String, confirmed_by: AccountId },
    #[event_version("1.0.0")]
    EvmCancelRequested { tx_id: U64, cancel_tx_id: U64, requested_by: AccountId },
    #[event_version("1.0.0")]
    EvmTransferCancelled { tx_id: U64, cancel_tx_id: U64 },
    #[event_version("1.0.0")]
    RecipientBlocked { recipient: String, reason: String, evidence_hash: String, reported_by: AccountId },
    #[event_version("1.0.0")]
    RecipientUnblocked { recipient: String, by: AccountId },
}

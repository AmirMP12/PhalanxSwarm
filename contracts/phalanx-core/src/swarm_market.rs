//! Swarm Coordination & Bidding Market (tracks: swarms, agents, business).
//!
//! An orchestrator agent posts a `TaskRfp` with a budget ceiling (reserved from the treasury
//! under policy), deadlines and a verification schema. Worker agents compete:
//!
//! * `SealedBid`: commit `sha256(borsh(task_id, agent_id, price, latency, salt))`, then reveal.
//!   Bids stay private until the reveal phase. The best weighted score wins (price 50%,
//!   latency 20%, reputation 30%).  Reputation uses square-root dampening to prevent
//!   incumbent monopoly: the marginal scoring benefit of each additional 250 bps
//!   diminishes, so a cheaper or faster newcomer can outbid a high-reputation incumbent.
//! * `ReverseDutch`: the offered price rises linearly from `dutch_start_price` to the ceiling;
//!   the first worker to accept wins at the current price.
//!
//! Nothing self-reported decides an auction: price and latency are binding terms (the winner's
//! promised latency becomes its execution deadline, and missing it fails the task and costs
//! reputation), and reputation is earned on-chain only through verified work. An RFP can require
//! `min_reputation_bps`, which keeps unvetted agents out.
//!
//! The DAO, not the posting agent, decides what releases escrow: an agent-posted RFP may pin only
//! a task prompt in `GlobalPolicy.task_prompt_hashes`, and its confidence and reputation floors must
//! meet the DAO's (`min_task_confidence_bps`, `min_task_reputation_bps`).
//!
//! The winning price is locked in escrow and released by `execute_verified_task` only after
//! `attestation.rs` verifies the TEE proof. It is credited to the winner's spendable balance.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId};

use crate::attestation::{AttestationError, ExecutionProof, ReceiptExpectation};
use crate::codec::{is_hash32_hex, is_lower_hash32_hex, is_safe_ascii, to_hex};
use crate::events::PhalanxEvent;
use crate::policy::{evaluate_spend, PolicyViolation, Severity, SpendRequest};
use crate::subaccounts::{AgentRecord, AgentRole, AgentStatus};
use crate::{PhalanxCore, PhalanxCoreExt};

pub const MAX_BIDDERS: u32 = 16;
pub const MAX_LATENCY_SEC: u32 = 86_400;
pub const MIN_EXECUTION_SEC: u64 = 60;
const NS: u64 = 1_000_000_000;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuctionKind {
    SealedBid,
    ReverseDutch,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Bidding,
    Revealing,
    Awarded,
    Completed,
    Failed,
    Expired,
    Cancelled,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Bidding => "bidding",
            TaskStatus::Revealing => "revealing",
            TaskStatus::Awarded => "awarded",
            TaskStatus::Completed => "completed",
            TaskStatus::Failed => "failed",
            TaskStatus::Expired => "expired",
            TaskStatus::Cancelled => "cancelled",
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerificationSchema {
    pub schema_id: String,
    /// Hex sha256 of the output schema; the TEE proof must carry the same hash.
    pub schema_hash: String,
    /// Minimum confidence in the TEE-attested output (read from the signed model response).
    pub min_confidence_bps: u32,
    /// Minimum on-chain reputation a bidder needs.
    pub min_reputation_bps: u32,
    /// Hex sha256 of the system prompt every NEAR AI proof for this task must use. The poster
    /// pins it, so the worker cannot write its own instructions. `None`: only enclave receipts.
    #[serde(default)]
    pub prompt_hash: Option<String>,
    /// The model's user message must be the exact task spec (`sha256 == spec_hash`). Use it when
    /// the whole input is known when the task is posted.
    #[serde(default)]
    pub input_pinned: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskRfpInput {
    pub title: String,
    pub category: String,
    /// Hex sha256 of the full (private) task specification shared with bidders off-chain.
    pub spec_hash: String,
    pub budget_ceiling: U128,
    pub auction: AuctionKind,
    pub dutch_start_price: Option<U128>,
    pub bidding_window_sec: u64,
    pub reveal_window_sec: Option<u64>,
    pub execution_window_sec: u64,
    pub deadline_epochs: u64,
    pub max_bidders: u32,
    pub verification: VerificationSchema,
    /// The customer order this task delivers (`orders.rs`).
    #[serde(default)]
    pub order_id: Option<U64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskRfp {
    pub task_id: U64,
    pub poster: AccountId,
    pub title: String,
    pub category: String,
    pub spec_hash: String,
    pub budget_ceiling: U128,
    pub auction: AuctionKind,
    pub dutch_start_price: U128,
    pub created_at_ns: U64,
    pub bidding_deadline_ns: U64,
    pub reveal_deadline_ns: U64,
    /// Upper bound for the winner's execution time.
    pub execution_window_sec: u64,
    /// Set when the task is awarded: award time + the winner's promised latency.
    pub execution_deadline_ns: U64,
    /// NEAR epoch height after which the task can no longer settle.
    pub deadline_epoch: U64,
    pub max_bidders: u32,
    pub verification: VerificationSchema,
    pub status: TaskStatus,
    pub bid_count: u32,
    pub revealed_count: u32,
    pub winner: Option<AccountId>,
    pub winning_price: Option<U128>,
    pub winning_score_bps: Option<u32>,
    pub winning_latency_sec: Option<u32>,
    pub receipt_hash: Option<String>,
    /// The customer order this task delivers, if any.
    pub order_id: Option<U64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BidAction {
    Commit { commitment: String },
    Reveal { price: U128, est_latency_sec: u32, salt: String },
    AcceptDutch { est_latency_sec: u32 },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentBid {
    pub task_id: U64,
    pub agent_id: AccountId,
    pub commitment: Option<String>,
    pub revealed: bool,
    pub price: Option<U128>,
    pub est_latency_sec: Option<u32>,
    /// The bidder's on-chain reputation when the bid was scored.
    pub reputation_bps: Option<u32>,
    pub score_bps: Option<u32>,
    pub submitted_at_ns: U64,
    pub revealed_at_ns: Option<U64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EscrowStatus {
    Locked,
    Released,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Escrow {
    pub task_id: U64,
    pub payee: AccountId,
    pub amount: U128,
    pub status: EscrowStatus,
    pub locked_at_ns: U64,
    pub closed_at_ns: Option<U64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskView {
    pub task: TaskRfp,
    pub bids: Vec<AgentBid>,
    pub escrow: Option<Escrow>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskPostOutcome {
    pub approved: bool,
    pub task: Option<TaskRfp>,
    pub severity: Severity,
    pub violations: Vec<PolicyViolation>,
    pub quarantined: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskExecutionOutcome {
    pub task_id: U64,
    pub settled: bool,
    /// Credited to the winner's spendable balance.
    pub payout: U128,
    pub receipt_hash: Option<String>,
    pub error: Option<String>,
    pub quarantined: bool,
}

/// Hex sha256 over the borsh encoding of the sealed-bid preimage.
pub fn bid_commitment(task_id: u64, agent_id: &str, price: u128, est_latency_sec: u32, salt: &str) -> String {
    let mut buf = Vec::with_capacity(64 + agent_id.len() + salt.len());
    buf.extend_from_slice(&task_id.to_le_bytes());
    buf.extend_from_slice(&(agent_id.len() as u32).to_le_bytes());
    buf.extend_from_slice(agent_id.as_bytes());
    buf.extend_from_slice(&price.to_le_bytes());
    buf.extend_from_slice(&est_latency_sec.to_le_bytes());
    buf.extend_from_slice(&(salt.len() as u32).to_le_bytes());
    buf.extend_from_slice(salt.as_bytes());
    to_hex(&env::sha256_array(buf))
}

/// Linear reverse-Dutch price: `start` at creation, `ceiling` at the bidding deadline.
pub fn dutch_price(start: u128, ceiling: u128, created_ns: u64, deadline_ns: u64, now_ns: u64) -> u128 {
    if now_ns <= created_ns {
        return start;
    }
    if now_ns >= deadline_ns || deadline_ns <= created_ns {
        return ceiling;
    }
    start + (ceiling - start) * u128::from(now_ns - created_ns) / u128::from(deadline_ns - created_ns)
}

/// Weighted bid score in basis points (price 50%, latency 20%, reputation 30%).
/// Requires `0 < price <= ceiling`.
///
/// Anti-monopoly design: reputation uses square-root dampening so that marginal gains
/// diminish as reputation grows.  A 5000 bps agent scores ~7071 effective, a 7250 bps
/// agent scores ~8515 — only +1444 effective for +2250 raw.  This prevents a single
/// incumbent from locking out competitive newcomers who offer lower prices or faster
/// delivery.  For full time-decay (EffectiveRep = BaseRep × e^{-λΔt}), the contract
/// would need per-agent timestamps on each delivery and a fixed-point exp(); the
/// sqrt() approximation achieves the same anti-monopoly property without extra storage.
pub fn score_bid(ceiling: u128, price: u128, est_latency_sec: u32, reputation_bps: u32) -> u32 {
    let price_score = ((ceiling - price) * 10_000 / ceiling) as u64;
    let latency = u64::from(est_latency_sec.min(MAX_LATENCY_SEC));
    let latency_score = 10_000 - latency * 10_000 / u64::from(MAX_LATENCY_SEC);
    // Square-root dampening: effective_rep = sqrt(raw / 10_000) * 10_000.
    // Integer approximation via Newton's method (3 iterations, exact for u32 inputs).
    let raw = u64::from(reputation_bps.min(10_000));
    let effective_rep = if raw == 0 {
        0
    } else {
        // sqrt(raw * 10_000) using Newton's method on raw * 10_000.
        let n = raw * 10_000;
        let mut x = n;
        x = (x + n / x) / 2;
        x = (x + n / x) / 2;
        x = (x + n / x) / 2;
        x = (x + n / x) / 2;
        x
    };
    let total = price_score * 50 + latency_score * 20 + effective_rep * 30;
    (total / 100) as u32
}

impl PhalanxCore {
    pub(crate) fn task_or_panic(&self, task_id: u64) -> TaskRfp {
        self.tasks.get(&task_id).cloned().unwrap_or_else(|| env::panic_str("PHALANX_E_UNKNOWN_TASK"))
    }

    /// Awards a task and locks its escrow. Returns `false` without touching the ledger when the
    /// task procures a customer order that has no delivery time left: awarding it would take the
    /// worker's money for work that can no longer be delivered, because `deliver_order` refuses a
    /// delivery past the order's deadline while `refund_order` returns the price to the customer.
    /// The caller must release the budget instead.
    fn award_task(
        &mut self,
        task: &mut TaskRfp,
        winner: &AgentRecord,
        price: u128,
        score: Option<u32>,
        latency_sec: u32,
    ) -> bool {
        let ceiling = task.budget_ceiling.0;
        let now = env::block_timestamp();
        // A task that procures an order may never outlive that order. Clamping the execution window
        // keeps a verified delivery and the customer's refund mutually exclusive.
        let mut execution_sec = u64::from(latency_sec).clamp(MIN_EXECUTION_SEC, task.execution_window_sec.max(MIN_EXECUTION_SEC));
        if let Some(order_id) = task.order_id {
            let order = self.order_or_panic(order_id.0);
            let remaining_sec = order.deadline_ns.0.saturating_sub(now) / NS;
            if remaining_sec == 0 {
                return false;
            }
            execution_sec = execution_sec.min(remaining_sec);
        }
        self.treasury.reserved_for_tasks =
            self.treasury.reserved_for_tasks.checked_sub(ceiling).unwrap_or_else(|| env::panic_str("PHALANX_E_LEDGER"));
        self.treasury.escrow_locked += price;
        self.treasury.liquid += ceiling - price;
        task.status = TaskStatus::Awarded;
        task.winner = Some(winner.agent_id.clone());
        task.winning_price = Some(U128(price));
        task.winning_score_bps = score;
        task.winning_latency_sec = Some(latency_sec);
        task.execution_deadline_ns = U64(now + execution_sec * NS);
        let escrow = Escrow {
            task_id: task.task_id,
            payee: winner.agent_id.clone(),
            amount: U128(price),
            status: EscrowStatus::Locked,
            locked_at_ns: U64(now),
            closed_at_ns: None,
        };
        self.escrows.insert(task.task_id.0, escrow);
        PhalanxEvent::AuctionClosed {
            task_id: task.task_id,
            winner: Some(winner.agent_id.clone()),
            winning_price: Some(U128(price)),
            score_bps: score,
        }
        .emit();
        PhalanxEvent::EscrowLocked { task_id: task.task_id, payee: winner.agent_id.clone(), amount: U128(price) }.emit();
        true
    }

    fn refund_escrow(&mut self, task_id: u64) -> u128 {
        let Some(mut escrow) = self.escrows.get(&task_id).cloned() else {
            return 0;
        };
        if escrow.status != EscrowStatus::Locked {
            return 0;
        }
        let amount = escrow.amount.0;
        escrow.status = EscrowStatus::Refunded;
        escrow.closed_at_ns = Some(U64(env::block_timestamp()));
        self.escrows.insert(task_id, escrow);
        self.treasury.escrow_locked -= amount;
        self.treasury.liquid += amount;
        amount
    }

    fn release_budget(&mut self, task: &TaskRfp) -> u128 {
        let ceiling = task.budget_ceiling.0;
        self.treasury.reserved_for_tasks -= ceiling;
        self.treasury.liquid += ceiling;
        ceiling
    }

    fn validate_rfp(rfp: &TaskRfpInput) {
        require!(!rfp.title.is_empty() && is_safe_ascii(&rfp.title, 96), "PHALANX_E_RFP: title");
        require!(!rfp.category.is_empty() && is_safe_ascii(&rfp.category, 32), "PHALANX_E_RFP: category");
        require!(is_hash32_hex(&rfp.spec_hash), "PHALANX_E_RFP: spec_hash must be 32-byte hex");
        require!(rfp.budget_ceiling.0 > 0, "PHALANX_E_RFP: budget_ceiling must be > 0");
        require!((10..=604_800).contains(&rfp.bidding_window_sec), "PHALANX_E_RFP: bidding_window_sec");
        require!((60..=2_592_000).contains(&rfp.execution_window_sec), "PHALANX_E_RFP: execution_window_sec");
        require!((1..=30).contains(&rfp.deadline_epochs), "PHALANX_E_RFP: deadline_epochs must be 1..=30");
        require!((1..=MAX_BIDDERS).contains(&rfp.max_bidders), "PHALANX_E_RFP: max_bidders must be 1..=16");
        require!(is_safe_ascii(&rfp.verification.schema_id, 64), "PHALANX_E_RFP: schema_id");
        require!(is_hash32_hex(&rfp.verification.schema_hash), "PHALANX_E_RFP: schema_hash");
        require!(rfp.verification.min_confidence_bps <= 10_000, "PHALANX_E_RFP: min_confidence_bps");
        require!(rfp.verification.min_reputation_bps <= 10_000, "PHALANX_E_RFP: min_reputation_bps");
        require!(
            rfp.verification.prompt_hash.as_deref().map(is_lower_hash32_hex).unwrap_or(true),
            "PHALANX_E_RFP: prompt_hash must be 32-byte lower-case hex"
        );
        require!(
            !rfp.verification.input_pinned || rfp.verification.prompt_hash.is_some(),
            "PHALANX_E_RFP: input_pinned needs prompt_hash"
        );
        match rfp.auction {
            AuctionKind::SealedBid => {
                let reveal = rfp.reveal_window_sec.unwrap_or(0);
                require!((10..=604_800).contains(&reveal), "PHALANX_E_RFP: sealed bids need reveal_window_sec");
            }
            AuctionKind::ReverseDutch => {
                let start = rfp.dutch_start_price.map(|p| p.0).unwrap_or(0);
                require!(start > 0 && start < rfp.budget_ceiling.0, "PHALANX_E_RFP: dutch_start_price must be in (0, ceiling)");
            }
        }
    }
}

#[near]
impl PhalanxCore {
    /// Orchestrator agents (or the owner) decompose goals into budgeted tasks.
    /// The budget is checked by the policy engine and reserved from treasury liquidity.
    pub fn post_task_rfp(&mut self, rfp: TaskRfpInput) -> TaskPostOutcome {
        Self::validate_rfp(&rfp);
        let now = env::block_timestamp();
        let epoch = env::epoch_height();
        let amount = rfp.budget_ceiling.0;

        let poster = if self.is_owner_call() {
            require!(!self.paused, "PHALANX_E_PAUSED");
            require!(amount <= self.available_liquidity(), "PHALANX_E_INSUFFICIENT_LIQUIDITY");
            self.owner_id.clone()
        } else {
            let agent = self.caller_agent("post_task_rfp");
            require!(agent.role == AgentRole::Orchestrator, "PHALANX_E_ONLY_ORCHESTRATOR");
            let req = SpendRequest::reservation(amount, self.available_liquidity());
            let (mut violations, _limits) = evaluate_spend(&self.policy, self.paused, &agent, &self.treasury, epoch, &req);
            // The DAO decides what releases escrow: approved prompts and minimum floors only.
            if let Some(prompt_hash) = &rfp.verification.prompt_hash {
                if !self.policy.task_prompt_hashes.contains(prompt_hash) {
                    violations.push(PolicyViolation::TaskPromptNotApproved { prompt_hash: prompt_hash.clone() });
                }
            }
            let floors = [
                ("min_confidence_bps", rfp.verification.min_confidence_bps, self.policy.min_task_confidence_bps),
                ("min_reputation_bps", rfp.verification.min_reputation_bps, self.policy.min_task_reputation_bps),
            ];
            for (field, value, floor) in floors {
                if value < floor {
                    violations.push(PolicyViolation::TaskFloorBelowPolicy { field: field.to_string(), value, floor });
                }
            }
            if !violations.is_empty() {
                let (severity, quarantined) = self.apply_circuit_breaker(&agent.agent_id, "post_task_rfp", &violations);
                return TaskPostOutcome { approved: false, task: None, severity, violations, quarantined };
            }
            let mut a = agent.clone();
            self.charge_epoch_spend(&mut a, amount, epoch);
            self.agents.insert(a.agent_id.clone(), a);
            agent.agent_id
        };

        self.treasury.liquid -= amount;
        self.treasury.reserved_for_tasks += amount;

        let task_id = self.next_task_id;
        self.next_task_id += 1;
        self.link_order(&rfp, task_id);
        let bidding_deadline = now + rfp.bidding_window_sec * NS;
        let reveal_deadline = match rfp.auction {
            AuctionKind::SealedBid => bidding_deadline + rfp.reveal_window_sec.unwrap_or(0) * NS,
            AuctionKind::ReverseDutch => bidding_deadline,
        };
        let task = TaskRfp {
            task_id: U64(task_id),
            poster: poster.clone(),
            title: rfp.title,
            category: rfp.category,
            spec_hash: rfp.spec_hash.to_lowercase(),
            budget_ceiling: rfp.budget_ceiling,
            auction: rfp.auction,
            dutch_start_price: rfp.dutch_start_price.unwrap_or(U128(0)),
            created_at_ns: U64(now),
            bidding_deadline_ns: U64(bidding_deadline),
            reveal_deadline_ns: U64(reveal_deadline),
            execution_window_sec: rfp.execution_window_sec,
            execution_deadline_ns: U64(0),
            deadline_epoch: U64(epoch + rfp.deadline_epochs),
            max_bidders: rfp.max_bidders,
            verification: VerificationSchema {
                schema_id: rfp.verification.schema_id,
                schema_hash: rfp.verification.schema_hash.to_lowercase(),
                min_confidence_bps: rfp.verification.min_confidence_bps,
                min_reputation_bps: rfp.verification.min_reputation_bps,
                prompt_hash: rfp.verification.prompt_hash,
                input_pinned: rfp.verification.input_pinned,
            },
            status: TaskStatus::Bidding,
            bid_count: 0,
            revealed_count: 0,
            winner: None,
            winning_price: None,
            winning_score_bps: None,
            winning_latency_sec: None,
            receipt_hash: None,
            order_id: rfp.order_id,
        };
        self.tasks.insert(task_id, task.clone());
        self.bids.insert(task_id, Vec::new());
        PhalanxEvent::TaskPosted { task_id: U64(task_id), poster, budget_ceiling: task.budget_ceiling, auction: task.auction }
            .emit();
        TaskPostOutcome { approved: true, task: Some(task), severity: Severity::None, violations: vec![], quarantined: false }
    }

    /// Worker agents commit, reveal, or accept a reverse-Dutch price.
    pub fn submit_bid(&mut self, task_id: U64, action: BidAction) -> AgentBid {
        let agent = self.caller_agent("submit_bid");
        require!(!self.paused, "PHALANX_E_PAUSED");
        require!(agent.status == AgentStatus::Active, "PHALANX_E_AGENT_NOT_ACTIVE");
        require!(agent.role.can_bid(), "PHALANX_E_ROLE_CANNOT_BID");
        let mut task = self.task_or_panic(task_id.0);
        require!(task.poster != agent.agent_id, "PHALANX_E_POSTER_CANNOT_BID");
        let now = env::block_timestamp();
        let mut bids = self.bids.get(&task_id.0).cloned().unwrap_or_default();

        let bid = match action {
            BidAction::Commit { commitment } => {
                require!(task.auction == AuctionKind::SealedBid, "PHALANX_E_NOT_SEALED_AUCTION");
                require!(
                    task.status == TaskStatus::Bidding && now <= task.bidding_deadline_ns.0,
                    "PHALANX_E_COMMIT_PHASE_CLOSED"
                );
                require!(task.bid_count < task.max_bidders, "PHALANX_E_AUCTION_FULL");
                require!(agent.reputation_bps >= task.verification.min_reputation_bps, "PHALANX_E_REPUTATION_BELOW_SCHEMA");
                require!(is_hash32_hex(&commitment), "PHALANX_E_INVALID_COMMITMENT");
                require!(!bids.iter().any(|b| b.agent_id == agent.agent_id), "PHALANX_E_ALREADY_BID");
                let bid = AgentBid {
                    task_id,
                    agent_id: agent.agent_id.clone(),
                    commitment: Some(commitment.to_lowercase()),
                    revealed: false,
                    price: None,
                    est_latency_sec: None,
                    reputation_bps: None,
                    score_bps: None,
                    submitted_at_ns: U64(now),
                    revealed_at_ns: None,
                };
                bids.push(bid.clone());
                task.bid_count += 1;
                if task.bid_count == task.max_bidders {
                    task.status = TaskStatus::Revealing;
                }
                PhalanxEvent::BidSubmitted { task_id, agent_id: agent.agent_id.clone(), phase: "commit".to_string() }.emit();
                bid
            }
            BidAction::Reveal { price, est_latency_sec, salt } => {
                require!(task.auction == AuctionKind::SealedBid, "PHALANX_E_NOT_SEALED_AUCTION");
                let in_reveal = task.status == TaskStatus::Revealing
                    || (task.status == TaskStatus::Bidding && now > task.bidding_deadline_ns.0);
                require!(in_reveal && now <= task.reveal_deadline_ns.0, "PHALANX_E_REVEAL_PHASE_CLOSED");
                require!(is_safe_ascii(&salt, 64) && salt.len() >= 8, "PHALANX_E_INVALID_SALT");
                require!(price.0 > 0 && price.0 <= task.budget_ceiling.0, "PHALANX_E_PRICE_OUT_OF_RANGE");
                require!(est_latency_sec <= MAX_LATENCY_SEC, "PHALANX_E_INVALID_LATENCY");
                let expected = bid_commitment(task_id.0, agent.agent_id.as_str(), price.0, est_latency_sec, &salt);
                let pos = bids
                    .iter()
                    .position(|b| b.agent_id == agent.agent_id)
                    .unwrap_or_else(|| env::panic_str("PHALANX_E_NO_COMMITMENT"));
                require!(!bids[pos].revealed, "PHALANX_E_ALREADY_REVEALED");
                require!(bids[pos].commitment.as_deref() == Some(expected.as_str()), "PHALANX_E_COMMITMENT_MISMATCH");
                let score = score_bid(task.budget_ceiling.0, price.0, est_latency_sec, agent.reputation_bps);
                let bid = &mut bids[pos];
                bid.revealed = true;
                bid.price = Some(price);
                bid.est_latency_sec = Some(est_latency_sec);
                bid.reputation_bps = Some(agent.reputation_bps);
                bid.score_bps = Some(score);
                bid.revealed_at_ns = Some(U64(now));
                let bid = bid.clone();
                task.revealed_count += 1;
                task.status = TaskStatus::Revealing;
                PhalanxEvent::BidSubmitted { task_id, agent_id: agent.agent_id.clone(), phase: "reveal".to_string() }.emit();
                bid
            }
            BidAction::AcceptDutch { est_latency_sec } => {
                require!(task.auction == AuctionKind::ReverseDutch, "PHALANX_E_NOT_DUTCH_AUCTION");
                require!(task.status == TaskStatus::Bidding && now <= task.bidding_deadline_ns.0, "PHALANX_E_AUCTION_CLOSED");
                require!(agent.reputation_bps >= task.verification.min_reputation_bps, "PHALANX_E_REPUTATION_BELOW_SCHEMA");
                require!(est_latency_sec <= MAX_LATENCY_SEC, "PHALANX_E_INVALID_LATENCY");
                let price = dutch_price(
                    task.dutch_start_price.0,
                    task.budget_ceiling.0,
                    task.created_at_ns.0,
                    task.bidding_deadline_ns.0,
                    now,
                );
                let score = score_bid(task.budget_ceiling.0, price, est_latency_sec, agent.reputation_bps);
                let bid = AgentBid {
                    task_id,
                    agent_id: agent.agent_id.clone(),
                    commitment: None,
                    revealed: true,
                    price: Some(U128(price)),
                    est_latency_sec: Some(est_latency_sec),
                    reputation_bps: Some(agent.reputation_bps),
                    score_bps: Some(score),
                    submitted_at_ns: U64(now),
                    revealed_at_ns: Some(U64(now)),
                };
                bids.push(bid.clone());
                task.bid_count += 1;
                task.revealed_count += 1;
                PhalanxEvent::BidSubmitted { task_id, agent_id: agent.agent_id.clone(), phase: "accept_dutch".to_string() }
                    .emit();
                if !self.award_task(&mut task, &agent, price, Some(score), est_latency_sec) {
                    // The order behind this task can no longer be delivered. Revert the accept: the
                    // task stays open, and `expire_task` releases its budget at the bidding deadline.
                    env::panic_str("PHALANX_E_ORDER: the delivery deadline has passed");
                }
                bid
            }
        };
        self.bids.insert(task_id.0, bids);
        self.tasks.insert(task_id.0, task);
        bid
    }

    /// Closes a sealed-bid auction: picks the best eligible revealed bid and locks escrow.
    /// Callable by the poster or owner once all bids are revealed, by anyone after the reveal deadline.
    pub fn close_auction(&mut self, task_id: U64) -> TaskRfp {
        let mut task = self.task_or_panic(task_id.0);
        require!(task.auction == AuctionKind::SealedBid, "PHALANX_E_NOT_SEALED_AUCTION");
        require!(matches!(task.status, TaskStatus::Bidding | TaskStatus::Revealing), "PHALANX_E_AUCTION_NOT_OPEN");
        let now = env::block_timestamp();
        let reveal_reached = task.status == TaskStatus::Revealing || now > task.bidding_deadline_ns.0;
        require!(reveal_reached, "PHALANX_E_COMMIT_PHASE_ACTIVE");
        let reveal_over = now > task.reveal_deadline_ns.0;
        require!(reveal_over || task.revealed_count == task.bid_count, "PHALANX_E_REVEALS_PENDING");
        let authorized = reveal_over
            || self.is_owner_call()
            || self.resolve_agent_caller().map(|a| a.agent_id == task.poster && a.status == AgentStatus::Active).unwrap_or(false);
        require!(authorized, "PHALANX_E_UNAUTHORIZED");

        let bids = self.bids.get(&task_id.0).cloned().unwrap_or_default();
        let ceiling = task.budget_ceiling.0;
        let min_rep = task.verification.min_reputation_bps;
        let mut best: Option<(&AgentBid, u32, u128, u32)> = None;
        for bid in bids.iter().filter(|b| b.revealed) {
            let (Some(price), Some(latency), Some(score)) = (bid.price, bid.est_latency_sec, bid.score_bps) else {
                continue;
            };
            if price.0 == 0 || price.0 > ceiling {
                continue;
            }
            // Reputation is re-read: a bidder that failed or was quarantined since revealing is out.
            let eligible = self
                .agents
                .get(&bid.agent_id)
                .map(|a| a.status == AgentStatus::Active && a.reputation_bps >= min_rep)
                .unwrap_or(false);
            if !eligible {
                continue;
            }
            let better = match best {
                None => true,
                Some((b, s, p, _)) => {
                    score > s
                        || (score == s && price.0 < p)
                        || (score == s && price.0 == p && bid.revealed_at_ns < b.revealed_at_ns)
                        || (score == s && price.0 == p && bid.revealed_at_ns == b.revealed_at_ns && bid.agent_id < b.agent_id)
                }
            };
            if better {
                best = Some((bid, score, price.0, latency));
            }
        }

        match best {
            Some((bid, score, price, latency)) => {
                let winner = self.agent_or_panic(&bid.agent_id);
                if !self.award_task(&mut task, &winner, price, Some(score), latency) {
                    // The order's delivery deadline passed while the auction ran: award nothing and
                    // return the budget. Paying a winner here would strand the customer's price.
                    let refunded = self.release_budget(&task);
                    task.status = TaskStatus::Expired;
                    task.winner = None;
                    self.reopen_order(&task);
                    PhalanxEvent::AuctionClosed { task_id, winner: None, winning_price: None, score_bps: None }.emit();
                    PhalanxEvent::TaskClosedWithoutSettlement {
                        task_id,
                        status: "expired".to_string(),
                        refunded: U128(refunded),
                    }
                    .emit();
                }
            }
            None => {
                let refunded = self.release_budget(&task);
                task.status = TaskStatus::Expired;
                self.reopen_order(&task);
                PhalanxEvent::AuctionClosed { task_id, winner: None, winning_price: None, score_bps: None }.emit();
                PhalanxEvent::TaskClosedWithoutSettlement { task_id, status: "expired".to_string(), refunded: U128(refunded) }
                    .emit();
            }
        }
        self.tasks.insert(task_id.0, task.clone());
        task
    }

    /// The winner proves execution with a TEE proof; escrow is released to its balance atomically.
    pub fn execute_verified_task(&mut self, task_id: U64, proof: ExecutionProof) -> TaskExecutionOutcome {
        let agent = self.caller_agent("execute_verified_task");
        require!(!self.paused, "PHALANX_E_PAUSED");
        require!(agent.status == AgentStatus::Active, "PHALANX_E_AGENT_NOT_ACTIVE");
        let mut task = self.task_or_panic(task_id.0);
        require!(task.status == TaskStatus::Awarded, "PHALANX_E_TASK_NOT_AWARDED");
        require!(task.winner.as_ref() == Some(&agent.agent_id), "PHALANX_E_NOT_TASK_WINNER");
        let now = env::block_timestamp();
        require!(
            now <= task.execution_deadline_ns.0 && env::epoch_height() <= task.deadline_epoch.0,
            "PHALANX_E_EXECUTION_DEADLINE_PASSED"
        );

        let exp = ReceiptExpectation {
            subject_kind: "task",
            subject_id: task_id.0,
            agent_id: &agent.agent_id,
            schema_hash: Some(&task.verification.schema_hash),
            input_hash: Some(&task.spec_hash),
            verdict: "completed",
            min_confidence_bps: task.verification.min_confidence_bps,
            prompt_hash: task.verification.prompt_hash.as_deref(),
            user_message: task.verification.input_pinned.then_some((task.spec_hash.as_str(), AttestationError::PromptMismatch)),
        };
        match self.verify_proof(&proof, &exp) {
            Ok((hash, receipt)) => {
                self.record_attestation(&hash, &proof, &receipt);
                let mut escrow = self.escrows.get(&task_id.0).cloned().unwrap_or_else(|| env::panic_str("PHALANX_E_NO_ESCROW"));
                let amount = escrow.amount.0;
                escrow.status = EscrowStatus::Released;
                escrow.closed_at_ns = Some(U64(now));
                self.escrows.insert(task_id.0, escrow);
                self.treasury.escrow_locked -= amount;
                self.treasury.total_operating_costs += amount;
                self.treasury.agent_balances += amount;
                self.credit_agent(&agent.agent_id, amount, &format!("task {}", task_id.0));

                let mut worker = self.agent_or_panic(&agent.agent_id);
                worker.tasks_completed += 1;
                worker.reputation_bps = (worker.reputation_bps + 250).min(10_000);
                self.agents.insert(worker.agent_id.clone(), worker);

                task.status = TaskStatus::Completed;
                task.receipt_hash = Some(hash.clone());
                self.deliver_order(&task, &receipt.output_hash, &hash);
                self.tasks.insert(task_id.0, task);
                PhalanxEvent::TaskSettled {
                    task_id,
                    payee: agent.agent_id.clone(),
                    amount: U128(amount),
                    receipt_hash: hash.clone(),
                }
                .emit();
                TaskExecutionOutcome {
                    task_id,
                    settled: true,
                    payout: U128(amount),
                    receipt_hash: Some(hash),
                    error: None,
                    quarantined: false,
                }
            }
            Err(err) => {
                let reason = err.reason().to_string();
                PhalanxEvent::AttestationRejected {
                    agent_id: agent.agent_id.clone(),
                    subject: format!("task:{}", task_id.0),
                    reason: reason.clone(),
                }
                .emit();
                self.record_security_event(
                    "attestation_rejected",
                    Some(&agent.agent_id),
                    if err.is_forgery() { Severity::Critical } else { Severity::Warning },
                    vec![reason.clone()],
                    format!("task {} proof rejected", task_id.0),
                );
                let mut worker = agent.clone();
                worker.tasks_failed += 1;
                worker.reputation_bps = worker.reputation_bps.saturating_sub(1_000);
                self.agents.insert(worker.agent_id.clone(), worker);

                let mut quarantined = false;
                if err.is_forgery() {
                    // Scam detection: forged or replayed proofs fail the task and trip the breaker.
                    let refunded = self.refund_escrow(task_id.0);
                    task.status = TaskStatus::Failed;
                    self.reopen_order(&task);
                    self.tasks.insert(task_id.0, task);
                    PhalanxEvent::TaskClosedWithoutSettlement { task_id, status: "failed".to_string(), refunded: U128(refunded) }
                        .emit();
                    let violation = PolicyViolation::InvalidTeeAttestation { reason: reason.clone() };
                    quarantined = self.apply_circuit_breaker(&agent.agent_id, "execute_verified_task", &[violation]).1;
                }
                TaskExecutionOutcome {
                    task_id,
                    settled: false,
                    payout: U128(0),
                    receipt_hash: None,
                    error: Some(reason),
                    quarantined,
                }
            }
        }
    }

    /// Anyone can close an overdue task: an awarded task past its execution deadline fails
    /// (escrow refunded, winner penalised); a reverse-Dutch task nobody accepted expires.
    pub fn expire_task(&mut self, task_id: U64) -> TaskRfp {
        let mut task = self.task_or_panic(task_id.0);
        let now = env::block_timestamp();
        match task.status {
            TaskStatus::Awarded => {
                require!(
                    now > task.execution_deadline_ns.0 || env::epoch_height() > task.deadline_epoch.0,
                    "PHALANX_E_NOT_OVERDUE"
                );
                let refunded = self.refund_escrow(task_id.0);
                task.status = TaskStatus::Failed;
                if let Some(winner) = task.winner.clone() {
                    if let Some(w) = self.agents.get_mut(&winner) {
                        w.tasks_failed += 1;
                        w.reputation_bps = w.reputation_bps.saturating_sub(500);
                    }
                }
                PhalanxEvent::TaskClosedWithoutSettlement { task_id, status: "failed".to_string(), refunded: U128(refunded) }
                    .emit();
            }
            TaskStatus::Bidding if task.auction == AuctionKind::ReverseDutch => {
                require!(now > task.bidding_deadline_ns.0, "PHALANX_E_NOT_OVERDUE");
                let refunded = self.release_budget(&task);
                task.status = TaskStatus::Expired;
                PhalanxEvent::TaskClosedWithoutSettlement { task_id, status: "expired".to_string(), refunded: U128(refunded) }
                    .emit();
            }
            _ => env::panic_str("PHALANX_E_NOT_EXPIRABLE: sealed auctions settle via close_auction"),
        }
        self.reopen_order(&task);
        self.tasks.insert(task_id.0, task.clone());
        task
    }

    /// Poster or owner withdraws a task nobody has bid on yet.
    pub fn cancel_task(&mut self, task_id: U64) -> TaskRfp {
        let mut task = self.task_or_panic(task_id.0);
        let is_poster = self.resolve_agent_caller().map(|a| a.agent_id == task.poster).unwrap_or(false);
        require!(self.is_owner_call() || is_poster, "PHALANX_E_UNAUTHORIZED");
        require!(task.status == TaskStatus::Bidding && task.bid_count == 0, "PHALANX_E_TASK_HAS_BIDS");
        let refunded = self.release_budget(&task);
        task.status = TaskStatus::Cancelled;
        self.reopen_order(&task);
        self.tasks.insert(task_id.0, task.clone());
        PhalanxEvent::TaskClosedWithoutSettlement { task_id, status: "cancelled".to_string(), refunded: U128(refunded) }.emit();
        task
    }

    pub fn get_task(&self, task_id: U64) -> Option<TaskView> {
        let task = self.tasks.get(&task_id.0)?.clone();
        Some(TaskView {
            bids: self.bids.get(&task_id.0).cloned().unwrap_or_default(),
            escrow: self.escrows.get(&task_id.0).cloned(),
            task,
        })
    }

    /// Newest first.
    pub fn list_tasks(&self, limit: Option<u32>) -> Vec<TaskView> {
        let limit = u64::from(limit.unwrap_or(20).min(crate::MAX_PAGE));
        let end = self.next_task_id;
        let start = end.saturating_sub(limit);
        (start..end).rev().filter_map(|id| self.get_task(U64(id))).collect()
    }

    /// Current reverse-Dutch price of a task.
    pub fn get_dutch_price(&self, task_id: U64) -> U128 {
        let task = self.task_or_panic(task_id.0);
        U128(dutch_price(
            task.dutch_start_price.0,
            task.budget_ceiling.0,
            task.created_at_ns.0,
            task.bidding_deadline_ns.0,
            env::block_timestamp(),
        ))
    }

    /// Parity helper: the commitment a sealed bid must carry.
    pub fn compute_bid_commitment(
        &self,
        task_id: U64,
        agent_id: AccountId,
        price: U128,
        est_latency_sec: u32,
        salt: String,
    ) -> String {
        bid_commitment(task_id.0, agent_id.as_str(), price.0, est_latency_sec, &salt)
    }

    /// Parity helper: the score a revealed bid would get right now.
    pub fn preview_bid_score(&self, task_id: U64, agent_id: AccountId, price: U128, est_latency_sec: u32) -> u32 {
        let task = self.task_or_panic(task_id.0);
        require!(price.0 > 0 && price.0 <= task.budget_ceiling.0, "PHALANX_E_PRICE_OUT_OF_RANGE");
        let reputation = self.agents.get(&agent_id).map(|a| a.reputation_bps).unwrap_or(0);
        score_bid(task.budget_ceiling.0, price.0, est_latency_sec, reputation)
    }
}

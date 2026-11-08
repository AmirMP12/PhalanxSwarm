/**
 * 1:1 Zod mirror of the `phalanx-core` JSON interface (snake_case, as serialized by serde).
 *
 * Every object schema is strict: if the contract adds, removes or renames a field, parsing a
 * real contract response fails. `test/parity.test.ts` parses live outputs of the compiled WASM
 * (views, call results and every NEP-297 event) through these schemas.
 *
 * Conventions: `U128` / `U64` are decimal strings, Rust `u32` / `u64` (non-wrapped) are numbers,
 * `Option<T>` is `T | null`.
 */
import { z } from "zod";

export const U128 = z.string().regex(/^\d+$/, "U128 must be a decimal string");
export const U64 = z.string().regex(/^\d+$/, "U64 must be a decimal string");
export const AccountId = z.string().min(2).max(64);
export const PublicKey = z.string().regex(/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/);
export const Hash32Hex = z.string().regex(/^[0-9a-f]{64}$/);
/** TEE measurement: 32-byte sha256 (offline) or 48-byte Intel TDX MRTD/RTMR (real hardware). */
export const MeasurementHex = z.string().regex(/^([0-9a-f]{64}|[0-9a-f]{96})$/);
const num = z.number().int().nonnegative();

export const AgentRole = z.enum(["orchestrator", "yield_strategist", "sentinel", "compute_worker"]);
export const SpawnMode = z.enum(["sub_account", "contract_key"]);

export const AgentStatus = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("provisioning") }),
  z.strictObject({ kind: z.literal("active") }),
  z.strictObject({ kind: z.literal("quarantined"), reason: z.string(), at_ns: U64, block_height: U64 }),
  z.strictObject({ kind: z.literal("revoked"), at_ns: U64 }),
]);

export const SpendWindow = z.strictObject({
  epoch: U64,
  spent_in_epoch: U128,
  window_start_ns: U64,
  requests_in_window: num,
});

export const AgentPolicy = z.strictObject({
  max_tx_amount_yocto: U128,
  epoch_spending_cap_yocto: U128,
  allowed_target_chains: z.array(z.string()),
  allowed_contract_ids: z.array(AccountId),
  require_tee_attestation: z.boolean(),
});

export const AgentRecord = z.strictObject({
  agent_id: AccountId,
  handle: z.string(),
  role: AgentRole,
  public_key: PublicKey,
  spawn_mode: SpawnMode,
  status: AgentStatus,
  key_active: z.boolean(),
  allowed_methods: z.array(z.string()),
  allowance_cap: U128,
  payout_account: AccountId,
  policy: AgentPolicy,
  spend: SpendWindow,
  reputation_bps: num,
  tasks_completed: num,
  tasks_failed: num,
  violations: num,
  balance: U128,
  total_earned: U128,
  total_spent: U128,
  created_at_ns: U64,
});

export const PriceFloor = z.strictObject({
  origin_asset: z.string(),
  destination_asset: z.string(),
  unit_in: U128,
  min_out_per_unit: U128,
});

export const EvmTokenPolicy = z.strictObject({ token: z.string(), symbol: z.string(), max_amount: U128, epoch_cap: U128 });

export const EvmChainPolicy = z.strictObject({
  chain: z.string(),
  chain_id: num,
  max_value_wei: U128,
  epoch_cap_wei: U128,
  max_fee_wei: U128,
  tokens: z.array(EvmTokenPolicy),
});

export const UnknownRecipientRule = z.enum(["quarantine", "hold"]);

/** Something the business sells (`place_order`). */
export const Product = z.strictObject({
  product_id: z.string(),
  title: z.string(),
  price: U128,
  delivery_sec: num,
  max_cost_bps: num,
});

export const GlobalPolicy = z.strictObject({
  max_tx_amount_yocto: U128,
  epoch_spending_cap_yocto: U128,
  allowed_target_chains: z.array(z.string()),
  allowed_contract_ids: z.array(AccountId),
  allowed_assets: z.array(z.string()),
  require_tee_attestation: z.boolean(),
  max_slippage_bps: num,
  velocity_limit: num,
  velocity_window_sec: num,
  auto_quarantine: z.boolean(),
  quarantine_after_strikes: num,
  dao_approval_threshold: U128,
  allowed_recipients: z.array(z.string()),
  price_floors: z.array(PriceFloor),
  evm_chains: z.array(EvmChainPolicy),
  /** sha256 of the Sentinel's audit prompt; NEAR AI audit proofs must use exactly that prompt. */
  audit_prompt_hash: Hash32Hex.nullable(),
  /** `quarantine`: paying an unknown recipient is critical. `hold`: settlements wait for the DAO. Contracts before 2.2 omit it. */
  unknown_recipient: UnknownRecipientRule.default("quarantine"),
  /** sha256 of every task prompt the DAO approved; an agent-posted RFP may pin only these. Contracts before 2.3 omit it. */
  task_prompt_hashes: z.array(Hash32Hex).default([]),
  /** Floors an agent-posted RFP must meet. Contracts before 2.3 omit them. */
  min_task_confidence_bps: num.default(0),
  min_task_reputation_bps: num.default(0),
  /** Vendor payments and EVM transfers must name an invoice. Contracts before 3.0 omit these four fields. */
  require_invoice_ref: z.boolean().default(false),
  /** Challenge window after which anyone may release a small held payment to a new recipient (0: DAO vote only). */
  hold_release_after_sec: num.default(0),
  hold_auto_release_max_yocto: U128.default("0"),
  products: z.array(Product).default([]),
});

export const Severity = z.enum(["none", "notice", "warning", "critical"]);

export const PolicyViolation = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("protocol_paused") }),
  z.strictObject({ code: z.literal("agent_not_active"), status: z.string() }),
  z.strictObject({ code: z.literal("amount_exceeds_tx_limit"), amount: U128, limit: U128 }),
  z.strictObject({ code: z.literal("agent_epoch_cap_exceeded"), spent: U128, amount: U128, cap: U128 }),
  z.strictObject({ code: z.literal("global_epoch_cap_exceeded"), spent: U128, amount: U128, cap: U128 }),
  z.strictObject({ code: z.literal("chain_not_allowed"), chain: z.string() }),
  z.strictObject({ code: z.literal("contract_not_allowed"), contract_id: z.string() }),
  z.strictObject({ code: z.literal("asset_not_allowed"), asset: z.string() }),
  z.strictObject({ code: z.literal("slippage_too_high"), slippage_bps: num, max_bps: num }),
  z.strictObject({ code: z.literal("velocity_exceeded"), requests: num, limit: num, window_sec: num }),
  z.strictObject({ code: z.literal("missing_tee_attestation") }),
  z.strictObject({ code: z.literal("invalid_tee_attestation"), reason: z.string() }),
  z.strictObject({ code: z.literal("invalid_intent_signature") }),
  z.strictObject({ code: z.literal("nonce_reused") }),
  z.strictObject({ code: z.literal("deadline_invalid"), reason: z.string() }),
  z.strictObject({ code: z.literal("quote_invalid"), reason: z.string() }),
  z.strictObject({ code: z.literal("insufficient_treasury_liquidity"), available: U128, amount: U128 }),
  z.strictObject({ code: z.literal("recipient_not_allowed"), chain: z.string(), recipient: z.string() }),
  z.strictObject({ code: z.literal("price_below_floor"), min_amount_out: U128, floor: U128 }),
  z.strictObject({ code: z.literal("no_price_floor"), origin_asset: z.string(), destination_asset: z.string() }),
  z.strictObject({ code: z.literal("evm_chain_not_allowed"), chain: z.string() }),
  z.strictObject({ code: z.literal("evm_asset_not_allowed"), asset: z.string() }),
  z.strictObject({ code: z.literal("evm_amount_exceeds_limit"), amount: U128, limit: U128 }),
  z.strictObject({ code: z.literal("evm_epoch_cap_exceeded"), spent: U128, amount: U128, cap: U128 }),
  z.strictObject({ code: z.literal("evm_fee_too_high"), fee: U128, cap: U128 }),
  z.strictObject({ code: z.literal("insufficient_agent_balance"), balance: U128, amount: U128 }),
  z.strictObject({ code: z.literal("recipient_blocked"), chain: z.string(), recipient: z.string(), reason: z.string() }),
  z.strictObject({ code: z.literal("recipient_needs_approval"), chain: z.string(), recipient: z.string() }),
  z.strictObject({ code: z.literal("task_prompt_not_approved"), prompt_hash: z.string() }),
  z.strictObject({ code: z.literal("task_floor_below_policy"), field: z.string(), value: num, floor: num }),
  z.strictObject({ code: z.literal("evm_nonce_mismatch"), expected: U64, got: U64 }),
  z.strictObject({ code: z.literal("evm_transfer_outstanding"), tx_id: U64 }),
  z.strictObject({ code: z.literal("invoice_ref_missing") }),
  z.strictObject({ code: z.literal("invoice_already_paid"), invoice_ref: z.string(), subject: z.string(), subject_id: U64 }),
]);

export const EffectiveLimits = z.strictObject({
  epoch: U64,
  max_tx_amount_yocto: U128,
  agent_epoch_cap: U128,
  agent_epoch_spent: U128,
  global_epoch_cap: U128,
  global_epoch_spent: U128,
  allowed_target_chains: z.array(z.string()),
  allowed_contract_ids: z.array(AccountId),
  require_tee_attestation: z.boolean(),
});

export const PolicyDecision = z.strictObject({
  approved: z.boolean(),
  severity: Severity,
  violations: z.array(PolicyViolation),
  requires_dao_approval: z.boolean(),
  /** `amount_at_or_above_dao_threshold`, `recipient_needs_approval`. Contracts before 2.2 omit it. */
  approval_reasons: z.array(z.string()).default([]),
  limits: EffectiveLimits,
});

export const SecurityEvent = z.strictObject({
  seq: U64,
  kind: z.string(),
  agent_id: AccountId.nullable(),
  severity: Severity,
  codes: z.array(z.string()),
  detail: z.string(),
  at_ns: U64,
  block_height: U64,
});

export const ProtocolConfig = z.strictObject({
  mpc_contract_id: AccountId.nullable(),
  mpc_domain_id: num,
  mpc_sign_gas_tgas: num,
  callback_gas_tgas: num,
  intents_contract_id: AccountId,
  min_operating_reserve: U128,
  min_distribution: U128,
  max_receipt_age_sec: num,
  max_intent_horizon_sec: num,
  subaccount_min_deposit: U128,
});

export const TreasuryReport = z.strictObject({
  liquid: U128,
  available: U128,
  reserved_for_tasks: U128,
  escrow_locked: U128,
  reserved_for_intents: U128,
  total_capital_in: U128,
  total_revenue: U128,
  total_operating_costs: U128,
  total_deployed_capital: U128,
  total_distributed: U128,
  total_retained: U128,
  net_profit: U128,
  distributable_profit: U128,
  epoch: U64,
  epoch_spent: U128,
  agent_balances: U128,
  contract_key_allowances: U128,
  /** Customer payments for undelivered orders (a liability). Contracts before 3.0 omit it. */
  orders_escrow: U128.default("0"),
  account_balance: U128,
  storage_usage: U64,
  solvent_liquidity: U128,
  unbacked_liquidity: U128,
});

export const StakeholderKind = z.enum(["dao_treasury", "operator", "investor", "reserve"]);

export const RevenueSplit = z.strictObject({
  account_id: AccountId,
  bps: num,
  label: z.string(),
  kind: StakeholderKind,
});

export const PayoutLeg = z.strictObject({ account_id: AccountId, amount: U128, label: z.string() });

export const DistributionRecord = z.strictObject({
  distribution_id: U64,
  total: U128,
  retained: U128,
  payouts: z.array(PayoutLeg),
  failed: U128,
  triggered_by: AccountId,
  at_ns: U64,
});

export const ContractInfo = z.strictObject({
  name: z.string(),
  version: z.string(),
  event_standard: z.string(),
  event_version: z.string(),
  nep413_recipient: AccountId,
});

export const EnclaveKind = z.enum(["receipt_signer", "near_ai_model"]);

export const EnclaveRecord = z.strictObject({
  enclave_id: z.string(),
  kind: EnclaveKind,
  measurement: MeasurementHex,
  signer_public_key: PublicKey,
  vendor: z.string(),
  model_id: z.string(),
  tee_type: z.string(),
  attestation_ref: z.string(),
  active: z.boolean(),
  registered_at_ns: U64,
  receipts_verified: num,
});

export const SubjectKind = z.enum(["task", "intent", "evm"]);

export const ExecutionReceipt = z.strictObject({
  subject_kind: SubjectKind,
  subject_id: U64,
  agent_id: AccountId,
  enclave_id: z.string(),
  measurement: MeasurementHex,
  model_id: z.string(),
  input_hash: Hash32Hex,
  output_hash: Hash32Hex,
  schema_hash: Hash32Hex,
  verdict: z.string(),
  confidence_bps: num,
  issued_at_ns: U64,
  nonce: z.string(),
});

export const SignedReceipt = z.strictObject({ receipt: ExecutionReceipt, signature: z.string() });

/** A NEAR AI Cloud completion as it went over the wire, plus the model TEE's signature. */
export const NearAiProof = z.strictObject({
  enclave_id: z.string(),
  chat_id: z.string(),
  subject_kind: SubjectKind,
  subject_id: U64,
  agent_id: AccountId,
  input_hash: Hash32Hex,
  schema_hash: Hash32Hex,
  nonce: z.string(),
  issued_at_ns: U64,
  request_body: z.string(),
  response_body: z.string(),
  signed_text: z.string(),
  signature: z.string(),
});

export const ExecutionProof = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("receipt"), receipt: ExecutionReceipt, signature: z.string() }),
  NearAiProof.extend({ kind: z.literal("near_ai") }),
]);

export const AttestationRecord = z.strictObject({
  receipt_hash: Hash32Hex,
  proof_kind: z.enum(["receipt", "near_ai"]),
  receipt: ExecutionReceipt,
  verified_at_ns: U64,
  block_height: U64,
});

export const AttestationCheck = z.strictObject({
  valid: z.boolean(),
  receipt_hash: Hash32Hex,
  reason: z.string().nullable(),
});

export const AuctionKind = z.enum(["sealed_bid", "reverse_dutch"]);
export const TaskStatus = z.enum(["bidding", "revealing", "awarded", "completed", "failed", "expired", "cancelled"]);

export const VerificationSchema = z.strictObject({
  schema_id: z.string(),
  schema_hash: Hash32Hex,
  min_confidence_bps: num,
  min_reputation_bps: num,
  /** sha256 of the system prompt NEAR AI proofs for the task must use; null accepts only enclave receipts. */
  prompt_hash: Hash32Hex.nullable(),
  /** The model's user message must be the exact spec whose sha256 is `spec_hash`. */
  input_pinned: z.boolean(),
});

export const TaskRfpInput = z.strictObject({
  title: z.string(),
  category: z.string(),
  spec_hash: Hash32Hex,
  budget_ceiling: U128,
  auction: AuctionKind,
  dutch_start_price: U128.nullable(),
  bidding_window_sec: num,
  reveal_window_sec: num.nullable(),
  execution_window_sec: num,
  deadline_epochs: num,
  max_bidders: num,
  verification: VerificationSchema,
  /** The customer order this task delivers. */
  order_id: U64.nullable().optional(),
});

export const TaskRfp = z.strictObject({
  task_id: U64,
  poster: AccountId,
  title: z.string(),
  category: z.string(),
  spec_hash: Hash32Hex,
  budget_ceiling: U128,
  auction: AuctionKind,
  dutch_start_price: U128,
  created_at_ns: U64,
  bidding_deadline_ns: U64,
  reveal_deadline_ns: U64,
  execution_window_sec: num,
  execution_deadline_ns: U64,
  deadline_epoch: U64,
  max_bidders: num,
  verification: VerificationSchema,
  status: TaskStatus,
  bid_count: num,
  revealed_count: num,
  winner: AccountId.nullable(),
  winning_price: U128.nullable(),
  winning_score_bps: num.nullable(),
  winning_latency_sec: num.nullable(),
  receipt_hash: Hash32Hex.nullable(),
  order_id: U64.nullable().default(null),
});

export const BidAction = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("commit"), commitment: Hash32Hex }),
  z.strictObject({ type: z.literal("reveal"), price: U128, est_latency_sec: num, salt: z.string() }),
  z.strictObject({ type: z.literal("accept_dutch"), est_latency_sec: num }),
]);

export const AgentBid = z.strictObject({
  task_id: U64,
  agent_id: AccountId,
  commitment: Hash32Hex.nullable(),
  revealed: z.boolean(),
  price: U128.nullable(),
  est_latency_sec: num.nullable(),
  reputation_bps: num.nullable(),
  score_bps: num.nullable(),
  submitted_at_ns: U64,
  revealed_at_ns: U64.nullable(),
});

export const EscrowStatus = z.enum(["locked", "released", "refunded"]);

export const Escrow = z.strictObject({
  task_id: U64,
  payee: AccountId,
  amount: U128,
  status: EscrowStatus,
  locked_at_ns: U64,
  closed_at_ns: U64.nullable(),
});

export const TaskView = z.strictObject({ task: TaskRfp, bids: z.array(AgentBid), escrow: Escrow.nullable() });

export const TaskPostOutcome = z.strictObject({
  approved: z.boolean(),
  task: TaskRfp.nullable(),
  severity: Severity,
  violations: z.array(PolicyViolation),
  quarantined: z.boolean(),
});

export const TaskExecutionOutcome = z.strictObject({
  task_id: U64,
  settled: z.boolean(),
  payout: U128,
  receipt_hash: Hash32Hex.nullable(),
  error: z.string().nullable(),
  quarantined: z.boolean(),
});

export const PaymentOutcome = z.strictObject({
  paid: z.boolean(),
  internal: z.boolean(),
  amount: U128,
  recipient: AccountId,
  severity: Severity,
  violations: z.array(PolicyViolation),
  quarantined: z.boolean(),
});

export const IntentKind = z.enum(["swap", "liquidity_deployment", "vendor_payment"]);
export const IntentStatus = z.enum([
  "rejected",
  "pending_approval",
  "committed",
  "signing",
  "signed",
  "authorization_failed",
  "paying",
  "payment_failed",
  "settled",
  "cancelled",
]);

export const QuoteBinding = z.strictObject({
  provider: z.string(),
  quote_hash: Hash32Hex,
  correlation_id: z.string(),
  amount_in: U128,
  amount_out: U128,
  min_amount_out: U128,
  expires_at_ns: U64,
  dry: z.boolean(),
  deposit_address: z.string().nullable(),
});

export const CrossChainIntentRequest = z.strictObject({
  kind: IntentKind,
  destination_chain: z.string(),
  origin_asset: z.string(),
  destination_asset: z.string(),
  amount: U128,
  min_amount_out: U128,
  recipient: z.string(),
  execution_contract: AccountId,
  slippage_bps: num,
  deadline_ns: U64,
  quote: QuoteBinding.nullable(),
  nonce: z.string(),
  signature: z.string(),
  attestation: ExecutionProof.nullable(),
  memo: z.string().nullable(),
  /** Vendor's invoice number: signed with the request, never paid twice to the same recipient. */
  invoice_ref: z.string().nullable().optional(),
});

export const MpcSignature = z.strictObject({ big_r: z.string(), s: z.string(), recovery_id: num });

export const MpcAuthorization = z.strictObject({
  mpc_contract_id: AccountId,
  path: z.string(),
  domain_id: num,
  commitment: Hash32Hex,
  payload: Hash32Hex,
  signature: MpcSignature.nullable(),
  error: z.string().nullable(),
});

export const IntentRecord = z.strictObject({
  intent_id: U64,
  agent_id: AccountId,
  kind: IntentKind,
  destination_chain: z.string(),
  origin_asset: z.string(),
  destination_asset: z.string(),
  amount: U128,
  min_amount_out: U128,
  recipient: z.string(),
  execution_contract: AccountId,
  slippage_bps: num,
  deadline_ns: U64,
  intent_message: z.string(),
  nep413_hash: Hash32Hex,
  nonce: z.string(),
  quote: QuoteBinding.nullable(),
  attestation_hash: Hash32Hex.nullable(),
  decision: PolicyDecision,
  status: IntentStatus,
  dry_run: z.boolean(),
  mpc: MpcAuthorization.nullable(),
  memo: z.string().nullable(),
  invoice_ref: z.string().nullable().default(null),
  /** When anyone may release this held payment (`release_held_intent`); `null`: DAO vote only. */
  hold_release_at_ns: U64.nullable().default(null),
  created_at_ns: U64,
  settled_at_ns: U64.nullable(),
  settlement_ref: z.string().nullable(),
});

export const SettlementOutcome = z.strictObject({
  intent_id: U64,
  status: IntentStatus,
  nep413_hash: Hash32Hex,
  decision: PolicyDecision,
  quarantined: z.boolean(),
});

export const IntentAssessment = z.strictObject({
  intent_message: z.string(),
  nep413_hash: Hash32Hex,
  signature_valid: z.boolean(),
  attestation_hash: Hash32Hex.nullable(),
  velocity_requests: num,
  decision: PolicyDecision,
  /** sha256 of the audit facts a NEAR AI audit of this request must carry. Contracts before 2.3 omit it. */
  audit_facts_hash: z.string().default(""),
});

/**
 * The facts document the contract builds for a settlement or EVM transfer. A NEAR AI audit counts
 * only if its user message is exactly `facts` (`get_intent_audit_facts`, `get_evm_audit_facts`).
 */
export const AuditFacts = z.strictObject({
  subject: z.enum(["intent", "evm"]),
  facts: z.string(),
  facts_hash: Hash32Hex,
});

/** The nonce the contract tracks for the treasury address on one EVM chain. */
export const EvmNonceState = z.strictObject({
  next_nonce: U64,
  outstanding_tx: U64.nullable(),
});

export const EvmTransferRequest = z.strictObject({
  chain: z.string(),
  to: z.string(),
  asset: z.string(),
  amount: U128,
  nonce: U64,
  gas_limit: U64,
  max_fee_per_gas: U128,
  max_priority_fee_per_gas: U128,
  memo: z.string().nullable(),
  attestation: ExecutionProof.nullable(),
  invoice_ref: z.string().nullable().optional(),
});

export const EvmTxStatus = z.enum(["rejected", "signing", "signed", "authorization_failed", "confirmed", "cancelled", "superseded"]);
export const EvmTxKind = z.enum(["transfer", "cancel"]);

export const EvmTxRecord = z.strictObject({
  tx_id: U64,
  agent_id: AccountId,
  chain: z.string(),
  chain_id: U64,
  to: z.string(),
  asset: z.string(),
  amount: U128,
  nonce: U64,
  gas_limit: U64,
  max_fee_per_gas: U128,
  max_priority_fee_per_gas: U128,
  tx_to: z.string(),
  tx_value: U128,
  data: z.string(),
  signing_hash: z.string(),
  path: z.string(),
  mpc_contract_id: AccountId.nullable(),
  signature: MpcSignature.nullable(),
  raw_tx: z.string().nullable(),
  tx_hash: z.string().nullable(),
  attestation_hash: Hash32Hex.nullable(),
  severity: Severity,
  violations: z.array(PolicyViolation),
  status: EvmTxStatus,
  error: z.string().nullable(),
  memo: z.string().nullable(),
  invoice_ref: z.string().nullable().default(null),
  /** `cancel`: a zero-value replacement at the same nonce. Contracts before 2.3 omit these four fields. */
  kind: EvmTxKind.default("transfer"),
  replaces: U64.nullable().default(null),
  replaced_by: U64.nullable().default(null),
  epoch: U64.default("0"),
  created_at_ns: U64,
  confirmed_at_ns: U64.nullable(),
});

export const EvmTransferOutcome = z.strictObject({
  tx_id: U64,
  status: EvmTxStatus,
  signing_hash: z.string(),
  severity: Severity,
  violations: z.array(PolicyViolation),
  quarantined: z.boolean(),
});

export const EvmTxPreview = z.strictObject({
  chain_id: U64,
  tx_to: z.string(),
  tx_value: U128,
  data: z.string(),
  unsigned_tx: z.string(),
  signing_hash: Hash32Hex,
});

/** A shared-blocklist entry: paying it is critical for every agent. */
export const BlockedRecipient = z.strictObject({
  recipient: z.string(),
  reason: z.string(),
  evidence_hash: Hash32Hex,
  reported_by: AccountId,
  at_ns: U64,
});

export const OrderStatus = z.enum(["paid", "in_production", "delivered", "refunding", "refunded"]);

/** A customer order (`place_order`): delivered by a verified task, or refunded after its deadline. */
export const Order = z.strictObject({
  order_id: U64,
  customer: AccountId,
  product_id: z.string(),
  price: U128,
  spec_hash: Hash32Hex,
  placed_at_ns: U64,
  deadline_ns: U64,
  status: OrderStatus,
  task_id: U64.nullable(),
  failed_tasks: z.array(U64),
  result_hash: Hash32Hex.nullable(),
  receipt_hash: Hash32Hex.nullable(),
  closed_at_ns: U64.nullable(),
});

/** The payment recorded for one invoice (`get_invoice_payment`). */
export const InvoicePayment = z.strictObject({
  invoice_ref: z.string(),
  recipient: z.string(),
  subject: z.enum(["intent", "evm"]),
  subject_id: U64,
  amount: U128,
  agent_id: AccountId,
  at_ns: U64,
});

export const Dashboard = z.strictObject({
  info: ContractInfo,
  owner_id: AccountId,
  paused: z.boolean(),
  config: ProtocolConfig,
  policy: GlobalPolicy,
  treasury: TreasuryReport,
  agents: z.array(AgentRecord),
  tasks: z.array(TaskView),
  intents: z.array(IntentRecord),
  security_events: z.array(SecurityEvent),
  revenue_splits: z.array(RevenueSplit),
  distributions: z.array(DistributionRecord),
  enclaves: z.array(EnclaveRecord),
  attestations: z.array(AttestationRecord),
  evm_txs: z.array(EvmTxRecord),
  /** Contracts before 2.2 omit it. */
  blocked_recipients: z.array(BlockedRecipient).default([]),
  /** Customer orders, newest first. Contracts before 3.0 omit it. */
  orders: z.array(Order).default([]),
  /** Bumped by every global-policy change. Contracts before 2.3 omit it. */
  policy_version: U64.default("0"),
  block_height: U64,
  block_timestamp_ns: U64,
  epoch_height: U64,
});

export const RecipientVerdict = z.enum(["allow", "warn", "block"]);

/** `check_recipient`: what an agent learns before it signs a payment. */
export const RecipientCheck = z.strictObject({
  chain: z.string(),
  recipient: z.string(),
  verdict: RecipientVerdict,
  reasons: z.array(z.string()),
  allow_listed: z.boolean(),
  registered_agent: z.boolean(),
  blocked: BlockedRecipient.nullable(),
  unknown_recipient: UnknownRecipientRule,
});

const ev = <N extends string, D extends z.ZodRawShape>(event: N, data: D) =>
  z.strictObject({
    standard: z.literal("phalanx"),
    version: z.literal("1.0.0"),
    event: z.literal(event),
    data: z.strictObject(data),
  });

export const PhalanxEvent = z.discriminatedUnion("event", [
  ev("treasury_funded", { from: AccountId, amount: U128, kind: z.string(), memo: z.string().nullable() }),
  ev("agent_spawn_requested", {
    agent_id: AccountId,
    role: AgentRole,
    spawn_mode: SpawnMode,
    public_key: PublicKey,
    allowed_methods: z.array(z.string()),
    allowance_cap: U128,
  }),
  ev("agent_spawned", { agent_id: AccountId, role: AgentRole }),
  ev("agent_spawn_failed", { agent_id: AccountId, refunded: U128 }),
  ev("agent_quarantined", {
    agent_id: AccountId,
    reason: z.string(),
    violation_codes: z.array(z.string()),
    automatic: z.boolean(),
    key_revoked: z.boolean(),
  }),
  ev("agent_reinstated", { agent_id: AccountId }),
  ev("agent_revoked", { agent_id: AccountId }),
  ev("policy_violation", { agent_id: AccountId, method: z.string(), severity: z.string(), violations: z.array(PolicyViolation) }),
  ev("policy_updated", { scope: z.string() }),
  ev("protocol_paused", { paused: z.boolean(), reason: z.string() }),
  ev("task_posted", { task_id: U64, poster: AccountId, budget_ceiling: U128, auction: AuctionKind }),
  ev("bid_submitted", { task_id: U64, agent_id: AccountId, phase: z.string() }),
  ev("auction_closed", { task_id: U64, winner: AccountId.nullable(), winning_price: U128.nullable(), score_bps: num.nullable() }),
  ev("escrow_locked", { task_id: U64, payee: AccountId, amount: U128 }),
  ev("attestation_verified", { receipt_hash: Hash32Hex, enclave_id: z.string(), agent_id: AccountId, subject: z.string() }),
  ev("attestation_rejected", { agent_id: AccountId, subject: z.string(), reason: z.string() }),
  ev("task_settled", { task_id: U64, payee: AccountId, amount: U128, receipt_hash: Hash32Hex }),
  ev("task_closed_without_settlement", { task_id: U64, status: z.string(), refunded: U128 }),
  ev("payout_failed", { task_id: U64, payee: AccountId, amount: U128 }),
  ev("intent_committed", {
    intent_id: U64,
    agent_id: AccountId,
    nep413_hash: Hash32Hex,
    amount: U128,
    destination_chain: z.string(),
    recipient: z.string(),
    status: z.string(),
  }),
  ev("intent_rejected", { intent_id: U64, agent_id: AccountId, nep413_hash: Hash32Hex, violation_codes: z.array(z.string()) }),
  ev("mpc_signature_requested", { intent_id: U64, mpc_contract_id: AccountId, path: z.string(), payload_hex: Hash32Hex }),
  ev("mpc_signature_resolved", { intent_id: U64, ok: z.boolean(), detail: z.string() }),
  ev("intent_settled", { intent_id: U64, settlement_ref: z.string(), dry_run: z.boolean() }),
  ev("intent_cancelled", { intent_id: U64, released: U128 }),
  ev("revenue_distributed", { distribution_id: U64, total: U128, retained: U128, payouts: z.array(PayoutLeg) }),
  ev("enclave_registered", { enclave_id: z.string(), measurement: MeasurementHex, vendor: z.string() }),
  ev("earnings_credited", { agent_id: AccountId, amount: U128, source: z.string() }),
  ev("agent_paid", { from: AccountId, to: AccountId, amount: U128, internal: z.boolean(), memo: z.string().nullable() }),
  ev("earnings_withdrawn", { agent_id: AccountId, payout_account: AccountId, amount: U128 }),
  ev("payment_failed", { agent_id: AccountId, to: AccountId, amount: U128 }),
  ev("vendor_paid", { intent_id: U64, recipient: AccountId, amount: U128 }),
  ev("vendor_payment_failed", { intent_id: U64, recipient: AccountId, amount: U128 }),
  ev("evm_transfer_requested", {
    tx_id: U64,
    agent_id: AccountId,
    chain: z.string(),
    chain_id: U64,
    to: z.string(),
    asset: z.string(),
    amount: U128,
    signing_hash: Hash32Hex,
  }),
  ev("evm_transfer_rejected", { tx_id: U64, agent_id: AccountId, violation_codes: z.array(z.string()) }),
  ev("evm_transfer_signed", { tx_id: U64, tx_hash: z.string(), path: z.string() }),
  ev("evm_transfer_confirmed", { tx_id: U64, tx_hash: z.string(), confirmed_by: AccountId }),
  ev("evm_cancel_requested", { tx_id: U64, cancel_tx_id: U64, requested_by: AccountId }),
  ev("evm_transfer_cancelled", { tx_id: U64, cancel_tx_id: U64 }),
  ev("recipient_blocked", { recipient: z.string(), reason: z.string(), evidence_hash: Hash32Hex, reported_by: AccountId }),
  ev("recipient_unblocked", { recipient: z.string(), by: AccountId }),
]);

/** Parses every `EVENT_JSON:` log line through the strict event schema. */
export function parsePhalanxEvents(logs: readonly string[]): PhalanxEventT[] {
  return logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => PhalanxEvent.parse(JSON.parse(l.slice("EVENT_JSON:".length))));
}

export type AgentRoleT = z.infer<typeof AgentRole>;
export type SpawnModeT = z.infer<typeof SpawnMode>;
export type AgentStatusT = z.infer<typeof AgentStatus>;
export type AgentPolicyT = z.infer<typeof AgentPolicy>;
export type AgentRecordT = z.infer<typeof AgentRecord>;
export type PriceFloorT = z.infer<typeof PriceFloor>;
export type EvmTokenPolicyT = z.infer<typeof EvmTokenPolicy>;
export type EvmChainPolicyT = z.infer<typeof EvmChainPolicy>;
export type GlobalPolicyT = z.infer<typeof GlobalPolicy>;
export type SeverityT = z.infer<typeof Severity>;
export type PolicyViolationT = z.infer<typeof PolicyViolation>;
export type PolicyDecisionT = z.infer<typeof PolicyDecision>;
export type SecurityEventT = z.infer<typeof SecurityEvent>;
export type ProtocolConfigT = z.infer<typeof ProtocolConfig>;
export type TreasuryReportT = z.infer<typeof TreasuryReport>;
export type RevenueSplitT = z.infer<typeof RevenueSplit>;
export type PayoutLegT = z.infer<typeof PayoutLeg>;
export type DistributionRecordT = z.infer<typeof DistributionRecord>;
export type ContractInfoT = z.infer<typeof ContractInfo>;
export type EnclaveKindT = z.infer<typeof EnclaveKind>;
export type EnclaveRecordT = z.infer<typeof EnclaveRecord>;
export type SubjectKindT = z.infer<typeof SubjectKind>;
export type ExecutionReceiptT = z.infer<typeof ExecutionReceipt>;
export type SignedReceiptT = z.infer<typeof SignedReceipt>;
export type NearAiProofT = z.infer<typeof NearAiProof>;
export type ExecutionProofT = z.infer<typeof ExecutionProof>;
export type AttestationRecordT = z.infer<typeof AttestationRecord>;
export type AttestationCheckT = z.infer<typeof AttestationCheck>;
export type AuctionKindT = z.infer<typeof AuctionKind>;
export type TaskStatusT = z.infer<typeof TaskStatus>;
export type VerificationSchemaT = z.infer<typeof VerificationSchema>;
export type TaskRfpInputT = z.infer<typeof TaskRfpInput>;
export type TaskRfpT = z.infer<typeof TaskRfp>;
export type BidActionT = z.infer<typeof BidAction>;
export type AgentBidT = z.infer<typeof AgentBid>;
export type EscrowT = z.infer<typeof Escrow>;
export type TaskViewT = z.infer<typeof TaskView>;
export type TaskPostOutcomeT = z.infer<typeof TaskPostOutcome>;
export type TaskExecutionOutcomeT = z.infer<typeof TaskExecutionOutcome>;
export type PaymentOutcomeT = z.infer<typeof PaymentOutcome>;
export type IntentKindT = z.infer<typeof IntentKind>;
export type IntentStatusT = z.infer<typeof IntentStatus>;
export type QuoteBindingT = z.infer<typeof QuoteBinding>;
export type CrossChainIntentRequestT = z.infer<typeof CrossChainIntentRequest>;
export type MpcSignatureT = z.infer<typeof MpcSignature>;
export type MpcAuthorizationT = z.infer<typeof MpcAuthorization>;
export type IntentRecordT = z.infer<typeof IntentRecord>;
export type SettlementOutcomeT = z.infer<typeof SettlementOutcome>;
export type IntentAssessmentT = z.infer<typeof IntentAssessment>;
export type AuditFactsT = z.infer<typeof AuditFacts>;
export type EvmNonceStateT = z.infer<typeof EvmNonceState>;
export type EvmTransferRequestT = z.infer<typeof EvmTransferRequest>;
export type EvmTxStatusT = z.infer<typeof EvmTxStatus>;
export type EvmTxKindT = z.infer<typeof EvmTxKind>;
export type EvmTxRecordT = z.infer<typeof EvmTxRecord>;
export type EvmTransferOutcomeT = z.infer<typeof EvmTransferOutcome>;
export type EvmTxPreviewT = z.infer<typeof EvmTxPreview>;
export type DashboardT = z.infer<typeof Dashboard>;
export type ProductT = z.infer<typeof Product>;
export type OrderT = z.infer<typeof Order>;
export type OrderStatusT = z.infer<typeof OrderStatus>;
export type InvoicePaymentT = z.infer<typeof InvoicePayment>;
export type UnknownRecipientRuleT = z.infer<typeof UnknownRecipientRule>;
export type BlockedRecipientT = z.infer<typeof BlockedRecipient>;
export type RecipientVerdictT = z.infer<typeof RecipientVerdict>;
export type RecipientCheckT = z.infer<typeof RecipientCheck>;
export type PhalanxEventT = z.infer<typeof PhalanxEvent>;

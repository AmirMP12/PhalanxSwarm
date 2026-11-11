# PhalanxSwarm Architecture

Technical specification for `contracts/phalanx-core` v3.0.0 — the module layout, the state model, the verification chain and the invariants the contract is built to preserve.

Every number and storage type below is taken from the source in `contracts/phalanx-core/src/`. Where a figure is a design bound rather than a measurement, the table says so.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Contract Module Architecture](#contract-module-architecture)
3. [State Model](#state-model)
4. [Agent Interaction Flows](#agent-interaction-flows)
5. [Security Verification Chain](#security-verification-chain)
6. [Treasury Accounting](#treasury-accounting)
7. [Key Design Decisions](#key-design-decisions)
8. [Security Invariants](#security-invariants)

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          PHALANXSWARM ARCHITECTURE                              │
└─────────────────────────────────────────────────────────────────────────────────┘

                    ┌──────────────────────────────────┐
                    │      SputnikDAO (Owner)          │
                    │   - Policy + version             │
                    │   - Prompt pins                  │
                    │   - Held-payment votes           │
                    │   - Revocation, upgrade          │
                    └──────────┬───────────────────────┘
                               │
                               │ owner-only methods
                               │
    ┌──────────────────────────▼───────────────────────────────────┐
    │                  PhalanxCore Smart Contract                   │
    │                      (NEAR Protocol)                          │
    ├───────────────────────────────────────────────────────────────┤
    │  lib.rs          Treasury ledger, revenue, ownership          │
    │  policy.rs       Policy engine, circuit breaker, products     │
    │  recipients.rs   Allow-list, blocklist, pre-flight            │
    │  subaccounts.rs  Agent registry, scoped FunctionCall keys     │
    │  swarm_market.rs RFPs, sealed-bid + reverse-Dutch, escrow     │
    │  orders.rs       Products, customer orders, delivery, refund  │
    │  attestation.rs  TEE receipts, NEAR AI proofs, enclaves       │
    │  facts.rs        Contract-built audit documents               │
    │  intents.rs      NEP-413 settlements, vendor payments, holds  │
    │  evm.rs          EIP-1559 via Chain Signatures, nonce, cancel │
    │  earnings.rs     Agent balances, agent-to-agent pay, withdraw │
    │  invoices.rs     One payment per invoice per recipient        │
    │  events.rs       NEP-297 events (standard "phalanx")          │
    │  codec.rs        Input validation and encoding helpers        │
    └───────────────────────────────────────────────────────────────┘
                               │
                ┏━━━━━━━━━━━━━━┻━━━━━━━━━━━━━━┓
                ┃     Agent Access Layer      ┃
                ┃  (FunctionCall keys only)   ┃
                ┗━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━┛
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
   ┌────▼─────┐         ┌─────▼──────┐        ┌─────▼──────┐
   │ Nexus    │         │  Cipher    │        │  Sentinel  │
   │ orchestr.│         │  worker    │        │  auditor   │
   ├──────────┤         ├────────────┤        ├────────────┤
   │ 8 methods│         │ 6 methods  │        │ 12 methods │
   └──────────┘         └────────────┘        └────────────┘

   ┌──────────┐         ┌────────────┐        ┌────────────┐
   │  Rhea    │         │   Vega     │        │  Mallory   │
   │ strateg. │         │  worker    │        │  unvetted  │
   ├──────────┤         ├────────────┤        ├────────────┤
   │ 6 methods│         │ 6 methods  │        │ 6 methods  │
   └──────────┘         └────────────┘        │ contract   │
                                              │ account key│
                                              └────────────┘

                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
   ┌────▼─────┐         ┌─────▼──────┐        ┌─────▼──────┐
   │ NEAR AI  │         │   Chain    │        │   NEAR     │
   │ Cloud    │         │ Signatures │        │  Intents   │
   │ (TDX)    │         │   (MPC)    │        │  (1Click)  │
   └──────────┘         └────────────┘        └────────────┘
```

---

## Contract Module Architecture

### Module Responsibilities

Line counts are the current source length, excluding `tests.rs` (2 729 lines of unit tests).

| Module | Lines | Purpose | Key entry points |
| --- | ---: | --- | --- |
| `policy.rs` | 1 377 | Global and per-agent policy, the circuit breaker, versioned updates, products, held-payment windows | `evaluate_spend`, `apply_circuit_breaker`, `quarantine_agent`, `update_global_policy`, `add_allowed_recipient`, `freeze_agent`, `report_agent` |
| `intents.rs` | 1 015 | NEP-413 settlement requests, NEAR vendor payments, MPC settlement commitments, held payments | `request_intent_settlement`, `confirm_intent_settlement`, `approve_intent`, `release_held_intent`, `cancel_intent`, `evaluate_intent` |
| `evm.rs` | 934 | EIP-1559 construction, MPC signing, nonce tracking, cancel replacements | `request_evm_transfer`, `confirm_evm_transfer`, `cancel_evm_transfer`, `preview_evm_transfer` |
| `swarm_market.rs` | 857 | Task RFPs, sealed-bid and reverse-Dutch auctions, escrow, deadlines | `post_task_rfp`, `submit_bid`, `close_auction`, `execute_verified_task`, `expire_task`, `cancel_task` |
| `attestation.rs` | 786 | TEE receipt and NEAR AI proof verification, enclave registry | `register_enclave`, `verify_attestation`, `verify_proof` |
| `lib.rs` | 706 | Treasury ledger, capital and revenue intake, revenue splits, ownership, upgrade, dashboard | `new`, `fund_treasury`, `deposit_revenue`, `distribute_revenue`, `get_dashboard`, `upgrade_contract` |
| `subaccounts.rs` | 428 | Agent registration, sub-accounts, scoped keys, role method lists | `register_and_spawn_agent`, `get_role_scope`, `revoke_agent` |
| `orders.rs` | 287 | Products, customer orders, delivery, refunds, reopen | `place_order`, `refund_order`, `get_order`, `list_orders`, `link_order`, `deliver_order` |
| `facts.rs` | 280 | The audit-facts document the contract builds per settlement or EVM transfer | `intent_facts`, `evm_facts`, `get_intent_audit_facts`, `get_evm_audit_facts` |
| `codec.rs` | 242 | Validation and encoding helpers | `is_safe_ascii`, `is_hash32_hex`, `is_valid_recipient_entry` |
| `recipients.rs` | 177 | Shared blocklist and the `check_recipient` pre-flight | `block_recipient`, `unblock_recipient`, `check_recipient` |
| `earnings.rs` | 149 | Agent balances, agent-to-agent payments, withdrawals | `pay_from_balance`, `withdraw_earnings` |
| `events.rs` | 140 | NEP-297 event definitions | `PhalanxEvent` |
| `invoices.rs` | 105 | Duplicate-invoice check | `get_invoice_payment`, invoice key storage |

### Dependency Shape

Modules depend on `lib.rs` for the state struct and on `policy.rs` for `PolicyViolation` and `Severity`. There is no circular module dependency beyond that: a module reaches state through `PhalanxCore`, never through another module's private fields.

```
                        ┌─────────────┐
                        │   lib.rs    │  state, treasury, ownership
                        └──────┬──────┘
                               │
        ┌──────────────────────┼─────────────────────────┐
        │                      │                         │
┌───────▼───────┐      ┌───────▼────────┐       ┌────────▼────────┐
│  policy.rs    │◄─────┤   intents.rs   │       │   orders.rs     │
│               │      │                │       │                 │
│ evaluate_     │      │ settlement     │       │ place / refund  │
│ spend,        │      │ request, hold  │       │ link / deliver  │
│ breaker,      │      │ lifecycle      │       │                 │
│ products      │      └───────┬────────┘       └────────┬────────┘
└───────▲───────┘              │                         │
        │              ┌───────▼────────┐                │
        │              │    evm.rs      │                │
        │              │                │                │
        │              │ EIP-1559, MPC  │                │
        │              │ nonce, cancel  │                │
        │              └───────┬────────┘                │
        │                      │                         │
┌───────┴───────┐      ┌───────▼────────┐       ┌────────▼────────┐
│attestation.rs │      │   facts.rs     │       │swarm_market.rs  │
│               │      │                │◄──────┤                 │
│ receipts,     │      │ stable audit   │       │ RFP, auctions,  │
│ NEAR AI       │      │ findings       │       │ escrow, expire  │
│ proofs        │      └────────────────┘       └────────┬────────┘
└───────▲───────┘                                        │
        │                                                │
┌───────┴───────┐      ┌────────────────┐       ┌────────▼────────┐
│subaccounts.rs │      │recipients.rs   │       │   earnings.rs   │
│               │      │                │       │                 │
│ agents, keys, │      │ allow/block,   │       │ balances,       │
│ method scope  │      │ pre-flight     │       │ withdrawal      │
└───────────────┘      └────────────────┘       └─────────────────┘
```

### Constants enforced by the contract

| Constant | Value | Where |
| --- | ---: | --- |
| `CONTRACT_VERSION` | `"3.0.0"` | `lib.rs` |
| `MAX_AGENTS` | 32 | `subaccounts.rs` |
| `MAX_ALLOWANCE` | 5 NEAR | `subaccounts.rs` |
| `INITIAL_REPUTATION_BPS` | 5 000 | `subaccounts.rs` |
| `MAX_BIDDERS` | 16 | `swarm_market.rs` |
| `MAX_LATENCY_SEC` | 86 400 | `swarm_market.rs` |
| `MIN_EXECUTION_SEC` | 60 | `swarm_market.rs` |
| `MAX_RECIPIENTS` | 64 | `policy.rs` |
| `MAX_PRICE_FLOORS` | 32 | `policy.rs` |
| `MAX_EVM_CHAINS` | 8 | `policy.rs` |
| `MAX_EVM_TOKENS` | 8 | `policy.rs` |
| `MAX_TASK_PROMPTS` | 16 | `policy.rs` |
| `MAX_BLOCKED_RECIPIENTS` | 128 | `recipients.rs` |
| `MAX_PRODUCTS` | 8 | `orders.rs` |
| `MAX_OPEN_ORDERS` | 32 | `orders.rs` |
| `MAX_REVENUE_SPLITS` | 8 | `lib.rs` |
| `SECURITY_EVENT_CAPACITY` | 128 (ring buffer) | `lib.rs` |
| `MAX_PAGE` | 50 | `lib.rs` |
| `MAX_INVOICE_REF` | 64 bytes | `invoices.rs` |
| `MAX_PROOF_BODY_BYTES` | 24 000 | `attestation.rs` |

---

## State Model

`PhalanxCore` is one `#[near(contract_state)]` struct. Collections use `near_sdk::store`, which writes through to storage on access rather than loading the whole map.

| Field | Type | Purpose |
| --- | --- | --- |
| `owner_id` | `AccountId` | The DAO. Every governance method calls `assert_owner`. |
| `config` | `ProtocolConfig` | MPC contract and domain, gas budgets, Intents verifier, operating reserve, receipt and intent horizons. |
| `policy` | `GlobalPolicy` | Spending caps, allow-lists, recipient rule, prompts, products. |
| `treasury` | `Treasury` | The ledger described in [Treasury Accounting](#treasury-accounting). |
| `paused` | `bool` | Emergency stop; only the owner can resume. |
| `agents` | `IterableMap<AccountId, AgentRecord>` | The agent registry, iterable for the dashboard. |
| `agent_by_key` | `LookupMap<String, AccountId>` | Resolves a `ContractKey` agent from `env::signer_account_pk()`. |
| `tasks` | `LookupMap<u64, TaskRfp>` | RFPs and auction state. |
| `bids` | `LookupMap<u64, Vec<AgentBid>>` | Bids per task, capped at 16. |
| `escrows` | `LookupMap<u64, Escrow>` | Locked escrow per task. |
| `enclaves` | `IterableMap<String, EnclaveRecord>` | Registered TEE enclaves. |
| `attestations` | `LookupMap<String, AttestationRecord>` | Verified proofs, keyed by receipt hash. |
| `attestation_log` | `Vector<String>` | Append-only order of receipt hashes. |
| `intents` | `LookupMap<u64, IntentRecord>` | Settlement requests and their status. |
| `used_nonces` | `LookupSet<String>` | `<agent>:<nonce>` replay protection for NEP-413. |
| `security_events` | `Vector<SecurityEvent>` | Ring buffer of the last 128 events. |
| `revenue_splits` | `Vec<RevenueSplit>` | 1–8 entries summing to 10 000 bps. |
| `distributions` | `Vector<DistributionRecord>` | Every `distribute_revenue` run. |
| `evm_txs` | `LookupMap<u64, EvmTxRecord>` | EVM transfer and cancel records. |
| `evm_spend` | `LookupMap<String, EvmSpend>` | Per-chain epoch spend. |
| `evm_nonces` | `LookupMap<String, EvmNonceState>` | Next nonce and the outstanding transfer holding it. |
| `blocked_recipients` | `IterableMap<String, BlockedRecipient>` | Shared blocklist, at most 128 entries. |
| `invoices` | `LookupMap<String, InvoicePayment>` | `<chain>:<recipient>:<invoice_ref>` → payment. |
| `orders` | `LookupMap<u64, Order>` | Customer orders. |
| `open_orders` | `u32` | Count of paid-but-unclosed orders, capped at 32. |
| `policy_version` | `u64` | Bumped by every policy change; guards stale DAO proposals. |
| `next_task_id`, `next_intent_id`, `next_evm_tx_id`, `next_order_id`, `next_event_seq` | `u64` | Monotonic ids. |

### Status machines

**Task** (`swarm_market.rs`)

```
bidding ──close──► awarded ──execute_verified_task──► completed
   │                  │
   │                  └──expire_task──► expired   (escrow refunded, −500 bps)
   └──cancel_task──► cancelled                    (only while bid_count == 0)

sealed_bid: bidding ──close (after reveal deadline or all revealed)──► awarded
            status "revealing" while the reveal window is open
reverse_dutch: bidding ──first accept, or close after the bidding deadline──► awarded
```

**Order** (`orders.rs`)

```
paid ──post_task_rfp with order_id──► in_production ──verified delivery──► delivered
 │                                          │
 │                                          └──task failed/expired/cancelled──► paid (reopened)
 └──refund_order (after deadline)──► refunding ──callback──► refunded
                                            └──bounced──► paid   (refundable again)
```

**Intent** (`intents.rs`)

```
rejected                      (policy rejection; no funds move)
pending_approval ──approve_intent | release_held_intent──► committed
                 └──cancel_intent──► cancelled
committed ──NEAR vendor payment──► paying ──► settled | payment_failed
          └──cross-chain────────► signing ──► signed ──confirm_intent_settlement──► settled
                                        └──► authorization_failed
```

**EVM transfer** (`evm.rs`)

```
rejected
signing ──► signed ──confirm_evm_transfer──► confirmed
              └──cancel_evm_transfer──► cancelled     (zero-value replacement mined)
              └──► superseded                        (the transfer was mined first)
          └──► authorization_failed
```

**Agent** (`subaccounts.rs`)

```
provisioning ──► active ──critical violation──► quarantined { reason, at_ns, block_height }
                   └──revoke_agent──► revoked
quarantined ──reinstate_agent──► active
```

---

## Agent Interaction Flows

### 1. Agent registration

```
┌─────────┐                 ┌──────────────┐                ┌─────────────┐
│  Owner  │                 │ PhalanxCore  │                │ NEAR        │
│ (DAO)   │                 │  Contract    │                │ Protocol    │
└────┬────┘                 └──────┬───────┘                └──────┬──────┘
     │                             │                               │
     │ register_and_spawn_agent    │                               │
     ├────────────────────────────►│                               │
     │  agent_handle, role,        │                               │
     │  public_key, allowance_cap, │                               │
     │  spawn_mode, payout_account,│                               │
     │  policy?, initial_rep_bps?  │                               │
     │                             │ assert_owner ─────┐           │
     │                             │ validate_handle   │           │
     │                             │ ◄─────────────────┘           │
     │                             │                               │
     │                             │ SpawnMode::SubAccount ?       │
     │                             ├──────────────────────────────►│
     │                             │ create <handle>.<contract>,   │
     │                             │ add FunctionCall key scoped   │
     │                             │ to methods_for_role(role)     │
     │                             │◄──────────────────────────────┤
     │                             │                               │
     │                             │ SpawnMode::ContractKey ?      │
     │                             ├──────────────────────────────►│
     │                             │ add the same scoped key to    │
     │                             │ the contract account itself   │
     │                             │◄──────────────────────────────┤
     │                             │                               │
     │                             │ status = active,              │
     │                             │ allowance booked as an        │
     │                             │ obligation (ContractKey only) │
     │        AgentRecord          │                               │
     │◄────────────────────────────┤                               │
```

The sub-account path attaches `config.subaccount_min_deposit` (0.1 NEAR by default, and at least 0.002 NEAR so account storage is covered). The method list is written into the key itself, so the scope is enforced by the NEAR protocol, not by a contract check.

### 2. Settlement request with attestation

```
┌─────────┐      ┌──────────┐      ┌──────────────┐      ┌──────────┐      ┌─────────┐
│ Agent   │      │ NEAR AI  │      │ PhalanxCore  │      │Recipient │      │  NEAR   │
│         │      │  Cloud   │      │  Contract    │      │  Rules   │      │Protocol │
└────┬────┘      └────┬─────┘      └──────┬───────┘      └────┬─────┘      └────┬────┘
     │                │                    │                   │                 │
     │ get_intent_audit_facts             │                   │                 │
     ├───────────────────────────────────►│                   │                 │
     │  (contract-built stable facts)     │                   │                 │
     │◄───────────────────────────────────┤                   │                 │
     │                                    │                   │                 │
     │ sign the NEP-413 intent message    │                   │                 │
     │ (agent key, off-chain)             │                   │                 │
     │                                    │                   │                 │
     │ request completion                 │                   │                 │
     ├───────────────►│                   │                   │                 │
     │ pinned prompt + facts              │                   │                 │
     │                │ TEE execution      │                   │                 │
     │                │ ─────────┐         │                   │                 │
     │                │ ◄────────┘         │                   │                 │
     │ signed response (TEE key)          │                   │                 │
     │◄───────────────┤                   │                   │                 │
     │                                    │                   │                 │
     │ request_intent_settlement          │                   │                 │
     ├───────────────────────────────────►│                   │                 │
     │ {request, nonce, signature, proof} │                   │                 │
     │                                    │ 1. verify NEP-413 │                 │
     │                                    │    signature      │                 │
     │                                    │ 2. verify TEE sig │                 │
     │                                    │ 3. prompt hash    │                 │
     │                                    │ 4. facts hash     │                 │
     │                                    │ 5. freshness      │                 │
     │                                    │ 6. recipient ────►│                 │
     │                                    │◄──────allow/warn/│                 │
     │                                    │       block       │                 │
     │                                    │ 7. evaluate_spend │                 │
     │                                    │    (caps, lists,  │                 │
     │                                    │     velocity,     │                 │
     │                                    │     floors,       │                 │
     │                                    │     invoice)      │                 │
     │                                    │                   │                 │
     │                                    │ committed → pay   │                 │
     │                                    ├─────────────────────────────────────►│
     │                                    │◄─────────────────────────────────────┤
     │  SettlementOutcome                 │                   │                 │
     │◄───────────────────────────────────┤                   │                 │
     │  {status, decision, intent_id}     │                   │                 │
```

A rejection returns `SettlementOutcome { intent_id, status: "rejected", nep413_hash, decision, quarantined }` and does **not** panic, so the quarantine and security event written in the same call survive. `decision.violations` carries the reasons, and `quarantined` says whether the agent is now frozen. This is the property the circuit breaker depends on.

### 3. Circuit breaker activation

```
┌──────────┐              ┌──────────────┐              ┌─────────┐
│ Agent    │              │ PhalanxCore  │              │  NEAR   │
│ (keyed)  │              │  Contract    │              │Protocol │
└────┬─────┘              └──────┬───────┘              └────┬────┘
     │                           │                           │
     │ request_intent_settlement │                           │
     ├──────────────────────────►│                           │
     │  (blocked recipient)      │                           │
     │                           │ evaluate_spend            │
     │                           │ ─────────┐                │
     │                           │ ◄────────┘                │
     │                           │ severity = critical        │
     │                           │ code = recipient_blocked   │
     │                           │ ─────────┐                │
     │                           │ ◄────────┘                │
     │                           │ apply_circuit_breaker     │
     │                           │ 1. status = quarantined   │
     │                           │ 2. record security event  │
     │                           │ 3. if ContractKey:        │
     │                           │    Promise::delete_key    │
     │                           ├──────────────────────────►│
     │                           │                           │
     │                           │ key deleted (receipt)     │
     │                           │◄──────────────────────────┤
     │  rejection (not a panic)  │                           │
     │◄──────────────────────────┤                           │
     │                           │                           │
     │ retry                     │                           │
     ├──────────────────────────►│                           │
     │                           │ signer key no longer      │
     │                           │ exists                    │
     │ InvalidAccessKeyError     │                           │
     │◄──────────────────────────┼───────────────────────────┤
```

`quarantine_agent` returns whether a key was revoked. For a `SubAccount` agent the contract holds no full-access key to the sub-account, so it cannot delete the key; the agent is refused by every method instead, and because its key is scoped to this contract only, retries burn its fixed gas allowance without execution.

---

## Security Verification Chain

### TEE verification

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    TEE VERIFICATION CHAIN                                │
└─────────────────────────────────────────────────────────────────────────┘

1. DCAP attestation (off-chain, one-time setup)
   ┌───────────────┐
   │ Intel TDX     │  hardware attestation
   │ Quote         │  └─► measurement (mr_td), signing key
   └───────┬───────┘
           ▼
   ┌───────────────┐
   │ Intel PCCS    │  quote verification
   │ + QVL         │  └─► certificate chain, TCB status, enclave identity
   └───────┬───────┘
           ▼
   ┌───────────────┐
   │ DAO           │  register_enclave
   │ registration  │  └─► enclave_id, measurement, signer key, vendor, model_id, tee_type
   └───────────────┘

2. Per-request verification (on-chain, every call)
   ┌──────────────────────────────────────────────────┐
   │ ExecutionProof::NearAi {                         │
   │   enclave_id, chat_id,                           │
   │   subject_kind, subject_id, agent_id,            │
   │   input_hash, schema_hash, nonce, issued_at_ns,  │
   │   request_body,   // exact JSON sent             │
   │   response_body,  // exact JSON received         │
   │   signed_text,    // [prefix:]sha256(req):sha256(resp)
   │   signature,      // ed25519 over signed_text    │
   │ }                                                │
   └──────────────────────────────────────────────────┘
                    │
                    ▼
   ┌─────────────────────────────────────────────────┐
   │ 1. Signature                                    │
   │    env::ed25519_verify(signature, signed_text,  │
   │                        enclave.signer_key)      │
   │    and signed_text hashes match the bodies      │
   └─────────────────────────────────────────────────┘
                    ▼
   ┌─────────────────────────────────────────────────┐
   │ 2. Enclave                                      │
   │    registered, active, kind = near_ai_model,    │
   │    measurement matches the record               │
   └─────────────────────────────────────────────────┘
                    ▼
   ┌─────────────────────────────────────────────────┐
   │ 3. Request shape                                │
   │    exactly two messages; system message hashes  │
   │    to the pinned prompt + binding line;         │
   │    temperature == 0; JSON response format;      │
   │    no fields except chat_template_kwargs        │
   │    {"enable_thinking": false}                   │
   └─────────────────────────────────────────────────┘
                    ▼
   ┌─────────────────────────────────────────────────┐
   │ 4. User message                                 │
   │    task with input_pinned → sha256 == spec_hash │
   │    audit → sha256 == contract-built facts       │
   │    otherwise the agent chose it                 │
   └─────────────────────────────────────────────────┘
                    ▼
   ┌─────────────────────────────────────────────────┐
   │ 5. Freshness                                    │
   │    issued_at_ns ≤ now + 60 s (future skew)      │
   │    now − issued_at_ns ≤ config.max_receipt_age_sec
   │    (3 600 s by default)                         │
   └─────────────────────────────────────────────────┘
                    ▼
   ┌─────────────────────────────────────────────────┐
   │ 6. Claim                                        │
   │    subject_kind / subject_id / agent_id match   │
   │    this call; verdict is the expected string    │
   │    ("completed", "approve"); confidence ≥ the   │
   │    schema's min_confidence_bps                  │
   └─────────────────────────────────────────────────┘
                    ▼
   ✅ VERIFIED → AttestationRecord written, escrow released or settlement committed
```

A prompt hash mismatch is `prompt_mismatch`; a facts hash mismatch is `facts_mismatch`. Both surface as `invalid_tee_attestation`, which is critical: the agent that submitted the proof is quarantined in the same call. `ExecutionProof::Receipt` is the fallback for self-hosted enclaves that sign an `ExecutionReceipt` digest under `RECEIPT_DOMAIN`; it carries the same subject, input hash and verdict fields and is subject to the same agent/subject checks.

### What the audit facts contain

`facts.rs` builds the document the Sentinel reads. Only findings that depend on the request and the policy go in — `is_stable_finding` decides — so a decision made a minute before submission still matches the document the contract rebuilds:

| Included | Excluded |
| --- | --- |
| Request fields: agent, kind, chain, recipient, amount, min_amount_out, assets, execution contract, memo, invoice, dry-run flag | Epoch spend, remaining liquidity |
| Recipient status: allow-listed, blocked reason | Velocity counters |
| Stable policy findings: amount over the tx limit, chain/contract/asset not allowed, slippage, recipient not allowed or blocked, price below floor or no floor, EVM chain/asset/amount/fee violations, missing invoice | Deadlines, quote expiry, nonces, the pause switch |

`AUDIT_FACTS_SCHEMA` is `phalanx.audit-facts.v1`; the document is `{subject, facts, facts_hash}` and the agent must send its `facts` string verbatim as the user message.

### Why DCAP runs off-chain

Full Intel TDX DCAP path validation — the X.509 DER chain PCK → Intermediate → Intel Root, RSA-3072 and P-256 signatures, TCB evaluation, QE identity — does not fit a NEAR receipt. A single receipt is capped at 300 Tgas, and without host precompiles a WASM X.509 path validation is well above that. The design splits the work:

1. An off-chain verifier (the `@phala/dcap-qvl` library against Intel PCCS collateral) checks the quote once.
2. The DAO registers the resulting model key and `mr_td` on-chain with `register_enclave`.
3. Every completion is then checked on-chain by one `env::ed25519_verify` plus the request-shape and hash checks above, which is cheap and constant-time.

This means the trust anchor is the DAO's registration step, not the contract's ability to parse a certificate chain. `pnpm verify:live` re-runs step 1 for the recorded deployment so the registration can be re-checked later.

---

## Treasury Accounting

`Treasury` is a ledger, not a balance. The account balance must back every line in it:

```
solvent_liquidity = account_balance
                  − storage_staking (storage_usage × 10¹⁹ yocto/byte)
                  − reserved_for_tasks
                  − escrow_locked
                  − reserved_for_intents
                  − agent_balances
                  − contract_key_allowances
                  − orders_escrow

available_liquidity = min(treasury.liquid, solvent_liquidity)
                    − config.min_operating_reserve
```

| Field | Meaning | Moves when |
| --- | --- | --- |
| `liquid` | Free treasury funds | `fund_treasury`, `deposit_revenue`, escrow release, settlement, refund |
| `reserved_for_tasks` | Budgets of RFPs still open | `post_task_rfp` reserves; award, expire and cancel release |
| `escrow_locked` | Winning prices held for awarded tasks | `close_auction` locks; `execute_verified_task` releases; `expire_task` refunds |
| `reserved_for_intents` | In-flight settlement and EVM amounts | `request_intent_settlement` / `request_evm_transfer` reserve; confirm, fail or cancel release |
| `agent_balances` | Earnings held for agents | Credited on settlement; debited by `pay_from_balance` and `withdraw_earnings` |
| `contract_key_allowances` | Gas a contract-account key may still burn | Booked at spawn; released on key deletion |
| `orders_escrow` | Customer payments for undelivered orders | `place_order` credits; `deliver_order` moves it to `liquid` + `total_revenue`; `refund_order` returns it |
| `total_capital_in` | Cumulative `fund_treasury` | — |
| `total_revenue` | Cumulative revenue | `deposit_revenue`, order delivery |
| `total_operating_costs` | Cumulative agent payouts and vendor payments | Task settlement, vendor payment |
| `total_distributed` / `total_retained` | Paid out vs. kept by `distribute_revenue` | — |
| `epoch`, `epoch_spent` | Rolling per-epoch spend | Reset when `epoch_height` changes |

`unbacked_liquidity` in `TreasuryReport` is `liquid − solvent_liquidity` when positive: gas burned by contract-account agent keys and bounced refunds can leave the ledger slightly ahead of the balance, and the report says so instead of hiding it. `distributable_profit` is `min(total_revenue − total_operating_costs − total_distributed − total_retained, available_liquidity)`.

---

### Violations, severity and the circuit breaker

Every check produces a `PolicyViolation`; `max_severity` over the set decides what happens.

| Severity | Effect | Examples |
| --- | --- | --- |
| `none` | No violation | — |
| `notice` | Rejected, no strike. Not the agent's fault, or an honest race | `protocol_paused`, `insufficient_treasury_liquidity`, `insufficient_agent_balance`, `recipient_needs_approval`, `evm_nonce_mismatch`, `evm_transfer_outstanding`, `invoice_already_paid`, `invoice_ref_missing` |
| `warning` | Rejected, counts as a strike | `agent_epoch_cap_exceeded`, `global_epoch_cap_exceeded`, `slippage_too_high`, `missing_tee_attestation`, `deadline_invalid`, `quote_invalid`, `no_price_floor`, `evm_epoch_cap_exceeded`, `evm_fee_too_high`, `task_prompt_not_approved`, `task_floor_below_policy` |
| `critical` | Rejected and quarantined at once | `chain_not_allowed`, `contract_not_allowed`, `asset_not_allowed`, `invalid_tee_attestation`, `invalid_intent_signature`, `nonce_reused`, `recipient_not_allowed`, `recipient_blocked`, `price_below_floor`, `evm_chain_not_allowed`, `evm_asset_not_allowed` |

Two checks escalate by degree, because the honest and hostile cases differ only in size:

- `amount_exceeds_tx_limit` and `evm_amount_exceeds_limit` are `warning` up to 4× the limit and `critical` at or above it. An attempt to move four times the cap in one call is treated as an attack, not a slip.
- `velocity_exceeded` is `notice` up to twice the configured limit — an honest batch backs off and retries — and `critical` beyond that.

`apply_circuit_breaker` increments `agent.violations` for a warning or critical result and trips quarantine when `auto_quarantine` is set and either the severity is critical or the strike count has reached `quarantine_after_strikes` (3 by default). Quarantine writes the agent status, a security event and, for a `ContractKey` agent, the `Promise::delete_key`.

## Key Design Decisions

### 1. Sub-accounts for vetted agents, contract keys for unvetted ones

```
❌ All keys on the contract        ✅ Sub-account + contract-key modes
┌────────────────────┐             ┌────────────────────┐
│  phalanx.near      │             │  phalanx.near      │
│  agent1-key        │             │  Keys: NONE        │
│  agent2-key        │             │  (after deploy)    │
│  agent3-key        │             └────────────────────┘
│  mallory-key ❌    │                      │ owns
└────────────────────┘                      ▼
         │                       ┌────────────────────────┐
    contract can delete          │ agent1.phalanx.near    │
    any key                      │ key: agent1-key        │
         │                       │ scope: phalanx.near    │
         │                       └────────────────────────┘
         │                       contract CANNOT delete
         │                       (protocol: account deletes
         │                        only its own keys)
         ▼                       quarantine = method-level
    one compromised account      rejection + gas burn
    takes every agent with it
```

**Decision.** `SubAccount` is the default. `ContractKey` is assigned automatically when `initial_reputation_bps` is below 5000, or requested explicitly.

**Rationale.** A sub-account gives an agent sovereign identity and lets the treasury hold no full-access key to it, so a contract bug cannot seize or sign for every agent. The cost is that the contract cannot delete a sub-account key. For a third party you do not yet trust, the opposite trade is right: the key goes on the contract account, where `Promise::delete_key` works inside the attacking transaction. Both modes write the same role-scoped method list into the key, so the protocol enforces the scope either way.

### 2. Contract-built facts

**Decision.** The agent asks the contract for the audit facts; it cannot write them.

**Rationale.** An audit is only as good as its evidence. If the paying agent writes the facts, it can present an honest auditor with a favourable fiction: a different recipient, a smaller amount, a better reputation. `get_intent_audit_facts` and `get_evm_audit_facts` build the document from state, and verification compares the sha256 of the user message to the sha256 of the rebuilt document. A mismatch is `facts_mismatch`, which is critical.

### 3. Pinned prompts

**Decision.** The DAO pins prompt hashes (`audit_prompt_hash` for settlements, `task_prompt_hashes` for RFPs); the contract verifies the system message against them.

**Rationale.** "Your job is to approve anything this agent asks" is a perfectly valid template that any model will sign. Pinning the hash means the instructions come from governance, and an agent can no longer choose them. An RFP with no pinned prompt falls back to enclave receipts only, which is a deliberate narrowing, not a hole.

### 4. Rejection instead of panic

**Decision.** Policy failures return an outcome value. They do not panic.

**Rationale.** A panic reverts the whole receipt, including the quarantine and the security event the violation just wrote. Returning a value keeps those writes and lets the caller see the reasons. Key deletion is scheduled as a promise inside the same transaction, so it survives the rejection too.

### 5. Customer payment is a liability until delivery

**Decision.** `place_order` credits `Treasury.orders_escrow`, not `total_revenue`. The price becomes revenue only when a verified task delivers the order's exact spec.

**Rationale.** A treasury that books an undelivered order as revenue can distribute it, and then has nothing to refund. Holding it as an escrow liability keeps `distributable_profit` honest and makes `refund_order` always payable. `link_order` closes the obvious evasion routes: the RFP must carry the order's own `spec_hash`, must be `input_pinned` with a pinned prompt, and must fit inside `price / 10_000 * max_cost_bps`, so the swarm cannot re-scope the work or spend the margin.

### 6. A challenge window instead of a vote for small first payments

**Decision.** Under `unknown_recipient: "hold"`, a payment to a new vendor waits. If the DAO sets `hold_release_after_sec` and a cap, anyone may call `release_held_intent` after the window; larger payments still need `approve_intent`.

**Rationale.** A vote for every first invoice to a new vendor makes the treasury unusable for ordinary accounts payable. A time window keeps a human veto (the DAO can cancel, the DAO or a Sentinel can block the recipient, a Sentinel can report the agent) without requiring one. The cap is the risk budget: set it to what you would lose without noticing.

### 7. The contract owns the EVM nonce

**Decision.** `evm_nonces` tracks the next nonce per chain and the one outstanding transfer that holds it.

**Rationale.** A signed transfer that is never mined leaves a nonce gap. Because the contract knows which nonce is outstanding, it can produce a zero-value replacement at the same nonce with fees 10–20% higher and cancel the transfer — a capability an agent holding an EVM key would have to be trusted with.

---

## Security Invariants

These are the properties the contract is built to preserve, and what enforces each:

| Invariant | Enforced by |
| --- | --- |
| An agent cannot call a method outside its role's scope | FunctionCall key method list, written at spawn; NEAR rejects the call |
| An agent cannot change the policy | `assert_owner` on every governance method |
| An agent cannot forge a TEE signature | `env::ed25519_verify` against the registered enclave key |
| An agent cannot choose the auditor's instructions | Prompt hash pin; a mismatch reports `prompt_mismatch` and counts as `invalid_tee_attestation` |
| An agent cannot invent the auditor's evidence | Contract-built facts; a mismatch reports `facts_mismatch` and counts as `invalid_tee_attestation` |
| A critical violation quarantines the agent in the same transaction | `apply_circuit_breaker` runs before the rejection is returned |
| A contract-account agent key is gone after a critical violation | `Promise::delete_key` scheduled inside the attacking transaction |
| A blocked recipient is never paid, even if allow-listed | `recipient_violation` checks the blocklist first |
| The same invoice is never paid twice to the same recipient | `invoices.rs`, keyed by `<chain>:<recipient>:<invoice_ref>` |
| Escrow is only released against a verified proof | `execute_verified_task` verifies before touching `escrow_locked` |
| A customer payment is not revenue until delivery | `orders_escrow` is a separate liability |
| An undelivered order is always refundable | The price stays in `orders_escrow` for the order's whole life |
| Every obligation is backed by the account balance | `solvent_liquidity`, reported as `unbacked_liquidity` when not |
| A stale policy proposal cannot overwrite a newer policy | `policy_version` + `expected_version` on every policy write |
| A settlement that moves money is re-checked against the facts | `evaluate_spend` runs on the contract's own state, not on the agent's claims |

### Known limits

- The audit facts include the request memo and invoice, which the agent writes, so an injection placed there reaches the auditor. The policy engine re-checks every fact that moves money.
- Invoice numbers are agent-written. The duplicate check stops the same invoice from being paid twice, not an agent that invents new ones; the caps bound that case.
- History signals (account age, activity, code changes, past payments) exist only in the off-chain pre-flight, and can only make the answer stricter.
- An EVM transfer is outside the contract's control once broadcast; a cancel works only if the replacement is mined first.
- The NEAR AI model key is registered after an off-chain DCAP check. When NEAR AI rotates the key, the DAO registers the new one.
- Pinned-prompt coverage is per task. A task without `input_pinned` lets the agent choose its proof's user message.
- The auction score weights price 50%, latency 20% and reputation 30%, where reputation enters as `sqrt(raw_bps × 10 000)` rather than linearly. The dampening limits how far an incumbent's reputation can carry it, but it does not remove the advantage: in the recorded market simulation one bidder still won all nine delivered rounds.

---

## Performance Notes

Gas figures are not published by the contract and vary with the NEAR runtime version, so no per-operation table is given here. The parameters that bound cost are configuration, and they are visible on-chain:

| Parameter | Default | Meaning |
| --- | ---: | --- |
| `config.mpc_sign_gas_tgas` | 50 | Gas attached to a Chain Signatures call (validated 5–250) |
| `config.callback_gas_tgas` | 20 | Gas for settlement, refund and distribution callbacks (validated 5–100) |
| `config.max_receipt_age_sec` | 3 600 | Oldest accepted proof (validated 60–86 400) |
| `config.max_intent_horizon_sec` | 3 600 | Furthest settlement deadline (validated 60–86 400) |
| `config.min_operating_reserve` | 2 NEAR | Liquidity agents and distributions cannot touch |
| `config.subaccount_min_deposit` | 0.1 NEAR | Attached on a sub-account spawn (≥ 0.002 NEAR) |
| `MAX_PROOF_BODY_BYTES` | 24 000 | Largest accepted proof request + response |

The page size for list views is capped at `MAX_PAGE` (50), and `get_dashboard` returns bounded slices, so a view call cannot be made to iterate unbounded state.

---

## Summary

The design has one organising idea: **the party that wants the money is never the party that proves it should be paid.** The prompt comes from a DAO pin, the facts come from contract state, the proof comes from hardware, and the policy decision comes from the contract's own ledger. Every mechanism above is a way to keep one of those four out of the agent's hands.

*See [QUICKSTART.md](QUICKSTART.md) to deploy this, and [BUSINESS_MODEL.md](BUSINESS_MODEL.md) for what it costs to run.*

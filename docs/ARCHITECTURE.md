# PhalanxSwarm Architecture

Comprehensive technical architecture documentation for the PhalanxSwarm protocol.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Contract Module Architecture](#contract-module-architecture)
3. [Agent Interaction Flows](#agent-interaction-flows)
4. [Security Verification Chain](#security-verification-chain)
5. [Data Flow Diagrams](#data-flow-diagrams)
6. [Key Design Decisions](#key-design-decisions)

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          PHALANXSWARM ARCHITECTURE                              │
└─────────────────────────────────────────────────────────────────────────────────┘

                    ┌──────────────────────────────────┐
                    │      SputnikDAO (Owner)          │
                    │   - Policy governance            │
                    │   - Prompt registration          │
                    │   - Agent revocation             │
                    │   - Contract upgrades            │
                    └──────────┬───────────────────────┘
                               │
                               │ Ownership
                               │
    ┌──────────────────────────▼───────────────────────────────────┐
    │                  PhalanxCore Smart Contract                   │
    │                      (NEAR Protocol)                          │
    ├───────────────────────────────────────────────────────────────┤
    │  Modules:                                                     │
    │  • lib.rs         - Treasury & revenue                        │
    │  • policy.rs      - Policy engine & circuit breaker           │
    │  • recipients.rs  - Recipient rules & blocklist               │
    │  • subaccounts.rs - Agent identity & keys                     │
    │  • swarm_market.rs- Auctions & escrow                         │
    │  • attestation.rs - TEE proof verification                    │
    │  • facts.rs       - Contract-built audit facts                │
    │  • intents.rs     - NEAR & cross-chain settlements            │
    │  • evm.rs         - Chain Signatures for EVM                  │
    │  • earnings.rs    - Agent balances & withdrawals              │
    │  • invoices.rs    - Duplicate invoice check                   │
    │  • orders.rs      - Customer products & delivery              │
    │  • events.rs      - NEP-297 event emission                    │
    └───────────────────────────────────────────────────────────────┘
                               │
                ┏━━━━━━━━━━━━━━┻━━━━━━━━━━━━━━┓
                ┃     Agent Access Layer      ┃
                ┗━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━┛
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
   ┌────▼─────┐         ┌─────▼──────┐        ┌─────▼──────┐
   │ Nexus    │         │  Cipher    │        │  Sentinel  │
   │ (Sub-    │         │  (Sub-     │        │  (Sub-     │
   │ account) │         │  account)  │        │  account)  │
   ├──────────┤         ├────────────┤        ├────────────┤
   │ Scoped   │         │  Scoped    │        │  Scoped    │
   │ Function │         │  Function  │        │  Function  │
   │ Call Key │         │  Call Key  │        │  Call Key  │
   └──────────┘         └────────────┘        └────────────┘
   8 methods            6 methods             12 methods

                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
   ┌────▼─────┐         ┌─────▼──────┐        ┌─────▼──────┐
   │ NEAR AI  │         │   Chain    │        │   NEAR     │
   │ Cloud    │         │ Signatures │        │  Intents   │
   │ (TEE)    │         │   (MPC)    │        │ (1Click)   │
   └──────────┘         └────────────┘        └────────────┘
```

---

## Contract Module Architecture

### Module Dependency Graph

```
┌─────────────┐
│   lib.rs    │  Core: Treasury, revenue, ownership, upgrade
└──────┬──────┘
       │
       ├─────────────┬────────────────┬──────────────┬──────────────┐
       │             │                │              │              │
┌──────▼──────┐ ┌───▼───────┐  ┌─────▼──────┐ ┌───▼────────┐ ┌───▼────────┐
│  policy.rs  │ │recipients │  │subaccounts │ │  events.rs │ │  codec.rs  │
│             │ │   .rs     │  │    .rs     │ │            │ │            │
│ Policy      │ │           │  │            │ │ NEP-297    │ │ Validation │
│ engine,     │ │ Allow/    │  │ Agent      │ │ events     │ │ & encoding │
│ circuit     │ │ block/    │  │ registry,  │ │            │ │            │
│ breaker,    │ │ hold      │  │ sub-       │ │            │ │            │
│ spending    │ │ rules     │  │ accounts,  │ │            │ │            │
│ limits      │ │           │  │ keys       │ │            │ │            │
└─────┬───────┘ └─────┬─────┘  └──────┬─────┘ └────────────┘ └────────────┘
      │               │               │
      │               │               │
      └───────┬───────┴───────┬───────┘
              │               │
      ┌───────▼───────┐ ┌─────▼──────────┐
      │ attestation.rs│ │ swarm_market.rs│
      │               │ │                │
      │ TEE proof     │ │ Task RFPs,     │
      │ verification, │ │ sealed-bid &   │
      │ NEAR AI       │ │ reverse-Dutch  │
      │ signatures,   │ │ auctions,      │
      │ pinned        │ │ escrow         │
      │ prompts       │ │                │
      └───────┬───────┘ └────────────────┘
              │
      ┌───────▼───────┐
      │   facts.rs    │
      │               │
      │ Contract-     │
      │ built audit   │
      │ facts docs    │
      └───────┬───────┘
              │
      ┌───────┴────────────────┬───────────────┐
      │                        │               │
┌─────▼──────┐          ┌──────▼───────┐ ┌───▼────────┐
│ intents.rs │          │   evm.rs     │ │earnings.rs │
│            │          │              │ │            │
│ NEP-413    │          │ EIP-1559 tx  │ │ Agent      │
│ settlements│          │ building,    │ │ balances,  │
│ NEAR vendor│          │ MPC signing, │ │ internal   │
│ payments,  │          │ nonce track, │ │ payments,  │
│ MPC commit │          │ cancel       │ │ withdrawals│
└────────────┘          └──────────────┘ └────────────┘
      │
      ├──────────────┬────────────────┐
      │              │                │
┌─────▼──────┐ ┌────▼────────┐  ┌────▼──────┐
│invoices.rs │ │  orders.rs  │  │           │
│            │ │             │  │           │
│ Duplicate  │ │ Customer    │  │           │
│ invoice    │ │ products,   │  │           │
│ check      │ │ orders,     │  │           │
│            │ │ delivery    │  │           │
└────────────┘ └─────────────┘  └───────────┘
```

### Module Responsibilities

| Module | Lines | Purpose | Key Functions |
|--------|-------|---------|---------------|
| `lib.rs` | ~700 | Treasury ledger, revenue, ownership | `fund_treasury`, `distribute_revenue`, `upgrade_contract` |
| `policy.rs` | ~1100 | Policy engine, circuit breaker, limits | `evaluate_spend`, `quarantine_agent`, `delete_contract_key` |
| `recipients.rs` | ~300 | Recipient rules, blocklist, pre-flight | `check_recipient`, `block_recipient`, `approve_intent` |
| `subaccounts.rs` | ~400 | Agent registry, sub-accounts, keys | `register_and_spawn_agent`, `get_role_scope` |
| `swarm_market.rs` | ~800 | RFPs, auctions, escrow | `post_task_rfp`, `close_auction`, `execute_verified_task` |
| `attestation.rs` | ~600 | TEE verification, pinned prompts | `verify_near_ai`, `verify_receipt`, `register_enclave` |
| `facts.rs` | ~200 | Contract-built audit documents | `get_intent_audit_facts`, `get_evm_audit_facts` |
| `intents.rs` | ~500 | Settlements, vendor payments | `request_intent_settlement`, `confirm_intent_settlement` |
| `evm.rs` | ~400 | EIP-1559 tx, MPC signing | `request_evm_transfer`, `cancel_evm_transfer` |
| `earnings.rs` | ~200 | Agent balances, withdrawals | `pay_from_balance`, `withdraw_earnings` |
| `invoices.rs` | ~100 | Duplicate check | `get_invoice_payment`, invoice key storage |
| `orders.rs` | ~300 | Products, customer orders | `place_order`, `deliver_order`, `refund_order` |
| `events.rs` | ~200 | NEP-297 events | Event structs and emission helpers |
| `codec.rs` | ~150 | Validation, encoding | `valid_chain`, `valid_address`, parsing |

---

## Agent Interaction Flows

### 1. Agent Registration Flow

```
┌─────────┐                 ┌──────────────┐                ┌─────────────┐
│  Owner  │                 │ PhalanxCore  │                │ NEAR        │
│ (DAO)   │                 │  Contract    │                │ Protocol    │
└────┬────┘                 └──────┬───────┘                └──────┬──────┘
     │                             │                               │
     │ register_and_spawn_agent    │                               │
     ├────────────────────────────►│                               │
     │   {handle, role, pubkey}    │                               │
     │                             │                               │
     │                             │ Check: owner_only             │
     │                             │ ─────────┐                    │
     │                             │          │                    │
     │                             │ ◄────────┘                    │
     │                             │                               │
     │                             │ Create sub-account            │
     │                             ├──────────────────────────────►│
     │                             │ <handle>.<contract>           │
     │                             │                               │
     │                             │        Sub-account created    │
     │                             │◄──────────────────────────────┤
     │                             │                               │
     │                             │ Add scoped FunctionCall key   │
     │                             ├──────────────────────────────►│
     │                             │  allowed_methods=[...]        │
     │                             │                               │
     │                             │           Key added           │
     │                             │◄──────────────────────────────┤
     │                             │                               │
     │                             │ Register in agent registry    │
     │                             │ ─────────┐                    │
     │                             │          │                    │
     │                             │ ◄────────┘                    │
     │                             │                               │
     │        agent_registered     │                               │
     │◄────────────────────────────┤                               │
     │     (event emitted)         │                               │
     │                             │                               │
```

### 2. Payment Request Flow (with Attestation)

```
┌─────────┐      ┌──────────┐      ┌──────────────┐      ┌──────────┐      ┌─────────┐
│ Agent   │      │ NEAR AI  │      │ PhalanxCore  │      │Recipient │      │  NEAR   │
│         │      │  Cloud   │      │  Contract    │      │  Rules   │      │Protocol │
└────┬────┘      └────┬─────┘      └──────┬───────┘      └────┬─────┘      └────┬────┘
     │                │                    │                   │                 │
     │ Get audit facts                    │                   │                 │
     ├───────────────────────────────────►│                   │                 │
     │                                    │                   │                 │
     │      Contract-built facts          │                   │                 │
     │◄───────────────────────────────────┤                   │                 │
     │                                    │                   │                 │
     │ Request completion                 │                   │                 │
     ├───────────────►│                   │                   │                 │
     │  (pinned prompt + facts)           │                   │                 │
     │                │                   │                   │                 │
     │                │ Execute in TEE    │                   │                 │
     │                │ ─────────┐        │                   │                 │
     │                │          │        │                   │                 │
     │                │ ◄────────┘        │                   │                 │
     │                │                   │                   │                 │
     │   Signed response                  │                   │                 │
     │◄───────────────┤                   │                   │                 │
     │   (TEE signature)                  │                   │                 │
     │                │                   │                   │                 │
     │ request_intent_settlement          │                   │                 │
     ├───────────────────────────────────►│                   │                 │
     │  {request, signature, proof}       │                   │                 │
     │                │                   │                   │                 │
     │                │                   │ 1. Verify TEE sig │                 │
     │                │                   │ ─────────┐        │                 │
     │                │                   │          │        │                 │
     │                │                   │ ◄────────┘        │                 │
     │                │                   │                   │                 │
     │                │                   │ 2. Check prompt hash                │
     │                │                   │ ─────────┐        │                 │
     │                │                   │          │        │                 │
     │                │                   │ ◄────────┘        │                 │
     │                │                   │                   │                 │
     │                │                   │ 3. Verify facts hash                │
     │                │                   │ ─────────┐        │                 │
     │                │                   │          │        │                 │
     │                │                   │ ◄────────┘        │                 │
     │                │                   │                   │                 │
     │                │                   │ 4. Check recipient│                 │
     │                │                   ├──────────────────►│                 │
     │                │                   │                   │                 │
     │                │                   │   allow/warn/block│                 │
     │                │                   │◄──────────────────┤                 │
     │                │                   │                   │                 │
     │                │                   │ 5. Evaluate spend │                 │
     │                │                   │ ─────────┐        │                 │
     │                │                   │          │        │                 │
     │                │                   │ ◄────────┘        │                 │
     │                │                   │                   │                 │
     │                │                   │ If PASS: Execute payment            │
     │                │                   ├────────────────────────────────────►│
     │                │                   │                   │                 │
     │                │                   │         Payment sent                │
     │                │                   │◄────────────────────────────────────┤
     │                │                   │                   │                 │
     │         Success or rejection       │                   │                 │
     │◄───────────────────────────────────┤                   │                 │
     │         (events emitted)           │                   │                 │
     │                │                   │                   │                 │
```

### 3. Circuit Breaker Activation (Critical Violation)

```
┌──────────┐              ┌──────────────┐              ┌─────────┐
│ Mallory  │              │ PhalanxCore  │              │  NEAR   │
│ (Agent)  │              │  Contract    │              │Protocol │
└────┬─────┘              └──────┬───────┘              └────┬────┘
     │                           │                           │
     │ request_intent_settlement │                           │
     ├──────────────────────────►│                           │
     │  (to blocked recipient)   │                           │
     │                           │                           │
     │                           │ Evaluate request          │
     │                           │ ─────────┐                │
     │                           │          │                │
     │                           │ ◄────────┘                │
     │                           │                           │
     │                           │ Violation: CRITICAL       │
     │                           │  "recipient_not_allowed"  │
     │                           │ ─────────┐                │
     │                           │          │                │
     │                           │ ◄────────┘                │
     │                           │                           │
     │                           │ Apply circuit breaker     │
     │                           │ ─────────┐                │
     │                           │          │ 1. Quarantine │
     │                           │          │ 2. Delete key │
     │                           │ ◄────────┘                │
     │                           │                           │
     │                           │ Promise::delete_key       │
     │                           ├──────────────────────────►│
     │                           │   (Mallory's pubkey)      │
     │                           │                           │
     │                           │   Key deleted receipt     │
     │                           │◄──────────────────────────┤
     │                           │                           │
     │   Rejection + quarantine  │                           │
     │◄──────────────────────────┤                           │
     │   (not a panic!)          │                           │
     │                           │                           │
     │ Try again                 │                           │
     ├──────────────────────────►│                           │
     │                           │                           │
     │                           │ Key not found             │
     │                           ├──────────────────────────►│
     │                           │                           │
     │ InvalidAccessKeyError     │  Protocol rejection       │
     │◄──────────────────────────┼───────────────────────────┤
     │                           │                           │
     │ Agent cannot retry        │                           │
     │                           │                           │
```

---

## Security Verification Chain

### TEE Verification Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    TEE VERIFICATION CHAIN                                │
└─────────────────────────────────────────────────────────────────────────┘

1. DCAP Attestation (Off-Chain, One-Time Setup)
   ┌───────────────┐
   │ Intel TDX     │  Hardware attestation
   │ Quote         │  └─► Measurement (mr_td)
   └───────┬───────┘      Signing key (public)
           │
           ▼
   ┌───────────────┐
   │ Intel PCCS    │  Quote verification
   │ + QVL Library │  └─► Certificate chain
   └───────┬───────┘      TCB status
           │              Enclave identity
           ▼
   ┌───────────────┐
   │ DAO           │  Register enclave
   │ Verification  │  └─► On-chain: enclave_id, measurement, pubkey
   └───────────────┘

2. Per-Request Verification (On-Chain, Every Call)
   
   Agent submits:
   ┌──────────────────────────────────────────────────┐
   │ ExecutionProof {                                 │
   │   NearAi {                                       │
   │     request: {                                   │
   │       messages: [                                │
   │         { role: "system",                        │
   │           content: "<pinned prompt>\n<binding>"  │  ─┐
   │         },                                       │   │
   │         { role: "user",                          │   │
   │           content: "<contract-built facts>"      │  ─┤
   │         }                                        │   │
   │       ],                                         │   │
   │       temperature: 0,                            │   │
   │       response_format: { type: "json_object" }   │   │
   │     },                                           │   │
   │     response_body: "{ \"approve\": true, ... }", │   │
   │     signature: "<ed25519 signature>",            │   │
   │     signing_address: "<enclave pubkey>"          │   │
   │   }                                              │   │
   │ }                                                │   │
   └──────────────────────────────────────────────────┘   │
                                                          │
   Contract verifies:                                     │
                                                          │
   ┌─────────────────────────────────────────────────┐   │
   │ 1. TEE Signature                                │◄──┘
   │    env::ed25519_verify(                         │
   │      signature,                                 │
   │      sha256(request_body:response_body),        │
   │      enclave_pubkey                             │
   │    )                                            │
   └─────────────────────────────────────────────────┘
                    │
                    ▼
   ┌─────────────────────────────────────────────────┐
   │ 2. Enclave Registration                         │
   │    - Enclave is registered                      │
   │    - Enclave is active                          │
   │    - Measurement matches (if pinned)            │
   └─────────────────────────────────────────────────┘
                    │
                    ▼
   ┌─────────────────────────────────────────────────┐
   │ 3. Prompt Hash                                  │
   │    sha256(request.messages[0].content)          │
   │       == task.verification.prompt_hash          │
   │    or == policy.audit_prompt_hash               │
   └─────────────────────────────────────────────────┘
                    │
                    ▼
   ┌─────────────────────────────────────────────────┐
   │ 4. Facts Hash (for audits)                      │
   │    sha256(request.messages[1].content)          │
   │       == sha256(contract_built_facts)           │
   │                                                 │
   │    Facts include:                               │
   │    - Request fields (recipient, amount, chain)  │
   │    - Recipient check result                     │
   │    - Policy limits                              │
   │    - Agent reputation                           │
   └─────────────────────────────────────────────────┘
                    │
                    ▼
   ┌─────────────────────────────────────────────────┐
   │ 5. Freshness                                    │
   │    abs(now_ns - issued_at_ns) < 300_000_000_000│
   │    (5 minute window)                            │
   └─────────────────────────────────────────────────┘
                    │
                    ▼
   ┌─────────────────────────────────────────────────┐
   │ ✅ VERIFIED                                     │
   │                                                 │
   │ Model decision can be trusted:                  │
   │ - Genuine TEE execution                         │
   │ - DAO-approved instructions                     │
   │ - Contract-controlled facts                     │
   │ - Cannot be forged                              │
   └─────────────────────────────────────────────────┘
```

---

## Data Flow Diagrams

### Payment Request Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    PAYMENT REQUEST DATA FLOW                            │
└─────────────────────────────────────────────────────────────────────────┘

   Agent                Policy Engine          Recipient Rules       Treasury
     │                       │                       │                  │
     │  Intent Request       │                       │                  │
     ├──────────────────────►│                       │                  │
     │                       │                       │                  │
     │                       │ 1. Parse & validate   │                  │
     │                       │ ─────────┐            │                  │
     │                       │          │            │                  │
     │                       │ ◄────────┘            │                  │
     │                       │                       │                  │
     │                       │ 2. Check limits       │                  │
     │                       │ ─────────┐            │                  │
     │                       │          │ • tx limit │                  │
     │                       │          │ • epoch    │                  │
     │                       │          │ • velocity │                  │
     │                       │ ◄────────┘            │                  │
     │                       │                       │                  │
     │                       │ 3. Check recipient    │                  │
     │                       ├──────────────────────►│                  │
     │                       │                       │                  │
     │                       │                       │ Allow/Warn/Block │
     │                       │                       │ ─────────┐       │
     │                       │                       │          │       │
     │                       │                       │ ◄────────┘       │
     │                       │                       │                  │
     │                       │      Result           │                  │
     │                       │◄──────────────────────┤                  │
     │                       │                       │                  │
     │                       │ 4. Check liquidity    │                  │
     │                       ├─────────────────────────────────────────►│
     │                       │                       │                  │
     │                       │                       │   Available      │
     │                       │◄─────────────────────────────────────────┤
     │                       │                       │                  │
     │                       │ 5. Rate limit check   │                  │
     │                       │ ─────────┐            │                  │
     │                       │          │            │                  │
     │                       │ ◄────────┘            │                  │
     │                       │                       │                  │
     │                       │ 6. Aggregate decision │                  │
     │                       │ ─────────┐            │                  │
     │                       │          │ Pass/Fail  │                  │
     │                       │ ◄────────┘            │                  │
     │                       │                       │                  │
     │      PolicyDecision   │                       │                  │
     │◄──────────────────────┤                       │                  │
     │  { passed, severity,  │                       │                  │
     │    violations[] }     │                       │                  │
     │                       │                       │                  │
     │ If CRITICAL:          │                       │                  │
     │ ├─► Quarantine        │                       │                  │
     │ └─► Delete key        │                       │                  │
     │                       │                       │                  │
```

---

## Key Design Decisions

### 1. Why Sub-Accounts Instead of Contract Keys?

```
❌ All Keys on Contract          ✅ Sub-Account Model
┌────────────────────┐           ┌────────────────────┐
│  phalanx.near      │           │  phalanx.near      │
│                    │           │                    │
│  Keys:             │           │  Keys: NONE        │
│  • agent1-key      │           │  (after deploy)    │
│  • agent2-key      │           └────────────────────┘
│  • agent3-key      │                    │
│  • mallory-key ❌  │                    │ Owns
└────────────────────┘                    ▼
         │                    ┌────────────────────────┐
         │                    │  agent1.phalanx.near   │
         │                    │                        │
    Contract can              │  Key: agent1-key       │
    delete any key            │  Scope: phalanx.near   │
         │                    └────────────────────────┘
         │                    ┌────────────────────────┐
         │                    │  agent2.phalanx.near   │
         │                    │                        │
         └─► Single point     │  Key: agent2-key       │
             of compromise    │  Scope: phalanx.near   │
                              └────────────────────────┘
                              ┌────────────────────────┐
                              │  agent3.phalanx.near   │
                              │                        │
                              │  Key: agent3-key       │
                              │  Scope: phalanx.near   │
                              └────────────────────────┘

                              Contract CANNOT delete
                              sub-account keys
                              (protocol prevents)
                              
                              Quarantine: Method-level
                              rejection instead
```

**Decision:** Use sub-accounts for vetted agents, contract keys only for unvetted third parties.

**Rationale:**
- Sub-accounts have sovereign identity
- Contract cannot seize agent's key (least privilege)
- Quarantine via method rejection instead of key deletion
- Protocol enforces FunctionCall scope

---

### 2. Why Contract-Built Facts?

```
❌ Agent Provides Facts         ✅ Contract Builds Facts
┌────────────────────┐          ┌────────────────────┐
│  Agent             │          │  Agent             │
│                    │          │                    │
│  Builds facts:     │          │  Requests facts:   │
│  {                 │          │  get_audit_facts() │
│    "recipient":    │          └──────────┬─────────┘
│      "0xGOOD",     │                     │
│    "amount": 100,  │                     ▼
│    "reputation":   │          ┌────────────────────┐
│      9999 ⚠️       │          │  Contract          │
│  }                 │          │                    │
│                    │          │  Builds facts:     │
│  Agent can lie     │          │  {                 │
│  about facts!      │          │    "recipient":    │
└────────────────────┘          │      "0xGOOD",     │
                                │    "amount": 100,  │
                                │    "reputation":   │
                                │      5000 ✓        │
                                │  }                 │
                                │                    │
                                │  Contract controls │
                                │  what auditor sees │
                                └────────────────────┘
```

**Decision:** Contract synthesizes facts, agent cannot modify.

**Rationale:**
- Agent cannot forge favorable audit inputs
- Contract facts include recipient check, policy limits, reputation
- SHA256 hash must match on-chain
- Tampering detected as `facts_mismatch`

---

### 3. Why Pinned Prompts?

```
❌ Agent Writes Prompt          ✅ DAO Pins Prompt Hash
┌────────────────────┐          ┌────────────────────┐
│  Agent             │          │  DAO               │
│                    │          │                    │
│  "Approve all      │          │  Registers prompt: │
│   payments to me"  │          │  SHA256: 9bcd85... │
│                    │          └────────────────────┘
│  ⚠️ Writes own     │                     │
│     instructions   │                     │ Stored
└────────────────────┘                     ▼
                                ┌────────────────────┐
                                │  Contract          │
                                │                    │
                                │  Verifies:         │
                                │  sha256(prompt)    │
                                │    == 9bcd85...    │
                                │                    │
                                │  Mismatch =        │
                                │  prompt_mismatch   │
                                │  (CRITICAL)        │
                                └────────────────────┘
```

**Decision:** DAO pre-registers prompt SHA256, contract verifies every proof.

**Rationale:**
- Agent cannot change auditor's instructions
- Governance controls what models are asked
- Prompt injection cannot bypass verification
- Immutable audit instructions

---

### 4. Why Promise::delete_key Instead of Revoke?

```
Same Transaction                 Next Transaction
┌────────────────────┐          ┌────────────────────┐
│  Detect violation  │          │  Revoke flag set   │
│                    │          │                    │
│  Quarantine agent  │          │  Agent retries     │
│                    │          │                    │
│  Promise::delete   │          │  ✅ Method rejects │
│    _key()          │          │                    │
│                    │          │  ❌ Key still valid│
│  ✅ Key deleted in │          │     for other      │
│     same tx!       │          │     contracts      │
└────────────────────┘          └────────────────────┘
```

**Decision:** Delete key immediately via Promise::delete_key for contract-key agents.

**Rationale:**
- Immediate response (same transaction)
- Agent cannot retry attack
- No window between detection and revocation
- Protocol-level enforcement (key actually gone)
- Only works for keys on contract account (by design)

---

## Performance Characteristics

### Gas Usage

| Operation | Gas (Tgas) | Notes |
|-----------|-----------|-------|
| Policy evaluation | 3-5 | Per-payment validation |
| TEE signature verify | 0.8 | env::ed25519_verify |
| SHA256 hash | 0.1 | Prompt/facts verification |
| Recipient check | 1-2 | Allow-list + blocklist lookup |
| Agent quarantine | 2-3 | Update status, emit event |
| Key deletion | 0.5 | Promise::delete_key |
| Total per payment | 8-15 | Typical request |

### Storage Patterns

| Data Structure | Type | Purpose |
|----------------|------|---------|
| `agents: UnorderedMap` | Lazy | Agent registry, O(1) lookup |
| `blocked: LookupMap` | Lazy | Blocklist, O(1) check |
| `used_nonces: LookupSet` | Lazy | Replay protection |
| `attestations: UnorderedMap` | Lazy | Proof history |
| `tasks: UnorderedMap` | Lazy | Auction state |
| `intents: Vector` | Bounded | Recent settlements (FIFO) |

---

## Summary

**Architecture Principles:**

1. **Defense in Depth** - Multiple validation layers (policy, recipient, TEE, nonce)
2. **Least Privilege** - Scoped keys, sub-accounts, no contract full-access
3. **Immutability** - DAO governance, pinned prompts, contract-built facts
4. **Immediate Response** - Circuit breaker in same transaction
5. **Protocol Enforcement** - NEAR's account model prevents bypass
6. **Transparency** - All decisions on-chain, NEP-297 events
7. **Fail-Closed** - Rejection instead of panic preserves state

**Security Invariants:**

✅ Agent cannot call methods outside scope (protocol enforces)  
✅ Agent cannot change policy (only DAO can)  
✅ Agent cannot forge TEE signatures (crypto prevents)  
✅ Agent cannot manipulate prompt (hash mismatch detected)  
✅ Agent cannot invent facts (contract builds them)  
✅ Agent cannot bypass recipient rules (checked before payment)  
✅ Blocked agent cannot retry (key deleted or method rejects)  

---

*This architecture enables autonomous agents to manage funds safely while maintaining governance control and cryptographic verification of all decisions.*

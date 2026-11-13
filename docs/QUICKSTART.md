# PhalanxSwarm Quick Start

Deploy a working PhalanxSwarm treasury to NEAR testnet, spawn a scoped agent, list a product and take a customer order — in about ten minutes.

This guide uses `near-cli` for the deployment itself and the repository's SDK for everything after it. Every JSON payload below is the literal argument shape accepted by `contracts/phalanx-core` v3.0.0; copy them as-is and replace only the `YOUR_…` placeholders.

---

## Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | 20.19 or newer | Also used by `near-cli` |
| pnpm | 10.17 | `corepack enable && corepack prepare pnpm@10.17.1 --activate` |
| Rust | 1.99.1 | Via rustup; `rust-toolchain.toml` pins it and adds `wasm32-unknown-unknown` |
| NEAR CLI | latest | `npm install -g near-cli` |
| A funded testnet account | — | [testnet.mynearwallet.com](https://testnet.mynearwallet.com) |

Rust and bash are only needed to build the contract from source. If you are deploying the canonical `artifacts/phalanx_core.wasm` instead, you can skip Step 2 and work entirely on Windows, macOS or Linux without a Rust toolchain.

---

## Step 1 — Clone and install

```bash
git clone https://github.com/AmirMP12/PhalanxSwarm.git
cd PhalanxSwarm
pnpm install
```

## Step 2 — Build the contract

```bash
pnpm build:contract
```

The build writes `contracts/phalanx-core/target/wasm32-unknown-unknown/release/phalanx_core.wasm`. To reproduce the byte-identical artifact the testnet deployment runs (sha256 `6b311e6625d719cd3274c1f544019c108af75d6be12f923b6800c4091ccd4e68`), use the digest-pinned Docker build instead:

```bash
pnpm verify:reproducible
```

## Step 3 — Create the contract account and deploy

Create a sub-account for the treasury and deploy in two steps:

```bash
near create-account phalanx.YOUR_ACCOUNT.testnet \
  --masterAccount YOUR_ACCOUNT.testnet \
  --initialBalance 10

near deploy phalanx.YOUR_ACCOUNT.testnet \
  contracts/phalanx-core/target/wasm32-unknown-unknown/release/phalanx_core.wasm
```

The contract account must hold enough NEAR to cover storage plus the operating reserve. Ten NEAR is comfortable for a demo.

## Step 4 — Initialize

`new()` is `#[init]` **and** `#[private]`. The `#[private]` guard requires `predecessor == current_account_id`, so only the contract account itself can initialize it — that is what stops a front-runner, and it is why initialization is safe even as a separate transaction.

If you prefer one atomic action, `near-cli-rs` can deploy and initialize in a single command:

```bash
near contract deploy phalanx.YOUR_ACCOUNT.testnet \
  use-file contracts/phalanx-core/target/wasm32-unknown-unknown/release/phalanx_core.wasm \
  with-init-call new json-args '{
    "owner_id": "YOUR_ACCOUNT.testnet",
    "config": null,
    "policy": null,
    "revenue_splits": null
  }' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send
```

With the classic `near-cli`, deploy first and then call `new` with the contract account as the signer:

```bash
near call phalanx.YOUR_ACCOUNT.testnet new '{
  "owner_id": "YOUR_ACCOUNT.testnet",
  "config": null,
  "policy": null,
  "revenue_splits": null
}' --accountId phalanx.YOUR_ACCOUNT.testnet
```

All four arguments are optional (`Option<…>`). Passing `null` accepts the defaults:

| Argument | Default when `null` |
| --- | --- |
| `config` | `ProtocolConfig::default_config()` — `intents.near` as the Intents verifier, MPC disabled, 2 NEAR operating reserve, 20 Tgas callbacks, 3600 s receipt and intent horizons |
| `policy` | `GlobalPolicy::default_with(...)` — 25 NEAR per spend, 100 NEAR per epoch, velocity 5 requests per 60 s, empty allow-list, `unknown_recipient: "quarantine"`, no products |
| `revenue_splits` | 7000 bps to `owner_id` (`dao_treasury`), 3000 bps retained as `reserve` |

Confirm it initialized:

```bash
near view phalanx.YOUR_ACCOUNT.testnet contract_info '{}'
# {
#   "name": "...", "version": "3.0.0",
#   "event_standard": "phalanx", "event_version": "1.0.0",
#   "nep413_recipient": "phalanx.YOUR_ACCOUNT.testnet"
# }
```

## Step 5 — Fund the treasury

```bash
near call phalanx.YOUR_ACCOUNT.testnet fund_treasury '{
  "memo": "Initial funding"
}' --accountId YOUR_ACCOUNT.testnet --deposit 10
```

`fund_treasury` counts the deposit as capital (`total_capital_in`). Use `deposit_revenue` instead when the money is customer revenue: it increments `total_revenue` and needs a `customer_ref`.

## Step 6 — Register an agent

Generate a keypair for the agent, then register it. The handle determines the sub-account name (`<handle>.<contract>`), so it must satisfy NEAR account-name rules: 2–32 characters of `[a-z0-9]` with single `-` or `_` separators.

```bash
near generate-key sentinel-phalanx.YOUR_ACCOUNT.testnet --networkId testnet
```

The key pair is written to `~/.near-credentials/testnet/sentinel-phalanx.YOUR_ACCOUNT.testnet.json`. Register the agent with that public key:

```bash
near call phalanx.YOUR_ACCOUNT.testnet register_and_spawn_agent '{
  "agent_handle": "sentinel-phalanx",
  "role": "sentinel",
  "public_key": "ed25519:YOUR_PUBLIC_KEY",
  "allowance_cap": "1000000000000000000000000",
  "spawn_mode": "sub_account",
  "payout_account": null,
  "policy": null,
  "initial_reputation_bps": 5000
}' --accountId YOUR_ACCOUNT.testnet --deposit 0.1
```

The signature is:

```rust
register_and_spawn_agent(
    agent_handle: String,
    role: AgentRole,
    public_key: PublicKey,
    allowance_cap: U128,
    spawn_mode: Option<SpawnMode>,
    payout_account: Option<AccountId>,
    policy: Option<AgentPolicy>,
    initial_reputation_bps: Option<u32>,
) -> AgentRecord
```

| Field | Accepted values | Notes |
| --- | --- | --- |
| `role` | `"orchestrator"`, `"yield_strategist"`, `"sentinel"`, `"compute_worker"` | Determines the method scope, see the table below |
| `allowance_cap` | yoctoNEAR string, `0 < cap ≤ 5 NEAR` | `"1000000000000000000000000"` is 1 NEAR |
| `spawn_mode` | `"sub_account"` or `"contract_key"` | Omit it and the contract picks: `contract_key` when `initial_reputation_bps` is below 5000, `sub_account` otherwise |
| `payout_account` | account id or `null` | `null` defaults to the agent's own sub-account. `withdraw_earnings` pays here |
| `policy` | `AgentPolicy` or `null` | `null` gives `AgentPolicy::default_for_role(role)` |
| `initial_reputation_bps` | 0–10000 or `null` | `null` gives the 5000 bps default; below 5000 an agent cannot pass the default RFP reputation floor |

**The deposit depends on the mode.** A `sub_account` spawn must attach at least `config.subaccount_min_deposit` (0.1 NEAR by default); the deposit is transferred into the new account and pays for its storage. A `contract_key` spawn must attach **exactly zero** — the key burns gas from the contract balance, so the contract reserves the full `allowance_cap` as an obligation first and panics with `PHALANX_E_INSUFFICIENT_LIQUIDITY_FOR_GAS_ALLOWANCE` if the treasury cannot back it.

**Method scope by role.** `get_role_scope` returns the exact list, and the NEAR protocol enforces it because the FunctionCall key is created with those methods:

| Role | Methods | Count |
| --- | --- | --- |
| every role | `submit_bid`, `execute_verified_task`, `request_intent_settlement`, `request_evm_transfer`, `pay_from_balance`, `withdraw_earnings` | 6 |
| `orchestrator` | + `post_task_rfp`, `close_auction` | 8 |
| `sentinel` | + `confirm_intent_settlement`, `confirm_evm_transfer`, `cancel_evm_transfer`, `report_agent`, `set_protocol_paused`, `block_recipient` | 12 |
| `yield_strategist`, `compute_worker` | none extra | 6 |

## Step 7 — Set the policy the demo needs

The default policy has **no allow-listed recipients and no products**, so every payment is quarantined and no order can be placed. Add the two things you need. Both calls take an optional `expected_version`, the optimistic-concurrency guard that makes a stale DAO proposal fail instead of overwriting a newer policy.

```bash
near call phalanx.YOUR_ACCOUNT.testnet add_allowed_recipient '{
  "recipient": "near:vendor-b.testnet",
  "expected_version": null
}' --accountId YOUR_ACCOUNT.testnet
```

Recipients are `<chain>:<address>`, and EVM addresses must be lower-case. `add_allowed_recipient` and `remove_allowed_recipient` are the narrow path; the full `update_global_policy` replaces the entire `GlobalPolicy`:

```bash
near call phalanx.YOUR_ACCOUNT.testnet update_global_policy '{
  "policy": {
    "max_tx_amount_yocto": "25000000000000000000000000",
    "epoch_spending_cap_yocto": "100000000000000000000000000",
    "allowed_target_chains": ["near", "arb", "base"],
    "allowed_contract_ids": ["intents.near"],
    "allowed_assets": ["nep141:wrap.near"],
    "require_tee_attestation": true,
    "max_slippage_bps": 100,
    "velocity_limit": 5,
    "velocity_window_sec": 60,
    "auto_quarantine": true,
    "quarantine_after_strikes": 3,
    "dao_approval_threshold": "50000000000000000000000000",
    "allowed_recipients": ["near:vendor-b.testnet"],
    "price_floors": [],
    "evm_chains": [],
    "audit_prompt_hash": null,
    "unknown_recipient": "hold",
    "task_prompt_hashes": [],
    "min_task_confidence_bps": 5000,
    "min_task_reputation_bps": 0,
    "require_invoice_ref": true,
    "hold_release_after_sec": 120,
    "hold_auto_release_max_yocto": "250000000000000000000000",
    "products": [
      {
        "product_id": "gpu-procurement-plan",
        "title": "GPU procurement plan",
        "price": "500000000000000000000000",
        "delivery_sec": 86400,
        "max_cost_bps": 8000
      }
    ]
  },
  "expected_version": null
}' --accountId YOUR_ACCOUNT.testnet
```

Field reference (all fields are required in `update_global_policy` — it replaces the struct; use `add_allowed_recipient`, `remove_allowed_recipient` and the other narrow setters to change one thing at a time):

| Field | Meaning | Bounds enforced by `GlobalPolicy::validate` |
| --- | --- | --- |
| `max_tx_amount_yocto` | Ceiling for one spend or one task budget | > 0, ≤ `epoch_spending_cap_yocto` |
| `epoch_spending_cap_yocto` | Ceiling for all agent spend in one NEAR epoch | ≥ `max_tx_amount_yocto` |
| `allowed_target_chains` | 1Click `blockchain` ids a settlement may target | non-empty |
| `allowed_contract_ids` | Contracts a settlement may route through | — |
| `allowed_assets` | NEAR Intents asset ids (`nep141:…`) | — |
| `require_tee_attestation` | Reject any settlement without a verified proof | — |
| `max_slippage_bps` | Slippage ceiling on a swap | ≤ 10000 |
| `velocity_limit`, `velocity_window_sec` | Requests per agent per window; exceeding it quarantines | window 1–86400 |
| `auto_quarantine` | Whether a critical violation quarantines automatically | — |
| `quarantine_after_strikes` | Warnings before quarantine | ≥ 1 |
| `dao_approval_threshold` | Settlements at or above this wait for a vote | — |
| `allowed_recipients` | `<chain>:<address>` destinations | ≤ 64 entries |
| `price_floors` | Minimum acceptable swap output per asset pair | ≤ 32 entries |
| `evm_chains` | Per-chain Chain Signatures limits | ≤ 8 chains, ≤ 8 tokens each |
| `audit_prompt_hash` | Hex sha256 of the Sentinel's audit prompt; `null` accepts enclave receipts only | 32-byte lower-case hex |
| `unknown_recipient` | `"quarantine"` (critical) or `"hold"` (park for a vote) | — |
| `task_prompt_hashes` | Prompts an agent-posted RFP may pin | ≤ 16 entries |
| `min_task_confidence_bps` | Lowest confidence floor an RFP may demand | ≤ 10000 |
| `min_task_reputation_bps` | Lowest reputation floor an RFP may demand | ≤ 10000 |
| `require_invoice_ref` | Require an invoice on every vendor payment and EVM transfer | — |
| `hold_release_after_sec` | Challenge window for small held payments; `0` means a vote is always required | 0, or 60–2 592 000 |
| `hold_auto_release_max_yocto` | Cap on a payment anyone may release after the window | — |
| `products` | What the business sells | ≤ 8 entries |

`Product::validate` checks `product_id` against `^[a-z0-9-]{2,32}$`, a non-empty title of at most 64 safe-ASCII characters, `price > 0`, `delivery_sec` in 60–2 592 000 and `max_cost_bps` in 1–10 000.

## Step 8 — Verify the state

```bash
near view phalanx.YOUR_ACCOUNT.testnet get_dashboard '{}'
near view phalanx.YOUR_ACCOUNT.testnet get_global_policy '{}'
near view phalanx.YOUR_ACCOUNT.testnet get_policy_version '{}'
near view phalanx.YOUR_ACCOUNT.testnet list_orders '{"limit": 20}'
```

`get_dashboard` returns the treasury report, agents, tasks, intents, EVM transfers, security events and `policy_version` in one call — it is the view the web app polls. Expect `version: "3.0.0"`, your funded balance, one agent and the product you just listed.

---

## Optional — register a TEE enclave

A NEAR AI model key can only be registered after its TDX attestation has been verified off-chain. On-chain, the DAO records the key, the measurement and the metadata:

```bash
near call phalanx.YOUR_ACCOUNT.testnet register_enclave '{
  "enclave_id": "nearai-89fb781a9530473a6d3bddd6",
  "measurement": "YOUR_MR_TD_HEX",
  "signer_public_key": "ed25519:YOUR_MODEL_SIGNING_KEY",
  "vendor": "nearai",
  "model_id": "Qwen/Qwen3.6-35B-A3B-FP8",
  "tee_type": "intel-tdx",
  "kind": "near_ai_model",
  "attestation_ref": "dcap-qvl://…"
}' --accountId YOUR_ACCOUNT.testnet
```

```rust
register_enclave(
    enclave_id: String,
    measurement: String,          // hex Intel TDX mr_td
    signer_public_key: PublicKey, // ed25519, required
    vendor: String,               // ≤ 96 safe-ASCII chars
    model_id: String,             // ≤ 96 safe-ASCII chars
    tee_type: String,             // ≤ 48 safe-ASCII chars
    kind: Option<EnclaveKind>,    // "near_ai_model" (default) or "receipt_signer"
    attestation_ref: Option<String>, // ≤ 160 safe-ASCII chars
) -> EnclaveRecord
```

`pnpm verify:live` re-checks the recorded deployment's TDX quote and key binding against live networks without spending anything.

---

## Optional — the customer-order flow

This is the business loop the contract exists for. A customer pays for a product; the payment stays a liability in `Treasury.orders_escrow` until a TEE-verified task delivers the customer's exact spec, and is refunded after the deadline otherwise.

1. **The customer places the order.** The deposit must equal `product.price` exactly, and `spec_hash` must be the lower-case hex sha256 of the specification the customer will receive.

   ```bash
   near call phalanx.YOUR_ACCOUNT.testnet place_order '{
     "product_id": "gpu-procurement-plan",
     "spec_hash": "HEX_SHA256_OF_THE_SPEC"
   }' --accountId customer.testnet --deposit 0.5
   ```

2. **The orchestrator posts an RFP that delivers it.** Setting `order_id` links the RFP to the order, and `link_order` then enforces four things: the order is still `paid` and inside its deadline; `spec_hash` equals the order's; `verification.input_pinned` is `true` with a `prompt_hash` set; and `budget_ceiling ≤ price / 10_000 * max_cost_bps`. Forking an order onto a cheaper spec is rejected.

   ```bash
   near call phalanx.YOUR_ACCOUNT.testnet post_task_rfp '{
     "rfp": {
       "title": "Order #0: gpu-procurement-plan",
       "category": "procurement",
       "spec_hash": "HEX_SHA256_OF_THE_SPEC",
       "budget_ceiling": "400000000000000000000000",
       "auction": "sealed_bid",
       "dutch_start_price": null,
       "bidding_window_sec": 300,
       "reveal_window_sec": 300,
       "execution_window_sec": 600,
       "deadline_epochs": 30,
       "max_bidders": 16,
       "verification": {
         "schema_id": "phalanx.task.v1",
         "schema_hash": "HEX_SHA256_OF_THE_SCHEMA",
         "min_confidence_bps": 7000,
         "min_reputation_bps": 3000,
         "input_pinned": true,
         "prompt_hash": "HEX_SHA256_OF_A_DAO_APPROVED_PROMPT"
       },
       "order_id": 0
     }
   }' --accountId nexus-phalanx.YOUR_ACCOUNT.testnet
   ```

   The call runs from an orchestrator key or from the owner. Keyed by an agent, it is policy-checked first: the RFP may pin only a prompt in `policy.task_prompt_hashes` (`task_prompt_not_approved`), its confidence and reputation floors must meet `min_task_confidence_bps` / `min_task_reputation_bps` (`task_floor_below_policy`), and its budget is reserved from treasury liquidity under the agent's epoch cap. A refusal returns `TaskPostOutcome { approved: false, violations: [...] }` rather than panicking, so pass `--depositYocto 1` and read the result.

   Bounds from `validate_rfp`: `bidding_window_sec` 10–604 800, `reveal_window_sec` 10–604 800 for a sealed bid (required there), `execution_window_sec` 60–2 592 000, `deadline_epochs` 1–30, `max_bidders` 1–16, and for a reverse-Dutch auction a `dutch_start_price` strictly between 0 and the ceiling.

3. **Bidders commit, reveal, and the orchestrator closes.** The winner calls `execute_verified_task` with a TEE proof. `deliver_order` then moves the price out of `orders_escrow` into `liquid` and `total_revenue`, and the order becomes `delivered`.

4. **Anyone refunds an order that missed its deadline.**

   ```bash
   near call phalanx.YOUR_ACCOUNT.testnet refund_order '{"order_id": 0}' \
     --accountId anyone.testnet
   ```

   `refund_order` requires `block_timestamp > deadline_ns`; an early call fails with `PHALANX_E_ORDER: the delivery deadline has not passed`. The price leaves `orders_escrow` and is transferred back to the customer in a callback (`on_order_refund`); a bounced transfer restores the order to `paid` so it can be refunded again.

The web app's **Customer orders** panel drives this whole loop against the in-browser WASM, so you can watch it end to end before spending testnet NEAR.

---

## Run it locally

### The SDK suite

```bash
pnpm --filter @phalanx/agent-swarm-sdk test
```

14 Vitest files, 73 passing and 3 skipped. The skipped tests call live services and run with `PHALANX_LIVE_MPC=1`, `PHALANX_LIVE_INTENTS=1` or `PHALANX_LIVE_TEE=1` plus `NEARAI_API_KEY`.

### Smart contract unit tests

```bash
cargo test -p phalanx-core
# or:
pnpm test:contract
```

Runs 121 unit tests (`tests.rs`, `codec.rs`, `facts.rs`). On Windows, native `cargo test` requires the MSVC C++ Linker (`link.exe` from Visual Studio Build Tools). If evaluating on Windows without MSVC, run via WSL or execute `pnpm test` and `pnpm judge:offline`, which run the complete test suite against `artifacts/phalanx_core.wasm` inside PhalanxSim.

### The judge scenario

```bash
pnpm judge:offline
```

Eleven steps against the compiled WASM in PhalanxSim, the in-process NEAR VM, ending in `ALL CHECKS PASSED: 80/80 assertions`. No API key needed.

### The web app

```bash
pnpm dev
```

Open http://localhost:3000. The command center runs the same WASM in the browser, so every panel is live without a deployment. The "Live on NEAR testnet" section reads `phalanx-v3d4.phalanxswarm.testnet` over public RPC.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Method not found` | `new()` was never called | Deploy and initialize in one batch (Step 4) |
| `PHALANX_E_OWNER_ONLY` | The call came from an agent key, or from an account that is not the owner | Owner-only methods need `--accountId YOUR_ACCOUNT.testnet` |
| `PHALANX_E_ED25519_KEY_REQUIRED` | `register_enclave` was given a secp256k1 or `ed25519:` key that does not parse | Use an `ed25519:…` key |
| `PHALANX_E_INVALID_HANDLE` | `agent_handle` failed the account-name rules | 2–32 chars of `[a-z0-9]`, single `-`/`_` separators, no separator at either edge |
| `PHALANX_E_ORDER: unknown product` | The product is not in `policy.products` | Add it with `update_global_policy` (Step 7) |
| `PHALANX_E_ORDER: attach exactly the product price` | The deposit differs from `product.price` | Attach the exact yoctoNEAR amount |
| `PHALANX_E_POLICY: ...` | `GlobalPolicy::validate` rejected the payload | See the bounds column in Step 7 |
| `InvalidAccessKeyError` on an agent call | The circuit breaker deleted the key, or the method is outside the role's scope | `get_role_scope` for the scope; re-register the agent for a deleted key |
| `PHALANX_E_INSUFFICIENT_LIQUIDITY` | The treasury cannot back the spend after the operating reserve | Fund it, or lower the amount |
| `Insufficient funds` on a plain transfer | The account has no NEAR for gas | Send it testnet NEAR |

If you need to redeploy from scratch, delete the contract account and recreate it, then repeat Steps 3–4:

```bash
near delete phalanx.YOUR_ACCOUNT.testnet YOUR_ACCOUNT.testnet
near create-account phalanx.YOUR_ACCOUNT.testnet --masterAccount YOUR_ACCOUNT.testnet --initialBalance 10
```

---

## Production checklist

Before moving real funds to mainnet:

- [ ] Complete a professional security audit of `contracts/phalanx-core`
- [ ] Reproduce the build (`pnpm verify:reproducible`) and record the code hash
- [ ] Deploy from a cold account, then delete the deployer's full-access key
- [ ] Hand ownership to a SputnikDAO with at least three independent council signers
- [ ] Set `max_tx_amount_yocto`, `epoch_spending_cap_yocto` and `dao_approval_threshold` for your real spend profile
- [ ] Populate `allowed_recipients` explicitly; the default allow-list is empty on purpose
- [ ] Pin `audit_prompt_hash` and `task_prompt_hashes` to prompts you control
- [ ] Register TEE enclaves only after an independent DCAP check of the quote
- [ ] Choose `unknown_recipient` (`quarantine` or `hold`) for your risk tolerance, and if `hold`, set the challenge window and cap deliberately
- [ ] Run `pnpm verify:live` against the new deployment
- [ ] Set up monitoring on `get_security_events` and on `solvent_liquidity`
- [ ] Document the incident-response path for key deletion and pause

---

## Related documentation

- [README](../README.md) — product overview and the full "do X, see Y" command table
- [ARCHITECTURE.md](ARCHITECTURE.md) — contract modules, state layout and the verification chain
- [BUSINESS_MODEL.md](BUSINESS_MODEL.md) — what the treasury actually monetises, and what it does not
- [Agent examples](../packages/agent-swarm-sdk/src/examples/README.md) — three complete agent integrations
- [NEAR docs](https://docs.near.org/) · [NEAR Builders](https://nearbuilders.org/build)

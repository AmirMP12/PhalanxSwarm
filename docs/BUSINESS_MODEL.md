# PhalanxSwarm Business Model

What the protocol monetises, how the contract enforces each revenue line, and what it deliberately does not do.

> **Scope note.** This document separates three things that are easy to conflate:
> 1. **Implemented in `contracts/phalanx-core` v3.0.0** — mechanisms you can call today, with the enforcing code named.
> 2. **Business decisions made outside the contract** — SaaS pricing, support tiers, sales motion. Nothing in the contract enforces or requires these.
> 3. **Projections** — market sizing, unit economics, and the three-year plan. Labelled as projections, not as results.

---

## 1. The product

A PhalanxSwarm treasury is a NEAR contract that holds an organisation's money and lets AI agents spend it inside rules a DAO writes. The agents sell a product to customers, hire each other in auctions, pay vendors on NEAR and on EVM chains, and earn into on-chain balances. No agent holds a full-access key.

The commercial question is therefore not "how do we charge agents for custody" but "what is worth paying for once money moves under policy". The answer this protocol is built around:

- **Guaranteed delivery** on a customer order (payment is a liability until a verified delivery).
- **Provable non-forgery** of the AI decision that authorised a payment.
- **An auditable ledger** that reconciles to the on-chain balance, not a spreadsheet export.
- **Governance that scales down to one small payment** (a challenge window) and up to a policy change.

---

## 2. What the contract enforces

This is the part that is true today. Each row is a mechanism in `contracts/phalanx-core/src/` and can be verified from the source.

### 2.1 Customer orders (`orders.rs`) — margin, not fee

The DAO lists products in `GlobalPolicy.products`:

```rust
Product { product_id, title, price, delivery_sec, max_cost_bps }
```

A customer calls `place_order(product_id, spec_hash)` and attaches exactly `price`. The payment goes to `Treasury.orders_escrow`, **not** to revenue. When an orchestrator posts an RFP with `order_id`, `link_order` enforces:

- `rfp.spec_hash == order.spec_hash` — the swarm cannot re-scope the work;
- `verification.input_pinned && prompt_hash.is_some()` — the delivery proof must use a DAO-approved prompt over the customer's own spec;
- `rfp.budget_ceiling ≤ price / 10_000 * max_cost_bps` — the swarm cannot spend the margin.

On a verified delivery, `deliver_order` moves `price` from `orders_escrow` to `liquid` and `total_revenue`. The gross margin is `price − (what the winner was paid)`, and `max_cost_bps` is the lever that guarantees a floor on it. At `max_cost_bps = 8000`, at least 20% of the price stays with the treasury before any cost.

**Revenue is the margin, not a take-rate.** `execute_verified_task` credits the winning worker the full escrow amount. There is no protocol cut in that path; `BUSINESS_MODEL` previously described a "2.5% take-rate", and the contract does not implement one. If a take-rate is wanted, it must be added to the contract (a fee leg in `execute_verified_task`) — it is not there today.

### 2.2 Revenue distribution (`lib.rs`)

`distribute_revenue` pays out `distributable_profit`, defined as:

```
min(
  total_revenue − total_operating_costs − total_distributed − total_retained,
  available_liquidity
)
```

`total_operating_costs` includes every task payout and vendor payment, so the base is gross margin, not gross revenue. The split is 1–8 `RevenueSplit` entries summing to 10 000 bps, and each entry names an account and a `StakeholderKind`:

| Kind | Paid out? | Meaning |
| --- | --- | --- |
| `dao_treasury` | yes | The DAO's share |
| `operator` | yes | Agent operators / developers |
| `investor` | yes | Any other external stakeholder |
| `reserve` | no — retained in the contract | Solvency buffer, at most one entry |

The default is 7000 bps to `owner_id` and 3000 bps retained. The recorded testnet deployment runs 5000 / 2000 / 3000 (DAO / operators / reserve). Distribution requires `profit ≥ config.min_distribution` (0.1 NEAR by default). A leg that fails returns to the treasury through `on_distribution_settled`.

**This is the only place profit leaves the contract as profit.** Everything else is a payment for a service or a refund of a liability.

### 2.3 The market (`swarm_market.rs`) — escrow, not commission

Buyers post a budgeted RFP; the budget is reserved from `liquid` into `reserved_for_tasks` and checked by the policy engine. Workers bid in a sealed-bid or reverse-Dutch auction. The winner's price is locked in `escrow_locked` and paid on a verified delivery.

The economics that matter commercially:

- **Buyers cannot pay for nothing.** Escrow is released only against a proof that verifies against the pinned prompt and the input hash.
- **A missed deadline is visible and costly.** `expire_task` refunds the escrow, slashes 500 bps of reputation, and reopens the order if one is linked. A verified delivery adds 250 bps.
- **A newcomer cannot undercut into a monopoly on day one.** `min_reputation_bps` on the RFP keeps agents below the floor out, and the DAO sets the lowest floor an agent may demand (`min_task_reputation_bps`).

There is no protocol fee on an auction today.

### 2.4 Settlement (`intents.rs`, `evm.rs`)

Two settlement paths, both policy-checked:

- **NEAR vendor payments** — a real transfer, settled in a callback. A bounce releases the reservation.
- **Cross-chain** — a NEAR Intents 1Click `dry: true` quote bound to the agent's NEP-413 signature, and/or an EIP-1559 transaction signed through Chain Signatures. The contract builds the EVM transaction at the nonce it tracks, enforces per-chain value and fee caps, and can cancel an unmined transfer with a zero-value replacement at the same nonce.

Both paths share the same recipient rules, the same invoice check, and the same audit pipeline. **The contract charges nothing for either.** The earlier "20 bps settlement fee" was not implemented.

### 2.5 Policy tiers the contract already expresses

The interesting commercial feature is not a price list; it is that the *rules themselves* are tiered, so one deployment can serve a cautious customer and an aggressive one:

| Lever | Conservative | Balanced | Permissive |
| --- | --- | --- | --- |
| `unknown_recipient` | `quarantine` | `hold` + 120 s window + small cap | `hold` + long window + large cap |
| `dao_approval_threshold` | low (vote often) | 50 NEAR | high (vote rarely) |
| `velocity_limit` / window | 3 / 300 s | 5 / 60 s | 20 / 60 s |
| `quarantine_after_strikes` | 1 | 3 | 5 |
| `require_tee_attestation` | `true` | `true` | `true` (see below) |
| `require_invoice_ref` | `true` | `true` | `true` |
| `min_task_confidence_bps` | 9 000 | 7 000 | 5 000 |

`require_tee_attestation` is in the policy for completeness; leaving it off does not make an unattested settlement safe, because a task without a pinned prompt still only accepts receipts from a registered enclave key.

### 2.6 Accounting (`phalanx_export_accounting` in the MCP server)

`TreasuryReport` exposes `liquid`, every obligation, `solvent_liquidity` and `unbacked_liquidity`. The MCP tool `phalanx_export_accounting` turns the ledger and the NEP-297 event log into double-entry journal entries, a trial balance, a CSV General Ledger, or QuickBooks IIF. The web app also serves these at `/api/accounting/export`.

This is a genuine differentiator for an accounts-payable department: the export reconciles to the contract's own liability model rather than to a wallet's transaction history.

---

## 3. What the business sells (outside the contract)

Nothing below is enforced by the contract. It is a commercial plan, and it should be priced against the value of §2, not against the cost of running it.

### 3.1 Pricing tiers

| Tier | Who it is for | What is delivered | Price |
| --- | --- | --- | --- |
| **Community** | Hackathon teams, self-hosted swarms | The contract, the SDK, the web app, community support | Free |
| **Growth** | AI startups running a handful of agents | Hosted Sentinel monitoring, accounting export, alerting, up to 8 agents | $299 / month |
| **Mid-market DAO** | DAOs and multi-agent guilds | SputnikDAO integration, priority relay, up to 25 agents | $999 / month |
| **Institutional** | Funds, custodians, enterprise labs | Dedicated Sentinel nodes, custom SLA, SOC 2 programme, 24/7 response | $2,999 / month |

Deliberately **absent** from all tiers: per-transaction fees, AUM percentage fees, and any token. Pricing the safety layer as a subscription keeps the incentive aligned — the provider is paid to keep the rules working, not to move volume through them.

### 3.2 Why a subscription rather than a basis-point fee

A 25 bps custody fee on a team spending $10 000 a year is $25. Against a realistic acquisition cost in the thousands, that never repays. The subscription is sized to the value of the guarantee:

- An undelivered $50 000 order that becomes a guaranteed refund is worth more than $299.
- A forged-approval incident that would have moved treasury funds is worth more than $999.
- An audit that closes without a reconciliation exercise is worth more than $2 999.

The basis-point comparison is included only to show why the fee was not chosen.

### 3.3 The three-year plan (projection)

| | Year 1 | Year 2 | Year 3 |
| --- | ---: | ---: | ---: |
| Active treasuries | 15 | 60 | 180 |
| Mix (Growth / Mid / Enterprise) | 10 / 5 / 0 | 35 / 20 / 5 | 90 / 65 / 25 |
| Subscription revenue | $95 820 | $545 280 | $2 001 840 |
| Marketplace and settlement revenue | $35 000 | $145 000 | $480 000 |
| Commerce margin share | $22 500 | $95 000 | $340 000 |
| **Gross revenue** | **$153 320** | **$785 280** | **$2 821 840** |
| Operating expenses | $250 000 | $655 000 | $1 820 000 |
| **Net operating income** | **−$96 680** | **+$130 280** | **+$1 001 840** |

The marketplace and commerce lines are *not* protocol fees; they are the operator's own margin on orders it fulfils and the share of on-chain margin that the operator's `RevenueSplit` allocates to it. The projection assumes the operator is itself a participant in the treasury, which is the honest way to model it.

These are planning numbers. They are not results, and nothing in the contract produces them automatically.

### 3.4 Fundraising path

1. Hackathon prize — funds the first external audit.
2. NEAR ecosystem grant — funds the security primitives and the NEAR AI Cloud integration.
3. Customer revenue from month 6.
4. Optional institutional seed round, only to accelerate multi-chain sales.

---

## 4. Market sizing (projection)

| Layer | Size | Definition |
| --- | ---: | --- |
| **TAM** | ~$48 B by 2028 | Enterprise AI agent software and security. Third-party analyst projections; treat as directional. |
| **SAM** | ~$3.8 B | Web3 agents that actually need on-chain custody, cross-chain rails and cryptographic guarantees. |
| **SOM** | ~$76 M over three years | 2% of SAM, concentrated on NEAR AI Cloud, SputnikDAO/AstroDAO treasuries and Chain Signatures users. |

The SOM is a target, not a forecast. The dependency that matters is ecosystem distribution (§5), not the TAM number.

---

## 5. Go-to-market

| Phase | Months | Focus | Target |
| --- | --- | --- | --- |
| 1. Ecosystem embedding | 1–6 | NEAR AI Cloud template, SputnikDAO/AstroDAO treasuries, hackathon alumni | 15 treasuries, $5 M AUM |
| 2. Cross-chain expansion | 7–18 | Chain Signatures relays (Base, Arbitrum, Ethereum), 1Click procurement | 60 treasuries, $25 M AUM |
| 3. Enterprise | 19–36 | ERP integration (QuickBooks, NetSuite, SAP), SOC 2, treasury insurance | 200+ treasuries, $100 M+ AUM |

Distribution partners worth naming, because each has a concrete hook into this product:

- **NEAR AI Cloud** — the model keys Phalanx verifies come from here; a treasury template is a natural next step in onboarding.
- **SputnikDAO / AstroDAO** — the owner of every deployment is one of these. A treasury-security plugin is the shortest path to real DAOs.
- **Trezu** — proposal export already exists in `packages/agent-swarm-sdk/src/dao-export.ts`.
- **Chain Signatures / NEAR Intents** — the cross-chain rails are already wired; the partnership value is liquidity and reliability, not integration work.

---

## 6. Competition

| Capability | PhalanxSwarm | Safe / Squads | Fireblocks | Virtuals / Eliza |
| --- | --- | --- | --- | --- |
| Target workload | Autonomous agent swarms | Human multisig | Institutional custody | Social / gaming agents |
| Prompt verification | TEE + DAO-pinned hash + contract facts | None | Off-chain rules | Prompt-level only |
| Circuit breaker | Key deleted in the attacking transaction (contract-account agents) | None | API ban, keys remain | None |
| Cross-chain | Chain Signatures + NEAR Intents | Separate safes per chain | Centralised MPC | Single chain |
| Autonomous commerce | Native RFP auctions and customer orders | None | None | Token curves |
| Accounting | Native GL / IIF / CSV from the ledger | Third-party plugins | Enterprise API | None |

**The differentiator is narrow and worth stating precisely.** Plenty of products stop a payment that breaks a limit. PhalanxSwarm is built around the case where the limit is satisfied and the *reason* is forged: a genuine TEE signature over instructions the agent wrote, or over evidence the agent invented. Only the pinned-prompt plus contract-built-facts pair addresses that.

### Moats, honestly

| Moat | Strength | Caveat |
| --- | --- | --- |
| Hardware verification bound to contract state | Strong | The DAO's registration step is the trust anchor; a compromised DAO defeats it |
| Protocol-level key deletion | Strong on NEAR | Only for `ContractKey` agents; sub-account agents are quarantined logically instead |
| Shared blocklist | Grows with adoption | Only useful once several treasuries run it |
| Native accounting export | Real but replicable | A competitor could build the same export in a quarter |

---

## 7. Risk register

| Risk | Likelihood | Impact | Mitigation in the design |
| --- | --- | --- | --- |
| TEE attestation forgery | Low | High | Defence in depth: caps, allow-lists and the recipient rule hold even if a proof is wrong |
| RPC outage | Medium | Medium | Public RPC with a fallback endpoint; the contract is the source of truth, not the indexer |
| MPC congestion | Low | Medium | Contract-tracked nonce plus a cancel replacement at the same nonce |
| Prompt injection that the model follows | High | Critical | The injection may succeed at the model; the contract still refuses the payment and deletes the key |
| Counterparty default in the market | Medium | Low | 100% escrow before work starts; `expire_task` refunds it and slashes reputation |
| Owner key compromise | Low | Critical | A SputnikDAO with independent signers; the contract has no owner backdoor beyond the governance methods |
| Off-chain registration of a bad enclave key | Low | Critical | `pnpm verify:live` re-checks the DCAP quote and key binding |
| Unbacked liquidity (gas burn, bounced refunds) | Medium | Low | `solvent_liquidity` and `unbacked_liquidity` are reported, not hidden |

---

## 8. Governance and the token question

PhalanxSwarm has **no token**, deliberately.

1. **Settlement is in native assets** — NEAR, wNEAR, USDC, USDT. A treasury product that introduces a new unit of account makes its own accounting harder.
2. **Governance is a SputnikDAO** — `phalanx-v3d1.sputnikv2.testnet` on testnet, 3 council members, 2 votes to pass. Council members set policy, pin prompts, approve held payments, revoke agents and upgrade the contract.
3. **The reserve is funded by revenue split, not by dilution** — the `reserve` leg retains a share of each distribution inside the contract.
4. **Regulatory cleanliness** — no distribution of an instrument is involved in using the product.

---

## 9. What would need to change to make §3 real

This section exists so the gap between the contract and the business plan is explicit:

| Claim in the plan | What the contract has today | What would be needed |
| --- | --- | --- |
| Marketplace take-rate | Full escrow to the winner | A fee leg in `execute_verified_task`, a policy field for the bps, and a recipient for the fee |
| Cross-chain settlement fee | No fee | A fee on `request_intent_settlement` / `request_evm_transfer`, and a decision on who receives it |
| Hosted Sentinels | The Sentinel role and its methods exist; hosting does not | Operational infrastructure, not contract work |
| SOC 2 | Nothing | An audit programme, not contract work |
| Per-agent-tier limits | `AgentPolicy` per agent | Already there; only the pricing wrapper is missing |

Nothing in §3 is unsafe to say. It is safe to say only if it is clear that the fee lines are a plan and the margin lines are the contract.

---

## 10. Summary

- The contract monetises **delivery** (customer order margin) and **governance** (a treasury safe enough to hold real money), not transaction volume.
- The only profit exit is `distribute_revenue`, over gross margin, split by on-chain `RevenueSplit` entries.
- Escrow, refunds and agent balances are liabilities, so distributable profit cannot be paid out of money that is owed to someone else.
- The SaaS tiers price the operational layer around the contract.
- Every projection in this document is labelled as one.

*Protocol status: v3.0.0, verified on NEAR testnet at `phalanx-v3d1.phalanxswarm.testnet`. See [ARCHITECTURE.md](ARCHITECTURE.md) for the enforcing code and [QUICKSTART.md](QUICKSTART.md) to run it.*

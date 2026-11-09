/**
 * PhalanxSwarm MCP server: any MCP client (Claude, Kiro, Cursor, an agent framework) can ask the
 * PhalanxSwarm treasury contract about a payment before an agent signs it.
 *
 * The tools are read-only. They call contract views and never hold a key, sign, or send a
 * transaction. An agent that decides to pay signs the returned intent message with its own scoped
 * key and submits it itself, and the contract enforces the same rules again on-chain.
 *
 * - `phalanx_check_recipient`: the contract's allow / warn / block answer for a recipient, on-chain
 *   history signals (account age, activity, code changes, prior payments), and what the agent may do.
 * - `phalanx_preview_payment`: a dry run of a payment through the contract's policy engine
 *   (`evaluate_intent`), the facts a Sentinel audit must judge (v2.3), and the exact message to sign.
 * - `phalanx_get_policy`: the DAO's current limits and rules.
 * - `phalanx_export_accounting`: export reconciled enterprise double-entry General Ledger (GL)
 *   journal entries and trial balance from the on-chain treasury state.
 *
 * Protocol: JSON-RPC 2.0, transport-agnostic (`mcp-cli.ts` runs it over stdio). It serves both MCP
 * eras: the stateless revisions (`server/discover`, protocol version in every request's `_meta`,
 * `MCP_MODERN_VERSIONS`) and the `initialize` handshake of earlier ones (`MCP_LEGACY_VERSIONS`).
 */
import { z } from "zod";

import type { PhalanxViews } from "./contract-client.ts";
import { formatNear, ONE_NEAR, toBase58, toBase64 } from "./encoding.ts";
import { decidePreflight, preflightRecipient, type HistorySource } from "./preflight.ts";
import { ASSETS } from "./swarm-orchestrator.ts";
import { ContractInfo, ProtocolConfig, type CrossChainIntentRequestT, type PolicyViolationT } from "./types.ts";
import { describeViolation } from "./violations.ts";

// MCP names its specification revisions by date; these are protocol identifiers.
export const MCP_MODERN_VERSIONS = ["2026-07-28"] as const; // source-integrity: revision ids
export const MCP_LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const; // source-integrity: revision ids
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

type JsonRpcId = string | number;
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface PhalanxMcpOptions {
  /** Contract views over NEAR RPC (`RpcTransport`) or the in-process PhalanxSim (`VmTransport`). */
  views: PhalanxViews;
  /** Where the contract runs; history lookups are skipped for `sim`. */
  network: "testnet" | "mainnet" | "sim";
  /** Recipient history for `phalanx_check_recipient` (see `nearHistorySource`). */
  history?: HistorySource;
  /** Block time for request deadlines. Default: wall clock. */
  nowNs?: () => bigint;
  serverVersion?: string;
}

const SAFE_TEXT = /^[\x20-\x7e]*$/;
const CheckArgs = z.strictObject({
  chain: z.string().regex(/^[a-z0-9-]{2,32}$/, "a lower-case chain id such as near, arb, base or basesepolia"),
  recipient: z.string().min(2).max(128).regex(SAFE_TEXT),
  history: z.boolean().optional(),
});
const PreviewArgs = z.strictObject({
  agent_id: z.string().regex(/^[a-z0-9._-]{2,64}$/, "the paying agent's NEAR account id"),
  chain: CheckArgs.shape.chain,
  recipient: CheckArgs.shape.recipient,
  amount_near: z.number().positive().max(1_000_000),
  memo: z.string().max(120).regex(SAFE_TEXT).optional(),
});
const ExportAccountingArgs = z.strictObject({
  format: z.enum(["journal_entries", "trial_balance", "both", "csv", "quickbooks_iif"]).default("both").optional(),
  include_raw_events: z.boolean().default(false).optional(),
});

/** Destination asset of a cross-chain vendor payment (USDC on the chain). */
const PAYOUT_ASSET: Record<string, string> = { arb: ASSETS.USDC_ARB, base: ASSETS.USDC_BASE, eth: ASSETS.USDC_ETH, sol: ASSETS.USDC_SOL };
/**
 * Findings a preview cannot avoid: it is unsigned and has no audit yet, and a cross-chain preview
 * has no 1Click quote, so its minimum output (and with it the price-floor check) is a placeholder.
 */
const isPending = (v: PolicyViolationT, crossChain: boolean) =>
  v.code === "invalid_intent_signature" ||
  v.code === "missing_tee_attestation" ||
  v.code === "invalid_tee_attestation" ||
  (crossChain && v.code === "quote_invalid" && v.reason === "cross_chain_requires_quote") ||
  (crossChain && v.code === "price_below_floor");

const TOOLS = [
  {
    name: "phalanx_check_recipient",
    title: "Check a payment recipient",
    description:
      "Ask the PhalanxSwarm treasury contract whether an agent may pay this recipient, before signing anything. Returns the contract's verdict (allow, warn or block) with its reasons, on-chain history signals, and the action to take: sign, refuse, submit for DAO approval, or ask the DAO to allow-list or confirm the recipient. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", description: "Settlement chain: near, arb, base, eth, sol, or an EVM chain id such as basesepolia." },
        recipient: { type: "string", description: "A NEAR account id or a 0x address." },
        history: { type: "boolean", description: "Also look up the recipient's on-chain history. Default true on testnet and mainnet." },
      },
      required: ["chain", "recipient"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "phalanx_get_policy",
    title: "Read the treasury policy",
    description:
      "The PhalanxSwarm DAO's current rules: per-payment limit, epoch spending cap, allowed chains, what happens to unknown recipients, the DAO approval threshold, the pinned audit prompt and the task-prompt registry. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "phalanx_preview_payment",
    title: "Preview a payment",
    description:
      "Dry-run a payment through the PhalanxSwarm policy engine before the agent signs it. Returns every policy finding (limits, chain, asset, recipient), whether the payment needs a DAO vote, the facts a Sentinel audit must judge, and the exact NEP-413 message the agent signs with its own key to submit it. Never signs or sends anything.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The paying agent's account id, registered with the treasury." },
        chain: { type: "string", description: "Settlement chain: near for a NEAR transfer, or arb, base, eth, sol for USDC via NEAR Intents." },
        recipient: { type: "string", description: "A NEAR account id or a 0x address." },
        amount_near: { type: "number", exclusiveMinimum: 0, description: "Amount in NEAR." },
        memo: { type: "string", maxLength: 120, description: "Invoice reference, printable ASCII." },
      },
      required: ["agent_id", "chain", "recipient", "amount_near"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "phalanx_export_accounting",
    title: "Export enterprise reconciliations & General Ledger",
    description:
      "Export auditable double-entry General Ledger (GL) journal entries and trial balance reconciliations from the on-chain PhalanxSwarm treasury. Formats capital inflows, customer orders, swarm procurement escrows, vendor settlements, EVM transfers, agent earnings, and revenue distributions into standard enterprise accounting journal entries where total debits equal total credits. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["journal_entries", "trial_balance", "both", "csv", "quickbooks_iif"],
          description: "Output format: journal_entries, trial_balance, both, csv (Excel/Xero), or quickbooks_iif (QuickBooks Desktop). Default: both.",
        },
        include_raw_events: {
          type: "boolean",
          description: "Include underlying on-chain reference IDs in line items. Default false.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
] as const;

const INSTRUCTIONS =
  "Call phalanx_check_recipient before an agent pays anyone, and follow its action. Use phalanx_preview_payment to see what the contract would decide and get the message to sign. Call phalanx_export_accounting to export reconciled double-entry General Ledger journal entries and trial balance. These tools never sign or send; the contract enforces the same rules when the agent submits.";

export class PhalanxMcpServer {
  private readonly serverInfo: { name: string; title: string; version: string };

  constructor(private readonly opts: PhalanxMcpOptions) {
    this.serverInfo = { name: "phalanx-swarm", title: "PhalanxSwarm treasury guard", version: opts.serverVersion ?? "0.1.0" };
  }

  /** One newline-delimited message in, at most one out (`null` for notifications). */
  async handleLine(line: string): Promise<string | null> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return JSON.stringify(this.error(null, -32700, "Parse error"));
    }
    const response = await this.handle(message);
    return response ? JSON.stringify(response) : null;
  }

  async handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return this.error(null, -32600, "Invalid Request");
    const m = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const hasId = typeof m.id === "string" || typeof m.id === "number";
    if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return hasId ? this.error(m.id as JsonRpcId, -32600, "Invalid Request") : null;
    if (!hasId) return null; // Notifications (notifications/initialized, notifications/cancelled) need no answer.
    const id = m.id as JsonRpcId;
    const params = (typeof m.params === "object" && m.params !== null ? m.params : {}) as Record<string, unknown>;
    const meta = (typeof params._meta === "object" && params._meta !== null ? params._meta : {}) as Record<string, unknown>;
    const requested = meta[VERSION_KEY];
    const modern = typeof requested === "string";
    if (modern && !(MCP_MODERN_VERSIONS as readonly string[]).includes(requested)) {
      return this.error(id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", { supported: [...MCP_MODERN_VERSIONS], requested });
    }
    const ok = (result: Record<string, unknown>, cacheable = false): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id,
      result: modern
        ? { ...result, resultType: "complete", ...(cacheable ? { ttlMs: 3_600_000, cacheScope: "public" } : {}), _meta: { [SERVER_INFO_KEY]: this.serverInfo } }
        : result,
    });

    switch (m.method) {
      case "server/discover":
        return ok({ supportedVersions: [...MCP_MODERN_VERSIONS], capabilities: { tools: {} }, instructions: INSTRUCTIONS }, true);
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const version = (MCP_LEGACY_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_LEGACY_VERSIONS[0];
        return ok({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: this.serverInfo, instructions: INSTRUCTIONS });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS }, true);
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string" || !TOOLS.some((t) => t.name === name)) return this.error(id, -32602, `Unknown tool: ${String(name)}`);
        try {
          const output = await this.callTool(name, params.arguments ?? {});
          return ok({ content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output, isError: false });
        } catch (err) {
          const text =
            err instanceof z.ZodError
              ? `Invalid arguments: ${err.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ")}`
              : String((err as Error).message ?? err);
          return ok({ content: [{ type: "text", text: text.slice(0, 1_000) }], isError: true });
        }
      }
      default:
        return this.error(id, -32601, `Method not found: ${m.method}`);
    }
  }

  private error(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
  }

  async callTool(name: string, args: unknown): Promise<Record<string, unknown>> {
    switch (name) {
      case "phalanx_check_recipient":
        return this.checkRecipient(CheckArgs.parse(args));
      case "phalanx_preview_payment":
        return this.previewPayment(PreviewArgs.parse(args));
      case "phalanx_get_policy":
        z.strictObject({}).parse(args);
        return this.getPolicy();
      case "phalanx_export_accounting":
        return this.exportAccounting(ExportAccountingArgs.parse(args));
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  private async checkRecipient(a: z.infer<typeof CheckArgs>): Promise<Record<string, unknown>> {
    const withHistory = (a.history ?? true) && this.opts.network !== "sim" && this.opts.history !== undefined;
    const decision = withHistory
      ? await preflightRecipient(this.opts.views, a.chain, a.recipient, { history: this.opts.history })
      : decidePreflight(await this.opts.views.checkRecipient(a.chain, a.recipient));
    return {
      contract_id: this.opts.views.contractId,
      chain: a.chain,
      recipient: a.recipient,
      action: decision.action,
      verdict: decision.verdict,
      contract_verdict: decision.check.verdict,
      reasons: decision.check.reasons,
      allow_listed: decision.check.allow_listed,
      blocked: decision.check.blocked,
      unknown_recipient_rule: decision.check.unknown_recipient,
      history: decision.signals,
      summary: decision.summary,
    };
  }

  private async previewPayment(a: z.infer<typeof PreviewArgs>): Promise<Record<string, unknown>> {
    const views = this.opts.views;
    const [info, config, policy] = await Promise.all([
      views.parse("contract_info", {}, ContractInfo),
      views.parse("get_config", {}, ProtocolConfig),
      views.policy(),
    ]);
    const agent = await views.agent(a.agent_id);
    if (!agent) throw new Error(`${a.agent_id} is not an agent of ${views.contractId}`);
    const isNear = a.chain === "near";
    const amount = (BigInt(Math.round(a.amount_near * 1_000)) * ONE_NEAR) / 1_000n;
    const nowNs = this.opts.nowNs?.() ?? BigInt(Date.now()) * 1_000_000n;
    const request: CrossChainIntentRequestT = {
      kind: "vendor_payment",
      destination_chain: a.chain,
      origin_asset: ASSETS.WNEAR,
      destination_asset: isNear ? ASSETS.WNEAR : (PAYOUT_ASSET[a.chain] ?? ASSETS.WNEAR),
      amount: amount.toString(),
      min_amount_out: isNear ? amount.toString() : "1",
      recipient: a.recipient,
      execution_contract: config.intents_contract_id,
      slippage_bps: isNear ? 0 : 50,
      deadline_ns: (nowNs + 900n * 1_000_000_000n).toString(),
      quote: null,
      nonce: toBase64(crypto.getRandomValues(new Uint8Array(32))),
      // Unsigned: the preview never holds the agent's key.
      signature: `ed25519:${toBase58(new Uint8Array(64))}`,
      attestation: null,
      memo: a.memo ?? null,
    };
    const assessment = await views.evaluateIntent(a.agent_id, request);
    let facts: { facts_hash: string; facts: unknown } | null = null;
    if (assessment.audit_facts_hash) {
      const f = await views.intentAuditFacts(a.agent_id, request);
      facts = { facts_hash: f.facts_hash, facts: JSON.parse(f.facts) as unknown };
    }
    const violations = assessment.decision.violations;
    const findings = violations.filter((v) => !isPending(v, !isNear));
    // The contract's rule once the request is signed and audited: a new recipient under `hold` is the
    // DAO's call when it is the only finding, and a large approved payment also waits for the DAO.
    const held = findings.length > 0 && findings.every((v) => v.code === "recipient_needs_approval");
    const wouldPass = findings.length === 0 || held;
    const approvalReasons = wouldPass
      ? [...(amount >= BigInt(policy.dao_approval_threshold) ? ["amount_at_or_above_dao_threshold"] : []), ...(held ? ["recipient_needs_approval"] : [])]
      : [];
    const describe = (v: PolicyViolationT) => ({ code: v.code, detail: describeViolation(v) });
    const stillNeeded = [
      `the agent's NEP-413 signature over intent_message (with the nonce below, recipient ${info.nep413_recipient})`,
      ...(violations.some((v) => v.code === "missing_tee_attestation")
        ? ["a Sentinel audit: a NEAR AI proof under the DAO-pinned prompt whose user message is the audit facts"]
        : []),
      ...(isNear ? [] : ["a 1Click dry quote bound to the request, whose minimum output meets the DAO's price floor"]),
    ];
    return {
      contract_id: views.contractId,
      contract_version: info.version,
      agent_id: a.agent_id,
      agent_status: agent.status.kind,
      amount_near: formatNear(amount, 3),
      would_pass_policy: wouldPass,
      requires_dao_approval: approvalReasons.length > 0,
      approval_reasons: approvalReasons,
      findings: wouldPass ? [] : findings.map(describe),
      still_needed: stillNeeded,
      limits: assessment.decision.limits,
      audit_facts: facts,
      intent_message: assessment.intent_message,
      nep413_hash_unsigned: assessment.nep413_hash,
      nonce: request.nonce,
      note: "Nothing was signed or sent. A submitted payment is checked again on-chain; findings that depend on time (epoch caps, velocity, deadlines) can change.",
    };
  }

  private async getPolicy(): Promise<Record<string, unknown>> {
    const views = this.opts.views;
    const [info, policy, owner] = await Promise.all([views.parse("contract_info", {}, ContractInfo), views.policy(), views.transport.view("get_owner", {})]);
    // Contracts before 2.3 have no policy version.
    const version = await views.policyVersion().catch(() => null);
    return {
      contract_id: views.contractId,
      contract_version: info.version,
      owner,
      policy_version: version,
      max_payment_near: formatNear(BigInt(policy.max_tx_amount_yocto), 3),
      epoch_spending_cap_near: formatNear(BigInt(policy.epoch_spending_cap_yocto), 3),
      dao_approval_threshold_near: formatNear(BigInt(policy.dao_approval_threshold), 3),
      allowed_chains: policy.allowed_target_chains,
      allowed_recipients: policy.allowed_recipients.length,
      unknown_recipient_rule: policy.unknown_recipient,
      require_tee_attestation: policy.require_tee_attestation,
      max_slippage_bps: policy.max_slippage_bps,
      velocity: `${policy.velocity_limit} requests per ${policy.velocity_window_sec} s`,
      quarantine_after_strikes: policy.quarantine_after_strikes,
      audit_prompt_hash: policy.audit_prompt_hash,
      task_prompt_hashes: policy.task_prompt_hashes,
      min_task_confidence_bps: policy.min_task_confidence_bps,
      min_task_reputation_bps: policy.min_task_reputation_bps,
    };
  }

  private async exportAccounting(a: z.infer<typeof ExportAccountingArgs>): Promise<Record<string, unknown>> {
    const views = this.opts.views;
    const [info, dashboard] = await Promise.all([views.parse("contract_info", {}, ContractInfo), views.dashboard()]);

    const format = a.format ?? "both";
    const includeRaw = a.include_raw_events ?? false;

    // Standard Chart of Accounts (COA) for enterprise autonomous treasury
    const COA = {
      1010: { code: "1010", name: "Cash & Liquid Treasury", category: "Asset", normal: "Debit" },
      1020: { code: "1020", name: "Escrow Deposits in Transit", category: "Asset", normal: "Debit" },
      1030: { code: "1030", name: "Capital Reserve", category: "Asset", normal: "Debit" },
      2010: { code: "2010", name: "Customer Unearned Revenue", category: "Liability", normal: "Credit" },
      2020: { code: "2020", name: "Agent Earnings Payable", category: "Liability", normal: "Credit" },
      3010: { code: "3010", name: "Contributed Treasury Capital", category: "Equity", normal: "Credit" },
      3020: { code: "3020", name: "Retained Operating Reserve", category: "Equity", normal: "Credit" },
      4010: { code: "4010", name: "Customer Sales Revenue", category: "Revenue", normal: "Credit" },
      5010: { code: "5010", name: "Swarm Task Procurement Expense", category: "Expense", normal: "Debit" },
      5020: { code: "5020", name: "Vendor Accounts Payable Expense", category: "Expense", normal: "Debit" },
      5030: { code: "5030", name: "Cross-Chain Settlement Expense", category: "Expense", normal: "Debit" },
      5040: { code: "5040", name: "Stakeholder Dividend & Operator Distributions", category: "Expense", normal: "Debit" },
    } as const;

    type CoaCode = keyof typeof COA;

    interface EntryLine {
      account_code: string;
      account_name: string;
      debit_yocto: string;
      debit_near: string;
      credit_yocto: string;
      credit_near: string;
      memo?: string;
    }

    interface JournalEntry {
      entry_id: string;
      block_height: string;
      source_module: string;
      description: string;
      reference_id?: string;
      lines: EntryLine[];
      reconciled: boolean;
      total_debit_near: string;
      total_credit_near: string;
    }

    const journalEntries: JournalEntry[] = [];
    let entrySeq = 1;

    const addEntry = (
      sourceModule: string,
      description: string,
      debits: Array<{ code: CoaCode; amount: bigint; memo?: string }>,
      credits: Array<{ code: CoaCode; amount: bigint; memo?: string }>,
      refId?: string,
    ) => {
      const sumDebits = debits.reduce((acc, d) => acc + d.amount, 0n);
      const sumCredits = credits.reduce((acc, c) => acc + c.amount, 0n);
      if (sumDebits === 0n && sumCredits === 0n) return;
      if (sumDebits !== sumCredits) {
        throw new Error(`Unbalanced journal entry in ${sourceModule}: debits ${sumDebits} != credits ${sumCredits}`);
      }

      const lines: EntryLine[] = [
        ...debits.map((d) => ({
          account_code: COA[d.code].code,
          account_name: COA[d.code].name,
          debit_yocto: d.amount.toString(),
          debit_near: formatNear(d.amount, 4),
          credit_yocto: "0",
          credit_near: "0.0000",
          ...(d.memo ? { memo: d.memo } : {}),
        })),
        ...credits.map((c) => ({
          account_code: COA[c.code].code,
          account_name: COA[c.code].name,
          debit_yocto: "0",
          debit_near: "0.0000",
          credit_yocto: c.amount.toString(),
          credit_near: formatNear(c.amount, 4),
          ...(c.memo ? { memo: c.memo } : {}),
        })),
      ];

      const entryId = `JE-${entrySeq.toString().padStart(4, "0")}`;
      entrySeq++;

      journalEntries.push({
        entry_id: entryId,
        block_height: dashboard.block_height,
        source_module: sourceModule,
        description,
        ...(includeRaw && refId ? { reference_id: refId } : {}),
        lines,
        reconciled: true,
        total_debit_near: formatNear(sumDebits, 4),
        total_credit_near: formatNear(sumCredits, 4),
      });
    };

    // 1. Initial Contributed Capital
    const capIn = BigInt(dashboard.treasury.total_capital_in);
    if (capIn > 0n) {
      addEntry(
        "TreasuryCapital",
        "Initial treasury capital funding contribution",
        [{ code: 1010, amount: capIn, memo: "Initial liquid treasury deposit" }],
        [{ code: 3010, amount: capIn, memo: "Contributed capital equity" }],
        "capital_in",
      );
    }

    // 2. Customer Orders & Sales Revenue
    let accountedRevenue = 0n;
    if (dashboard.orders && dashboard.orders.length > 0) {
      for (const order of dashboard.orders) {
        const price = BigInt(order.price);
        if (price <= 0n) continue;
        if (order.status === "paid" || order.status === "in_production") {
          addEntry(
            "CustomerOrders",
            `Customer deposit received for order #${order.order_id} (${order.product_id})`,
            [{ code: 1010, amount: price, memo: `Paid by ${order.customer}` }],
            [{ code: 2010, amount: price, memo: "Unearned revenue liability" }],
            `order:${order.order_id}:deposit`,
          );
        } else if (order.status === "delivered") {
          accountedRevenue += price;
          addEntry(
            "CustomerOrders",
            `Customer deposit received for order #${order.order_id} (${order.product_id})`,
            [{ code: 1010, amount: price, memo: `Paid by ${order.customer}` }],
            [{ code: 2010, amount: price, memo: "Unearned revenue liability" }],
            `order:${order.order_id}:deposit`,
          );
          addEntry(
            "CustomerOrders",
            `Revenue recognized: Order #${order.order_id} verified and delivered`,
            [{ code: 2010, amount: price, memo: "Unearned revenue fulfilled" }],
            [{ code: 4010, amount: price, memo: `Sales revenue for ${order.product_id}` }],
            `order:${order.order_id}:delivery`,
          );
        } else if (order.status === "refunded" || order.status === "refunding") {
          addEntry(
            "CustomerOrders",
            `Customer deposit received for order #${order.order_id} (${order.product_id})`,
            [{ code: 1010, amount: price, memo: `Paid by ${order.customer}` }],
            [{ code: 2010, amount: price, memo: "Unearned revenue liability" }],
            `order:${order.order_id}:deposit`,
          );
          addEntry(
            "CustomerOrders",
            `Customer refund: Order #${order.order_id} unfulfilled by deadline; deposit returned`,
            [{ code: 2010, amount: price, memo: "Refund liability reduction" }],
            [{ code: 1010, amount: price, memo: `Refunded to ${order.customer}` }],
            `order:${order.order_id}:refund`,
          );
        }
      }
    }

    const totalRev = BigInt(dashboard.treasury.total_revenue);
    if (totalRev > accountedRevenue) {
      const unitemizedRev = totalRev - accountedRevenue;
      addEntry(
        "CustomerOrders",
        "Direct customer sales & treasury revenue deposits",
        [{ code: 1010, amount: unitemizedRev, memo: "Liquid revenue received" }],
        [{ code: 4010, amount: unitemizedRev, memo: "Product sales revenue" }],
        "revenue_deposits",
      );
    }

    // 3. Swarm Market Procurement Tasks
    let accountedCosts = 0n;
    if (dashboard.tasks && dashboard.tasks.length > 0) {
      for (const taskView of dashboard.tasks) {
        const task = taskView.task;
        const escrowAmt = taskView.escrow?.amount ? BigInt(taskView.escrow.amount) : BigInt(task.budget_ceiling);
        if (escrowAmt <= 0n) continue;
        if (task.status === "awarded") {
          addEntry(
            "SwarmMarket",
            `Task #${task.task_id} awarded to ${task.winner ?? "worker"}; escrow locked`,
            [{ code: 1020, amount: escrowAmt, memo: "Escrow transit hold" }],
            [{ code: 1010, amount: escrowAmt, memo: "Treasury liquid reservation" }],
            `task:${task.task_id}:award`,
          );
        } else if (task.status === "completed") {
          accountedCosts += escrowAmt;
          addEntry(
            "SwarmMarket",
            `Task #${task.task_id} verified via TEE proof; payment disbursed to ${task.winner ?? "worker"}`,
            [{ code: 5010, amount: escrowAmt, memo: "Task execution procurement expense" }],
            [{ code: 1010, amount: escrowAmt, memo: "Disbursed to worker earnings" }],
            `task:${task.task_id}:complete`,
          );
        }
      }
    }

    // 4. Vendor Invoices & Settlements
    if (dashboard.intents && dashboard.intents.length > 0) {
      for (const intent of dashboard.intents) {
        if (intent.status === "settled" && intent.kind === "vendor_payment") {
          const amt = BigInt(intent.amount);
          if (amt > 0n) {
            accountedCosts += amt;
            addEntry(
              "VendorSettlements",
              `Settled vendor invoice (${intent.memo ?? "invoice"}) to ${intent.recipient}`,
              [{ code: 5020, amount: amt, memo: `Vendor payment on ${intent.destination_chain}` }],
              [{ code: 1010, amount: amt, memo: "Direct treasury transfer" }],
              `intent:${intent.intent_id}`,
            );
          }
        }
      }
    }

    // 5. Cross-chain EVM Settlements
    if (dashboard.evm_txs && dashboard.evm_txs.length > 0) {
      for (const tx of dashboard.evm_txs) {
        if (tx.status === "confirmed") {
          const amt = BigInt(tx.amount);
          if (amt > 0n) {
            accountedCosts += amt;
            addEntry(
              "CrossChainEVM",
              `Confirmed EIP-1559 transfer #${tx.tx_id} to ${tx.to} on ${tx.chain}`,
              [{ code: 5030, amount: amt, memo: "EVM Chain Signatures settlement" }],
              [{ code: 1010, amount: amt, memo: "Treasury EVM allocation" }],
              `evm:${tx.tx_id}`,
            );
          }
        }
      }
    }

    const totalCosts = BigInt(dashboard.treasury.total_operating_costs);
    if (totalCosts > accountedCosts) {
      const unitemizedCosts = totalCosts - accountedCosts;
      addEntry(
        "OperatingExpenses",
        "Operating disbursements and vendor expenses",
        [{ code: 5020, amount: unitemizedCosts, memo: "Operating expense disbursements" }],
        [{ code: 1010, amount: unitemizedCosts, memo: "Disbursed from liquid treasury" }],
        "operating_disbursements",
      );
    }

    // 6. Revenue Distributions
    let accountedDistributed = 0n;
    let accountedRetained = 0n;
    if (dashboard.distributions && dashboard.distributions.length > 0) {
      for (const dist of dashboard.distributions) {
        for (const leg of dist.payouts) {
          const legAmt = BigInt(leg.amount);
          if (legAmt > 0n) {
            accountedDistributed += legAmt;
            addEntry(
              "RevenueDistributions",
              `Dividend distribution #${dist.distribution_id} to ${leg.label} (${leg.account_id})`,
              [{ code: 5040, amount: legAmt, memo: `Stakeholder payout to ${leg.account_id}` }],
              [{ code: 1010, amount: legAmt, memo: "Disbursed from treasury profits" }],
              `dist:${dist.distribution_id}:${leg.account_id}`,
            );
          }
        }
        const retainedAmt = BigInt(dist.retained);
        if (retainedAmt > 0n) {
          accountedRetained += retainedAmt;
          addEntry(
            "RevenueDistributions",
            `Retained operating reserve allocation from distribution #${dist.distribution_id}`,
            [{ code: 1030, amount: retainedAmt, memo: "Restricted reserve asset" }],
            [{ code: 3020, amount: retainedAmt, memo: "Retained earnings reserve equity" }],
            `dist:${dist.distribution_id}:reserve`,
          );
        }
      }
    }

    const totalDist = BigInt(dashboard.treasury.total_distributed);
    if (totalDist > accountedDistributed) {
      const deltaDist = totalDist - accountedDistributed;
      addEntry(
        "RevenueDistributions",
        "Stakeholder dividend distributions",
        [{ code: 5040, amount: deltaDist, memo: "Stakeholder payouts" }],
        [{ code: 1010, amount: deltaDist, memo: "Disbursed from liquid treasury" }],
        "distribution_disbursements",
      );
    }

    const totalRet = BigInt(dashboard.treasury.total_retained);
    if (totalRet > accountedRetained) {
      const deltaRet = totalRet - accountedRetained;
      addEntry(
        "RevenueDistributions",
        "Retained operating reserve allocation",
        [{ code: 1030, amount: deltaRet, memo: "Restricted reserve asset" }],
        [{ code: 3020, amount: deltaRet, memo: "Retained earnings reserve equity" }],
        "reserve_allocations",
      );
    }

    // Compute Trial Balance by aggregating all lines across all journal entries
    const trialBalanceMap = new Map<CoaCode, { debits: bigint; credits: bigint }>();
    for (const k of Object.keys(COA).map(Number) as CoaCode[]) {
      trialBalanceMap.set(k, { debits: 0n, credits: 0n });
    }

    for (const entry of journalEntries) {
      for (const line of entry.lines) {
        const codeNum = Number(line.account_code) as CoaCode;
        const record = trialBalanceMap.get(codeNum);
        if (record) {
          record.debits += BigInt(line.debit_yocto);
          record.credits += BigInt(line.credit_yocto);
        }
      }
    }

    let grandTotalDebits = 0n;
    let grandTotalCredits = 0n;

    const trialBalance = (Object.keys(COA).map(Number) as CoaCode[])
      .map((code) => {
        const meta = COA[code];
        const { debits, credits } = trialBalanceMap.get(code)!;
        grandTotalDebits += debits;
        grandTotalCredits += credits;
        const net = meta.normal === "Debit" ? debits - credits : credits - debits;
        return {
          account_code: meta.code,
          account_name: meta.name,
          category: meta.category,
          normal_balance: meta.normal,
          total_debit_near: formatNear(debits, 4),
          total_credit_near: formatNear(credits, 4),
          net_balance_near: formatNear(net, 4),
          net_balance_yocto: net.toString(),
        };
      })
      .filter((row) => row.total_debit_near !== "0.0000" || row.total_credit_near !== "0.0000");

    const imbalance = grandTotalDebits > grandTotalCredits ? grandTotalDebits - grandTotalCredits : grandTotalCredits - grandTotalDebits;
    const isReconciled = imbalance === 0n;

    const tsMs = Number(BigInt(dashboard.block_timestamp_ns) / 1_000_000n);
    const generatedAt = !isNaN(tsMs) && tsMs > 0 ? new Date(tsMs).toISOString() : new Date().toISOString();

    const summary = {
      total_capital_contributed_near: formatNear(BigInt(dashboard.treasury.total_capital_in), 4),
      total_sales_revenue_near: formatNear(BigInt(dashboard.treasury.total_revenue), 4),
      total_operating_expenses_near: formatNear(BigInt(dashboard.treasury.total_operating_costs), 4),
      total_distributed_near: formatNear(BigInt(dashboard.treasury.total_distributed), 4),
      total_retained_reserve_near: formatNear(BigInt(dashboard.treasury.total_retained), 4),
      net_operating_profit_near: formatNear(BigInt(dashboard.treasury.net_profit), 4),
      liquid_cash_balance_near: formatNear(BigInt(dashboard.treasury.liquid), 4),
      escrow_held_balance_near: formatNear(BigInt(dashboard.treasury.escrow_locked), 4),
      journal_entry_count: journalEntries.length,
    };

    if (format === "csv") {
      const header = [
        "Entry ID",
        "Block Height",
        "Timestamp",
        "Source Module",
        "Description",
        "Account Code",
        "Account Name",
        "Category",
        "Debit NEAR",
        "Credit NEAR",
        "Debit Yocto",
        "Credit Yocto",
        "Line Memo",
      ].join(",");
      const rows: string[] = [header];
      for (const je of journalEntries) {
        for (const line of je.lines) {
          const cat = COA[Number(line.account_code) as CoaCode].category;
          rows.push(
            [
              je.entry_id,
              je.block_height,
              generatedAt,
              `"${je.source_module}"`,
              `"${je.description.replace(/"/g, '""')}"`,
              line.account_code,
              `"${line.account_name}"`,
              cat,
              line.debit_near,
              line.credit_near,
              line.debit_yocto,
              line.credit_yocto,
              `"${(line.memo ?? "").replace(/"/g, '""')}"`,
            ].join(","),
          );
        }
      }
      return {
        contract_id: views.contractId,
        contract_version: info.version,
        format: "csv",
        reporting_currency: "NEAR",
        generated_at: generatedAt,
        reconciled: isReconciled,
        imbalance_near: formatNear(imbalance, 4),
        csv: rows.join("\n"),
        summary,
        note: "Standard General Ledger CSV format compatible with Excel, Xero, and corporate accounting imports.",
      };
    }

    if (format === "quickbooks_iif") {
      const iifLines: string[] = [
        "!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO",
        "!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO",
        "!ENDTRNS",
      ];
      const dateParts = generatedAt.split("T")[0]!.split("-");
      const iifDate = `${dateParts[1]}/${dateParts[2]}/${dateParts[0]}`;
      for (const je of journalEntries) {
        const firstLine = je.lines[0];
        if (!firstLine) continue;
        const firstDebit = parseFloat(firstLine.debit_near);
        const firstCredit = parseFloat(firstLine.credit_near);
        const firstAmt = firstDebit > 0 ? firstDebit : -firstCredit;
        iifLines.push(
          `TRNS\t${je.entry_id}\tGENERAL JOURNAL\t${iifDate}\t${firstLine.account_name}\t\t${firstAmt.toFixed(4)}\t${je.entry_id}\t${je.description}`,
        );
        for (let i = 1; i < je.lines.length; i++) {
          const line = je.lines[i]!;
          const d = parseFloat(line.debit_near);
          const c = parseFloat(line.credit_near);
          const amt = d > 0 ? d : -c;
          iifLines.push(
            `SPL\t${je.entry_id}_${i}\tGENERAL JOURNAL\t${iifDate}\t${line.account_name}\t\t${amt.toFixed(4)}\t${je.entry_id}\t${line.memo ?? je.description}`,
          );
        }
        iifLines.push("ENDTRNS");
      }
      return {
        contract_id: views.contractId,
        contract_version: info.version,
        format: "quickbooks_iif",
        reporting_currency: "NEAR",
        generated_at: generatedAt,
        reconciled: isReconciled,
        imbalance_near: formatNear(imbalance, 4),
        iif: iifLines.join("\n"),
        summary,
        note: "Intuit Interchange Format (IIF) for direct import into QuickBooks Desktop / Enterprise.",
      };
    }

    return {
      contract_id: views.contractId,
      contract_version: info.version,
      reporting_currency: "NEAR",
      generated_at: generatedAt,
      block_height: dashboard.block_height,
      reconciled: isReconciled,
      imbalance_near: formatNear(imbalance, 4),
      summary,
      ...(format === "trial_balance" || format === "both" ? { trial_balance: trialBalance } : {}),
      ...(format === "journal_entries" || format === "both" ? { journal_entries: journalEntries } : {}),
      note: "Exported double-entry general ledger generated directly from verified on-chain treasury ledger and events. Debits equal credits.",
    };
  }
}

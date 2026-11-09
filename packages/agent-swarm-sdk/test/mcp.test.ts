/** Unit tests for PhalanxSwarm MCP server and phalanx_export_accounting GL tool. */
import { beforeAll, describe, expect, it } from "vitest";

import { ACCOUNTS, ONE_NEAR, SwarmRuntime } from "../src/index.ts";
import { PhalanxMcpServer } from "../src/mcp.ts";
import { loadContractWasm } from "../src/node.ts";

describe("PhalanxMcpServer and Enterprise Accounting Export", () => {
  let rt: SwarmRuntime;
  let server: PhalanxMcpServer;

  beforeAll(async () => {
    rt = await SwarmRuntime.boot({ wasm: loadContractWasm(), intentsMode: "offline" });
    await rt.fund(100, "initial seed funding");
    // Customer pays 40 NEAR revenue
    await rt.contract.call(rt.customer, "deposit_revenue", { customer_ref: "acme-corp", memo: "q4 enterprise software license" }, null, {
      deposit: 40n * ONE_NEAR,
    });
    for (const p of ["nexus", "cipher", "sentinel"] as const) await rt.spawn(p);

    server = new PhalanxMcpServer({
      views: rt.contract,
      network: "sim",
      nowNs: () => rt.nowNs(),
    });
  });

  it("lists phalanx_export_accounting in tools/list", async () => {
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    expect(res).not.toBeNull();
    expect(res?.error).toBeUndefined();
    const tools = (res?.result as { tools: Array<{ name: string; title: string }> }).tools;
    expect(tools.map((t) => t.name)).toContain("phalanx_export_accounting");
    const tool = tools.find((t) => t.name === "phalanx_export_accounting");
    expect(tool?.title).toBe("Export enterprise reconciliations & General Ledger");
  });

  it("exports balanced General Ledger journal entries and trial balance via tools/call", async () => {
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "phalanx_export_accounting",
        arguments: { format: "both" },
      },
    });

    expect(res).not.toBeNull();
    expect(res?.error).toBeUndefined();
    const result = res?.result as { structuredContent: Record<string, unknown>; isError: boolean };
    expect(result.isError).toBe(false);

    const report = result.structuredContent;
    expect(report.contract_id).toBe(ACCOUNTS.contract);
    expect(report.reporting_currency).toBe("NEAR");
    expect(report.reconciled).toBe(true);
    expect(report.imbalance_near).toBe("0.0000");

    const summary = report.summary as Record<string, unknown>;
    expect(summary.total_capital_contributed_near).toBe("100.0000");
    expect(summary.total_sales_revenue_near).toBe("40.0000");
    expect(summary.liquid_cash_balance_near).toBe("140.0000");
    expect(summary.journal_entry_count).toBeGreaterThan(0);

    const journalEntries = report.journal_entries as Array<{
      entry_id: string;
      source_module: string;
      reconciled: boolean;
      total_debit_near: string;
      total_credit_near: string;
      lines: Array<{ account_code: string; debit_near: string; credit_near: string }>;
    }>;
    expect(journalEntries.length).toBeGreaterThan(0);
    for (const je of journalEntries) {
      expect(je.reconciled).toBe(true);
      expect(je.total_debit_near).toBe(je.total_credit_near);
      const sumDebits = je.lines.reduce((s, l) => s + parseFloat(l.debit_near), 0);
      const sumCredits = je.lines.reduce((s, l) => s + parseFloat(l.credit_near), 0);
      expect(sumDebits.toFixed(4)).toBe(sumCredits.toFixed(4));
    }

    const trialBalance = report.trial_balance as Array<{
      account_code: string;
      account_name: string;
      category: string;
      total_debit_near: string;
      total_credit_near: string;
      net_balance_near: string;
    }>;
    expect(trialBalance.length).toBeGreaterThan(0);

    // Sum of all trial balance debits must equal sum of all credits
    const totalTrialDebits = trialBalance.reduce((s, r) => s + parseFloat(r.total_debit_near), 0);
    const totalTrialCredits = trialBalance.reduce((s, r) => s + parseFloat(r.total_credit_near), 0);
    expect(totalTrialDebits.toFixed(4)).toBe(totalTrialCredits.toFixed(4));
  });

  it("filters format to trial_balance only", async () => {
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "phalanx_export_accounting",
        arguments: { format: "trial_balance" },
      },
    });

    const report = (res?.result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(report.trial_balance).toBeDefined();
    expect(report.journal_entries).toBeUndefined();
    expect(report.reconciled).toBe(true);
  });

  it("filters format to journal_entries only", async () => {
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "phalanx_export_accounting",
        arguments: { format: "journal_entries" },
      },
    });

    const report = (res?.result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(report.journal_entries).toBeDefined();
    expect(report.trial_balance).toBeUndefined();
    expect(report.reconciled).toBe(true);
  });

  it("exports standard CSV format for corporate accounting imports", async () => {
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "phalanx_export_accounting",
        arguments: { format: "csv" },
      },
    });

    const report = (res?.result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(report.format).toBe("csv");
    expect(report.reconciled).toBe(true);
    expect(report.csv).toBeDefined();
    const csv = report.csv as string;
    expect(csv).toContain("Entry ID,Block Height,Timestamp");
    expect(csv).toContain("Cash & Liquid Treasury");
    expect(csv).toContain("Contributed Treasury Capital");
  });

  it("exports QuickBooks IIF format for direct desktop import", async () => {
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "phalanx_export_accounting",
        arguments: { format: "quickbooks_iif" },
      },
    });

    const report = (res?.result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(report.format).toBe("quickbooks_iif");
    expect(report.reconciled).toBe(true);
    expect(report.iif).toBeDefined();
    const iif = report.iif as string;
    expect(iif).toContain("!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT");
    expect(iif).toContain("GENERAL JOURNAL");
    expect(iif).toContain("ENDTRNS");
  });

  it("handles line-delimited JSON-RPC over stdio", async () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "phalanx_export_accounting",
        arguments: {},
      },
    });
    const out = await server.handleLine(line);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.id).toBe(7);
    expect(parsed.result.structuredContent.reconciled).toBe(true);
    expect(parsed.result.structuredContent.summary.total_capital_contributed_near).toBe("100.0000");
  });
});

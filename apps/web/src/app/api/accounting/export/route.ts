/**
 * GET /api/accounting/export?format=both|trial_balance|journal_entries|csv|quickbooks_iif
 *
 * Exports reconciled enterprise General Ledger journal entries and trial balance from the
 * on-chain PhalanxSwarm treasury contract. Supports JSON, CSV (Excel/Xero), and Intuit
 * Interchange Format (.IIF for QuickBooks Desktop/Enterprise).
 */
import { PhalanxMcpServer, PhalanxViews, RpcTransport } from "@phalanx/agent-swarm-sdk";

import { clientKey, createLimiter, isCrossSite } from "@/lib/server-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createLimiter({ perClient: 60, perInstance: 600, windowMs: 10 * 60_000 });

export async function GET(req: Request): Promise<Response> {
  if (isCrossSite(req)) return Response.json({ message: "cross-site requests are not served" }, { status: 403 });
  const limit = limiter.take(clientKey(req));
  if (!limit.ok) {
    return Response.json({ message: "rate limited; please try again shortly" }, { status: 429 });
  }

  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "both";
  const validFormats = ["both", "trial_balance", "journal_entries", "csv", "quickbooks_iif"];
  if (!validFormats.includes(format)) {
    return Response.json({ message: `invalid format: ${format}. Expected one of: ${validFormats.join(", ")}` }, { status: 400 });
  }

  const contractId = process.env.NEXT_PUBLIC_PHALANX_CONTRACT_ID ?? "phalanx-v3d1.phalanxswarm.testnet";
  const rpcUrl = process.env.NEXT_PUBLIC_NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";

  try {
    const views = new PhalanxViews(new RpcTransport(rpcUrl, contractId));
    const server = new PhalanxMcpServer({ views, network: "testnet" });
    const report = await server.callTool("phalanx_export_accounting", { format });

    if (format === "csv" && typeof report.csv === "string") {
      return new Response(report.csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="phalanx-general-ledger.csv"',
        },
      });
    }
    if (format === "quickbooks_iif" && typeof report.iif === "string") {
      return new Response(report.iif, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": 'attachment; filename="phalanx-quickbooks.iif"',
        },
      });
    }
    return Response.json(report, {
      headers: { "Cache-Control": "public, max-age=15" },
    });
  } catch (err) {
    return Response.json({ message: `accounting export failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
}

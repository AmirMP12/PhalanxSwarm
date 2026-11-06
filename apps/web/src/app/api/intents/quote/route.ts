/**
 * Server-side proxy for `POST https://1click.chaindefuser.com/v0/quote`.
 * - forces `"dry": true` (Rule Q-007: quotes only, no deposit address, no funds move);
 * - keeps the optional partner JWT (`ONECLICK_JWT`) on the server;
 * - validates the request body with the SDK's 1Click schema.
 * The browser client falls back to the deterministic offline engine if this route fails.
 */
import { OneClickQuoteRequest } from "@aegis/agent-swarm-sdk";

import { clientKey, createLimiter, envMs, isCrossSite } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

/** Requests are forwarded with the partner key; a judge run quotes about 10 routes. */
const limiter = createLimiter({ perClient: 120, perInstance: 1_200, windowMs: 10 * 60_000 });

export async function POST(req: Request): Promise<Response> {
  if (isCrossSite(req)) return Response.json({ message: "cross-site requests are not served" }, { status: 403 });
  const limit = limiter.take(clientKey(req));
  if (!limit.ok) {
    return Response.json(
      { message: "too many quote requests; try again in a few minutes" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ message: "invalid JSON" }, { status: 400 });
  }
  const parsed = OneClickQuoteRequest.safeParse({ ...(body as object), dry: true });
  if (!parsed.success) return Response.json({ message: "invalid quote request", issues: parsed.error.issues }, { status: 400 });
  if (process.env.AEGIS_INTENTS_MODE === "offline") return Response.json({ message: "live quotes disabled (AEGIS_INTENTS_MODE=offline)" }, { status: 503 });

  const base = process.env.ONECLICK_API_BASE || "https://1click.chaindefuser.com";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.ONECLICK_JWT) {
    headers.Authorization = `Bearer ${process.env.ONECLICK_JWT}`;
    headers["X-API-Key"] = process.env.ONECLICK_JWT;
  }
  const controller = new AbortController();
  // An empty or non-numeric value used to become a 0 ms timeout, which aborted every request.
  const timer = setTimeout(() => controller.abort(), envMs(process.env.AEGIS_INTENTS_TIMEOUT_MS, 6_000, 500, 30_000));
  try {
    const upstream = await fetch(`${base}/v0/quote`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...parsed.data, dry: true }),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return Response.json({ message: `1Click unreachable: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Server-side NEAR AI Cloud attestation. The DCAP verifier (`@phala/dcap-qvl`) and Intel's PCCS
 * stay on the server; the browser receives the structured result.
 *
 * GET /api/tee/attest
 *   Fresh gateway attestation: new nonce, hardware-signed Intel TDX quote, DCAP verification and
 *   the `report_data = signing_address ‖ nonce` binding. The endpoint needs no API key (one is
 *   sent when NEARAI_API_KEY is set). After bounded retries, or when the caller is over the rate
 *   limit, it returns the DCAP evidence saved at build time, labeled `cached` (and `stale` once
 *   older than 7 days) instead of failing.
 *
 * GET /api/tee/attest?model=<id>&signing_address=<hex>
 *   Attestation of the key that signed an agent's completion. The browser registers that key
 *   on-chain only if this verifies (DCAP + report_data binding of the key and a fresh nonce).
 *
 * Cross-site browser requests are refused; see `lib/server-guard.ts` for the limits.
 */
import { resolve } from "node:path";

import { DEFAULT_NEARAI_MODEL, offlineAttestation } from "@aegis/agent-swarm-sdk";
import { loadCachedNearAiEvidence, verifyNearAiAttestationNode, verifyNearAiModelNode } from "@aegis/agent-swarm-sdk/node";

import { clientKey, createLimiter, envMs, isCrossSite } from "@/lib/server-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };
/** Each fresh check fetches a quote and runs DCAP against Intel collateral; a page load makes one. */
const limiter = createLimiter({ perClient: 30, perInstance: 300, windowMs: 10 * 60_000 });
/** Copied from artifacts/ by scripts/copy-wasm.mjs; bundled via outputFileTracingIncludes. */
const EVIDENCE_PATH = resolve(process.cwd(), "public/evidence/nearai-attestation.json");

const offline = () => process.env.AEGIS_INTENTS_MODE === "offline" || process.env.AEGIS_TEE_MODE === "offline";
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function withRetries<T>(attempts: number, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await run();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 750 * 2 ** i));
    }
  }
  throw lastError;
}

/** The DCAP evidence saved at build time, labeled `cached`, or a 503 when there is none. */
function cachedResponse(reason: string): Response {
  const cached = loadCachedNearAiEvidence(EVIDENCE_PATH);
  if (!cached) return Response.json({ message: `NEAR AI attestation unavailable and no saved evidence: ${reason}` }, { status: 503, headers: NO_STORE });
  return Response.json(cached, {
    headers: {
      ...NO_STORE,
      "X-Aegis-Attestation": cached.stale ? "cached-stale" : "cached",
      "X-Aegis-Fresh-Error": reason.replace(/[^\x20-\x7e]/g, "?").slice(0, 200),
    },
  });
}

async function gatewayAttestation(limited: boolean): Promise<Response> {
  if (offline()) return Response.json(offlineAttestation("aegis-gateway:offline"), { headers: NO_STORE });
  // Over the limit, the saved evidence answers instead of a fresh quote and DCAP run.
  if (limited) return cachedResponse("rate limited: showing saved evidence");
  const timeoutMs = envMs(process.env.AEGIS_TEE_TIMEOUT_MS, 10_000, 1_000, 10_000);
  try {
    const result = await withRetries(2, async () => {
      const r = await verifyNearAiAttestationNode({ timeoutMs });
      if (!r.verified || !r.bindingOk || !r.measurementMatch) throw new Error(`attestation verification rejected: ${r.status}`);
      return r;
    });
    return Response.json(result, { headers: NO_STORE });
  } catch (err) {
    return cachedResponse(message(err));
  }
}

async function modelAttestation(model: string, signingAddress: string, limited: { retryAfterSec: number } | null): Promise<Response> {
  if (offline()) return Response.json({ message: "model attestation is disabled in offline mode" }, { status: 503, headers: NO_STORE });
  if (limited) {
    return Response.json(
      { message: "too many attestation requests; try again in a few minutes" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(limited.retryAfterSec) } },
    );
  }
  const allowed = process.env.NEARAI_MODEL || DEFAULT_NEARAI_MODEL;
  if (model !== allowed) return Response.json({ message: `model must be ${allowed}` }, { status: 400, headers: NO_STORE });
  if (!/^[0-9a-f]{64}$/i.test(signingAddress)) return Response.json({ message: "signing_address must be 32 bytes of hex" }, { status: 400, headers: NO_STORE });
  try {
    const result = await verifyNearAiModelNode({ model, signingAddress: signingAddress.toLowerCase(), timeoutMs: 20_000 });
    return Response.json(result, { headers: NO_STORE });
  } catch (err) {
    return Response.json({ message: `NEAR AI model attestation failed: ${message(err)}` }, { status: 502, headers: NO_STORE });
  }
}

export async function GET(req: Request): Promise<Response> {
  if (isCrossSite(req)) return Response.json({ message: "cross-site requests are not served" }, { status: 403, headers: NO_STORE });
  const limit = limiter.take(clientKey(req));
  const params = new URL(req.url).searchParams;
  const model = params.get("model");
  if (model !== null) return modelAttestation(model, params.get("signing_address") ?? "", limit.ok ? null : limit);
  return gatewayAttestation(!limit.ok);
}

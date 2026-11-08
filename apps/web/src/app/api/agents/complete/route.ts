/**
 * Server-side NEAR AI Cloud inference for the browser swarm. The API key never leaves the server.
 *
 * GET  -> { enabled, model }: whether live agents are available on this deployment.
 * POST { model, role, context, marker } -> SignedCompletion
 *   The server rebuilds the prompt with `messagesFor(role, context, marker)`; it never forwards
 *   caller-written messages, so the route cannot be used as a general chat proxy. It calls
 *   /v1/chat/completions, fetches the TEE signature for the completion and checks that the
 *   signature covers the exact request and response bytes. The browser re-checks the signature
 *   and that the prompt is the one its agent built; the contract verifies it again on-chain.
 */
import { DEFAULT_NEARAI_MODEL, GenericLlmBackend, messagesFor, NearAiBackend, type BrainRole } from "@phalanx/agent-swarm-sdk";

import { clientKey, createLimiter, isCrossSite } from "@/lib/server-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROLES: readonly BrainRole[] = ["orchestrator", "bidder", "procurement", "strategy", "auditor", "accounts_payable"];
const MAX_CONTEXT_CHARS = 16_384;
/** `PHALANX-BIND:v1:{kind}:{id}:{agent}:{input_hash}:{nonce}:{issued_at_ns}` (see attestation.rs). */
const MARKER = /^PHALANX-BIND:v1:(task|intent|evm):\d{1,20}:[a-z0-9._-]{2,64}:[0-9a-f]{64}:[A-Za-z0-9_-]{8,64}:\d{1,20}$/;
/**
 * Every call spends the operator's model credits. A judge run makes about 10 calls, so 60 per
 * client and 300 per server instance in 10 minutes leave room for repeated runs while bounding
 * what one instance can spend.
 */
const limiter = createLimiter({ perClient: 60, perInstance: 300, windowMs: 10 * 60_000 });

const NO_STORE = { "Cache-Control": "no-store" };

const nearAiKey = () => process.env.NEARAI_API_KEY || undefined;
const geminiKey = () => process.env.GEMINI_API_KEY || undefined;
const openAiKey = () => process.env.OPENAI_API_KEY || undefined;
const genericKey = () => process.env.LLM_API_KEY || geminiKey() || openAiKey();

const provider = () => (nearAiKey() ? "nearai" : genericKey() ? "generic_llm" : null);

const model = () => {
  if (nearAiKey()) return process.env.NEARAI_MODEL || DEFAULT_NEARAI_MODEL;
  if (geminiKey()) return process.env.GEMINI_MODEL || "gemini-2.5-flash";
  if (openAiKey()) return process.env.OPENAI_MODEL || "gpt-4o-mini";
  return process.env.LLM_MODEL || "gpt-4o-mini";
};

const baseUrl = () => {
  if (process.env.LLM_BASE_URL) return process.env.LLM_BASE_URL;
  if (geminiKey()) return "https://generativelanguage.googleapis.com/v1beta/openai";
  return "https://api.openai.com/v1";
};

const enabled = () => Boolean(nearAiKey() || genericKey()) && process.env.PHALANX_INTENTS_MODE !== "offline" && process.env.PHALANX_AGENTS_MODE !== "offline";

/** One instance per server process: its signing key is random, so every completion here shares one key. */
let generic: GenericLlmBackend | null = null;
const genericBackend = () => (generic ??= new GenericLlmBackend({ apiKey: genericKey()!, baseUrl: baseUrl(), model: model(), timeoutMs: 50_000 }));

const bad = (message: string, status = 400, headers: Record<string, string> = {}) =>
  Response.json({ message }, { status, headers: { ...NO_STORE, ...headers } });

export function GET(): Response {
  return Response.json({ enabled: enabled(), model: model(), provider: provider() }, { headers: NO_STORE });
}

export async function POST(req: Request): Promise<Response> {
  if (!enabled()) {
    return bad("live agents are not configured on this server (set NEARAI_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY)", 503);
  }
  if (isCrossSite(req)) return bad("cross-site requests are not served", 403);
  const limit = limiter.take(clientKey(req));
  if (!limit.ok) {
    return bad("too many agent calls; try again in a few minutes", 429, { "Retry-After": String(limit.retryAfterSec) });
  }

  let body: { model?: unknown; role?: unknown; context?: unknown; marker?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("invalid JSON");
  }
  if (body.model !== model()) return bad(`model must be ${model()}`);
  if (typeof body.role !== "string" || !ROLES.includes(body.role as BrainRole)) return bad(`role must be one of ${ROLES.join(", ")}`);
  const marker = body.marker ?? null;
  if (marker !== null && (typeof marker !== "string" || !MARKER.test(marker))) return bad("marker is not an PHALANX-BIND:v1 binding marker");
  const contextJson = body.context === undefined ? undefined : JSON.stringify(body.context);
  if (contextJson === undefined || contextJson.length > MAX_CONTEXT_CHARS)
    return bad(`context is required and must be at most ${MAX_CONTEXT_CHARS} characters of JSON`);

  const role = body.role as BrainRole;
  try {
    const prov = provider();
    if (prov === "nearai") {
      const backend = new NearAiBackend({ apiKey: nearAiKey()!, model: model(), timeoutMs: 50_000 });
      const completion = await backend.complete(messagesFor(role, body.context, marker), undefined, { role, context: body.context, marker });
      return Response.json(completion, { headers: NO_STORE });
    }
    // Generic OpenAI-compatible LLM (Gemini, OpenAI, Groq, Ollama, etc.)
    const completion = await genericBackend().complete(messagesFor(role, body.context, marker), () => ({}));
    return Response.json(completion, { headers: NO_STORE });
  } catch (err) {
    return bad(`Agent inference failed: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
}

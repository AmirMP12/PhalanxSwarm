/**
 * Abuse limits for the API routes that spend this deployment's resources: model credits
 * (`/api/agents/complete`), the 1Click partner key (`/api/intents/quote`) and DCAP verification
 * (`/api/tee/attest`). Server-only.
 *
 * The limits live in memory, per server instance. The per-client limit keys on `x-real-ip` /
 * `x-forwarded-for`, which Vercel overwrites with the caller's address; on a host without such a
 * proxy the client controls those headers, so the per-instance limit is the bound that rotating
 * headers cannot get around.
 */

const MAX_TRACKED_CLIENTS = 5_000;

export interface Limiter {
  /** Counts one request from `client`. `ok: false` means refuse it with HTTP 429. */
  take(client: string): { ok: true } | { ok: false; retryAfterSec: number };
}

export function createLimiter(opts: { perClient: number; perInstance: number; windowMs: number }): Limiter {
  const clients = new Map<string, number[]>();
  let instance: number[] = [];

  const evictIdle = (now: number) => {
    for (const [key, hits] of clients) {
      if (now - (hits[hits.length - 1] ?? 0) >= opts.windowMs) clients.delete(key);
    }
    // Still full: drop the clients seen first (a Map iterates in insertion order).
    for (const key of clients.keys()) {
      if (clients.size <= MAX_TRACKED_CLIENTS) break;
      clients.delete(key);
    }
  };

  return {
    take(client) {
      const now = Date.now();
      const recent = (clients.get(client) ?? []).filter((t) => now - t < opts.windowMs);
      if (recent.length >= opts.perClient) {
        recent.push(now);
        clients.set(client, recent.slice(-opts.perClient));
        return { ok: false, retryAfterSec: Math.ceil(opts.windowMs / 1000) };
      }
      instance = instance.filter((t) => now - t < opts.windowMs);
      if (instance.length >= opts.perInstance) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((opts.windowMs - (now - instance[0]!)) / 1000)) };
      }
      recent.push(now);
      instance.push(now);
      clients.delete(client);
      clients.set(client, recent);
      if (clients.size > MAX_TRACKED_CLIENTS) evictIdle(now);
      return { ok: true };
    },
  };
}

/** The caller's address as the hosting proxy reports it (`unknown` when there is none). */
export function clientKey(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (real || forwarded || "unknown").slice(0, 64);
}

/**
 * True for a browser request sent by another site. Refusing those stops a third-party page from
 * making its visitors' browsers spend this deployment's credits. Non-browser clients send neither
 * header and fall under the rate limits instead.
 */
export function isCrossSite(req: Request): boolean {
  if (req.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return !host || new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/** A timeout from the environment: `fallback` when unset or not a number, clamped to [min, max]. */
export function envMs(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) && value !== undefined && value.trim() !== "" ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/**
 * NEAR Intents 1Click API client (`POST https://1click.chaindefuser.com/v0/quote`).
 *
 * - Every request is forced to `"dry": true` (hackathon Rule Q-007: no testnet for Intents, so
 *   quotes are previews and never create deposit addresses or move funds).
 * - `mode: "auto"` tries the live API with a timeout and falls back to a deterministic offline
 *   engine, so CI and air-gapped judge machines never fail. `"live"` fails loudly; `"offline"`
 *   never touches the network.
 * - The offline engine uses a fixed token calibration from `GET /v0/tokens`, applies the
 *   unauthenticated 20 bps app fee, a per-chain route spread and withdraw fees, and signs its
 *   quote with its own ed25519 key (`provider: "1click-offline"`).
 */
import { z } from "zod";

import { canonicalJson, keyPairFromSeed, sha256Bytes, sha256Hex, signEd25519, toHex } from "./encoding.ts";
import type { QuoteBindingT } from "./types.ts";

export const ONECLICK_BASE_URL = "https://1click.chaindefuser.com";

export type IntentsMode = "auto" | "live" | "offline";

export const OneClickQuoteRequest = z.object({
  dry: z.literal(true),
  swapType: z.enum(["EXACT_INPUT", "EXACT_OUTPUT", "FLEX_INPUT"]),
  slippageTolerance: z.number().int().min(0).max(10_000),
  originAsset: z.string(),
  depositType: z.enum(["ORIGIN_CHAIN", "INTENTS"]),
  destinationAsset: z.string(),
  amount: z.string().regex(/^\d+$/),
  refundTo: z.string(),
  refundType: z.enum(["ORIGIN_CHAIN", "INTENTS"]),
  recipient: z.string(),
  recipientType: z.enum(["DESTINATION_CHAIN", "INTENTS"]),
  deadline: z.string(),
  referral: z.string().optional(),
  quoteWaitingTimeMs: z.number().int().optional(),
});
export type OneClickQuoteRequestT = z.infer<typeof OneClickQuoteRequest>;

export const OneClickQuote = z.looseObject({
  amountIn: z.string(),
  amountInFormatted: z.string(),
  amountInUsd: z.string(),
  minAmountIn: z.string(),
  amountOut: z.string(),
  amountOutFormatted: z.string(),
  amountOutUsd: z.string(),
  minAmountOut: z.string(),
  timeEstimate: z.number(),
  depositAddress: z.string().optional(),
  deadline: z.string().optional(),
  withdrawFee: z.string().optional(),
  refundFee: z.string().optional(),
});

export const OneClickQuoteResponse = z.looseObject({
  correlationId: z.string(),
  timestamp: z.string(),
  signature: z.string(),
  quoteRequest: z.looseObject({ dry: z.boolean(), deadline: z.string(), amount: z.string() }),
  quote: OneClickQuote,
});
export type OneClickQuoteResponseT = z.infer<typeof OneClickQuoteResponse>;

export interface QuoteResult {
  response: OneClickQuoteResponseT;
  source: "live" | "offline";
  latencyMs: number;
  /** Set when `auto` mode fell back to the offline engine. */
  fallbackReason?: string;
}

export interface AssetInfo {
  symbol: string;
  blockchain: string;
  decimals: number;
  priceUsd: number;
  /** Destination withdraw fee in base units (from live quotes). */
  withdrawFee: bigint;
}

/** Token calibration used only by the explicitly selected offline engine. */
export const ASSET_SNAPSHOT: Record<string, AssetInfo> = {
  "nep141:wrap.near": { symbol: "wNEAR", blockchain: "near", decimals: 24, priceUsd: 4.73, withdrawFee: 0n },
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": {
    symbol: "USDC",
    blockchain: "near",
    decimals: 6,
    priceUsd: 0.999543,
    withdrawFee: 0n,
  },
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near": {
    symbol: "USDC",
    blockchain: "arb",
    decimals: 6,
    priceUsd: 0.999543,
    withdrawFee: 5_300n,
  },
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near": {
    symbol: "USDC",
    blockchain: "base",
    decimals: 6,
    priceUsd: 0.999543,
    withdrawFee: 2_400n,
  },
  "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near": {
    symbol: "USDC",
    blockchain: "sol",
    decimals: 6,
    priceUsd: 0.999543,
    withdrawFee: 10_000n,
  },
  "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near": {
    symbol: "USDC",
    blockchain: "eth",
    decimals: 6,
    priceUsd: 0.999543,
    withdrawFee: 450_000n,
  },
  "nep141:eth.omft.near": { symbol: "ETH", blockchain: "eth", decimals: 18, priceUsd: 2359.3, withdrawFee: 0n },
  "nep141:sol.omft.near": { symbol: "SOL", blockchain: "sol", decimals: 9, priceUsd: 102.44, withdrawFee: 0n },
  "nep141:btc.omft.near": { symbol: "BTC", blockchain: "btc", decimals: 8, priceUsd: 81_243, withdrawFee: 0n },
};

/** Route spread per destination chain used by the offline engine, in basis points. */
const ROUTE_SPREAD_BPS: Record<string, number> = { near: 3, arb: 5, base: 5, sol: 8, eth: 12, btc: 15 };
const TIME_ESTIMATE_SEC: Record<string, number> = { near: 8, arb: 10, base: 12, sol: 15, eth: 45, btc: 1_200 };
const UNAUTHENTICATED_APP_FEE_BPS = 20;
const offlineQuoter = keyPairFromSeed("aegis-offline-1click-quote-engine");

function formatUnits(amount: bigint, decimals: number, digits = decimals): string {
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s
    .slice(s.length - decimals)
    .slice(0, digits)
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}.0`;
}

const MICRO = 1_000_000;

/** Deterministic quote with the same response shape as 1Click (`provider: 1click-offline`). */
export function offlineQuote(request: OneClickQuoteRequestT, nowMs: number): OneClickQuoteResponseT {
  const assetIn = ASSET_SNAPSHOT[request.originAsset];
  const assetOut = ASSET_SNAPSHOT[request.destinationAsset];
  if (!assetIn || !assetOut) throw new Error(`offline engine has no price for ${!assetIn ? request.originAsset : request.destinationAsset}`);
  if (request.swapType !== "EXACT_INPUT") throw new Error("offline engine supports EXACT_INPUT quotes only");
  const amountIn = BigInt(request.amount);
  const pIn = BigInt(Math.round(assetIn.priceUsd * MICRO));
  const pOut = BigInt(Math.round(assetOut.priceUsd * MICRO));
  const gross = (amountIn * pIn * 10n ** BigInt(assetOut.decimals)) / (pOut * 10n ** BigInt(assetIn.decimals));
  const spread = BigInt(ROUTE_SPREAD_BPS[assetOut.blockchain] ?? 10);
  const afterFees = (gross * (10_000n - BigInt(UNAUTHENTICATED_APP_FEE_BPS) - spread)) / 10_000n;
  const amountOut = afterFees > assetOut.withdrawFee ? afterFees - assetOut.withdrawFee : 0n;
  const minAmountOut = (amountOut * BigInt(10_000 - request.slippageTolerance)) / 10_000n;
  const usd = (amount: bigint, a: AssetInfo) => ((Number(amount) / 10 ** a.decimals) * a.priceUsd).toFixed(12);

  const quoteRequest = { ...request, depositMode: "SIMPLE" };
  const quote = {
    amountIn: amountIn.toString(),
    amountInFormatted: formatUnits(amountIn, assetIn.decimals),
    amountInUsd: usd(amountIn, assetIn),
    minAmountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    amountOutFormatted: formatUnits(amountOut, assetOut.decimals),
    amountOutUsd: usd(amountOut, assetOut),
    minAmountOut: minAmountOut.toString(),
    timeEstimate: TIME_ESTIMATE_SEC[assetOut.blockchain] ?? 30,
    refundFee: "0",
    withdrawFee: assetOut.withdrawFee.toString(),
  };
  const timestamp = new Date(nowMs).toISOString();
  const id = toHex(sha256Bytes(canonicalJson({ quoteRequest, timestamp })));
  const correlationId = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`;
  const signature = signEd25519(offlineQuoter, sha256Bytes(canonicalJson({ correlationId, quote, quoteRequest, timestamp })));
  return OneClickQuoteResponse.parse({ correlationId, timestamp, signature, quoteRequest, quote });
}

/** Content hash bound into the on-chain `QuoteBinding.quote_hash`. */
export function quoteHash(response: OneClickQuoteResponseT): string {
  return sha256Hex(
    canonicalJson({
      correlationId: response.correlationId,
      quote: response.quote,
      quoteRequest: response.quoteRequest,
      signature: response.signature,
      timestamp: response.timestamp,
    }),
  );
}

/** Converts a quote into the binding the contract validates. */
export function toQuoteBinding(result: QuoteResult): QuoteBindingT {
  const r = result.response;
  const deadlineMs = Date.parse(r.quote.deadline ?? r.quoteRequest.deadline);
  return {
    provider: result.source === "live" ? "1click" : "1click-offline",
    quote_hash: quoteHash(r),
    correlation_id: r.correlationId,
    amount_in: r.quote.amountIn,
    amount_out: r.quote.amountOut,
    min_amount_out: r.quote.minAmountOut,
    expires_at_ns: (BigInt(deadlineMs) * 1_000_000n).toString(),
    dry: r.quoteRequest.dry === true,
    deposit_address: r.quote.depositAddress ?? null,
  };
}

export interface OneClickClientOptions {
  mode?: IntentsMode;
  baseUrl?: string;
  /** Full URL of the quote endpoint (e.g. the web app's server-side proxy `/api/intents/quote`). */
  quoteEndpoint?: string;
  /** Optional partner JWT (Rule Q-006), sent as `X-API-Key`. Server-side only. */
  jwt?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Clock used for deadlines and offline quotes (the AegisSim VM clock in scenarios). */
  nowMs?: () => number;
}

export interface QuoteParams {
  originAsset: string;
  destinationAsset: string;
  amount: bigint | string;
  recipient: string;
  refundTo: string;
  slippageBps: number;
  deadlineSec?: number;
  referral?: string;
}

export class OneClickClient {
  readonly mode: IntentsMode;
  private readonly endpoint: string;
  private readonly jwt?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;

  constructor(opts: OneClickClientOptions = {}) {
    this.mode = opts.mode ?? "auto";
    this.endpoint = opts.quoteEndpoint ?? `${opts.baseUrl ?? ONECLICK_BASE_URL}/v0/quote`;
    this.jwt = opts.jwt;
    this.timeoutMs = opts.timeoutMs ?? 6_000;
    this.fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /** Builds the exact 1Click request body (always `dry: true`, treasury funds held in NEAR Intents). */
  buildRequest(p: QuoteParams): OneClickQuoteRequestT {
    return OneClickQuoteRequest.parse({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: p.slippageBps,
      originAsset: p.originAsset,
      depositType: "INTENTS",
      destinationAsset: p.destinationAsset,
      amount: p.amount.toString(),
      refundTo: p.refundTo,
      refundType: "INTENTS",
      recipient: p.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(this.nowMs() + (p.deadlineSec ?? 1_800) * 1000).toISOString(),
      referral: p.referral ?? "aegis-swarm",
      quoteWaitingTimeMs: 0,
    });
  }

  async quote(p: QuoteParams): Promise<QuoteResult> {
    const request = this.buildRequest(p);
    if (this.mode === "offline") return { response: offlineQuote(request, this.nowMs()), source: "offline", latencyMs: 0 };
    const started = Date.now();
    try {
      const response = await this.liveQuote(request);
      return { response, source: "live", latencyMs: Date.now() - started };
    } catch (err) {
      if (this.mode === "live") throw err;
      const reason = err instanceof Error ? err.message : String(err);
      return { response: offlineQuote(request, this.nowMs()), source: "offline", latencyMs: Date.now() - started, fallbackReason: reason };
    }
  }

  private async liveQuote(request: OneClickQuoteRequestT): Promise<OneClickQuoteResponseT> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.jwt) {
        headers.Authorization = `Bearer ${this.jwt}`;
        headers["X-API-Key"] = this.jwt;
      }
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...request, dry: true }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`1Click HTTP ${res.status}: ${text.slice(0, 200)}`);
      const parsed = OneClickQuoteResponse.parse(JSON.parse(text));
      if (parsed.quoteRequest.dry !== true) throw new Error("1Click echoed a non-dry request; refusing to use it");
      return parsed;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new Error(`1Click timeout after ${this.timeoutMs} ms`, { cause: err });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface RouteCandidate {
  label: string;
  destinationChain: string;
  destinationAsset: string;
  recipient: string;
}

export interface RankedRoute {
  candidate: RouteCandidate;
  result: QuoteResult;
  amountOutUsd: number;
  timeEstimateSec: number;
  /** Net USD out minus a 0.01 USD penalty per 10 s of settlement time. */
  score: number;
}

/** Quotes every candidate (dry) and ranks them by delivered value net of latency. */
export async function rankRoutes(
  client: OneClickClient,
  base: Omit<QuoteParams, "destinationAsset" | "recipient">,
  candidates: RouteCandidate[],
): Promise<RankedRoute[]> {
  const ranked = await Promise.all(
    candidates.map(async (candidate) => {
      const result = await client.quote({ ...base, destinationAsset: candidate.destinationAsset, recipient: candidate.recipient });
      const amountOutUsd = Number(result.response.quote.amountOutUsd);
      const timeEstimateSec = result.response.quote.timeEstimate;
      return { candidate, result, amountOutUsd, timeEstimateSec, score: amountOutUsd - timeEstimateSec * 0.001 };
    }),
  );
  return ranked.sort((a, b) => b.score - a.score);
}

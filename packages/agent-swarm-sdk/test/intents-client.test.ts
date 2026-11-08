import { describe, expect, it } from "vitest";

import { ASSETS, OneClickClient, offlineQuote, quoteHash, rankRoutes, toQuoteBinding, type OneClickQuoteResponseT } from "../src/index.ts";

const NOW = Date.now();

/** A recorded real `POST /v0/quote` (`dry: true`) response for 12 wNEAR → USDC on Base. */
const RECORDED_LIVE = {
  quote: {
    amountIn: "12000000000000000000000000",
    amountInFormatted: "12.0",
    amountInUsd: "56.640000000000",
    minAmountIn: "12000000000000000000000000",
    amountOut: "56432628",
    amountOutFormatted: "56.432628",
    amountOutUsd: "56.404355253372",
    minAmountOut: "56150464",
    timeEstimate: 12,
    refundFee: "0",
    withdrawFee: "2400",
  },
  quoteRequest: {
    dry: true,
    depositMode: "SIMPLE",
    swapType: "EXACT_INPUT",
    slippageTolerance: 50,
    originAsset: "nep141:wrap.near",
    depositType: "INTENTS",
    destinationAsset: ASSETS.USDC_BASE,
    amount: "12000000000000000000000000",
    refundTo: "phalanx-swarm.testnet",
    refundType: "INTENTS",
    recipient: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
    recipientType: "DESTINATION_CHAIN",
    deadline: "2026-10-29T00:59:09.918Z",
    confidentiality: "public",
    referral: "phalanx-swarm",
    quoteWaitingTimeMs: 0,
    insured: false,
    appFees: [{ recipient: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", fee: 20 }],
  },
  signature: "ed25519:3McmNDta9kTnKSSWXKAHZMSviY7j1ArCoFwv1X185Sko3vDWH6H9EyFzoEV9J4GpDJ36Afcb5MfU2uTdxExty2kW",
  timestamp: "2026-10-29T00:29:10.735Z",
  correlationId: "52ef4f28-76d4-4415-8735-ecb0103cef6f",
};

const params = {
  originAsset: ASSETS.WNEAR,
  destinationAsset: ASSETS.USDC_BASE,
  amount: 12n * 10n ** 24n,
  recipient: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
  refundTo: "phalanx-swarm.testnet",
  slippageBps: 50,
};

describe("NEAR Intents 1Click client", () => {
  it("always builds dry-run requests with the documented schema", () => {
    const client = new OneClickClient({ mode: "offline", nowMs: () => NOW });
    const req = client.buildRequest(params);
    expect(req).toMatchObject({ dry: true, swapType: "EXACT_INPUT", depositType: "INTENTS", recipientType: "DESTINATION_CHAIN", refundType: "INTENTS" });
    expect(req.deadline).toBe(new Date(NOW + 30 * 60_000).toISOString());
  });

  it("offline engine is deterministic and internally consistent", () => {
    const client = new OneClickClient({ mode: "offline", nowMs: () => NOW });
    const a = offlineQuote(client.buildRequest(params), NOW);
    const b = offlineQuote(client.buildRequest(params), NOW);
    expect(a).toEqual(b);
    expect(quoteHash(a)).toBe(quoteHash(b));
    const out = BigInt(a.quote.amountOut);
    expect(BigInt(a.quote.minAmountOut)).toBe((out * 9_950n) / 10_000n);
    // Within 1% of the recorded live quote for the same route.
    const live = BigInt(RECORDED_LIVE.quote.amountOut);
    const diff = out > live ? out - live : live - out;
    expect(diff * 100n).toBeLessThan(live);
  });

  it("sends the request to the live endpoint and validates the response", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(RECORDED_LIVE), { status: 201 });
    }) as typeof fetch;
    const client = new OneClickClient({ mode: "live", fetchImpl, jwt: "test-jwt", nowMs: () => NOW });
    const r = await client.quote(params);
    expect(body.dry).toBe(true);
    expect(r.source).toBe("live");
    expect(r.response.correlationId).toBe(RECORDED_LIVE.correlationId);
    const binding = toQuoteBinding(r);
    expect(binding).toMatchObject({ provider: "1click", amount_out: "56432628", min_amount_out: "56150464", dry: true, deposit_address: null });
    expect(binding.expires_at_ns).toBe((BigInt(Date.parse("2026-10-29T00:59:09.918Z")) * 1_000_000n).toString());
  });

  it("auto mode falls back to the offline engine on network errors; live mode fails loudly", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const auto = await new OneClickClient({ mode: "auto", fetchImpl: failing, nowMs: () => NOW }).quote(params);
    expect(auto.source).toBe("offline");
    expect(auto.fallbackReason).toMatch(/fetch failed/);
    await expect(new OneClickClient({ mode: "live", fetchImpl: failing, nowMs: () => NOW }).quote(params)).rejects.toThrow(/fetch failed/);
  });

  it("refuses a response that is not a dry run", async () => {
    const notDry = { ...RECORDED_LIVE, quoteRequest: { ...RECORDED_LIVE.quoteRequest, dry: false } } as OneClickQuoteResponseT;
    const fetchImpl = (async () => new Response(JSON.stringify(notDry), { status: 201 })) as typeof fetch;
    await expect(new OneClickClient({ mode: "live", fetchImpl, nowMs: () => NOW }).quote(params)).rejects.toThrow(/non-dry/);
  });

  it("ranks routes by delivered value net of latency", async () => {
    const client = new OneClickClient({ mode: "offline", nowMs: () => NOW });
    const ranked = await rankRoutes(client, { originAsset: ASSETS.WNEAR, amount: 12n * 10n ** 24n, refundTo: "phalanx-swarm.testnet", slippageBps: 50 }, [
      { label: "eth", destinationChain: "eth", destinationAsset: ASSETS.USDC_ETH, recipient: params.recipient },
      { label: "base", destinationChain: "base", destinationAsset: ASSETS.USDC_BASE, recipient: params.recipient },
    ]);
    expect(ranked.map((r) => r.candidate.label)).toEqual(["base", "eth"]);
  });

  it.runIf(process.env.PHALANX_LIVE_INTENTS === "1")("returns a real dry-run quote from 1click.chaindefuser.com", async () => {
    const r = await new OneClickClient({ mode: "live", timeoutMs: 15_000 }).quote(params);
    expect(r.source).toBe("live");
    expect(r.response.quoteRequest.dry).toBe(true);
    expect(BigInt(r.response.quote.amountOut)).toBeGreaterThan(0n);
  });
});

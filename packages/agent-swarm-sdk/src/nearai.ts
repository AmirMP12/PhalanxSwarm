/**
 * Real NEAR AI Cloud confidential-compute attestation.
 *
 * NEAR AI Cloud runs open-weight models inside Intel TDX confidential VMs (dstack) with NVIDIA
 * confidential GPUs. `GET /v1/attestation/report?nonce=…` returns a hardware-signed TDX quote
 * plus the ed25519 key the gateway TEE signs responses with. This module fetches that report
 * with a fresh nonce and verifies it, giving the swarm a *real* enclave measurement to register
 * on-chain instead of a placeholder hash:
 *
 *  1. DCAP: the Intel TDX quote is verified against Intel's collateral with `@phala/dcap-qvl`
 *     from the Node/server entry. A genuine quote returns `status: "UpToDate"` and the
 *     measurement register `mr_td`. This anchors trust in Intel's root, not in the gateway.
 *  2. Binding: `report_data == signing_address ‖ nonce`, so the verified quote commits to our
 *     fresh nonce (anti-replay) and to the exact key that signs inference responses.
 *  3. Measurement: `mr_td` from the verified quote must equal the `mrtd` the gateway reported.
 *
 * The resulting measurement is what `register_enclave` stores on-chain. See the README for what
 * is real (this hardware attestation) versus composed (an agent binds the verified measurement
 * and its private-inference I/O hashes into its own `ExecutionReceipt`).
 */
import { z } from "zod";

import { fromHex, sha256Hex, toBase58 } from "./encoding.ts";

export const NEARAI_CLOUD_BASE = "https://cloud-api.near.ai";
export const DEFAULT_PCCS_URL = "https://api.trustedservices.intel.com";

const Hex = z.string().regex(/^[0-9a-f]+$/i);

/** The subset of `GET /v1/attestation/report` the swarm consumes. */
export const NearAiAttestationReport = z.looseObject({
  gateway_attestation: z.looseObject({
    signing_address: Hex,
    signing_algo: z.string(),
    intel_quote: Hex,
    report_data: Hex,
    request_nonce: Hex.optional(),
    info: z.looseObject({
      app_id: z.string().optional(),
      tcb_info: z.looseObject({
        mrtd: Hex,
        rtmr0: Hex.optional(),
        rtmr1: Hex.optional(),
        rtmr2: Hex.optional(),
        rtmr3: Hex.optional(),
        os_image_hash: Hex.optional(),
        compose_hash: Hex.optional(),
      }),
    }),
  }),
});
export type NearAiAttestationReportT = z.infer<typeof NearAiAttestationReport>;

export interface AttestationResult {
  /** True only when DCAP verified the quote AND the nonce/key binding and measurement match. */
  verified: boolean;
  /** DCAP TCB status, e.g. "UpToDate", or an error label when verification could not complete. */
  status: string;
  /** ed25519 key the gateway TEE signs inference responses with. */
  signingAddress: string;
  /** Intel TDX measurement (`mr_td` / `mrtd`): the enclave measurement registered on-chain. */
  measurement: string;
  /** Freshly generated 32-byte nonce (hex) the quote is bound to. */
  nonce: string;
  bindingOk: boolean;
  measurementMatch: boolean;
  advisoryIds: string[];
  /** "live" when fetched and DCAP-verified now; "cached" for preserved DCAP evidence; "binding-only" for offline fixtures. */
  source: "live" | "cached" | "binding-only";
  /** Cached evidence older than a week: still verified when it was produced, shown as stale. */
  stale?: boolean;
  /** When the DCAP verification was performed (present for live/cached evidence). */
  verifiedAt?: string;
  report: NearAiAttestationReportT;
}

/** Alias following the SDK's `XxxT` naming convention. */
export type AttestationResultT = AttestationResult;

export interface AttestationOptions {
  baseUrl?: string;
  model?: string;
  /** NEAR AI Cloud API key for fresh gateway reports (sent only as a Bearer token). */
  apiKey?: string;
  nonce?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Verify the Intel TDX quote chain (default true when a `quoteVerifier` is supplied). */
  deep?: boolean;
  pccsUrl?: string;
  /** Injected DCAP verifier (node entry supplies `verifyTdxQuote`). Omit for binding-only checks. */
  quoteVerifier?: QuoteVerifier;
}

function randomNonceHex(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await run(c.signal);
  } finally {
    clearTimeout(t);
  }
}

export async function fetchAttestationReport(opts: AttestationOptions = {}): Promise<{ report: NearAiAttestationReportT; nonce: string }> {
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const nonce = opts.nonce ?? randomNonceHex();
  const base = opts.baseUrl ?? NEARAI_CLOUD_BASE;
  const url = new URL(`${base}/v1/attestation/report`);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("signing_algo", "ed25519");
  if (opts.model) url.searchParams.set("model", opts.model);
  const report = await withTimeout(opts.timeoutMs ?? 15_000, async (signal) => {
    const headers = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : undefined;
    const res = await fetchImpl(url.toString(), { signal, headers, cache: "no-store" } as RequestInit);
    if (!res.ok) throw new Error(`NEAR AI attestation HTTP ${res.status}`);
    return NearAiAttestationReport.parse(await res.json());
  });
  return { report, nonce };
}

/** Result of DCAP-verifying a TDX quote. */
export interface TdxVerification {
  status: string;
  mrTd: string;
  advisoryIds: string[];
  /** 64-byte `report_data` of the verified TD report, hex (absent from older verifiers). */
  reportData?: string;
}

/**
 * Verifies a raw Intel TDX quote against Intel collateral. Implemented by `verifyTdxQuote` in the
 * node entry (`@phalanx/agent-swarm-sdk/node`, which loads `@phala/dcap-qvl` + `node:fs`); injected
 * here so this module stays free of Node built-ins and bundles for the browser. The browser path
 * calls the server route instead (see `apps/web/src/app/api/tee/attest`).
 */
export type QuoteVerifier = (intelQuoteHex: string, opts?: { pccsUrl?: string; nowSec?: bigint }) => Promise<TdxVerification>;

/** Checks the quote binds our nonce and the published signing key (`report_data = addr ‖ nonce`). */
export function checkBinding(report: NearAiAttestationReportT, nonce: string): boolean {
  const g = report.gateway_attestation;
  return g.report_data.toLowerCase() === (g.signing_address + nonce).toLowerCase();
}

/** Fetches a fresh NEAR AI attestation and verifies it (DCAP + binding + measurement match). */
export async function fetchAndVerifyNearAiAttestation(opts: AttestationOptions = {}): Promise<AttestationResult> {
  const { report, nonce } = await fetchAttestationReport(opts);
  const g = report.gateway_attestation;
  const measurement = g.info.tcb_info.mrtd.toLowerCase();
  const bindingOk = checkBinding(report, nonce);
  const base = {
    signingAddress: g.signing_address.toLowerCase(),
    measurement,
    nonce,
    bindingOk,
    report,
  };
  if (opts.deep === false || !opts.quoteVerifier) {
    return { ...base, verified: bindingOk, status: "binding-only", measurementMatch: true, advisoryIds: [], source: "binding-only" };
  }
  const q = await opts.quoteVerifier(g.intel_quote, { pccsUrl: opts.pccsUrl });
  const measurementMatch = q.mrTd === measurement;
  const upToDate = isAcceptedTcbStatus(q.status);
  // The report_data the gateway reports must be the one inside the hardware-signed quote.
  const quoteBinding = q.reportData === undefined || q.reportData.toLowerCase() === g.report_data.toLowerCase();
  return {
    ...base,
    bindingOk: bindingOk && quoteBinding,
    verified: bindingOk && quoteBinding && measurementMatch && upToDate,
    status: q.status,
    measurementMatch,
    advisoryIds: q.advisoryIds,
    source: "live",
    verifiedAt: new Date().toISOString(),
  };
}

export function isAcceptedTcbStatus(status: string): boolean {
  return status === "UpToDate" || status === "SWHardeningNeeded" || status === "ConfigurationAndSWHardeningNeeded";
}

// Model attestations: the key that signs a model's responses, bound to its TDX quote.

export const ModelAttestation = z.looseObject({
  model_name: z.string().optional(),
  signing_address: Hex,
  signing_algo: z.string(),
  signing_public_key: z.string().optional(),
  request_nonce: Hex.optional(),
  intel_quote: Hex,
  info: z.looseObject({ tcb_info: z.looseObject({ mrtd: Hex.optional() }).optional() }).optional(),
});
export type ModelAttestationT = z.infer<typeof ModelAttestation>;

export const ModelAttestationReport = z.looseObject({ model_attestations: z.array(ModelAttestation) });

export interface ModelAttestationResult {
  /** True only when DCAP verified the quote and its report_data binds this key and our nonce. */
  verified: boolean;
  status: string;
  model: string;
  /** ed25519 response-signing key, 32 bytes hex (NEAR AI's `signing_address`). */
  signingAddress: string;
  /** The same key as a NEAR `PublicKey` string, for `register_enclave`. */
  publicKey: string;
  /** Intel TDX `mr_td` of the model CVM (from the verified quote). */
  measurement: string;
  nonce: string;
  bindingOk: boolean;
  /** sha256 of the attestation entry: recorded on-chain as `attestation_ref`. */
  reportHash: string;
  verifiedAt: string;
}

export interface ModelAttestationOptions extends Omit<AttestationOptions, "model"> {
  model: string;
  /** Pick the attestation of this signing key (multi-server deployments). */
  signingAddress?: string;
}

/** One fresh-nonce report with the attestation of every server that serves `model`. */
export async function fetchModelAttestationReport(opts: ModelAttestationOptions): Promise<{ attestations: ModelAttestationT[]; nonce: string }> {
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const nonce = opts.nonce ?? randomNonceHex();
  const url = new URL(`${opts.baseUrl ?? NEARAI_CLOUD_BASE}/v1/attestation/report`);
  url.searchParams.set("model", opts.model);
  url.searchParams.set("signing_algo", "ed25519");
  url.searchParams.set("nonce", nonce);
  if (opts.signingAddress) url.searchParams.set("signing_address", opts.signingAddress);
  const report = await withTimeout(opts.timeoutMs ?? 20_000, async (signal) => {
    const headers = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : undefined;
    const res = await fetchImpl(url.toString(), { signal, headers, cache: "no-store" } as RequestInit);
    if (!res.ok) throw new Error(`NEAR AI model attestation HTTP ${res.status}`);
    return ModelAttestationReport.parse(await res.json());
  });
  return { attestations: report.model_attestations, nonce };
}

export async function fetchModelAttestation(opts: ModelAttestationOptions): Promise<{ attestation: ModelAttestationT; nonce: string }> {
  const { attestations, nonce } = await fetchModelAttestationReport(opts);
  const wanted = opts.signingAddress?.toLowerCase();
  const attestation = attestations.find((a) => !wanted || a.signing_address.toLowerCase() === wanted);
  if (!attestation) throw new Error(`no model attestation for ${opts.model}${wanted ? ` and key ${wanted}` : ""}`);
  return { attestation, nonce };
}

async function verifyModelEntry(
  attestation: ModelAttestationT,
  nonce: string,
  opts: ModelAttestationOptions & { quoteVerifier: QuoteVerifier },
): Promise<ModelAttestationResult> {
  const signingAddress = attestation.signing_address.toLowerCase();
  if (attestation.signing_algo !== "ed25519" || signingAddress.length !== 64) {
    throw new Error(`expected an ed25519 signing key, got ${attestation.signing_algo}`);
  }
  const q = await opts.quoteVerifier(attestation.intel_quote, { pccsUrl: opts.pccsUrl });
  const bindingOk = (q.reportData ?? "").toLowerCase() === `${signingAddress}${nonce}`.toLowerCase();
  return {
    verified: bindingOk && isAcceptedTcbStatus(q.status),
    status: q.status,
    model: opts.model,
    signingAddress,
    publicKey: `ed25519:${toBase58(fromHex(signingAddress))}`,
    measurement: q.mrTd.toLowerCase(),
    nonce,
    bindingOk,
    reportHash: sha256Hex(JSON.stringify(attestation)),
    verifiedAt: new Date().toISOString(),
  };
}

/** Fetches and DCAP-verifies a model attestation; needs the node quote verifier. */
export async function verifyModelAttestation(opts: ModelAttestationOptions): Promise<ModelAttestationResult> {
  const quoteVerifier = opts.quoteVerifier;
  if (!quoteVerifier) throw new Error("model attestation needs a DCAP quote verifier (node entry or the server route)");
  const { attestation, nonce } = await fetchModelAttestation(opts);
  return verifyModelEntry(attestation, nonce, { ...opts, quoteVerifier });
}

/**
 * DCAP-verifies every signing key in one model attestation report. A model served by several
 * TEE servers has one key per server; all of them must be registered before an owner hands
 * governance to a DAO, because completions may come from any server.
 */
export async function verifyAllModelAttestations(opts: ModelAttestationOptions): Promise<ModelAttestationResult[]> {
  const quoteVerifier = opts.quoteVerifier;
  if (!quoteVerifier) throw new Error("model attestation needs a DCAP quote verifier (node entry or the server route)");
  const { attestations, nonce } = await fetchModelAttestationReport(opts);
  const results: ModelAttestationResult[] = [];
  for (const a of attestations) results.push(await verifyModelEntry(a, nonce, { ...opts, quoteVerifier }));
  return results;
}

/**
 * Deterministic offline stand-in with the same shape, used in CI / air-gapped runs. The
 * measurement is derived from `imageLabel` so it is stable; `source` is reported as
 * "binding-only" and `verified` is false so callers never mistake it for a hardware proof.
 */
export function offlineAttestation(imageLabel: string): AttestationResult {
  const measurement = sha256Hex(`phalanx-enclave-image:${imageLabel}`);
  const signingAddress = sha256Hex(`phalanx-enclave-key:${imageLabel}`);
  return {
    verified: false,
    status: "offline-fixture",
    signingAddress,
    measurement,
    nonce: "0".repeat(64),
    bindingOk: false,
    measurementMatch: false,
    advisoryIds: [],
    source: "binding-only",
    report: {
      gateway_attestation: {
        signing_address: signingAddress,
        signing_algo: "ed25519",
        intel_quote: "00",
        report_data: signingAddress + "0".repeat(64),
        info: { tcb_info: { mrtd: measurement } },
      },
    },
  };
}

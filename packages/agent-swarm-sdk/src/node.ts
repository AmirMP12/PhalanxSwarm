/** Node-only helpers (kept out of the browser bundle). */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getCollateral, PHALA_PCCS_URL, verify } from "@phala/dcap-qvl";

import { DEFAULT_NEARAI_MODEL } from "./nearai-inference.ts";
import {
  DEFAULT_PCCS_URL,
  fetchAndVerifyNearAiAttestation,
  verifyAllModelAttestations,
  verifyModelAttestation,
  type AttestationOptions,
  type AttestationResult,
  type ModelAttestationOptions,
  type ModelAttestationResult,
  type TdxVerification,
} from "./nearai.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path of `artifacts/phalanx_core.wasm` at the repository root. */
export const WASM_PATH = resolve(here, "../../../artifacts/phalanx_core.wasm");
/** Repository-root `.env` (optional; see `.env.example`). */
export const ROOT_ENV_PATH = resolve(here, "../../../.env");

/** Loads the repo-root `.env` if present. Variables already set in the environment win. */
export function loadRootEnv(path = ROOT_ENV_PATH): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}

/** Live agent model settings: NEAR AI Cloud (TEE-signed) when NEARAI_API_KEY is set, else an OpenAI-compatible API. */
export interface LiveModelEnv {
  nearAiApiKey?: string;
  nearAiModel: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel: string;
}

export function liveModelFromEnv(env: NodeJS.ProcessEnv = process.env): LiveModelEnv {
  const gemini = env.GEMINI_API_KEY || undefined;
  const openAi = env.OPENAI_API_KEY || undefined;
  return {
    nearAiApiKey: env.NEARAI_API_KEY || undefined,
    nearAiModel: env.NEARAI_MODEL || DEFAULT_NEARAI_MODEL,
    llmApiKey: env.LLM_API_KEY || gemini || openAi,
    llmBaseUrl: env.LLM_BASE_URL || (gemini ? "https://generativelanguage.googleapis.com/v1beta/openai" : openAi ? "https://api.openai.com/v1" : undefined),
    llmModel: env.LLM_MODEL || (gemini ? env.GEMINI_MODEL || "gemini-2.5-flash" : openAi ? env.OPENAI_MODEL || "gpt-4o-mini" : "gpt-4o-mini"),
  };
}

export function loadContractWasm(path = process.env.PHALANX_WASM_PATH ?? WASM_PATH): Uint8Array {
  if (!existsSync(path)) {
    throw new Error(`${path} not found. Build it with \`pnpm build:contract\` (bash scripts/build-contract.sh).`);
  }
  return new Uint8Array(readFileSync(path));
}

/**
 * Where DCAP collateral (TCB info, QE identity, CRLs) is fetched from, in order. Collateral is
 * signed by Intel and dcap-qvl verifies it up to Intel's root CA, so a caching PCCS can only
 * withhold it, not forge it. Phala's public PCCS cache answers in 2-5 s; Intel's PCS is the
 * fallback. Override with PHALANX_PCCS_URLS (comma-separated).
 */
export const PCCS_URLS = (process.env.PHALANX_PCCS_URLS ?? `${PHALA_PCCS_URL},${DEFAULT_PCCS_URL}`)
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const COLLATERAL_TIMEOUT_MS = 12_000;

function withDeadline<T>(ms: number, label: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no answer within ${ms} ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/**
 * DCAP-verifies a raw Intel TDX quote against Intel's trust chain. With `pccsUrl` only that
 * collateral source is used; otherwise each of `PCCS_URLS` is tried in turn.
 */
export async function verifyTdxQuote(intelQuoteHex: string, opts: { pccsUrl?: string; nowSec?: bigint } = {}): Promise<TdxVerification> {
  const quote = Uint8Array.from(Buffer.from(intelQuoteHex, "hex"));
  const sources = opts.pccsUrl ? [opts.pccsUrl] : PCCS_URLS;
  let collateral: Awaited<ReturnType<typeof getCollateral>> | null = null;
  const errors: string[] = [];
  for (const url of sources) {
    try {
      collateral = await withDeadline(COLLATERAL_TIMEOUT_MS, `collateral from ${url}`, getCollateral(url, quote));
      break;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (!collateral) throw new Error(`DCAP collateral unavailable: ${errors.join("; ")}`);
  const nowSec = Number(opts.nowSec ?? BigInt(Math.floor(Date.now() / 1000)));
  const out = verify(quote, collateral, nowSec);
  const td = out.report.asTd10();
  if (!td) throw new Error("Expected an Intel TDX quote");
  return {
    status: out.status,
    mrTd: Buffer.from(td.mrTd).toString("hex"),
    advisoryIds: out.advisory_ids,
    reportData: Buffer.from(td.reportData).toString("hex"),
  };
}

/**
 * Fetches and fully verifies a real NEAR AI Cloud gateway attestation (DCAP + binding),
 * Node-side. The attestation endpoint answers without an API key; a key is sent when set.
 */
export function verifyNearAiAttestationNode(opts: AttestationOptions = {}): Promise<AttestationResult> {
  return fetchAndVerifyNearAiAttestation({ ...opts, apiKey: opts.apiKey ?? process.env.NEARAI_API_KEY, quoteVerifier: verifyTdxQuote });
}

/** DCAP-verifies the attestation of a NEAR AI model's response-signing key, Node-side. */
export function verifyNearAiModelNode(opts: ModelAttestationOptions): Promise<ModelAttestationResult> {
  return verifyModelAttestation({ ...opts, apiKey: opts.apiKey ?? process.env.NEARAI_API_KEY, quoteVerifier: verifyTdxQuote });
}

/** DCAP-verifies every server key of a NEAR AI model from one report, Node-side. */
export function verifyNearAiModelKeysNode(opts: ModelAttestationOptions): Promise<ModelAttestationResult[]> {
  return verifyAllModelAttestations({ ...opts, apiKey: opts.apiKey ?? process.env.NEARAI_API_KEY, quoteVerifier: verifyTdxQuote });
}

/** Shape of `artifacts/nearai-attestation.json` (written by `pnpm verify:tee`). */
export interface SavedNearAiEvidence {
  verified: boolean;
  status: string;
  nonce_bound: boolean;
  measurement_match: boolean;
  measurement_mr_td: string;
  gateway_signing_address: string;
  nonce: string;
  advisory_ids: string[];
  timestamp: string;
}

/**
 * Turns saved, previously DCAP-verified gateway evidence into an `AttestationResult` labeled
 * `cached`. Evidence older than `staleAfterMs` is still returned, flagged `stale`, so callers
 * can label it instead of failing; unverified evidence is never returned.
 */
export function cachedNearAiEvidence(saved: SavedNearAiEvidence, nowMs = Date.now(), staleAfterMs = 30 * 24 * 60 * 60 * 1000): AttestationResult | null {
  const age = nowMs - Date.parse(saved.timestamp);
  if (!saved.verified || !saved.nonce_bound || !saved.measurement_match || !Number.isFinite(age) || age < 0) return null;
  return {
    verified: true,
    status: saved.status,
    signingAddress: saved.gateway_signing_address,
    measurement: saved.measurement_mr_td,
    nonce: saved.nonce,
    bindingOk: true,
    measurementMatch: true,
    advisoryIds: saved.advisory_ids,
    source: "cached",
    stale: age > staleAfterMs,
    verifiedAt: saved.timestamp,
    report: {
      gateway_attestation: {
        signing_address: saved.gateway_signing_address,
        signing_algo: "ed25519",
        intel_quote: "00",
        report_data: saved.gateway_signing_address + saved.nonce,
        request_nonce: saved.nonce,
        info: { tcb_info: { mrtd: saved.measurement_mr_td } },
      },
    },
  };
}

export function loadCachedNearAiEvidence(path: string, nowMs = Date.now(), staleAfterMs?: number): AttestationResult | null {
  if (!existsSync(path)) return null;
  try {
    return cachedNearAiEvidence(JSON.parse(readFileSync(path, "utf8")) as SavedNearAiEvidence, nowMs, staleAfterMs);
  } catch {
    return null;
  }
}

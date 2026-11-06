/**
 * `pnpm judge` — runs the full judge scenario against artifacts/aegis_core.wasm and prints a
 * step-by-step report. Exit code 0 only when every assertion passes.
 *
 *   pnpm judge                          # live 1Click dry quotes, fresh NEAR AI gateway attestation (no key needed);
 *                                       # agents run on NEAR AI Cloud when NEARAI_API_KEY is set, else on the labeled stand-in
 *   NEARAI_API_KEY=… pnpm judge --live  # require live quotes and TEE-signed NEAR AI inference for every agent decision
 *   pnpm judge --offline                # fully deterministic, no network
 *   pnpm judge --attack                 # security hero only: boot → spawn → invoice-fraud kill
 *   pnpm judge --json                   # machine-readable report on stdout
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sha256Hex } from "./encoding.ts";
import { liveModelFromEnv, loadCachedNearAiEvidence, loadContractWasm, loadRootEnv, verifyNearAiModelNode, verifyTdxQuote, WASM_PATH } from "./node.ts";
import type { IntentsMode } from "./intents-client.ts";
import type { AttestationResult } from "./nearai.ts";
import { JUDGE_STEPS, runJudgeScenario, type StepReport } from "./judge-scenario.ts";

loadRootEnv();
const args = new Set(process.argv.slice(2));
const envMode = process.env.AEGIS_INTENTS_MODE as IntentsMode | undefined;
const mode: IntentsMode = args.has("--offline") ? "offline" : args.has("--live") ? "live" : (envMode ?? "auto");
const focus = args.has("--attack") ? ("attack" as const) : ("full" as const);
const { nearAiApiKey: apiKey, nearAiModel: model, llmApiKey: genericKey, llmBaseUrl: genericBaseUrl, llmModel: genericModel } = liveModelFromEnv();

if (args.has("--live") && !apiKey && !genericKey) {
  throw new Error("--live runs agents on live models: set NEARAI_API_KEY (NEAR AI Cloud TEE), GEMINI_API_KEY (Google Gemini), or OPENAI_API_KEY (OpenAI)");
}
const teeMode = mode === "offline" ? "offline" : "auto";
const json = args.has("--json");

const color = (code: number) => (s: string) => (process.stdout.isTTY && !json ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = color(32);
const red = color(31);
const dim = color(2);
const bold = color(1);
const cyan = color(36);

function printStep(step: StepReport): void {
  const mark = step.passed ? green("PASS") : red("FAIL");
  const total = focus === "attack" ? 3 : JUDGE_STEPS.length;
  console.log(`\n${bold(`[${step.index}/${total}] ${step.title}`)}  ${mark} ${dim(`${step.durationMs} ms`)}`);
  for (const line of step.narrative) console.log(`  ${cyan("›")} ${line}`);
  for (const tx of step.txs) {
    const status = tx.ok ? green("ok") : red(`rejected: ${tx.error}`);
    console.log(`  ${dim("tx")} ${tx.label} ${dim(`${tx.signer} → ${tx.method}`)} ${status}`);
    if (tx.events.length) console.log(`     ${dim("events:")} ${tx.events.join(", ")}`);
    for (const r of tx.receipts.slice(1))
      console.log(`     ${dim("receipt")} ${r.receiver}: ${r.actions} ${r.status === "success" ? dim("✓") : red(r.status)}`);
  }
  for (const a of step.assertions) {
    console.log(`  ${a.passed ? green("✔") : red("✘")} ${a.label}${a.detail ? dim(`  (${a.detail})`) : ""}`);
  }
}

/** Whether this WASM is what the recorded testnet deployment runs (`pnpm verify:live` re-checks it on-chain). */
function testnetMatch(wasm: Uint8Array): string {
  const path = resolve(WASM_PATH, "../testnet-swarm.json");
  if (!existsSync(path)) return "no testnet deployment recorded for this WASM";
  const rec = JSON.parse(readFileSync(path, "utf8")) as { contract_id?: string; wasm_sha256?: string };
  return rec.wasm_sha256 === sha256Hex(wasm)
    ? `same WASM as testnet ${rec.contract_id ?? "deployment"}`
    : `differs from the recorded testnet deployment ${rec.contract_id ?? ""}`.trim();
}

/** Fresh keyless gateway attestation; preserved evidence (labeled) only if NEAR AI is unreachable. */
async function gatewayFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

async function main(): Promise<void> {
  const wasm = loadContractWasm();
  if (!json) {
    console.log(bold(focus === "attack" ? "PhalanxSwarm judge · security hero (invoice fraud)" : "PhalanxSwarm judge scenario"));
    console.log(
      dim(
        `wasm: artifacts/aegis_core.wasm (${wasm.length} bytes, ${testnetMatch(wasm)}) · runtime: AegisSim local rehearsal · 1Click mode: ${mode} (dry: true)${focus === "attack" ? " · focus: attack" : ""}`,
      ),
    );
    console.log(
      dim(
        mode === "offline"
          ? "agents: deterministic stand-in (offline) · TEE evidence: not fetched"
          : apiKey
            ? `agents: NEAR AI Cloud ${model} (TEE-signed, keys registered after DCAP-verified model attestation)`
            : genericKey
              ? `agents: Live LLM ${genericModel} via ${genericBaseUrl} (real model reasoning, local signing)`
              : "agents: deterministic stand-in (set NEARAI_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY for live models) · gateway attestation: fresh, keyless",
      ),
    );
    console.log(dim("Live money/MPC/TEE proofs: pnpm verify:live (does not require this rehearsal)."));
  }
  const cachedPath = resolve(WASM_PATH, "../nearai-attestation.json");
  const teeFallback = (): AttestationResult | null => loadCachedNearAiEvidence(cachedPath);
  const report = await runJudgeScenario({
    wasm,
    intentsMode: mode,
    focus,
    teeMode,
    teeApiKey: apiKey,
    teeQuoteVerifier: verifyTdxQuote,
    nearAiApiKey: mode === "offline" ? undefined : apiKey,
    nearAiModel: model,
    llmApiKey: mode === "offline" ? undefined : genericKey,
    llmBaseUrl: mode === "offline" ? undefined : genericBaseUrl,
    llmModel: mode === "offline" ? undefined : genericModel,
    modelAttestationVerifier: (signingAddress, m) => verifyNearAiModelNode({ model: m, signingAddress, timeoutMs: 30_000 }),
    oneClickJwt: process.env.ONECLICK_JWT || undefined,
    intentsTimeoutMs: Number(process.env.AEGIS_INTENTS_TIMEOUT_MS ?? 6000),
    quoteEndpoint: process.env.ONECLICK_API_BASE ? `${process.env.ONECLICK_API_BASE}/v0/quote` : undefined,
    fetchImpl: gatewayFetch,
    teeFallback,
    listener: json ? undefined : { onStep: printStep },
  });
  if (json) {
    const { runtime: _runtime, ...serializable } = report;
    console.log(JSON.stringify(serializable, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  } else {
    console.log(
      `\n${report.passed ? green(bold("ALL CHECKS PASSED")) : red(bold("CHECKS FAILED"))}: ${report.assertionCount - report.failedAssertions.length}/${report.assertionCount} assertions · agents: ${report.inference} · quotes: ${report.quoteSources.join("+") || "n/a"} · wasm sha256 ${report.wasmSha256} · ${report.durationMs} ms`,
    );
    for (const f of report.failedAssertions) console.log(red(`  ✘ [${f.step}] ${f.label}${f.detail ? ` (${f.detail})` : ""}`));
  }
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

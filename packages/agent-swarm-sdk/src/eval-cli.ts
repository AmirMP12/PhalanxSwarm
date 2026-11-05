/**
 * `pnpm eval:injection` — the indirect prompt-injection evaluation (see injection-eval.ts).
 *
 *   pnpm eval:injection                 # offline stand-in: measures the contract only (no network, no credits)
 *   pnpm eval:injection --live          # Mallory's model is live: NEARAI_API_KEY, else GEMINI_API_KEY / OPENAI_API_KEY.
 *                                       # About 48 chat completions (draft and critique for 24 invoices).
 *   pnpm eval:injection --only INV-2291:footer_note,INV-3307:pay_link
 *   pnpm eval:injection --json          # print the report on stdout
 *
 * Writes artifacts/injection-eval.json. Exit code 1 if a payment to the attacker was not stopped
 * or a variant failed to run.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runInjectionEval, type InjectionVariantResult } from "./injection-eval.ts";
import { liveModelFromEnv, loadContractWasm, loadRootEnv, WASM_PATH } from "./node.ts";

loadRootEnv();
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const live = flag("--live");
const json = flag("--json");
const only = value("--only")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const env = liveModelFromEnv();
if (live && !env.nearAiApiKey && !env.llmApiKey) {
  throw new Error("--live needs NEARAI_API_KEY (NEAR AI Cloud), GEMINI_API_KEY or OPENAI_API_KEY");
}

const log = (line: string) => {
  if (!json) console.log(line);
};

function describe(r: InjectionVariantResult): string {
  const m = r.model;
  const decided =
    m.decision === "error" ? `model error: ${m.error}` : `${m.decision.replace("_", " ")}${m.amount_near !== null ? ` ${m.amount_near} NEAR` : ""}`;
  const c = r.contract;
  const verdict = c ? `${c.status}${c.violations.length ? ` (${c.violations.join(", ")})` : ""}${c.key_deleted ? ", key deleted" : ""}` : "not submitted";
  return `${r.stopped ? "✔" : "✘"} ${r.id.padEnd(30)} model: ${decided}${r.forced ? " → forced" : ""} · contract: ${verdict}`;
}

async function main(): Promise<void> {
  const wasm = loadContractWasm();
  log(
    live
      ? `injection eval · live model: ${env.nearAiApiKey ? `NEAR AI Cloud ${env.nearAiModel}` : `${env.llmModel} via ${env.llmBaseUrl}`}`
      : "injection eval · offline stand-in (measures the contract; pass --live to measure a model)",
  );
  const report = await runInjectionEval({
    wasm,
    // Live agents need a non-offline runtime; `auto` falls back to offline 1Click quotes if needed.
    intentsMode: live ? "auto" : "offline",
    teeMode: "offline",
    nearAiApiKey: live ? env.nearAiApiKey : undefined,
    nearAiModel: env.nearAiModel,
    llmApiKey: live && !env.nearAiApiKey ? env.llmApiKey : undefined,
    llmBaseUrl: live && !env.nearAiApiKey ? env.llmBaseUrl : undefined,
    llmModel: env.llmModel,
    intentsTimeoutMs: Number(process.env.AEGIS_INTENTS_TIMEOUT_MS ?? 6000),
    concurrency: live ? 3 : 4,
    only,
    onResult: (r, done, total) => log(`[${String(done).padStart(2)}/${total}] ${describe(r)}`),
  });
  const out = resolve(WASM_PATH, "../injection-eval.json");
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const m = report.model_results;
    const c = report.contract_results;
    console.log(
      `\nmodel (${report.model.source}${report.model_measured ? "" : ", simulated"}): ${m.paid_attacker} paid the attacker, ${m.held} held, ${m.paid_vendor} paid the vendor, ${m.other} other, ${m.error} errors` +
        (m.fooled_rate === null ? " · fooled rate: not measured" : ` · fooled rate ${(m.fooled_rate * 100).toFixed(1)}%`),
    );
    console.log(
      `contract: ${c.rejected}/${c.submitted} rejected (${c.forced} forced), ${c.quarantined} quarantined, ${c.key_deleted} keys deleted, ${c.funds_moved} moved funds`,
    );
    console.log(report.note);
    console.log(`${report.passed ? "PASS" : "FAIL"} · wrote ${out} · ${report.duration_ms} ms`);
  }
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

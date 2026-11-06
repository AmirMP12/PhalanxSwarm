// Copies the compiled contract and public verification evidence into public/.
// Evidence JSON contains account IDs, transaction hashes, measurements and verdicts only — never keys.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const wasmSrc = resolve(root, "artifacts/aegis_core.wasm");
const wasmDst = resolve(here, "../public/aegis_core.wasm");

if (!existsSync(wasmSrc)) {
  console.error(`[copy-wasm] ${wasmSrc} is missing. Run \`pnpm build:contract\` first.`);
  process.exit(1);
}
mkdirSync(dirname(wasmDst), { recursive: true });
copyFileSync(wasmSrc, wasmDst);
console.log("[copy-wasm] artifacts/aegis_core.wasm -> apps/web/public/aegis_core.wasm");

const EVIDENCE = [
  "reproducible-build.json",
  "testnet-swarm.json",
  "testnet-smoke.json",
  "wallet-smoke.json",
  "nearai-attestation.json",
  "live-verification.json",
  "injection-eval.json",
  "market-sim.json",
];
const evidenceDir = resolve(here, "../public/evidence");
mkdirSync(evidenceDir, { recursive: true });
// public/evidence/ is generated (gitignored): drop copies whose source is gone or no longer published.
for (const name of readdirSync(evidenceDir)) {
  if (name === "index.json") continue;
  if (!EVIDENCE.includes(name) || !existsSync(resolve(root, "artifacts", name))) rmSync(resolve(evidenceDir, name), { force: true });
}
const copied = [];
for (const name of EVIDENCE) {
  const src = resolve(root, "artifacts", name);
  if (!existsSync(src)) continue;
  copyFileSync(src, resolve(evidenceDir, name));
  copied.push(name);
}
// The UI reads this list so it never requests evidence that was not produced.
writeFileSync(resolve(evidenceDir, "index.json"), `${JSON.stringify({ files: copied }, null, 2)}\n`);
console.log(`[copy-wasm] evidence copied to apps/web/public/evidence/: ${copied.join(", ") || "none"}`);

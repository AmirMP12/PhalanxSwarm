/** End-to-end: the full judge scenario against the compiled WASM, offline and deterministic. */
import { describe, expect, it } from "vitest";

import { runJudgeScenario } from "../src/index.ts";
import { loadContractWasm } from "../src/node.ts";

describe("judge scenario (offline, deterministic)", () => {
  it("passes every assertion across all 11 steps", async () => {
    const report = await runJudgeScenario({ wasm: loadContractWasm(), intentsMode: "offline" });
    const failures = report.failedAssertions.map((f) => `[${f.step}] ${f.label} ${f.detail ?? ""}`);
    expect(failures).toEqual([]);
    expect(report.steps.map((s) => s.id)).toEqual([
      "boot",
      "spawn",
      "attack",
      "plan",
      "auction",
      "execute",
      "intent",
      "recipients",
      "forgery",
      "revenue",
      "verify",
    ]);
    expect(report.assertionCount).toBeGreaterThan(50);
    expect(report.quoteSources).toEqual(["offline"]);
    expect(report.inference).toBe("standin");
  });

  it("attack focus runs only the security-hero path (boot → spawn → attack)", async () => {
    const report = await runJudgeScenario({ wasm: loadContractWasm(), intentsMode: "offline", focus: "attack" });
    expect(report.failedAssertions).toEqual([]);
    expect(report.steps.map((s) => s.id)).toEqual(["boot", "spawn", "attack"]);
    expect(report.steps.find((s) => s.id === "attack")?.passed).toBe(true);
  });

  it("is reproducible: two offline runs from the same genesis produce identical on-chain state", async () => {
    const wasm = loadContractWasm();
    const genesisMs = Math.floor(Date.now() / 1000) * 1000;
    const [a, b] = await Promise.all([
      runJudgeScenario({ wasm, intentsMode: "offline", genesisMs }),
      runJudgeScenario({ wasm, intentsMode: "offline", genesisMs }),
    ]);
    const [da, db] = await Promise.all([a.runtime.dashboard(), b.runtime.dashboard()]);
    expect(da).toEqual(db);
    expect(da.intents.map((i) => i.nep413_hash)).toEqual(db.intents.map((i) => i.nep413_hash));
  });
});

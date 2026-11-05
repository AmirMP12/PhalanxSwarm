/**
 * `pnpm market` — the 20-bidder swarm market simulation on the compiled contract (see market-sim.ts).
 *
 *   pnpm market                     # 12 rounds, seed 7
 *   pnpm market --rounds 20 --seed 3
 *   pnpm market --json              # print the report on stdout
 *
 * Offline and deterministic for a seed. Writes artifacts/market-sim.json. Exit code 1 if the
 * treasury paid for work that was not delivered.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runMarketSim, type MarketRound } from "./market-sim.ts";
import { loadContractWasm, WASM_PATH } from "./node.ts";

const argv = process.argv.slice(2);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const json = argv.includes("--json");
const rounds = Number(value("--rounds") ?? 12);
const seed = Number(value("--seed") ?? 7);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 60) throw new Error("--rounds must be an integer in 1..=60");
if (!Number.isInteger(seed) || seed < 0) throw new Error("--seed must be a non-negative integer");

function line(r: MarketRound): string {
  const outcome = !r.winner
    ? "no eligible bid"
    : `${r.winner} (${r.winner_strategy}) at ${r.clearing_price_near} NEAR, score ${r.winning_score_bps} → ${r.delivered ? `delivered, paid ${r.paid_near}` : `did not deliver, ${r.refunded_near} NEAR refunded`}`;
  const turnedAway = [
    r.auction_full ? `${r.auction_full} full` : "",
    r.below_reputation_floor ? `${r.below_reputation_floor} below floor` : "",
    r.waited_for_reveal_deadline ? "no-show: closed at reveal deadline" : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `round ${String(r.round).padStart(2)} · ${r.commits} sealed bids, ${r.revealed} revealed${turnedAway ? ` (${turnedAway})` : ""} · ${outcome}`;
}

async function main(): Promise<void> {
  const report = await runMarketSim({ wasm: loadContractWasm(), rounds, seed, onRound: json ? undefined : (r) => console.log(line(r)) });
  const out = resolve(WASM_PATH, "../market-sim.json");
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const s = report.summary;
    const wins = Object.entries(s.wins)
      .sort((a, b) => b[1] - a[1])
      .map(([h, n]) => `${h}×${n}`)
      .join(", ");
    console.log(
      `\nclearing price (delivered rounds): ${s.clearing_price_near ? `min ${s.clearing_price_near.min}, median ${s.clearing_price_near.median}, max ${s.clearing_price_near.max} NEAR` : "n/a"} · ceiling ${report.results[0]?.ceiling_near} NEAR`,
    );
    console.log(`wins: ${wins || "none"}`);
    console.log(report.note);
    console.log(`paid for undelivered work: ${s.paid_for_undelivered_near} NEAR · wrote ${out} · ${report.duration_ms} ms`);
  }
  process.exitCode = report.summary.paid_for_undelivered_near === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

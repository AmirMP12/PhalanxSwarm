/**
 * Swarm market simulation (`pnpm market`): 20 scripted worker agents compete for procurement tasks
 * in sealed-bid auctions on the compiled contract (AegisSim), round after round.
 *
 * Every rule the report shows is the contract's, not this script's:
 * - an auction takes at most 16 sealed bids (`max_bidders`); later commits fail (AEGIS_E_AUCTION_FULL);
 * - the RFP's reputation floor (40% here) keeps agents below it out (AEGIS_E_REPUTATION_BELOW_SCHEMA);
 * - the best score wins: price 50%, promised latency 20%, reputation 30%;
 * - escrow is paid only for a signed completion that verifies; a winner that misses its deadline is
 *   failed by anyone (`expire_task`), the escrow returns to the treasury, and the winner loses 5%
 *   reputation; a verified delivery earns 2.5%;
 * - a bidder that commits and never reveals cannot block the auction: anyone closes it after the
 *   reveal deadline.
 *
 * The bidders' strategies are scripted and their completions come from the offline stand-in, so a
 * run is deterministic for a seed. It measures the market rules, not model reasoning.
 */
import { promptHash, think } from "./agent-brains.ts";
import { canonicalJson, deterministicBytes, formatNear, keyPairFromSeed, ONE_NEAR, sha256Hex, toHex, type Ed25519KeyPair } from "./encoding.ts";
import type { Signer } from "./contract-client.ts";
import { bindingMarkerFor, type ProofBinding } from "./nearai-inference.ts";
import { bidCommitment } from "./protocol.ts";
import { ACCOUNTS, planProcurement, SwarmRuntime, type ProcurementSpec, type RuntimeOptions } from "./swarm-orchestrator.ts";
import { AgentBid, AgentRecord, TaskExecutionOutcome, TaskPostOutcome, TaskRfp, type TaskRfpInputT, type TaskRfpT } from "./types.ts";

export const MARKET_SIM_SCHEMA = "aegis.market-sim.v1";

/**
 * - `cost_plus`: bids its cost plus its margin and always delivers.
 * - `undercutter`: bids half its cost to win, then abandons the task (griefing).
 * - `flaky`: bids cost plus 10% and delivers about half the time.
 * - `no_show`: commits a sealed bid and never reveals it.
 * - `newcomer`: an unvetted agent the DAO registered below the RFP's reputation floor.
 */
export type BidderStrategy = "cost_plus" | "undercutter" | "flaky" | "no_show" | "newcomer";

export interface BidderProfile {
  handle: string;
  strategy: BidderStrategy;
  /** The bidder's private cost of doing one task, in NEAR (varies ±8% per round). */
  costNear: number;
  marginBps: number;
  latencySec: number;
  initialReputationBps: number;
}

export interface MarketBidRecord {
  handle: string;
  strategy: BidderStrategy;
  /** `committed`, or why the commit failed (`auction_full`, `reputation_below_floor`, `price_above_ceiling`, …). */
  commit: string;
  price_near: number | null;
  revealed: boolean;
  score_bps: number | null;
}

export interface MarketRound {
  round: number;
  task_id: string;
  ceiling_near: number;
  commits: number;
  auction_full: number;
  below_reputation_floor: number;
  revealed: number;
  /** A committed bid was never revealed, so the auction closed only after the reveal deadline. */
  waited_for_reveal_deadline: boolean;
  winner: string | null;
  winner_strategy: BidderStrategy | null;
  clearing_price_near: number | null;
  winning_score_bps: number | null;
  runner_up_price_near: number | null;
  delivered: boolean;
  /** Paid to the winner for verified work. */
  paid_near: number;
  /** Escrow returned to the treasury because the winner did not deliver. */
  refunded_near: number;
  winner_reputation_after_bps: number | null;
  bids: MarketBidRecord[];
}

export interface MarketSimReport {
  schema: typeof MARKET_SIM_SCHEMA;
  checked_at: string;
  wasm_sha256: string;
  seed: number;
  rounds: number;
  bidders: number;
  max_bidders_per_auction: number;
  reputation_floor_bps: number;
  summary: {
    delivered_rounds: number;
    failed_rounds: number;
    no_winner_rounds: number;
    paid_near: number;
    refunded_near: number;
    /** NEAR paid for work that was not delivered. The contract makes this zero. */
    paid_for_undelivered_near: number;
    auction_full_rejections: number;
    reputation_floor_rejections: number;
    rounds_delayed_by_no_shows: number;
    clearing_price_near: { min: number; median: number; max: number } | null;
    /** The bidder with the most delivered rounds and its share of them (reputation compounds for the winner). */
    top_winner: { handle: string; wins: number; share: number } | null;
    wins: Record<string, number>;
    failures: Record<string, number>;
    final_reputation_bps: Record<string, number>;
    /** First round from which a vetted bidder could no longer bid: failures took its reputation below the floor. */
    locked_out: Record<string, number>;
  };
  profiles: BidderProfile[];
  results: MarketRound[];
  duration_ms: number;
  note: string;
}

export interface MarketSimOptions extends Pick<RuntimeOptions, "wasm" | "genesisMs"> {
  rounds?: number;
  seed?: number;
  onRound?: (round: MarketRound) => void;
}

const CEILING_NEAR = 8;
const MAX_BIDDERS = 16;
const REPUTATION_FLOOR_BPS = 4_000;
const NS = 1_000_000_000n;
const near = (n: number) => (BigInt(Math.round(n * 1_000)) * ONE_NEAR) / 1_000n;
const toNear = (yocto: bigint | string) => Number(formatNear(BigInt(yocto), 3));

/** mulberry32: a small seeded PRNG, so a seed replays the same market. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The 20 bidders: 14 cost-plus workers, 1 undercutter, 2 flaky workers, 1 no-show, 2 newcomers. */
export function marketProfiles(seed = 7): BidderProfile[] {
  const rand = prng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const round3 = (x: number) => Math.round(x * 1_000) / 1_000;
  const profiles: BidderProfile[] = [];
  const add = (strategy: BidderStrategy, p: Omit<BidderProfile, "handle" | "strategy">) =>
    profiles.push({ handle: `market-w${String(profiles.length + 1).padStart(2, "0")}`, strategy, ...p });
  for (let i = 0; i < 14; i++) {
    add("cost_plus", {
      costNear: round3(3 + rand() * 2),
      marginBps: 500 + Math.round(rand() * 30) * 100,
      latencySec: pick([600, 900, 1_200, 1_800, 2_400, 3_600]),
      initialReputationBps: 5_000,
    });
  }
  add("undercutter", { costNear: 3.5, marginBps: -5_000, latencySec: 600, initialReputationBps: 5_000 });
  for (let i = 0; i < 2; i++) add("flaky", { costNear: round3(3.2 + rand()), marginBps: 1_000, latencySec: 900, initialReputationBps: 5_000 });
  add("no_show", { costNear: 3.4, marginBps: 1_000, latencySec: 900, initialReputationBps: 5_000 });
  for (let i = 0; i < 2; i++) add("newcomer", { costNear: round3(3 + rand()), marginBps: 1_500, latencySec: 1_200, initialReputationBps: 3_000 });
  return profiles;
}

interface Bidder extends BidderProfile {
  accountId: string;
  keyPair: Ed25519KeyPair;
  signer: Signer;
}

function roundSpec(rt: SwarmRuntime, round: number, gpuHours: number): ProcurementSpec {
  const base = rt.procurementSpec(`market round ${round}`);
  return { ...base, objective: `${gpuHours} GPU-hours of TEE-backed inference capacity (market round ${round})`, gpu_hours: gpuHours };
}

function rfpFor(round: number, spec: ProcurementSpec): TaskRfpInputT {
  return {
    title: `Market round ${round}: GPU procurement`,
    category: "procurement",
    spec_hash: sha256Hex(canonicalJson(spec)),
    budget_ceiling: near(CEILING_NEAR).toString(),
    auction: "sealed_bid",
    dutch_start_price: null,
    bidding_window_sec: 120,
    reveal_window_sec: 300,
    execution_window_sec: 3_600,
    deadline_epochs: 2,
    max_bidders: MAX_BIDDERS,
    verification: {
      schema_id: spec.schema,
      schema_hash: sha256Hex(spec.schema),
      min_confidence_bps: 8_000,
      min_reputation_bps: REPUTATION_FLOOR_BPS,
      prompt_hash: promptHash("procurement"),
      input_pinned: true,
    },
  };
}

/**
 * Why a commit failed. The 16th commit moves the task to `revealing`, so a later commit inside the
 * bidding window fails with AEGIS_E_COMMIT_PHASE_CLOSED: here that always means the auction is full.
 */
function commitError(error: string | null): string {
  if (!error) return "failed";
  if (error.includes("AEGIS_E_AUCTION_FULL") || error.includes("AEGIS_E_COMMIT_PHASE_CLOSED")) return "auction_full";
  if (error.includes("AEGIS_E_REPUTATION_BELOW_SCHEMA")) return "reputation_below_floor";
  return /AEGIS_E_[A-Z_]+/.exec(error)?.[0] ?? error.slice(0, 80);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round(((s[m - 1]! + s[m]!) / 2) * 1_000) / 1_000;
};

export async function runMarketSim(opts: MarketSimOptions): Promise<MarketSimReport> {
  const started = Date.now();
  const seed = opts.seed ?? 7;
  const rounds = opts.rounds ?? 12;
  const rand = prng(seed ^ 0x5eed);
  const rt = await SwarmRuntime.boot({ wasm: opts.wasm, intentsMode: "offline", genesisMs: opts.genesisMs });
  const must = <T>(label: string, r: { ok: boolean; error: string | null; value: T | null }): T => {
    if (!r.ok || r.value === null) throw new Error(`${label} failed: ${r.error}`);
    return r.value;
  };
  must("fund_treasury", await rt.fund(200, "market simulation"));
  must("spawn Nexus", await rt.spawn("nexus"));

  const profiles = marketProfiles(seed);
  const bidders: Bidder[] = [];
  for (const p of profiles) {
    const keyPair = keyPairFromSeed(`aegis-market:${seed}:${p.handle}`);
    const accountId = `${p.handle}.${ACCOUNTS.contract}`;
    const subAccount = p.initialReputationBps >= 5_000;
    must(
      `spawn ${p.handle}`,
      await rt.contract.call(
        rt.owner,
        "register_and_spawn_agent",
        {
          agent_handle: p.handle,
          role: "compute_worker",
          public_key: keyPair.publicKeyString,
          allowance_cap: (ONE_NEAR / 4n).toString(),
          spawn_mode: subAccount ? "sub_account" : "contract_key",
          payout_account: subAccount ? ACCOUNTS.operators : null,
          policy: null,
          initial_reputation_bps: p.initialReputationBps,
        },
        AgentRecord,
        { deposit: subAccount ? ONE_NEAR / 2n : 0n },
      ),
    );
    const signer: Signer = subAccount
      ? { accountId, publicKey: keyPair.publicKeyString }
      : { accountId: ACCOUNTS.contract, publicKey: keyPair.publicKeyString };
    bidders.push({ ...p, accountId, keyPair, signer });
  }

  const nexus = rt.agents.nexus;
  const results: MarketRound[] = [];
  const lockedOut: Record<string, number> = {};
  for (let round = 1; round <= rounds; round++) {
    // One round per epoch, so Nexus's per-epoch spending cap never limits the market.
    if (round > 1) rt.vm.advance(Number(rt.vm.epochLengthBlocks));
    const spec = roundSpec(rt, round, 1_600 + Math.round(rand() * 8) * 100);
    const posted = must(`post round ${round}`, await rt.contract.call(nexus.signer, "post_task_rfp", { rfp: rfpFor(round, spec) }, TaskPostOutcome));
    if (!posted.approved || !posted.task) throw new Error(`round ${round} RFP rejected: ${posted.violations.map((v) => v.code).join(", ")}`);
    const task: TaskRfpT = posted.task;
    const taskId = task.task_id;

    // Commit phase: bidders arrive in a random order (Fisher-Yates); the contract admits the first 16.
    const order = [...bidders];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const bids: Array<MarketBidRecord & { bidder: Bidder; price: bigint | null; salt: string }> = [];
    for (const b of order) {
      const cost = b.costNear * (1 + (rand() * 2 - 1) * 0.08);
      const priceNear = Math.round(cost * (1 + b.marginBps / 10_000) * 1_000) / 1_000;
      const record = { handle: b.handle, strategy: b.strategy, bidder: b, price_near: priceNear, revealed: false, score_bps: null, salt: "" };
      if (priceNear > CEILING_NEAR || priceNear <= 0) {
        bids.push({ ...record, commit: "price_above_ceiling", price: null });
        continue;
      }
      const price = near(priceNear);
      const salt = toHex(deterministicBytes(`market-salt:${seed}:${b.handle}:${taskId}`)).slice(0, 32);
      const commitment = bidCommitment(taskId, b.accountId, price, b.latencySec, salt);
      const r = await rt.contract.call(b.signer, "submit_bid", { task_id: taskId, action: { type: "commit", commitment } }, AgentBid);
      bids.push({ ...record, commit: r.ok ? "committed" : commitError(r.error), price, salt });
    }
    // A vetted bidder whose failures took it below the floor can no longer bid.
    for (const b of bidders) {
      if (b.initialReputationBps < REPUTATION_FLOOR_BPS || lockedOut[b.handle]) continue;
      if (bids.some((x) => x.handle === b.handle && x.commit === "reputation_below_floor")) lockedOut[b.handle] = round;
    }

    // Reveal phase.
    rt.vm.advance(Number((BigInt(task.bidding_deadline_ns) - rt.nowNs()) / NS) + 1);
    const committed = bids.filter((x) => x.commit === "committed");
    for (const x of committed) {
      if (x.strategy === "no_show") continue;
      const r = await rt.contract.call(
        x.bidder.signer,
        "submit_bid",
        { task_id: taskId, action: { type: "reveal", price: x.price!.toString(), est_latency_sec: x.bidder.latencySec, salt: x.salt } },
        AgentBid,
      );
      x.revealed = r.ok;
      x.score_bps = r.value?.score_bps ?? null;
    }

    // Close: the poster closes as soon as every bid is revealed; otherwise anyone, after the reveal deadline.
    const waited = committed.some((x) => !x.revealed);
    if (waited) rt.vm.advance(Number((BigInt(task.reveal_deadline_ns) - rt.nowNs()) / NS) + 1);
    const closed = must(`close round ${round}`, await rt.contract.call(waited ? rt.keeper : nexus.signer, "close_auction", { task_id: taskId }, TaskRfp));
    const winner = bidders.find((b) => b.accountId === closed.winner) ?? null;
    const revealedPrices = committed
      .filter((x) => x.revealed && x.handle !== winner?.handle)
      .sort((a, b) => (b.score_bps ?? 0) - (a.score_bps ?? 0))
      .map((x) => x.price_near);

    // Execution: the winner proves the work with a signed completion, or misses its deadline.
    let delivered = false;
    let paid = 0n;
    let refunded = 0n;
    if (winner) {
      const delivers = winner.strategy === "cost_plus" || (winner.strategy === "flaky" && rand() < 0.5);
      if (delivers) {
        const binding: ProofBinding = {
          subjectKind: "task",
          subjectId: taskId,
          agentId: winner.accountId,
          inputHash: closed.spec_hash,
          schemaHash: closed.verification.schema_hash,
          nonce: rt.proofNonce(`market-${taskId}-${winner.handle}`),
          issuedAtNs: rt.nowNs(),
        };
        const plan = planProcurement(spec);
        const thought = await think(rt.backend, "procurement", spec, bindingMarkerFor(binding), () => ({
          verdict: "completed" as const,
          confidence_bps: plan.covered_hours >= spec.gpu_hours ? 9_400 : 6_000,
          allocations: plan.allocations.map((a) => ({ vendor: a.vendor, hours: a.hours })),
          total_usd: plan.total_usd,
          notes: "cheapest TEE vendors in allowed regions under the price cap",
        }));
        const proof = await rt.proofFor(thought.completion, binding);
        const out = must(
          `round ${round} execution`,
          await rt.contract.call(winner.signer, "execute_verified_task", { task_id: taskId, proof }, TaskExecutionOutcome),
        );
        delivered = out.settled;
        paid = BigInt(out.payout);
      }
      if (!delivered) {
        rt.vm.advance(Number((BigInt(closed.execution_deadline_ns) - rt.nowNs()) / NS) + 1);
        const before = BigInt((await rt.contract.treasury()).liquid);
        must(`expire round ${round}`, await rt.contract.call(rt.keeper, "expire_task", { task_id: taskId }, TaskRfp));
        refunded = BigInt((await rt.contract.treasury()).liquid) - before;
      }
    }
    const winnerRecord = winner ? await rt.contract.agent(winner.accountId) : null;
    const result: MarketRound = {
      round,
      task_id: taskId,
      ceiling_near: CEILING_NEAR,
      commits: committed.length,
      auction_full: bids.filter((x) => x.commit === "auction_full").length,
      below_reputation_floor: bids.filter((x) => x.commit === "reputation_below_floor").length,
      revealed: committed.filter((x) => x.revealed).length,
      waited_for_reveal_deadline: waited,
      winner: winner?.handle ?? null,
      winner_strategy: winner?.strategy ?? null,
      clearing_price_near: closed.winning_price ? toNear(closed.winning_price) : null,
      winning_score_bps: closed.winning_score_bps ?? null,
      runner_up_price_near: revealedPrices[0] ?? null,
      delivered,
      paid_near: toNear(paid),
      refunded_near: toNear(refunded),
      winner_reputation_after_bps: winnerRecord?.reputation_bps ?? null,
      bids: bids.map(({ bidder: _b, price: _p, salt: _s, ...rest }) => rest),
    };
    results.push(result);
    opts.onRound?.(result);
  }

  const finalRep: Record<string, number> = {};
  for (const b of bidders) finalRep[b.handle] = (await rt.contract.agent(b.accountId))?.reputation_bps ?? 0;
  const tally = (pick: (r: MarketRound) => boolean) => {
    const out: Record<string, number> = {};
    for (const r of results) if (r.winner && pick(r)) out[r.winner] = (out[r.winner] ?? 0) + 1;
    return out;
  };
  const deliveredRounds = results.filter((r) => r.delivered);
  const prices = deliveredRounds.map((r) => r.clearing_price_near!).filter((p) => p !== null);
  const failedRounds = results.filter((r) => r.winner && !r.delivered);
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 1_000) / 1_000;
  const wins = tally((r) => r.delivered);
  const [topHandle, topWins] = Object.entries(wins).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const summary: MarketSimReport["summary"] = {
    delivered_rounds: deliveredRounds.length,
    failed_rounds: failedRounds.length,
    no_winner_rounds: results.filter((r) => !r.winner).length,
    paid_near: sum(results.map((r) => r.paid_near)),
    refunded_near: sum(results.map((r) => r.refunded_near)),
    paid_for_undelivered_near: sum(failedRounds.map((r) => r.paid_near)),
    auction_full_rejections: sum(results.map((r) => r.auction_full)),
    reputation_floor_rejections: sum(results.map((r) => r.below_reputation_floor)),
    rounds_delayed_by_no_shows: results.filter((r) => r.waited_for_reveal_deadline).length,
    clearing_price_near: prices.length ? { min: Math.min(...prices), median: median(prices), max: Math.max(...prices) } : null,
    top_winner: topHandle ? { handle: topHandle, wins: topWins, share: Math.round((topWins / deliveredRounds.length) * 1_000) / 1_000 } : null,
    wins,
    failures: tally((r) => !r.delivered),
    final_reputation_bps: finalRep,
    locked_out: lockedOut,
  };
  const strategyOf = (handle: string) => bidders.find((b) => b.handle === handle)?.strategy ?? "cost_plus";
  const lockouts = Object.entries(lockedOut).map(([h, r]) => `${h} (${strategyOf(h)}) from round ${r}`);
  const note =
    `${rounds} sealed-bid rounds among ${bidders.length} bidders (at most ${MAX_BIDDERS} admitted per auction, reputation floor ${REPUTATION_FLOOR_BPS / 100}%). ` +
    `${summary.delivered_rounds} rounds delivered verified work for ${summary.paid_near} NEAR; in ${summary.failed_rounds} the winner did not deliver and ${summary.refunded_near} NEAR of escrow went back to the treasury. ` +
    (lockouts.length ? `Failures took ${lockouts.join(", ")} below the floor, so it could no longer bid. ` : "") +
    `No-show bids delayed ${summary.rounds_delayed_by_no_shows} closes to the reveal deadline but never blocked one. ` +
    (summary.top_winner
      ? `${summary.top_winner.handle} won ${summary.top_winner.wins} of ${deliveredRounds.length} delivered rounds: reputation is 30% of the score and every verified delivery adds 2.5%, so the incumbent's lead grows.`
      : "");
  return {
    schema: MARKET_SIM_SCHEMA,
    checked_at: new Date().toISOString(),
    wasm_sha256: rt.wasmSha256,
    seed,
    rounds,
    bidders: bidders.length,
    max_bidders_per_auction: MAX_BIDDERS,
    reputation_floor_bps: REPUTATION_FLOOR_BPS,
    summary,
    profiles,
    results,
    duration_ms: Date.now() - started,
    note,
  };
}

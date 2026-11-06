"use client";

import { runMarketSim, type BidderStrategy, type MarketSimReport } from "@aegis/agent-swarm-sdk";
import { Ban, Play, Scale, Trophy } from "lucide-react";
import { useEffect, useState } from "react";

import { loadEvidence } from "@/lib/evidence";

import { Badge, Button, Callout, Card, CardHeader, KV, SkeletonBlock, Spinner, cx, type Tone } from "./ui";

const STRATEGY: Record<BidderStrategy, { label: string; tone: Tone; hint: string }> = {
  cost_plus: { label: "cost plus", tone: "emerald", hint: "bids its cost plus a margin and delivers" },
  undercutter: { label: "undercutter", tone: "red", hint: "bids half its cost to win, then abandons the task" },
  flaky: { label: "flaky", tone: "amber", hint: "delivers about half the time" },
  no_show: { label: "no-show", tone: "violet", hint: "commits a sealed bid and never reveals it" },
  newcomer: { label: "newcomer", tone: "slate", hint: "registered below the reputation floor" },
};

/**
 * `pnpm market`: 20 scripted bidders against the compiled contract. Shows the recorded run
 * (artifacts/market-sim.json) and can replay it, or another seed, in this tab.
 */
export function MarketSimulation() {
  const [report, setReport] = useState<MarketSimReport | null>(null);
  const [source, setSource] = useState<"recorded" | "this tab" | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seed, setSeed] = useState(7);

  useEffect(() => {
    let cancelled = false;
    void loadEvidence<MarketSimReport>("market-sim.json").then((r) => {
      if (!cancelled && r) {
        setReport((cur) => cur ?? r);
        setSource((cur) => cur ?? "recorded");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const rerun = async (nextSeed: number) => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/aegis_core.wasm");
      if (!res.ok) throw new Error(`GET /aegis_core.wasm → HTTP ${res.status}`);
      const wasm = new Uint8Array(await res.arrayBuffer());
      setReport(await runMarketSim({ wasm, seed: nextSeed, rounds: 12 }));
      setSource("this tab");
      setSeed(nextSeed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const s = report?.summary;
  return (
    <Card className="p-4 sm:p-5">
      <CardHeader
        icon={Scale}
        eyebrow="pnpm market · 20 bidders, at most 16 per auction"
        title="Market simulation"
        description="Twenty scripted worker agents bid for twelve procurement tasks on the compiled contract. The rules are the contract's: 16 sealed bids per auction, a 40% reputation floor, score = price 50% + latency 20% + reputation 30%, escrow paid only for verified work, −5% reputation for a missed deadline."
        actions={
          <>
            {source && <Badge tone={source === "recorded" ? "slate" : "sky"}>{source === "recorded" ? "recorded run" : `this tab · seed ${seed}`}</Badge>}
            <Button size="sm" icon={Play} loading={running} onClick={() => void rerun(source === "this tab" ? seed + 1 : seed)}>
              {source === "this tab" ? "Run another seed" : "Re-run in this tab"}
            </Button>
          </>
        }
      />
      {error && (
        <Callout tone="red" icon={Ban} className="mt-3">
          <span className="num">{error}</span>
        </Callout>
      )}
      {!report || !s ? (
        <div className="mt-4">{running ? <Spinner /> : <SkeletonBlock rows={4} />}</div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          <div className="space-y-3">
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-1">
              <KV k="Rounds delivered" v={`${s.delivered_rounds} of ${report.rounds} · ${s.paid_near} NEAR paid`} />
              <KV k="Winner did not deliver" v={`${s.failed_rounds} · ${s.refunded_near} NEAR escrow refunded`} />
              <KV
                k="Paid for undelivered work"
                v={<span className={s.paid_for_undelivered_near === 0 ? "text-emerald-300" : "text-red-300"}>{s.paid_for_undelivered_near} NEAR</span>}
              />
              <KV
                k="Clearing price"
                v={
                  s.clearing_price_near ? `median ${s.clearing_price_near.median} (${s.clearing_price_near.min}–${s.clearing_price_near.max}) of 8 NEAR` : "n/a"
                }
              />
              <KV k="Turned away" v={`${s.auction_full_rejections} auction full · ${s.reputation_floor_rejections} below the floor`} />
              <KV k="No-show delays" v={`${s.rounds_delayed_by_no_shows} closes waited for the reveal deadline`} />
              {s.top_winner && <KV k="Top winner" v={`${s.top_winner.handle} · ${Math.round(s.top_winner.share * 100)}% of delivered rounds`} />}
            </div>
            <p className="text-[12px] leading-relaxed text-slate-400">{report.note}</p>
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              {(Object.keys(STRATEGY) as BidderStrategy[]).map((k) => (
                <Badge key={k} tone={STRATEGY[k].tone}>
                  {report.profiles.filter((p) => p.strategy === k).length}× {STRATEGY[k].label}: {STRATEGY[k].hint}
                </Badge>
              ))}
            </div>
          </div>
          <div className="min-w-0 overflow-x-auto rounded-xl border border-white/[0.06]">
            <table className="w-full min-w-[520px] text-left text-[12px]">
              <thead className="bg-white/[0.03] text-[10.5px] uppercase tracking-[0.12em] text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Round</th>
                  <th className="px-3 py-2 font-medium">Bids</th>
                  <th className="px-3 py-2 font-medium">Winner</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-3 py-2 text-right font-medium">Score</th>
                  <th className="px-3 py-2 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {report.results.map((r) => (
                  <tr key={r.round} className="border-t border-white/[0.05]">
                    <td className="num px-3 py-1.5 text-slate-400">{r.round}</td>
                    <td className="num px-3 py-1.5 text-slate-300">
                      {r.revealed}/{r.commits}
                      {r.waited_for_reveal_deadline && <span className="text-violet-300"> · no-show</span>}
                    </td>
                    <td className="px-3 py-1.5">
                      {r.winner ? (
                        <span className="flex items-center gap-1.5">
                          {r.winner === s.top_winner?.handle && <Trophy className="size-3 text-amber-200" aria-hidden />}
                          <span className="num text-slate-200">{r.winner}</span>
                          {r.winner_strategy && <Badge tone={STRATEGY[r.winner_strategy].tone}>{STRATEGY[r.winner_strategy].label}</Badge>}
                        </span>
                      ) : (
                        <span className="text-slate-500">none</span>
                      )}
                    </td>
                    <td className="num px-3 py-1.5 text-right text-slate-200">{r.clearing_price_near ?? "—"}</td>
                    <td className="num px-3 py-1.5 text-right text-slate-400">{r.winning_score_bps ?? "—"}</td>
                    <td className={cx("px-3 py-1.5", r.delivered ? "text-emerald-300" : "text-red-300")}>
                      {r.delivered ? `paid ${r.paid_near}` : r.winner ? `refunded ${r.refunded_near}` : "expired"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

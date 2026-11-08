"use client";

import { Gavel, Inbox, Lock, LockOpen, ReceiptText, Store, TrendingDown, Trophy } from "lucide-react";

import { usePhalanx } from "@/lib/phalanx-context";

import { Badge, Card, CardHeader, EmptyState, PersonaAvatar, SkeletonBlock, cx, nearFmt, short, usePersonaOf, type Tone } from "./ui";

const taskTone = (s: string): Tone =>
  s === "completed" ? "emerald" : s === "failed" || s === "expired" || s === "cancelled" ? "red" : s === "awarded" ? "violet" : "sky";

export function CoordinationMarket() {
  const { dashboard } = usePhalanx();
  const personaOf = usePersonaOf();
  return (
    <Card className="p-4 sm:p-5">
      <CardHeader
        icon={Store}
        eyebrow="Coordination market · RFPs, bids, escrow"
        title="Task market"
        description="Nexus posts budgeted RFPs; workers bid in sealed commit-reveal or reverse-Dutch auctions. Bids need earned reputation, the promised latency becomes the deadline, and escrow is released only when the winner's signed model output verifies on-chain."
        actions={dashboard && <Badge tone="slate">{dashboard.tasks.length} RFPs</Badge>}
      />
      <div className="mt-4">
        {!dashboard ? (
          <SkeletonBlock rows={5} />
        ) : dashboard.tasks.length === 0 ? (
          <EmptyState icon={Inbox} title="No RFPs yet" hint="Run Judge Mode or let Nexus post tasks." />
        ) : (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {dashboard.tasks.map((t) => {
              const sealed = t.task.auction === "sealed_bid";
              const AuctionIcon = sealed ? Gavel : TrendingDown;
              const winnerPersona = personaOf(t.task.winner);
              return (
                <article key={t.task.task_id} className="min-w-0 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 sm:p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="num text-[11px] text-slate-500">RFP #{t.task.task_id}</div>
                      <h4 className="text-[13.5px] font-medium text-slate-100">{t.task.title}</h4>
                    </div>
                    <Badge tone={taskTone(t.task.status)} dot>
                      {t.task.status}
                    </Badge>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2 text-[11.5px]">
                    <div className="rounded-lg bg-black/20 px-2.5 py-2">
                      <div className="flex items-center gap-1 text-slate-500">
                        <AuctionIcon className="size-3" aria-hidden /> auction
                      </div>
                      <div className="mt-0.5 text-slate-200">{t.task.auction.replace("_", " ")}</div>
                    </div>
                    <div className="rounded-lg bg-black/20 px-2.5 py-2">
                      <div className="text-slate-500">ceiling</div>
                      <div className="num mt-0.5 text-slate-200">{nearFmt(t.task.budget_ceiling)}</div>
                    </div>
                    <div className="rounded-lg bg-black/20 px-2.5 py-2">
                      <div className="text-slate-500">winning price</div>
                      <div className="num mt-0.5 text-emerald-300">{nearFmt(t.task.winning_price)}</div>
                    </div>
                  </div>
                  <p className="num mt-2 text-[11px] text-slate-500">
                    bidders need reputation ≥ {t.task.verification.min_reputation_bps / 100}% · signed output needs confidence ≥{" "}
                    {t.task.verification.min_confidence_bps / 100}% ·{" "}
                    {t.task.verification.prompt_hash ? (
                      <span title={`sha256 of the system prompt every NEAR AI proof must use: ${t.task.verification.prompt_hash}`}>
                        prompt pinned {short(t.task.verification.prompt_hash, 8, 4)}
                        {t.task.verification.input_pinned ? " with its spec" : ""}
                      </span>
                    ) : (
                      "no pinned prompt: enclave receipts only"
                    )}
                  </p>

                  <div className="mt-3 space-y-2 sm:hidden" aria-label={`Bids for RFP ${t.task.task_id}`}>
                    {t.bids.map((b) => {
                      const p = personaOf(b.agent_id);
                      const win = b.agent_id === t.task.winner;
                      return (
                        <div
                          key={b.agent_id}
                          className={cx("rounded-lg border p-2.5", win ? "border-emerald-400/20 bg-emerald-400/[0.04]" : "border-white/[0.05] bg-black/15")}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            {p && <PersonaAvatar persona={p} size={24} />}
                            <span className={cx("num min-w-0 flex-1 truncate text-[11.5px]", win ? "text-emerald-200" : "text-slate-300")} title={b.agent_id}>
                              {short(b.agent_id, 24, 0)}
                            </span>
                            {win && <Trophy className="size-3.5 shrink-0 text-amber-300" aria-label="winner" />}
                          </div>
                          {b.revealed ? (
                            <dl className="mt-2 grid grid-cols-3 gap-2 text-[10.5px]">
                              <div>
                                <dt className="text-slate-500">price</dt>
                                <dd className="num mt-0.5 text-slate-200">{nearFmt(b.price)}</dd>
                              </div>
                              <div>
                                <dt className="text-slate-500">reputation</dt>
                                <dd
                                  className={cx(
                                    "num mt-0.5",
                                    (b.reputation_bps ?? 0) < t.task.verification.min_reputation_bps ? "text-red-300" : "text-slate-300",
                                  )}
                                >
                                  {(b.reputation_bps ?? 0) / 100}%
                                </dd>
                              </div>
                              <div>
                                <dt className="text-slate-500">score</dt>
                                <dd className="num mt-0.5 text-slate-300">{b.score_bps ?? "—"}</dd>
                              </div>
                            </dl>
                          ) : (
                            <div className="num mt-2 text-[10.5px] text-slate-500">sealed {short(b.commitment ?? "", 8, 4)}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <div
                    className="-mx-1 mt-3 hidden overflow-x-auto px-1 pb-1 sm:block"
                    role="region"
                    aria-label={`Bids for RFP ${t.task.task_id}`}
                    tabIndex={0}
                  >
                    <table className="w-full min-w-[300px] text-[11.5px]">
                      <caption className="sr-only">Bids for RFP {t.task.task_id}</caption>
                      <thead className="text-left text-[10.5px] uppercase tracking-wider text-slate-500">
                        <tr>
                          <th className="pb-1 font-medium">bidder</th>
                          <th className="pb-1 text-right font-medium">price</th>
                          <th className="pb-1 text-right font-medium">latency</th>
                          <th className="pb-1 text-right font-medium">rep</th>
                          <th className="pb-1 text-right font-medium">score</th>
                        </tr>
                      </thead>
                      <tbody>
                        {t.bids.map((b) => {
                          const p = personaOf(b.agent_id);
                          const win = b.agent_id === t.task.winner;
                          return (
                            <tr key={b.agent_id} className={cx("border-t border-white/[0.04]", win && "bg-emerald-400/[0.04]")}>
                              <td className="py-1.5 pr-2">
                                <span className="flex min-w-0 items-center gap-2">
                                  {p && <PersonaAvatar persona={p} size={20} />}
                                  <span className={cx("num truncate", win ? "text-emerald-200" : "text-slate-300")} title={b.agent_id}>
                                    {short(b.agent_id, 20, 0)}
                                  </span>
                                  {win && <Trophy className="size-3 shrink-0 text-amber-300" aria-label="winner" />}
                                </span>
                              </td>
                              {b.revealed ? (
                                <>
                                  <td className="num py-1.5 text-right text-slate-200">{nearFmt(b.price)}</td>
                                  <td className="num py-1.5 text-right text-slate-300">{b.est_latency_sec !== null ? `${b.est_latency_sec}s` : "—"}</td>
                                  <td
                                    className={cx(
                                      "num py-1.5 text-right",
                                      (b.reputation_bps ?? 0) < t.task.verification.min_reputation_bps ? "text-red-300" : "text-slate-300",
                                    )}
                                  >
                                    {(b.reputation_bps ?? 0) / 100}%
                                  </td>
                                  <td className="num py-1.5 text-right text-slate-300">{b.score_bps ?? "—"}</td>
                                </>
                              ) : (
                                <td colSpan={4} className="num py-1.5 text-right text-slate-500">
                                  sealed {short(b.commitment ?? "", 8, 4)}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {t.escrow && (
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/[0.05] pt-3 text-[11.5px] text-slate-400">
                      <span className="flex items-center gap-1.5">
                        {t.escrow.status === "locked" ? (
                          <Lock className="size-3 text-amber-200" aria-hidden />
                        ) : (
                          <LockOpen className="size-3 text-emerald-300" aria-hidden />
                        )}
                        escrow <span className="num text-slate-200">{nearFmt(t.escrow.amount)}</span> · {t.escrow.status}
                      </span>
                      {winnerPersona && (
                        <span className="flex items-center gap-1.5">
                          <PersonaAvatar persona={winnerPersona} size={16} /> payee
                        </span>
                      )}
                      {t.task.receipt_hash && (
                        <span className="num flex items-center gap-1.5" title={t.task.receipt_hash}>
                          <ReceiptText className="size-3 text-violet-300" aria-hidden />
                          proof {short(t.task.receipt_hash, 8, 4)}
                        </span>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

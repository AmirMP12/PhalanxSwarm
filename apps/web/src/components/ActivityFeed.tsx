"use client";

import { CircleCheck, CircleX, CornerDownRight, Inbox, ScrollText } from "lucide-react";
import { useEffect, useState } from "react";

import { useAegis } from "@/lib/aegis-context";

import { Badge, Card, CardHeader, CopyButton, EmptyState, SegmentedControl, ago, cx, short } from "./ui";

type Filter = "all" | "ok" | "rejected";

function useNow(ms = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Every transaction the UI sent to the contract, with its receipts and NEP-297 events. */
export function ActivityFeed() {
  const { activity } = useAegis();
  const [filter, setFilter] = useState<Filter>("all");
  const now = useNow();
  const okCount = activity.filter((a) => a.ok).length;
  const shown = activity.filter((a) => (filter === "all" ? true : filter === "ok" ? a.ok : !a.ok));

  return (
    <Card className="p-4 sm:p-5">
      <CardHeader
        icon={ScrollText}
        eyebrow="AegisSim receipts"
        title="Transaction log"
        description="Newest first. Signer → method, transaction hash, NEP-297 events and the receipts each call produced."
        actions={
          <SegmentedControl<Filter>
            label="Filter transactions"
            value={filter}
            onChange={setFilter}
            size="sm"
            options={[
              { value: "all", label: `All ${activity.length}` },
              { value: "ok", label: `OK ${okCount}` },
              { value: "rejected", label: `Rejected ${activity.length - okCount}` },
            ]}
          />
        }
      />
      <div className="mt-5">
        {shown.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={activity.length ? "Nothing matches this filter" : "No transactions yet"}
            hint="Contract calls from this tab appear here as they execute."
          />
        ) : (
          <ol tabIndex={0} aria-label="Transactions, newest first" className="fade-bottom relative max-h-[640px] overflow-y-auto pb-6 pr-1">
            {shown.map((a, i) => (
              <li key={a.id} className="relative flex gap-3 pb-3">
                {i < shown.length - 1 && <span className="absolute left-[11px] top-7 bottom-0 w-px bg-white/[0.07]" aria-hidden />}
                <span
                  className={cx(
                    "relative z-10 mt-0.5 grid size-6 shrink-0 place-items-center rounded-full ring-4 ring-[#0b0e15]",
                    a.ok ? "bg-emerald-400/15 text-emerald-300" : "bg-red-500/15 text-red-300",
                  )}
                >
                  {a.ok ? <CircleCheck className="size-3.5" aria-label="ok" /> : <CircleX className="size-3.5" aria-label="rejected" />}
                </span>
                <div className="min-w-0 flex-1 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-[12px] transition-colors hover:border-white/[0.12]">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="font-medium text-slate-100">{a.label}</span>
                    <span className="flex items-center gap-2">
                      <time className="text-[11px] text-slate-500" dateTime={new Date(a.at).toISOString()}>
                        {ago(a.at, now)}
                      </time>
                      <Badge tone={a.ok ? "emerald" : "red"}>{a.ok ? "ok" : "rejected"}</Badge>
                    </span>
                  </div>
                  <div className="num mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                    <span title={a.signer} className="break-all">
                      {short(a.signer, 28, 4)}
                    </span>
                    <span className="text-slate-600">→</span>
                    <span className="break-all text-slate-300">{a.method}</span>
                    {a.txHash && (
                      <span className="flex items-center gap-0.5" title={a.txHash}>
                        · tx {short(a.txHash, 6, 4)}
                        <span className="-my-1.5 scale-75">
                          <CopyButton text={a.txHash} label="Copy transaction hash" iconOnly />
                        </span>
                      </span>
                    )}
                  </div>
                  {a.error && <div className="num mt-2 break-words rounded-md bg-red-500/10 px-2 py-1 text-[11px] text-red-300">{a.error}</div>}
                  {a.events.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {a.events.map((e, j) => (
                        <span
                          key={j}
                          className="num rounded border border-emerald-400/20 bg-emerald-400/[0.06] px-1.5 text-[10.5px] leading-[18px] text-emerald-200"
                        >
                          {e}
                        </span>
                      ))}
                    </div>
                  )}
                  {a.receipts.length > 1 && (
                    <div className="mt-2 space-y-0.5">
                      {a.receipts.slice(1).map((r, j) => (
                        <div key={j} className="num flex gap-1 break-words text-[10.5px] text-slate-500">
                          <CornerDownRight className="mt-px size-3 shrink-0" aria-hidden />
                          <span className="min-w-0">
                            <span className="text-slate-400">{r.receiver}</span>: {r.actions}
                            {r.status !== "success" && <span className="text-red-300"> ({r.status})</span>}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}

"use client";

import { ArrowUpRight, Coins, Landmark, ShieldAlert, ShieldCheck, UsersRound, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useAegis } from "@/lib/aegis-context";

import { AnimatedNumber, Badge, PERSONAS, PersonaAvatar, Skeleton, Sparkline, StatusDot, cx, nearFmt, toNear, type ChartTone } from "./ui";

interface Point {
  liquid: number;
  profit: number;
}

/** Treasury values sampled on every dashboard refresh in this session (reset with the runtime). */
function useSessionHistory(): Point[] {
  const { dashboard, runtime } = useAegis();
  const [hist, setHist] = useState<Point[]>([]);
  const rt = useRef(runtime);
  useEffect(() => {
    if (!dashboard) return;
    const reset = rt.current !== runtime;
    rt.current = runtime;
    const p = { liquid: toNear(dashboard.treasury.liquid), profit: toNear(dashboard.treasury.net_profit) };
    setHist((h) => {
      const base = reset ? [] : h;
      const last = base[base.length - 1];
      if (last && last.liquid === p.liquid && last.profit === p.profit) return base;
      return [...base, p].slice(-48);
    });
  }, [dashboard, runtime]);
  return hist;
}

function Tile({
  href,
  icon: Icon,
  label,
  tone = "emerald",
  children,
  footer,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  tone?: ChartTone;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ring = {
    emerald: "text-emerald-300",
    sky: "text-sky-300",
    amber: "text-amber-200",
    red: "text-red-300",
    violet: "text-violet-300",
    slate: "text-slate-400",
  }[tone];
  return (
    <a
      href={href}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
        e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
      }}
      className="surface spotlight group flex min-w-0 flex-col rounded-2xl p-4 transition-transform duration-200 hover:-translate-y-0.5"
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[12px] font-medium text-slate-400">
          <span className={cx("grid size-6 place-items-center rounded-md bg-white/[0.05]", ring)}>
            <Icon className="size-3.5" aria-hidden />
          </span>
          {label}
        </span>
        <ArrowUpRight className="size-3.5 text-slate-600 transition group-hover:text-slate-300" aria-hidden />
      </div>
      <div className="mt-3 min-w-0">{children}</div>
      {footer && <div className="mt-auto pt-3">{footer}</div>}
    </a>
  );
}

export function OverviewStats() {
  const { dashboard, runtime } = useAegis();
  const hist = useSessionHistory();

  if (!dashboard || !runtime) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="surface rounded-2xl p-4">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-4 h-8 w-36" />
            <Skeleton className="mt-4 h-9 w-full" />
          </div>
        ))}
      </div>
    );
  }

  const t = dashboard.treasury;
  const agents = dashboard.agents;
  const active = agents.filter((a) => a.status.kind === "active").length;
  const quarantined = agents.filter((a) => a.status.kind === "quarantined").length;
  const critical = dashboard.security_events.filter((e) => e.severity === "critical").length;
  const strikes = agents.reduce((n, a) => n + a.violations, 0);
  const statusOf = (p: (typeof PERSONAS)[number]) => agents.find((a) => a.agent_id === runtime.agents[p].accountId)?.status.kind;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Tile href="#treasury" icon={Landmark} label="Treasury liquid" footer={<Sparkline data={hist.map((h) => h.liquid)} />}>
        <AnimatedNumber
          value={toNear(t.liquid)}
          className="text-[26px] font-semibold tracking-tight text-white"
          suffix={<span className="ml-1 text-[15px] text-slate-500">Ⓝ</span>}
        />
        <div className="mt-1 text-[12px] text-slate-500 break-words">
          available <span className="num text-slate-300">{nearFmt(t.available)}</span>
        </div>
      </Tile>

      <Tile href="#treasury" icon={Coins} label="Net profit" tone="sky" footer={<Sparkline data={hist.map((h) => h.profit)} tone="sky" />}>
        <AnimatedNumber
          value={toNear(t.net_profit)}
          className="text-[26px] font-semibold tracking-tight text-white"
          suffix={<span className="ml-1 text-[15px] text-slate-500">Ⓝ</span>}
        />
        <div className="mt-1 text-[12px] text-slate-500 break-words">
          distributable <span className="num text-slate-300">{nearFmt(t.distributable_profit)}</span> · distributed{" "}
          <span className="num text-slate-300">{nearFmt(t.total_distributed)}</span>
        </div>
      </Tile>

      <Tile
        href="#swarm"
        icon={UsersRound}
        label="Agents"
        tone="violet"
        footer={
          <div className="flex items-center -space-x-1.5 overflow-x-auto py-0.5 [scrollbar-width:none]">
            {PERSONAS.map((p) => (
              <PersonaAvatar key={p} persona={p} size={28} status={statusOf(p)} className="ring-2 ring-[#0c0f16]" />
            ))}
          </div>
        }
      >
        <div className="num text-[26px] font-semibold tracking-tight text-white">
          {active}
          <span className="text-[15px] text-slate-500">/{agents.length} active</span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[12px] text-slate-500">
          {quarantined ? (
            <Badge tone="red" dot>
              {quarantined} quarantined
            </Badge>
          ) : (
            "FunctionCall keys only · zero FullAccess"
          )}
        </div>
      </Tile>

      <Tile
        href="#policy"
        icon={critical ? ShieldAlert : ShieldCheck}
        label="Security"
        tone={critical || dashboard.paused ? "red" : "emerald"}
        footer={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
            <StatusDot tone={dashboard.paused ? "red" : "emerald"} pulse />
            <span className={dashboard.paused ? "text-red-300" : "text-slate-300"}>{dashboard.paused ? "Protocol paused" : "Protocol live"}</span>
            <span className="text-slate-600">·</span>
            <span className="num text-slate-500">
              epoch {nearFmt(t.epoch_spent, 1)} / {nearFmt(dashboard.policy.epoch_spending_cap_yocto, 0)}
            </span>
          </div>
        }
      >
        <div className="num text-[26px] font-semibold tracking-tight text-white">
          {critical}
          <span className="text-[15px] text-slate-500"> critical</span>
        </div>
        <div className="mt-1 text-[12px] text-slate-500">
          <span className="num text-slate-300">{dashboard.security_events.length}</span> events · <span className="num text-slate-300">{strikes}</span> strikes
        </div>
      </Tile>
    </div>
  );
}

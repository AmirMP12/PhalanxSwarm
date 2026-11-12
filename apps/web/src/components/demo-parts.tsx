"use client";

import { motion } from "framer-motion";
import { ChevronDown, CircleCheck, ExternalLink, Hourglass, OctagonAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cx } from "./ui";

/** Link to the same step in the recorded testnet run. */
export function TestnetLink({ href, label = "Same step on testnet" }: { href?: string; label?: string }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] text-sky-300 hover:text-sky-200">
      <ExternalLink className="size-3" aria-hidden /> {label}
    </a>
  );
}

export function StepCard({
  n,
  icon: Icon,
  title,
  lead,
  done,
  current = false,
  children,
}: {
  n: number;
  icon: LucideIcon;
  title: string;
  lead: ReactNode;
  done: boolean;
  /** The next step to take: highlighted until it is done. */
  current?: boolean;
  children: ReactNode;
}) {
  return (
    <li
      aria-current={current && !done ? "step" : undefined}
      className={cx(
        "relative flex h-full min-w-0 flex-col rounded-2xl border p-4 sm:p-5 transition-all duration-300 backdrop-blur-md",
        done
          ? "border-emerald-400/35 bg-gradient-to-b from-emerald-500/[0.07] to-emerald-950/[0.04] shadow-[0_8px_24px_-8px_rgba(0,236,151,0.15)]"
          : current
            ? "border-sky-400/50 bg-gradient-to-b from-sky-500/[0.08] to-sky-950/[0.04] shadow-[0_0_0_1px_rgba(56,189,248,0.25),0_12px_32px_-8px_rgba(56,189,248,0.2)]"
            : "border-white/[0.09] bg-gradient-to-b from-white/[0.025] to-black/30 hover:border-white/15",
      )}
    >
      {/* Top subtle highlight */}
      <div
        className={cx(
          "pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-2xl",
          done
            ? "bg-gradient-to-r from-transparent via-emerald-400/60 to-transparent"
            : current
              ? "bg-gradient-to-r from-transparent via-sky-400/70 to-transparent"
              : "bg-gradient-to-r from-transparent via-white/10 to-transparent",
        )}
      />

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span
            className={cx(
              "relative grid size-9 shrink-0 place-items-center rounded-xl border text-[13px] font-bold transition-transform duration-200",
              done
                ? "border-emerald-400/60 bg-emerald-400/20 text-emerald-300 shadow-[0_0_16px_rgba(0,236,151,0.3)]"
                : current
                  ? "border-sky-400/60 bg-sky-400/20 text-sky-200 shadow-[0_0_16px_rgba(56,189,248,0.3)]"
                  : "border-white/15 bg-white/[0.05] text-slate-400",
            )}
            aria-hidden
          >
            {done ? <CircleCheck className="size-5" /> : n}
            {current && !done && <span className="absolute -inset-1 animate-ping rounded-xl border border-sky-400/40 opacity-75" />}
          </span>
          <div className="min-w-0">
            <div className="num flex items-center gap-2 text-[10.5px] uppercase tracking-[0.14em] text-slate-400 font-medium">
              Step {n}
              {done && <span className="rounded-full bg-emerald-400/15 px-1.5 py-0.2 text-[9px] font-semibold text-emerald-300">PASSED</span>}
              {current && !done && <span className="rounded-full bg-sky-400/15 px-1.5 py-0.2 text-[9px] font-semibold text-sky-300 animate-pulse">ACTIVE</span>}
            </div>
            <h3 className="flex items-center gap-1.5 text-[15px] font-semibold text-white tracking-tight">
              <Icon className={cx("size-4 shrink-0", done ? "text-emerald-400" : current ? "text-sky-400" : "text-slate-400")} aria-hidden />
              {title}
            </h3>
          </div>
        </div>
      </div>
      <p className="mt-3 flex-1 text-[13px] leading-relaxed text-slate-300/90">{lead}</p>
      <div className="mt-4 flex min-w-0 flex-col gap-3">{children}</div>
    </li>
  );
}

const outcomeStyles = {
  good: {
    box: "border-emerald-400/40 bg-gradient-to-r from-emerald-500/15 to-emerald-950/20 shadow-[0_0_20px_-4px_rgba(0,236,151,0.2)]",
    icon: CircleCheck,
    iconTone: "text-emerald-400",
  },
  wait: {
    box: "border-amber-400/40 bg-gradient-to-r from-amber-500/15 to-amber-950/20 shadow-[0_0_20px_-4px_rgba(251,191,36,0.2)]",
    icon: Hourglass,
    iconTone: "text-amber-300",
  },
  bad: {
    box: "border-red-400/50 bg-gradient-to-r from-red-500/20 to-red-950/30 shadow-[0_0_20px_-4px_rgba(244,63,94,0.25)]",
    icon: OctagonAlert,
    iconTone: "text-red-400",
  },
} as const;

/** A step's result in one line, before any of the evidence. */
export function StepOutcome({ tone, label, children }: { tone: keyof typeof outcomeStyles; label: string; children: ReactNode }) {
  const s = outcomeStyles[tone];
  const Icon = s.icon;
  return (
    <div className={cx("flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[13px] backdrop-blur-md", s.box)}>
      <Icon className={cx("mt-0.5 size-4.5 shrink-0", s.iconTone)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-white tracking-tight">{label}</div>
        <div className="mt-0.5 text-slate-200 leading-snug">{children}</div>
      </div>
    </div>
  );
}

/** The step's full setup and evidence, folded until asked for. */
export function StepDetails({ ran, children }: { ran: boolean; children: ReactNode }) {
  return (
    <details className="group/details rounded-xl border border-white/[0.08] bg-black/40 text-[12px] backdrop-blur-md transition-colors hover:border-white/15">
      <summary className="touch-target flex cursor-pointer list-none items-center gap-1.5 rounded-xl px-3.5 py-2.5 text-slate-300 hover:text-white [&::-webkit-details-marker]:hidden font-medium">
        <ChevronDown className="size-3.5 text-slate-400 transition-transform group-open/details:rotate-180" aria-hidden />
        {ran ? "Inspect verified cryptographic outcome" : "How the contract guarantees this"}
      </summary>
      <div className="space-y-2.5 px-3.5 pb-3.5 pt-1 border-t border-white/[0.04]">{children}</div>
    </details>
  );
}

export function Reveal({ children }: { children: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
      {children}
    </motion.div>
  );
}

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
        "flex h-full min-w-0 flex-col rounded-2xl border p-4 transition-colors",
        done
          ? "border-emerald-400/25 bg-emerald-400/[0.03]"
          : current
            ? "border-sky-400/30 bg-sky-400/[0.03] shadow-[0_0_0_1px_rgb(56_189_248/0.08)]"
            : "border-white/[0.08] bg-black/20",
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cx(
            "grid size-8 shrink-0 place-items-center rounded-full border text-[13px] font-semibold",
            done ? "border-emerald-400/50 bg-emerald-400/15 text-emerald-300" : "border-white/15 bg-white/[0.04] text-slate-300",
          )}
          aria-hidden
        >
          {done ? <CircleCheck className="size-4" /> : n}
        </span>
        <div className="min-w-0">
          <div className="num text-[10.5px] uppercase tracking-[0.14em] text-slate-500">Step {n}</div>
          <h3 className="flex items-center gap-1.5 text-[14.5px] font-semibold text-slate-50">
            <Icon className="size-4 shrink-0 text-emerald-300" aria-hidden />
            {title}
          </h3>
        </div>
      </div>
      <p className="mt-2.5 flex-1 text-[12.5px] leading-relaxed text-slate-400">{lead}</p>
      <div className="mt-4 flex min-w-0 flex-col gap-3">{children}</div>
    </li>
  );
}

const outcomeStyles = {
  good: { box: "border-emerald-400/25 bg-emerald-400/[0.06]", icon: CircleCheck, iconTone: "text-emerald-300" },
  wait: { box: "border-amber-400/30 bg-amber-400/[0.06]", icon: Hourglass, iconTone: "text-amber-200" },
  bad: { box: "border-red-400/40 bg-red-500/10", icon: OctagonAlert, iconTone: "text-red-300" },
} as const;

/** A step's result in one line, before any of the evidence. */
export function StepOutcome({ tone, label, children }: { tone: keyof typeof outcomeStyles; label: string; children: ReactNode }) {
  const s = outcomeStyles[tone];
  const Icon = s.icon;
  return (
    <div className={cx("flex items-start gap-2 rounded-xl border px-3 py-2.5 text-[12.5px]", s.box)}>
      <Icon className={cx("mt-0.5 size-4 shrink-0", s.iconTone)} aria-hidden />
      <div className="min-w-0">
        <div className="font-semibold text-slate-50">{label}</div>
        <div className="text-slate-300">{children}</div>
      </div>
    </div>
  );
}

/** The step's full setup and evidence, folded until asked for. */
export function StepDetails({ ran, children }: { ran: boolean; children: ReactNode }) {
  return (
    <details className="group/details rounded-xl border border-white/[0.06] bg-black/20 text-[12px]">
      <summary className="touch-target flex cursor-pointer list-none items-center gap-1.5 rounded-xl px-3 py-2 text-slate-300 hover:text-white [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-3.5 text-slate-500 transition-transform group-open/details:rotate-180" aria-hidden />
        {ran ? "What happened" : "How it works"}
      </summary>
      <div className="space-y-2 px-3 pb-3">{children}</div>
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

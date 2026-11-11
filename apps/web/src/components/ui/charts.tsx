"use client";

import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "framer-motion";
import { useEffect, useId, type ReactNode } from "react";

import { cx } from "./format";

const EASE = [0.16, 1, 0.3, 1] as const;

const HEX = {
  emerald: "#00ec97",
  teal: "#2dd4bf",
  sky: "#7dd3fc",
  amber: "#fcd34d",
  red: "#f87171",
  violet: "#c4b5fd",
  slate: "#64748b",
} as const;
export type ChartTone = keyof typeof HEX;

const svgId = (raw: string) => `g${raw.replace(/[^a-zA-Z0-9_-]/g, "")}`;

/** Counts from the previous value to the next one; React never re-writes the text node. */
export function AnimatedNumber({ value, decimals = 2, className, suffix }: { value: number; decimals?: number; className?: string; suffix?: ReactNode }) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(reduce ? value : 0);
  const text = useTransform(mv, (v) => v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
  useEffect(() => {
    if (reduce) {
      mv.set(value);
      return;
    }
    const c = animate(mv, value, { duration: 0.9, ease: EASE });
    return () => c.stop();
  }, [value, reduce, mv]);
  return (
    <span className={cx("num", className)}>
      <motion.span>{text}</motion.span>
      {suffix}
    </span>
  );
}

export function Sparkline({ data, tone = "emerald", height = 40, className }: { data: number[]; tone?: ChartTone; height?: number; className?: string }) {
  const gid = svgId(useId());
  const w = 160;
  const series = data.length >= 2 ? data : [data[0] ?? 0, data[0] ?? 0];
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const pts = series.map((v, i) => [(i / (series.length - 1)) * w, height - 4 - ((v - min) / span) * (height - 8)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const c = HEX[tone];
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className={cx("block w-full", className)} style={{ height }} aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={c} stopOpacity="0.32" />
          <stop offset="100%" stopColor={c} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w},${height} L0,${height} Z`} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={c} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function ProgressRing({
  value,
  max,
  size = 128,
  stroke = 9,
  tone = "emerald",
  children,
}: {
  value: number;
  max: number;
  size?: number;
  stroke?: number;
  tone?: ChartTone;
  children?: ReactNode;
}) {
  const gid = svgId(useId());
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = max > 0 ? Math.min(1, value / max) : 0;
  const color = HEX[tone];
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={color} />
            <stop offset="100%" stopColor={tone === "emerald" ? HEX.sky : color} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(255 255 255 / 0.06)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#${gid})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={false}
          animate={{ strokeDashoffset: c * (1 - p), opacity: p > 0 ? 1 : 0 }}
          transition={{ duration: 0.8, ease: EASE }}
          style={{ filter: `drop-shadow(0 0 6px ${color}66)` }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

/** Semi-circular gauge for spend vs. cap. */
export function Gauge({
  value,
  max,
  size = 168,
  tone = "emerald",
  children,
}: {
  value: number;
  max: number;
  size?: number;
  tone?: ChartTone;
  children?: ReactNode;
}) {
  const stroke = 12;
  const r = (size - stroke) / 2;
  const half = Math.PI * r;
  const p = max > 0 ? Math.min(1, value / max) : 0;
  const color = HEX[tone];
  const h = size / 2 + stroke;
  const d = `M ${stroke / 2} ${size / 2} A ${r} ${r} 0 0 1 ${size - stroke / 2} ${size / 2}`;
  return (
    <div className="relative" style={{ width: size, height: h }}>
      <svg width={size} height={h} aria-hidden>
        <path d={d} fill="none" stroke="rgb(255 255 255 / 0.06)" strokeWidth={stroke} strokeLinecap="round" />
        <motion.path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={half}
          initial={false}
          animate={{ strokeDashoffset: half * (1 - p), opacity: p > 0 ? 1 : 0 }}
          transition={{ duration: 0.8, ease: EASE }}
          style={{ filter: `drop-shadow(0 0 8px ${color}55)` }}
        />
      </svg>
      <div className="absolute inset-x-0 bottom-1 text-center">{children}</div>
    </div>
  );
}

export interface DonutSegment {
  label: string;
  value: number;
  tone: ChartTone;
}

export function Donut({ segments, size = 132, stroke = 16, children }: { segments: DonutSegment[]; size?: number; stroke?: number; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((n, s) => n + s.value, 0) || 1;
  const gap = segments.length > 1 ? 3 : 0;
  const lengths = segments.map((s) => (s.value / total) * c);
  const offsets = lengths.map((_, i) => lengths.slice(0, i).reduce((sum, len) => sum + len, 0));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(255 255 255 / 0.05)" strokeWidth={stroke} />
        {segments.map((s, i) => {
          const len = lengths[i] ?? 0;
          const offset = offsets[i] ?? 0;
          return (
            <motion.circle
              key={s.label}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={HEX[s.tone]}
              strokeWidth={stroke}
              strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
              initial={{ strokeDashoffset: 0, opacity: 0 }}
              animate={{ strokeDashoffset: -offset, opacity: 1 }}
              transition={{ duration: 0.8, ease: EASE }}
            />
          );
        })}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

export const toneHex = HEX;

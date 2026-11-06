"use client";

import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { useId, useRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";

import { cx } from "./format";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
  hint?: string;
}

/** Radio-group semantics with roving focus and an animated active pill. */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  disabled,
  size = "md",
  className,
  fullWidth = false,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<SegmentOption<T>>;
  label: string;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  fullWidth?: boolean;
}) {
  const group = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (e: KeyboardEvent, i: number) => {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const n = (i + delta + options.length) % options.length;
    const next = options[n];
    if (!next) return;
    onChange(next.value);
    refs.current[n]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cx(
        "inline-flex max-w-full overflow-x-auto rounded-lg border border-white/[0.08] bg-black/30 p-0.5 [scrollbar-width:none]",
        fullWidth && "w-full flex",
        disabled && "opacity-50",
        className,
      )}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            title={o.hint}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => move(e, i)}
            className={cx(
              "relative isolate inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:cursor-not-allowed",
              fullWidth && "flex-1",
              size === "sm" ? "h-7.5 px-2.5 text-[12px]" : "h-8.5 px-3 text-[12.5px]",
              active ? "text-white" : "text-slate-400 hover:text-slate-200",
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${group}`}
                className="absolute inset-0 -z-10 rounded-md border border-white/10 bg-white/[0.09] shadow-sm shadow-black/40"
                transition={{ type: "spring", bounce: 0.18, duration: 0.45 }}
              />
            )}
            {Icon && <Icon className={cx("size-3.5 shrink-0", active && "text-emerald-300")} aria-hidden />}
            <span className="truncate">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-[13px] font-medium text-slate-200">{label}</span>
        {description && <span className="block text-[11.5px] text-slate-500 break-words">{description}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="touch-target-square inline-grid size-11 shrink-0 place-items-center rounded-full disabled:opacity-40"
      >
        <span
          className={cx(
            "relative inline-flex h-[22px] w-10 items-center rounded-full border transition-colors duration-200",
            checked ? "border-emerald-300/60 bg-emerald-400" : "border-white/10 bg-white/10",
          )}
          aria-hidden
        >
          <span
            className={cx("size-4 rounded-full bg-white shadow-md transition-transform duration-200", checked ? "translate-x-[20px]" : "translate-x-[3px]")}
          />
        </span>
      </button>
    </div>
  );
}

export function Field({
  label,
  suffix,
  hint,
  error,
  presets,
  onPreset,
  className,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  suffix?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  presets?: string[];
  onPreset?: (v: string) => void;
}) {
  const id = useId();
  const msgId = `${id}-msg`;
  return (
    <div className={cx("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-[12px] font-medium text-slate-400">
          {label}
        </label>
        {presets && onPreset && (
          <div className="flex gap-1">
            {presets.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onPreset(p)}
                className={cx(
                  "touch-target num min-w-6 rounded px-2 text-[11px] leading-[18px] transition",
                  input.value === p ? "bg-emerald-400/15 text-emerald-300" : "bg-white/[0.04] text-slate-500 hover:bg-white/[0.08] hover:text-slate-300",
                )}
              >
                {p}
              </button>
            ))}
          </div>
        )}
      </div>
      <div
        className={cx(
          "touch-target flex h-9 items-center rounded-lg border bg-black/30 transition focus-within:ring-2",
          error
            ? "border-red-400/50 focus-within:ring-red-400/15"
            : "border-white/10 hover:border-white/20 focus-within:border-emerald-400/50 focus-within:ring-emerald-400/15",
        )}
      >
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? msgId : undefined}
          {...input}
          className="num h-full w-full min-w-0 bg-transparent px-3 text-[13px] text-slate-100 outline-none placeholder:text-slate-600 focus-visible:outline-none"
        />
        {suffix && <span className="shrink-0 pr-3 text-[11.5px] text-slate-500">{suffix}</span>}
      </div>
      {error ? (
        <p id={msgId} className="text-[11px] text-red-300">
          {error}
        </p>
      ) : hint ? (
        <p id={msgId} className="text-[11px] text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

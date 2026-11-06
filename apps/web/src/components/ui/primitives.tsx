"use client";

import { Check, Copy, LoaderCircle, type LucideIcon } from "lucide-react";
import {
  cloneElement,
  isValidElement,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { cx } from "./format";
import { toast } from "./toast";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    "bg-emerald-400 text-[#04140d] font-semibold hover:bg-emerald-300 shadow-[0_0_0_1px_rgb(0_236_151/0.5),0_8px_28px_-6px_rgb(0_236_151/0.55)] disabled:shadow-none",
  secondary: "border border-white/10 bg-white/[0.04] text-slate-200 hover:border-white/20 hover:bg-white/[0.08]",
  ghost: "text-slate-300 hover:bg-white/[0.06] hover:text-white",
  danger: "border border-red-400/35 bg-red-500/10 text-red-200 hover:border-red-400/60 hover:bg-red-500/20",
};
const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-2.5 text-[12.5px]",
  md: "h-9 gap-2 px-3.5 text-[13px]",
  lg: "h-11 gap-2.5 px-5 text-[15px]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
  shine?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon: Icon,
  iconRight: IconRight,
  loading,
  shine,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "touch-target inline-flex max-w-full shrink-0 select-none items-center justify-center whitespace-nowrap rounded-lg font-medium transition-[background,border,color,box-shadow,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 max-sm:h-auto max-sm:min-h-10 max-sm:whitespace-normal max-sm:py-2",
        buttonVariants[variant],
        buttonSizes[size],
        shine && !disabled && !loading && "shine",
        className,
      )}
    >
      {loading ? (
        <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />
      ) : Icon ? (
        <Icon className={cx("shrink-0", size === "lg" ? "size-[18px]" : "size-4")} aria-hidden />
      ) : null}
      {children}
      {IconRight && <IconRight className="size-4 shrink-0 opacity-70" aria-hidden />}
    </button>
  );
}

export function IconButton({
  icon: Icon,
  label,
  className,
  tooltip = true,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; tooltip?: boolean }) {
  const btn = (
    <button
      type="button"
      aria-label={label}
      {...props}
      className={cx(
        "touch-target-square inline-grid size-10 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-white/[0.07] hover:text-white disabled:pointer-events-none disabled:opacity-40 sm:size-8",
        className,
      )}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
  return tooltip ? <Tooltip content={label}>{btn}</Tooltip> : btn;
}

const tones = {
  emerald: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  red: "border-red-400/30 bg-red-500/10 text-red-300",
  amber: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  sky: "border-sky-400/25 bg-sky-400/10 text-sky-300",
  violet: "border-violet-400/25 bg-violet-400/10 text-violet-300",
  slate: "border-white/10 bg-white/[0.04] text-slate-300",
} as const;
export type Tone = keyof typeof tones;

const dotColors: Record<Tone, string> = {
  emerald: "bg-emerald-400",
  red: "bg-red-400",
  amber: "bg-amber-300",
  sky: "bg-sky-300",
  violet: "bg-violet-300",
  slate: "bg-slate-500",
};

export function Badge({
  tone = "slate",
  dot,
  icon: Icon,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[11.5px] font-medium",
        tones[tone],
        className,
      )}
    >
      {dot && <span className={cx("size-1.5 rounded-full", dotColors[tone])} aria-hidden />}
      {Icon && <Icon className="size-3" aria-hidden />}
      {children}
    </span>
  );
}

export function StatusDot({ tone = "emerald", pulse, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={cx("relative inline-flex size-2 shrink-0", className)} aria-hidden>
      {pulse && <span className={cx("absolute inset-0 animate-ping rounded-full opacity-60", dotColors[tone])} />}
      <span className={cx("relative inline-flex size-2 rounded-full", dotColors[tone])} />
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-white/10 bg-white/[0.06] px-1 font-sans text-[10.5px] font-medium text-slate-400",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cx("size-4 animate-spin", className)} aria-hidden />;
}

export function Tooltip({
  content,
  children,
  side = "top",
  className,
}: {
  content: ReactNode;
  children: ReactElement;
  side?: "top" | "bottom";
  className?: string;
}) {
  const id = useId();
  const child = isValidElement<Record<string, unknown>>(children) ? cloneElement(children, { "aria-describedby": id }) : children;
  return (
    <span className={cx("group/tt relative inline-flex", className)}>
      {child}
      <span
        role="tooltip"
        id={id}
        className={cx(
          "tooltip-bubble pointer-events-none absolute left-1/2 z-50 hidden w-max max-w-[min(16rem,calc(100vw-1rem))] -translate-x-1/2 rounded-md border border-white/10 bg-[#141925] px-2 py-1 text-center text-[11.5px] font-normal leading-snug text-slate-200 shadow-xl shadow-black/50 group-hover/tt:block group-focus-within/tt:block",
          side === "top" ? "bottom-full mb-2" : "top-full mt-2",
        )}
      >
        {content}
      </span>
    </span>
  );
}

function trackPointer(e: PointerEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
}

export function Card({ className, children, spotlight = true, ...rest }: HTMLAttributes<HTMLElement> & { spotlight?: boolean }) {
  return (
    <section {...rest} onPointerMove={spotlight ? trackPointer : undefined} className={cx("surface min-w-0 rounded-2xl p-3 sm:p-4 md:p-5", spotlight && "spotlight", className)}>
      {children}
    </section>
  );
}

export function CardHeader({
  icon: Icon,
  eyebrow,
  title,
  description,
  actions,
  className,
  titleId,
}: {
  icon?: LucideIcon;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  titleId?: string;
}) {
  return (
    <header className={cx("space-y-1.5", className)}>
      <div className="flex items-start justify-between gap-2 sm:gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2 sm:gap-3">
          {Icon && (
            <span className="mt-0.5 grid size-8 sm:size-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-gradient-to-b from-white/[0.08] to-white/[0.02] text-emerald-300 shadow-inner shadow-white/5">
              <Icon className="size-[16px] sm:size-[18px]" aria-hidden />
            </span>
          )}
          <div className="min-w-0 flex-1">
            {eyebrow && <div className="text-[9px] sm:text-[10.5px] font-semibold uppercase tracking-[0.12em] sm:tracking-[0.16em] text-slate-500 break-words">{eyebrow}</div>}
            <h3 id={titleId} className="text-[14px] sm:text-[15px] font-semibold tracking-tight text-slate-50 break-words">
              {title}
            </h3>
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">{actions}</div>}
      </div>
      {description && <p className="text-[11.5px] sm:text-[12.5px] leading-relaxed text-slate-400 break-words">{description}</p>}
    </header>
  );
}

export function Section({
  id,
  icon: Icon,
  title,
  description,
  meta,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="min-w-0 scroll-mt-20 lg:scroll-mt-24 space-y-4">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3 border-b border-white/[0.06] pb-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/20">
            <Icon className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="text-[17px] font-semibold tracking-tight text-white">
              {title}
            </h2>
            <p className="text-[12.5px] text-slate-400">{description}</p>
          </div>
        </div>
        {meta && <div className="flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {children}
    </section>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500", className)}>{children}</div>;
}

export function Meter({
  value,
  max,
  tone = "emerald",
  label = "Usage",
  className,
}: {
  value: bigint;
  max: bigint;
  tone?: "emerald" | "amber" | "red" | "sky" | "violet";
  /** Accessible name: screen readers announce a meter by it. */
  label?: string;
  className?: string;
}) {
  const p = max <= 0n ? 0 : Math.min(100, Number((value * 10_000n) / max) / 100);
  const color = {
    emerald: "from-emerald-500 to-emerald-300",
    amber: "from-amber-500 to-amber-300",
    red: "from-red-500 to-red-300",
    sky: "from-sky-500 to-sky-300",
    violet: "from-violet-500 to-violet-300",
  }[tone];
  return (
    <div
      className={cx("h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]", className)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p)}
      aria-valuetext={`${Math.round(p)}%`}
    >
      <div className={cx("h-full rounded-full bg-gradient-to-r transition-[width] duration-700 ease-out", color)} style={{ width: `${p}%` }} />
    </div>
  );
}

export function KV({ k, v, mono = true }: { k: ReactNode; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-white/[0.04] py-1.5 text-[12.5px] min-[380px]:flex-row min-[380px]:items-baseline min-[380px]:justify-between min-[380px]:gap-3 last:border-0">
      <span className="min-w-0 break-words text-slate-500">{k}</span>
      <span className={cx("min-w-0 break-words text-left text-slate-200 min-[380px]:text-right", mono && "num text-[12px]")}>{v}</span>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, hint, className }: { icon: LucideIcon; title: string; hint?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-col items-center justify-center rounded-xl border border-dashed border-white/[0.08] px-4 py-8 text-center", className)}>
      <span className="grid size-10 place-items-center rounded-full bg-white/[0.04] text-slate-500 ring-1 ring-white/[0.06]">
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <p className="mt-3 text-[13px] font-medium text-slate-300">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-[12px] text-slate-500">{hint}</p>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton rounded-md", className)} aria-hidden />;
}

export function SkeletonBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2.5" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cx("h-4", i % 3 === 0 ? "w-3/4" : i % 3 === 1 ? "w-full" : "w-1/2")} />
      ))}
    </div>
  );
}

export function Callout({
  tone,
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  tone: Tone;
  icon: LucideIcon;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex items-start gap-3 rounded-xl border p-3 text-[12.5px]", tones[tone], className)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cx("break-words", title ? "mt-0.5 opacity-90" : "")}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast({ tone: "error", title: "Clipboard unavailable", description: "The browser blocked clipboard access on this origin." });
    return false;
  }
}

export function CopyButton({ text, label = "Copy", iconOnly, size = "sm" }: { text: string; label?: string; iconOnly?: boolean; size?: ButtonSize }) {
  const [done, setDone] = useState(false);
  const onClick = () => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setDone(true);
      setTimeout(() => setDone(false), 1400);
    });
  };
  if (iconOnly)
    return <IconButton icon={done ? Check : Copy} label={done ? "Copied" : label} onClick={onClick} className={done ? "text-emerald-300" : undefined} />;
  return (
    <Button size={size} icon={done ? Check : Copy} onClick={onClick} className={done ? "text-emerald-300" : undefined}>
      <span aria-live="polite">{done ? "Copied" : label}</span>
    </Button>
  );
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function highlightJson(json: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of json.matchAll(JSON_TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(json.slice(last, at));
    if (m[1]) {
      out.push(
        <span key={k++} className={m[2] ? "text-sky-300" : "text-emerald-300"}>
          {m[1]}
        </span>,
      );
      if (m[2]) out.push(m[2]);
    } else if (m[3]) {
      out.push(
        <span key={k++} className="text-violet-300">
          {m[3]}
        </span>,
      );
    } else if (m[4]) {
      out.push(
        <span key={k++} className="text-amber-200">
          {m[4]}
        </span>,
      );
    }
    last = at + m[0].length;
  }
  out.push(json.slice(last));
  return out;
}

export function CodeBlock({
  children,
  json,
  title,
  actions,
  label,
  className,
}: {
  children?: ReactNode;
  json?: string;
  title?: ReactNode;
  actions?: ReactNode;
  /** Accessible name of the scrollable code region (defaults to a string `title`). */
  label?: string;
  className?: string;
}) {
  return (
    <div className={cx("overflow-hidden rounded-xl border border-white/[0.07] bg-black/40", className)}>
      {(title || actions) && (
        <div className="flex min-w-0 items-center justify-between gap-2 border-b border-white/[0.06] bg-white/[0.02] px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2 overflow-x-auto text-[11.5px] text-slate-400 [scrollbar-width:none]">
            <span className="flex gap-1" aria-hidden>
              <span className="size-2 rounded-full bg-white/10" />
              <span className="size-2 rounded-full bg-white/10" />
              <span className="size-2 rounded-full bg-white/10" />
            </span>
            {title}
          </div>
          <div className="flex items-center gap-1">{actions}</div>
        </div>
      )}
      {/* Focusable so keyboard users can scroll long lines and payloads (WCAG 2.1.1). */}
      <pre
        tabIndex={0}
        role="region"
        aria-label={label ?? (typeof title === "string" ? title : "Code")}
        className="num max-h-72 overflow-auto p-3 text-[11.5px] leading-relaxed text-slate-300"
      >
        {json !== undefined ? highlightJson(json) : children}
      </pre>
    </div>
  );
}

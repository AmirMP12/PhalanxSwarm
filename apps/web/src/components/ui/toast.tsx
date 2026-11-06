"use client";

import { AnimatePresence, motion } from "framer-motion";
import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-react";
import { useSyncExternalStore } from "react";

import { cx } from "./format";

type ToastTone = "success" | "error" | "warning" | "info";
export interface ToastInput {
  tone: ToastTone;
  title: string;
  description?: string;
  duration?: number;
}
interface ToastItem extends ToastInput {
  id: number;
}

let items: ToastItem[] = [];
let seq = 0;
const EMPTY: ToastItem[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function dismissToast(id: number): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

/** Fire-and-forget notification (sonner-style module store; safe to call from any client code). */
export function toast(t: ToastInput): number {
  const id = ++seq;
  items = [...items, { ...t, id }].slice(-4);
  emit();
  setTimeout(() => dismissToast(id), t.duration ?? (t.tone === "error" ? 7000 : 4500));
  return id;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

const meta = {
  success: { icon: CircleCheck, cls: "text-emerald-300", bar: "bg-emerald-400" },
  error: { icon: CircleX, cls: "text-red-300", bar: "bg-red-400" },
  warning: { icon: TriangleAlert, cls: "text-amber-200", bar: "bg-amber-300" },
  info: { icon: Info, cls: "text-sky-300", bar: "bg-sky-300" },
} as const;

export function Toaster() {
  const list = useSyncExternalStore(
    subscribe,
    () => items,
    () => EMPTY,
  );
  return (
    <div
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-[70] flex flex-col gap-2 sm:left-auto sm:right-4 sm:w-[min(380px,calc(100vw-2rem))]"
    >
      <AnimatePresence initial={false}>
        {list.map((t) => {
          const m = meta[t.tone];
          const Icon = m.icon;
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 48, transition: { duration: 0.18 } }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              className="pointer-events-auto relative flex items-start gap-3 overflow-hidden rounded-xl border border-white/10 bg-[#10141d]/95 p-3 pl-4 shadow-2xl shadow-black/60 backdrop-blur-xl"
            >
              <span className={cx("absolute inset-y-0 left-0 w-[3px]", m.bar)} aria-hidden />
              <Icon className={cx("mt-0.5 size-4 shrink-0", m.cls)} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-slate-100">{t.title}</p>
                {t.description && <p className="num mt-0.5 line-clamp-3 break-words text-[11.5px] text-slate-400">{t.description}</p>}
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => dismissToast(t.id)}
                className="touch-target-square -m-2 inline-grid size-10 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-white/10 hover:text-slate-200 sm:-m-1 sm:size-8"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

"use client";

import type { LucideIcon } from "lucide-react";
import { useEffect, useId, useSyncExternalStore, type DependencyList } from "react";

export interface CommandItem {
  id: string;
  group: string;
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  keywords?: string;
  tone?: "default" | "danger" | "primary";
  disabled?: boolean;
  /** Shown instead of the subtitle when the command is disabled. */
  disabledReason?: string;
  run: () => unknown;
}

const sources = new Map<string, CommandItem[]>();
let snapshot: CommandItem[] = [];
const EMPTY: CommandItem[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  snapshot = [...sources.values()].flat();
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Registers this component's commands while it is mounted; `factory` re-runs when `deps` change. */
export function useCommands(factory: () => CommandItem[], deps: DependencyList): void {
  const source = useId();
  useEffect(() => {
    sources.set(source, factory());
    emit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, ...deps]);
  useEffect(
    () => () => {
      sources.delete(source);
      emit();
    },
    [source],
  );
}

export function useCommandList(): CommandItem[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY,
  );
}

let paletteOpen = false;
const paletteListeners = new Set<() => void>();
export function setPaletteOpen(open: boolean): void {
  paletteOpen = open;
  paletteListeners.forEach((l) => l());
}
export function usePaletteOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      paletteListeners.add(l);
      return () => {
        paletteListeners.delete(l);
      };
    },
    () => paletteOpen,
    () => false,
  );
}

/**
 * Scrolls to a page section (sticky header offset comes from scroll-padding-top). An explicit
 * `behavior: "smooth"` overrides the CSS reduced-motion rule, so the preference is checked here.
 */
export function scrollToSection(id: string): void {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById(id)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  history.replaceState(null, "", `#${id}`);
}

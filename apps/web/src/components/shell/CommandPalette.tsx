"use client";

import type { IntentsMode } from "@aegis/agent-swarm-sdk";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  CornerDownLeft,
  Globe,
  MousePointerClick,
  Play,
  RadioTower,
  RotateCcw,
  Search,
  SearchX,
  Wallet,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { useAegis } from "@/lib/aegis-context";
import { loadLive } from "@/lib/live-deployment";
import { connectWallet } from "@/lib/use-wallet";

import { setOverviewTab } from "../OverviewHero";
import { Kbd, cx, scrollToSection, setPaletteOpen, useCommandList, useCommands, usePaletteOpen, type CommandItem } from "../ui";

import { SECTIONS } from "./nav";

function score(item: CommandItem, q: string): number {
  if (!q) return 1;
  const title = item.title.toLowerCase();
  const hay = `${title} ${item.subtitle ?? ""} ${item.keywords ?? ""} ${item.group}`.toLowerCase();
  if (title.startsWith(q)) return 100;
  if (title.split(/\s+/).some((w) => w.startsWith(q))) return 80;
  if (hay.includes(q)) return 60;
  let i = 0;
  for (const ch of title) if (ch === q[i]) i++;
  return i === q.length ? 20 : 0;
}

/** Commands that belong to the page itself: navigation, judge mode, 1Click mode, wallet. */
function useGlobalCommands() {
  const { runScenario, reset, setMode, configure, mode, brains, agentsInfo, status, scenario, busy } = useAegis();
  useCommands(
    () => [
      ...SECTIONS.flatMap<CommandItem>((s) => [
        {
          id: `nav-${s.id}`,
          group: "Navigate",
          title: `Go to ${s.label}`,
          icon: s.icon,
          keywords: s.id,
          run: () => scrollToSection(s.id),
        },
        ...(s.subItems ?? []).map<CommandItem>((sub) => ({
          id: `nav-${sub.id}`,
          group: `Navigate: ${s.label}`,
          title: sub.label,
          icon: sub.icon ?? s.icon,
          keywords: `${s.label} ${sub.label}`,
          run: () => {
            if (sub.action) setOverviewTab(sub.action);
            scrollToSection(sub.href.replace(/^#/, ""));
          },
        })),
      ]),
      {
        id: "try-it",
        group: "Overview",
        title: "Try it: limits, a job, a poisoned invoice",
        subtitle: "The three-step walkthrough",
        icon: MousePointerClick,
        keywords: "demo walkthrough start",
        run: () => {
          setOverviewTab("try");
          scrollToSection("overview");
        },
      },
      {
        id: "live-read",
        group: "On-chain",
        title: "Read the live testnet deployment",
        subtitle: "get_dashboard, access keys and the owner DAO over public RPC",
        icon: RadioTower,
        keywords: "testnet rpc chain real refresh dao",
        run: () => {
          scrollToSection("onchain");
          void loadLive();
        },
      },
      {
        id: "judge-run",
        group: "Judge scenario",
        title: "Run judge scenario (local)",
        subtitle: "11 steps and every check against the compiled WASM, in this tab",
        icon: Play,
        tone: "primary",
        keywords: "verify scenario start judge",
        disabled: scenario.running || status !== "ready" || busy !== null,
        disabledReason: scenario.running ? "Scenario is running" : status !== "ready" ? "Runtime is loading" : "Busy",
        run: () => {
          setOverviewTab("judge");
          scrollToSection("overview");
          void runScenario();
        },
      },
      {
        id: "judge-reset",
        group: "Judge scenario",
        title: "Reset sandbox",
        subtitle: "Boot a fresh AegisSim runtime",
        icon: RotateCcw,
        disabled: scenario.running || status !== "ready" || busy !== null,
        disabledReason: "Busy",
        run: () => void reset(),
      },
      ...(
        [
          ["auto", "1Click mode: auto", "live quotes with labeled fallback", Zap],
          ["live", "1Click mode: live only", "real dry quotes from 1click.chaindefuser.com", Globe],
          ["offline", "1Click mode: offline", "deterministic quote engine, no network", WifiOff],
        ] as const
      ).map<CommandItem>(([m, title, subtitle, icon]) => ({
        id: `mode-${m}`,
        group: "Settings",
        title,
        subtitle: mode === m ? `${subtitle} · current` : subtitle,
        icon,
        keywords: "quotes intents",
        // Changing a setting restarts the sandbox, so it waits like the on-page control does.
        disabled: scenario.running || mode === m || busy !== null || status !== "ready",
        disabledReason: mode === m ? "Current mode" : scenario.running ? "Scenario is running" : "Busy",
        run: () => setMode(m as IntentsMode),
      })),
      ...(agentsInfo?.enabled
        ? (
            [
              ["nearai", "Agent models: NEAR AI Cloud", `${agentsInfo.model}, TEE-signed`],
              ["standin", "Agent models: stand-in", "deterministic local model, no TEE"],
            ] as const
          ).map<CommandItem>(([b, title, subtitle]) => ({
            id: `brains-${b}`,
            group: "Settings",
            title,
            subtitle: brains === b ? `${subtitle} · current` : subtitle,
            icon: Bot,
            keywords: "agents model inference near ai",
            disabled: scenario.running || brains === b || mode === "offline" || busy !== null || status !== "ready",
            disabledReason:
              brains === b ? "Current setting" : mode === "offline" ? "Offline mode uses the stand-in" : scenario.running ? "Scenario is running" : "Busy",
            run: () => void configure({ brains: b }),
          }))
        : []),
      { id: "wallet", group: "Settings", title: "Connect NEAR wallet", subtitle: "NEAR Connect (testnet)", icon: Wallet, run: () => void connectWallet() },
    ],
    [mode, brains, agentsInfo, status, scenario.running, busy, runScenario, reset, setMode, configure],
  );
}

export function CommandPalette() {
  useGlobalCommands();
  const open = usePaletteOpen();
  const commands = useCommandList();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }

  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => {
      clearTimeout(t);
      document.documentElement.style.overflow = prev;
      restoreFocus.current?.focus?.();
    };
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return commands
      .map((c) => ({ c, s: score(c, q) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => (q ? b.s - a.s : 0))
      .map((r) => r.c);
  }, [commands, query]);

  const groups = useMemo(() => {
    const order: string[] = [];
    const byGroup = new Map<string, CommandItem[]>();
    for (const c of results) {
      if (!byGroup.has(c.group)) {
        byGroup.set(c.group, []);
        order.push(c.group);
      }
      byGroup.get(c.group)!.push(c);
    }
    return order.map((g) => ({ group: g, items: byGroup.get(g)! }));
  }, [results]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (c: CommandItem | undefined) => {
    if (!c || c.disabled) return;
    setPaletteOpen(false);
    setTimeout(() => void c.run(), 0);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => (flat.length ? (i + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(flat[index]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setPaletteOpen(false);
    } else if (e.key === "Tab") {
      e.preventDefault();
    }
  };

  const activeId = flat[index] ? `cmd-${flat[index]!.id}` : undefined;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-start sm:px-4 sm:pt-[12vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setPaletteOpen(false)} aria-hidden />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command menu"
            initial={{ opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -8 }}
            transition={{ type: "spring", stiffness: 500, damping: 36 }}
            className="relative flex max-h-[100dvh] w-full max-w-[600px] flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-[#0d1119]/95 shadow-[0_24px_80px_-12px_rgb(0_0_0/0.8)] ring-1 ring-black/40 backdrop-blur-2xl sm:max-h-[calc(100dvh-12vh)] sm:rounded-2xl"
            onKeyDown={onKeyDown}
          >
            <div className="flex items-center gap-3 border-b border-white/[0.07] px-4">
              <Search className="size-4 text-slate-500" aria-hidden />
              <input
                ref={inputRef}
                role="combobox"
                aria-expanded="true"
                aria-controls="cmd-list"
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setIndex(0);
                }}
                placeholder="Type a command or search…"
                className="h-14 flex-1 bg-transparent text-[15px] text-slate-100 outline-none placeholder:text-slate-500 focus-visible:outline-none"
              />
              <div className="flex items-center gap-1.5">
                <Kbd className="hidden sm:inline-flex">Esc</Kbd>
                <button
                  type="button"
                  aria-label="Close command menu"
                  onClick={() => setPaletteOpen(false)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/[0.08] hover:text-white"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
            </div>
            <div ref={listRef} id="cmd-list" role="listbox" aria-label="Commands" className="min-h-0 flex-1 overflow-y-auto p-2 sm:max-h-[min(420px,60vh)]">
              {flat.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-10 text-center text-[13px] text-slate-500">
                  <SearchX className="size-5" aria-hidden />
                  No commands match “{query}”.
                </div>
              )}
              {groups.map((g) => (
                <div key={g.group} role="group" aria-label={g.group} className="mb-1">
                  <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-600">{g.group}</div>
                  {g.items.map((c) => {
                    const i = flat.indexOf(c);
                    const on = i === index;
                    const Icon = c.icon;
                    return (
                      <div
                        key={c.id}
                        id={`cmd-${c.id}`}
                        role="option"
                        aria-selected={on}
                        aria-disabled={c.disabled || undefined}
                        data-index={i}
                        onMouseMove={() => i !== index && setIndex(i)}
                        onClick={() => run(c)}
                        className={cx(
                          "touch-target flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                          on && "bg-white/[0.07]",
                          c.disabled ? "cursor-not-allowed opacity-45" : "",
                        )}
                      >
                        <span
                          className={cx(
                            "grid size-7 shrink-0 place-items-center rounded-md border",
                            c.tone === "danger"
                              ? "border-red-400/30 bg-red-500/10 text-red-300"
                              : c.tone === "primary"
                                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                                : "border-white/[0.08] bg-white/[0.04] text-slate-400",
                          )}
                        >
                          {Icon && <Icon className="size-3.5" aria-hidden />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={cx("block truncate", c.tone === "danger" ? "text-red-200" : "text-slate-100")}>{c.title}</span>
                          {(c.disabled ? c.disabledReason : c.subtitle) && (
                            <span className="block truncate text-[11.5px] text-slate-500">{c.disabled ? c.disabledReason : c.subtitle}</span>
                          )}
                        </span>
                        {on && !c.disabled && <CornerDownLeft className="size-3.5 text-slate-500" aria-hidden />}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-4 border-t border-white/[0.07] bg-white/[0.02] px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2 text-[11px] text-slate-500 sm:pb-2">
              <span className="hidden items-center gap-1 sm:flex">
                <Kbd>
                  <ArrowUp className="size-3" aria-label="Up" />
                </Kbd>
                <Kbd>
                  <ArrowDown className="size-3" aria-label="Down" />
                </Kbd>
                navigate
              </span>
              <span className="hidden items-center gap-1 sm:flex">
                <Kbd>
                  <CornerDownLeft className="size-3" aria-label="Enter" />
                </Kbd>
                run
              </span>
              <span className="ml-auto">
                {flat.length} {flat.length === 1 ? "command" : "commands"}
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

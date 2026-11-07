"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronRight, Command, ExternalLink, LogOut, Menu, OctagonAlert, Play, Search, TriangleAlert, Wallet, X } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { useAegis } from "@/lib/aegis-context";
import { useLiveDeployment } from "@/lib/live-deployment";
import { useAction } from "@/lib/use-action";
import { connectWallet, disconnectWallet, useWalletAccount } from "@/lib/use-wallet";
import { NETWORK } from "@/lib/wallet";

import { setOverviewTab } from "../OverviewHero";
import { Badge, Button, Callout, IconButton, Kbd, Spinner, StatusDot, cx, setPaletteOpen, short, type Tone } from "../ui";

import { SECTIONS, useScrollSpy, type NavSection } from "./nav";

const noSubscription = () => () => {};

/** "⌘" on Apple platforms, "Ctrl" elsewhere. The server snapshot keeps hydration consistent. */
function useModKey(): string {
  return useSyncExternalStore(
    noSubscription,
    () => (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl"),
    () => "Ctrl",
  );
}

function LogoMark({ size = 40 }: { size?: number }) {
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <span aria-hidden className="absolute inset-[18%] rounded-full bg-sky-500/30 blur-lg" />
      {/* Empty alt: the "PhalanxSwarm" name is always rendered next to the mark. */}
      <Image
        src="/logo.png"
        alt=""
        width={size}
        height={size}
        priority
        className="relative size-full object-contain drop-shadow-[0_0_10px_rgb(56_189_248/0.35)]"
      />
    </span>
  );
}

function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="bg-grid absolute inset-x-0 top-0 h-[720px]" />
      <div className="absolute -top-56 left-[8%] h-[520px] w-[720px] rounded-full bg-emerald-400/[0.07] blur-[120px]" />
      <div className="absolute -top-40 right-[-10%] h-[480px] w-[640px] rounded-full bg-sky-500/[0.06] blur-[120px]" />
      <div className="absolute bottom-[-20%] left-[30%] h-[520px] w-[720px] rounded-full bg-violet-500/[0.04] blur-[140px]" />
      <div className="bg-noise absolute inset-0 opacity-[0.035] mix-blend-overlay" />
    </div>
  );
}

function useNavCounts(): Partial<Record<NavSection["id"], { text: string; tone: Tone }>> {
  const { dashboard, activity } = useAegis();
  const live = useLiveDeployment();
  const onchain: { text: string; tone: Tone } | undefined = live.snapshot
    ? { text: live.snapshot.dashboard.paused ? "paused" : "live", tone: live.snapshot.dashboard.paused ? "red" : "emerald" }
    : live.status === "error"
      ? { text: "offline", tone: "red" }
      : undefined;
  if (!dashboard) return onchain ? { onchain } : {};
  const active = dashboard.agents.filter((a) => a.status.kind === "active").length;
  const critical = dashboard.security_events.filter((e) => e.severity === "critical").length;
  return {
    onchain,
    swarm: { text: `${active}/${dashboard.agents.length}`, tone: active === dashboard.agents.length ? "emerald" : "amber" },
    policy: dashboard.paused ? { text: "paused", tone: "red" } : critical ? { text: String(critical), tone: "red" } : { text: "live", tone: "emerald" },
    intents: dashboard.intents.length ? { text: String(dashboard.intents.length), tone: "slate" } : undefined,
    activity: activity.length ? { text: String(activity.length), tone: "slate" } : undefined,
  } as Partial<Record<NavSection["id"], { text: string; tone: Tone }>>;
}

const countTone: Record<Tone, string> = {
  emerald: "bg-emerald-400/10 text-emerald-300",
  red: "bg-red-500/15 text-red-300",
  amber: "bg-amber-400/10 text-amber-200",
  sky: "bg-sky-400/10 text-sky-300",
  violet: "bg-violet-400/10 text-violet-300",
  slate: "bg-white/[0.06] text-slate-400",
};

function Sidebar({ active }: { active: NavSection["id"] }) {
  const counts = useNavCounts();
  const mod = useModKey();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggleSection = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setExpanded((prev) => ({
      ...prev,
      [id]: !(prev[id] ?? active === id),
    }));
  };

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] flex-col border-r border-white/[0.06] bg-[#080a10]/80 backdrop-blur-xl lg:flex">
      <div className="flex h-16 shrink-0 items-center gap-3 px-5">
        <LogoMark />
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight text-white">PhalanxSwarm</div>
          <div className="text-[11.5px] text-slate-500">Command Center</div>
        </div>
      </div>

      <div className="shrink-0 px-3 pt-2 pb-1">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex h-9 w-full items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 text-left text-[12.5px] text-slate-500 transition hover:border-white/15 hover:text-slate-300"
        >
          <Search className="size-3.5" aria-hidden />
          <span className="flex-1">Search or run…</span>
          <Kbd>{mod}</Kbd>
          <Kbd>K</Kbd>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.1)_transparent]">
        <nav aria-label="Sections">
          {(["start", "explore"] as const).map((group) => (
            <div key={group} className="mb-4">
              <div className="px-2.5 pb-2 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-600">
                {group === "start" ? "Start" : "Explore"}
              </div>
              <ul className="space-y-1">
                {SECTIONS.filter((s) => s.group === group).map((s) => {
                  const on = active === s.id;
                  const c = counts[s.id];
                  const Icon = s.icon;
                  const hasSubs = Boolean(s.subItems && s.subItems.length > 0);
                  const isOpen = expanded[s.id] ?? on;

                  return (
                    <li key={s.id} className="relative">
                      <div className="flex items-center">
                        <a
                          href={`#${s.id}`}
                          aria-current={on ? "location" : undefined}
                          className={cx(
                            "relative isolate flex h-9 flex-1 min-w-0 items-center gap-2 rounded-lg px-2 text-[13px] font-medium transition-colors",
                            on ? "text-white" : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
                          )}
                        >
                          {on && (
                            <motion.span
                              layoutId="nav-active"
                              className="absolute inset-0 -z-10 rounded-lg border border-white/[0.08] bg-gradient-to-r from-emerald-400/[0.12] to-white/[0.03]"
                              transition={{ type: "spring", bounce: 0.15, duration: 0.45 }}
                            >
                              <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r bg-emerald-400" aria-hidden />
                            </motion.span>
                          )}
                          <Icon className={cx("size-4 shrink-0", on ? "text-emerald-300" : "text-slate-500")} aria-hidden />
                          <span className="flex-1 truncate">{s.label}</span>
                          {c && <span className={cx("num shrink-0 rounded-md px-1.5 text-[10.5px] leading-[18px]", countTone[c.tone])}>{c.text}</span>}
                        </a>

                        {hasSubs && (
                          <button
                            type="button"
                            onClick={(e) => toggleSection(s.id, e)}
                            aria-label={isOpen ? `Collapse ${s.label} sub-menu` : `Expand ${s.label} sub-menu`}
                            className="ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-300"
                          >
                            {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                          </button>
                        )}
                      </div>

                      {hasSubs && isOpen && (
                        <ul className="ml-5 mt-1 mb-2 space-y-0.5 border-l border-white/[0.08] pl-2">
                          {s.subItems!.map((sub) => {
                            const SubIcon = sub.icon;
                            return (
                              <li key={sub.id}>
                                <a
                                  href={sub.href}
                                  onClick={() => {
                                    if (sub.action) {
                                      setOverviewTab(sub.action);
                                    }
                                  }}
                                  className="group flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-slate-400 transition hover:bg-white/[0.04] hover:text-white"
                                >
                                  {SubIcon && <SubIcon className="size-3 shrink-0 text-slate-500 group-hover:text-slate-300" />}
                                  <span className="truncate">{sub.label}</span>
                                </a>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </div>
    </aside>
  );
}

function WalletButton() {
  const account = useWalletAccount();
  if (account) {
    return (
      <div className="flex h-8.5 sm:h-9 min-w-0 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] pl-2 sm:pl-2.5">
        <StatusDot tone="emerald" />
        <span className="num max-w-16 truncate text-[11.5px] sm:text-[12.5px] text-slate-200 sm:max-w-40" title={account}>
          {short(account, 16, 0)}
        </span>
        <IconButton icon={LogOut} label="Disconnect wallet" onClick={() => void disconnectWallet()} className="size-7 sm:size-8" />
      </div>
    );
  }
  return (
    <Button
      icon={Wallet}
      size="sm"
      className="h-8.5 px-2.5 text-[12px] sm:h-9 sm:px-3 sm:text-[12.5px] max-sm:min-h-0 max-sm:py-0"
      onClick={() => void connectWallet()}
    >
      <span className="hidden sm:inline">Connect NEAR wallet</span>
      <span className="sm:hidden">Connect</span>
    </Button>
  );
}

function Topbar({ active, onOpenMobileMenu, mobileOpen }: { active: NavSection["id"]; onOpenMobileMenu: () => void; mobileOpen: boolean }) {
  const { status, busy } = useAegis();
  const section = SECTIONS.find((s) => s.id === active);
  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#07090e]/80 backdrop-blur-xl">
      <div className="flex h-14 sm:h-16 min-w-0 items-center gap-2 px-3 sm:gap-3 sm:px-6 lg:px-8">
        <div className="flex shrink-0 items-center gap-2 lg:hidden">
          <LogoMark size={28} />
          <span className="text-[14px] font-semibold tracking-tight text-white max-[359px]:hidden">PhalanxSwarm</span>
        </div>
        <nav aria-label="Breadcrumb" className="hidden items-center gap-1.5 text-[13px] lg:flex">
          <span className="text-slate-500">Command Center</span>
          <ChevronRight className="size-3.5 text-slate-600" aria-hidden />
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={active}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
              className="font-medium text-slate-100"
            >
              {section?.label}
            </motion.span>
          </AnimatePresence>
        </nav>

        <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
          {/* Mobile search / commands button */}
          <button
            type="button"
            aria-label="Open command menu"
            onClick={() => setPaletteOpen(true)}
            className="flex size-8.5 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-slate-400 transition hover:bg-white/[0.08] hover:text-white lg:hidden"
          >
            <Command className="size-3.5" aria-hidden />
          </button>

          {/* Only while something happens: the idle state lives in the demo's "Local contract" menu. */}
          <div aria-live="polite" className="hidden min-w-0 items-center md:flex">
            {busy ? (
              <Badge tone="sky" className="gap-2">
                <Spinner className="size-3" />
                <span className="max-w-56 truncate">{busy}…</span>
              </Badge>
            ) : status !== "ready" ? (
              <Badge tone={status === "error" ? "red" : "amber"} className="gap-2">
                <StatusDot tone={status === "error" ? "red" : "amber"} pulse={status === "loading"} />
                {status === "error" ? "Runtime error" : "Starting local contract…"}
              </Badge>
            ) : null}
          </div>
          <span className="hidden 2xl:inline-flex">
            <Badge tone="violet">{NETWORK}</Badge>
          </span>
          <WalletButton />

          {/* Mobile full menu drawer toggle */}
          <button
            type="button"
            aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
            onClick={onOpenMobileMenu}
            className={cx(
              "flex size-8.5 shrink-0 items-center justify-center rounded-lg border transition lg:hidden",
              mobileOpen
                ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                : "border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] hover:text-white",
            )}
          >
            {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </div>
    </header>
  );
}

function MobileNav({ active }: { active: NavSection["id"] }) {
  const listRef = useRef<HTMLUListElement>(null);
  const counts = useNavCounts();

  useEffect(() => {
    const list = listRef.current;
    const link = list?.querySelector<HTMLAnchorElement>(`a[href="#${active}"]`);
    if (!list || !link) return;
    const left = link.offsetLeft - (list.clientWidth - link.offsetWidth) / 2;
    list.scrollTo({ left: Math.max(0, left), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [active]);

  return (
    <nav aria-label="Sections" className="sticky top-14 sm:top-16 z-20 border-b border-white/[0.08] bg-[#07090e]/90 backdrop-blur-xl lg:hidden">
      <div className="relative flex items-center">
        <div aria-hidden className="pointer-events-none absolute left-0 inset-y-0 w-3 bg-gradient-to-r from-[#07090e] to-transparent z-10" />
        <ul ref={listRef} className="flex w-full gap-1.5 overflow-x-auto px-3 py-1.5 [scrollbar-width:none]">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const on = active === s.id;
            const c = counts[s.id];
            return (
              <li key={s.id} className="shrink-0">
                <a
                  href={`#${s.id}`}
                  aria-current={on ? "location" : undefined}
                  className={cx(
                    "flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[12px] font-medium transition-all",
                    on
                      ? "border border-emerald-400/35 bg-emerald-400/15 text-emerald-300 shadow-sm shadow-emerald-950/40"
                      : "border border-transparent text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
                  )}
                >
                  <Icon className={cx("size-3.5 shrink-0", on ? "text-emerald-300" : "text-slate-500")} aria-hidden />
                  <span>{s.label}</span>
                  {c && <span className={cx("num rounded px-1 text-[10px] leading-4", countTone[c.tone])}>{c.text}</span>}
                </a>
              </li>
            );
          })}
        </ul>
        <div aria-hidden className="pointer-events-none absolute right-0 inset-y-0 w-3 bg-gradient-to-l from-[#07090e] to-transparent z-10" />
      </div>
    </nav>
  );
}

function MobileDrawer({ open, onClose, active }: { open: boolean; onClose: () => void; active: NavSection["id"] }) {
  const counts = useNavCounts();
  const mod = useModKey();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggleSection = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setExpanded((prev) => ({
      ...prev,
      [id]: !(prev[id] ?? active === id),
    }));
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex flex-col bg-black/75 backdrop-blur-md lg:hidden"
        >
          <div className="absolute inset-0" onClick={onClose} aria-hidden />
          <motion.div
            initial={{ y: -16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -16, opacity: 0 }}
            transition={{ type: "spring", bounce: 0.1, duration: 0.3 }}
            className="relative z-10 flex max-h-[85vh] w-full flex-col overflow-hidden border-b border-white/10 bg-[#0a0d14] shadow-2xl"
          >
            <div className="flex h-14 items-center justify-between border-b border-white/[0.08] px-4">
              <div className="flex items-center gap-2.5">
                <LogoMark size={28} />
                <span className="text-[14px] font-semibold text-white">PhalanxSwarm Menu</span>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close menu"
                className="flex size-8.5 items-center justify-center rounded-lg border border-white/10 text-slate-400 hover:bg-white/[0.06] hover:text-white"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="p-3">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  setPaletteOpen(true);
                }}
                className="flex h-9 w-full items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-left text-[12.5px] text-slate-500 transition hover:border-white/15 hover:text-slate-300"
              >
                <Search className="size-3.5" aria-hidden />
                <span className="flex-1">Search or run command…</span>
                <Kbd>{mod}</Kbd>
                <Kbd>K</Kbd>
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4 [scrollbar-width:thin]">
              <nav aria-label="Mobile Navigation">
                {(["start", "explore"] as const).map((group) => (
                  <div key={group} className="mb-4">
                    <div className="px-2.5 pb-2 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                      {group === "start" ? "Start" : "Explore"}
                    </div>
                    <ul className="space-y-1">
                      {SECTIONS.filter((s) => s.group === group).map((s) => {
                        const on = active === s.id;
                        const c = counts[s.id];
                        const Icon = s.icon;
                        const hasSubs = Boolean(s.subItems && s.subItems.length > 0);
                        const isOpen = expanded[s.id] ?? on;

                        return (
                          <li key={s.id} className="relative">
                            <div className="flex items-center">
                              <a
                                href={`#${s.id}`}
                                onClick={onClose}
                                className={cx(
                                  "flex h-9 flex-1 min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors",
                                  on ? "border border-emerald-400/30 bg-emerald-400/10 text-emerald-200" : "text-slate-300 hover:bg-white/[0.04]",
                                )}
                              >
                                <Icon className={cx("size-4 shrink-0", on ? "text-emerald-300" : "text-slate-500")} />
                                <span className="flex-1 truncate">{s.label}</span>
                                {c && <span className={cx("num shrink-0 rounded px-1.5 text-[10px] leading-4", countTone[c.tone])}>{c.text}</span>}
                              </a>
                              {hasSubs && (
                                <button
                                  type="button"
                                  onClick={(e) => toggleSection(s.id, e)}
                                  className="ml-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:text-white"
                                >
                                  {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                                </button>
                              )}
                            </div>

                            {hasSubs && isOpen && (
                              <ul className="ml-5 mt-1 mb-2 space-y-0.5 border-l border-white/[0.08] pl-2.5">
                                {s.subItems!.map((sub) => {
                                  const SubIcon = sub.icon;
                                  return (
                                    <li key={sub.id}>
                                      <a
                                        href={sub.href}
                                        onClick={() => {
                                          if (sub.action) setOverviewTab(sub.action);
                                          onClose();
                                        }}
                                        className="group flex h-7 items-center gap-2 rounded-md px-2 text-[12px] text-slate-400 hover:bg-white/[0.04] hover:text-white"
                                      >
                                        {SubIcon && <SubIcon className="size-3 shrink-0 text-slate-500 group-hover:text-slate-300" />}
                                        <span className="truncate">{sub.label}</span>
                                      </a>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </nav>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PausedBanner() {
  const { dashboard, runtime, busy } = useAegis();
  const action = useAction();
  return (
    <AnimatePresence initial={false}>
      {dashboard?.paused && runtime && (
        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
          <div role="alert" className="border-b border-red-400/30 bg-gradient-to-r from-red-500/20 via-red-500/10 to-red-500/20">
            <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 sm:px-6 lg:px-8">
              <span className="grid size-7 place-items-center rounded-lg bg-red-500/20 text-red-300 ring-1 ring-red-400/40">
                <OctagonAlert className="size-4" aria-hidden />
              </span>
              <p className="min-w-0 flex-1 text-[13px] text-red-100">
                <strong className="font-semibold">Protocol paused</strong>
                <span className="text-red-200/80">
                  {" "}
                  · every agent spend is rejected until the owner resumes. Sentinels can pause; only the owner can resume.
                </span>
              </p>
              <Button
                className="w-full sm:w-auto"
                size="sm"
                variant="primary"
                icon={Play}
                disabled={busy !== null}
                onClick={() =>
                  void action("owner resumes protocol", runtime.owner, "set_protocol_paused", (rt) => rt.setPaused(false, "owner review complete"))
                }
              >
                Resume protocol
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const active = useScrollSpy();
  const { error } = useAegis();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="relative min-h-screen">
      <Backdrop />
      <a
        href="#main"
        className="sr-only z-[80] rounded-md bg-emerald-400 px-3 py-2 text-sm font-semibold text-black focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <Sidebar active={active} />
      <div className="lg:pl-[248px]">
        <Topbar active={active} onOpenMobileMenu={() => setMobileMenuOpen((o) => !o)} mobileOpen={mobileMenuOpen} />
        <MobileNav active={active} />
        <MobileDrawer open={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)} active={active} />
        <PausedBanner />
        <main id="main" className="mx-auto flex max-w-[1400px] flex-col gap-10 px-3 py-5 min-[380px]:px-4 sm:gap-12 sm:px-6 sm:py-8 lg:px-8">
          <h1 className="sr-only">PhalanxSwarm Command Center</h1>
          {error && (
            <Callout tone="red" icon={TriangleAlert} title="Runtime error">
              <span className="num">{error}</span>
            </Callout>
          )}
          {children}
        </main>
        <footer className="mx-auto flex max-w-[1400px] flex-col items-start gap-3 border-t border-white/[0.06] px-3 py-6 text-[12px] text-slate-500 min-[380px]:px-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <span className="font-medium text-slate-400">Built at NEAR HACKATHON</span>
          <a
            href="https://github.com/AmirMP12/PhalanxSwarm"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-slate-300 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
          >
            <svg className="size-4 shrink-0 fill-current text-slate-300" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
              />
            </svg>
            <span className="font-mono text-[12px]">AmirMP12/PhalanxSwarm</span>
            <ExternalLink className="size-3 text-slate-500" aria-hidden />
          </a>
        </footer>
      </div>
    </div>
  );
}

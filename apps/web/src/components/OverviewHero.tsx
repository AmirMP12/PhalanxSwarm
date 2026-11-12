"use client";

import { Cpu, ExternalLink, FlaskConical, Globe, KeyRound, Lock, MousePointerClick, Rocket, ShieldAlert, Sparkles } from "lucide-react";
import { useSyncExternalStore } from "react";

import { JudgeMode } from "./JudgeModeBar";
import { RuntimeMenu } from "./shell/RuntimeMenu";
import { TryIt } from "./TryIt";
import { Button, SegmentedControl } from "./ui";

export type OverviewTab = "try" | "judge";

let current: OverviewTab = "try";
const listeners = new Set<() => void>();

/** Switches the overview between the product walkthrough and the judge scenario (also used by the command palette). */
export function setOverviewTab(tab: OverviewTab): void {
  current = tab;
  listeners.forEach((l) => l());
}

function useOverviewTab(): OverviewTab {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => "try",
  );
}

export function OverviewHero() {
  const tab = useOverviewTab();

  return (
    <div className="min-w-0 space-y-6">
      {/* Consumer-Grade Hero Showcase Banner */}
      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-[#0e131f]/90 via-[#0a0d15]/95 to-[#07090e] p-6 sm:p-8 lg:p-10 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.8)] backdrop-blur-xl">
        {/* Ambient lighting glows */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 h-80 w-[600px] rounded-full bg-emerald-500/15 blur-[120px]"
        />
        <div aria-hidden className="pointer-events-none absolute -bottom-20 -right-20 h-64 w-64 rounded-full bg-sky-500/10 blur-[90px]" />
        <div aria-hidden className="pointer-events-none absolute -bottom-20 -left-20 h-64 w-64 rounded-full bg-violet-500/10 blur-[90px]" />

        {/* Top telemetry & hackathon status pills */}
        <div className="relative flex flex-wrap items-center justify-between gap-3 pb-6 border-b border-white/[0.07]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[11.5px] font-semibold text-emerald-300 shadow-[0_0_14px_rgba(0,236,151,0.25)]">
              <Sparkles className="size-3.5 text-emerald-400" />
              NEAR HACKATHON 2026
            </span>

            <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11.5px] text-slate-400">
              <Cpu className="size-3.5 text-slate-400" />
              Intel TDX Verified
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-slate-400">
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
              </span>
              Live on testnet:{" "}
              <a
                href="https://testnet.nearblocks.io/address/phalanx-v3d4.phalanxswarm.testnet"
                target="_blank"
                rel="noreferrer"
                className="font-mono text-emerald-300 hover:text-emerald-200 hover:underline flex items-center gap-1"
              >
                phalanx-v3d4
                <ExternalLink className="size-3" />
              </a>
              <span className="text-slate-600">·</span>
              <span
                className="text-slate-500"
                title="Two agents were quarantined by the circuit breaker during the recorded testnet run, and one third-party agent's key was deleted. That is the product working, not a fault: see the Security panel."
              >
                2 quarantined by the breaker
              </span>
            </span>
          </div>
        </div>

        {/* Hero Headline & Value Proposition */}
        <div className="relative pt-6 max-w-4xl">
          <h1 className="text-balance text-3xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-white leading-[1.08]">
            The Zero-Trust Treasury Firewall{" "}
            <span className="block mt-1 bg-gradient-to-r from-emerald-400 via-teal-300 to-sky-400 bg-clip-text text-transparent drop-shadow-sm">
              for Autonomous AI Agents
            </span>
          </h1>
          <p className="mt-4 text-balance text-sm sm:text-base lg:text-[17px] leading-relaxed text-slate-300 font-normal">
            A TEE signature proves which model answered, but not what it was asked. PhalanxSwarm enforces on-chain DAO-pinned system prompt hashes and
            contract-synthesized audit facts, neutralizing prompt injection and revoking keys in the same transaction at the protocol consensus layer.
          </p>
        </div>

        {/* 4 Core Architectural Proof Pillars */}
        <div className="relative mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          <div className="group rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 transition-all duration-200 hover:border-emerald-400/40 hover:bg-emerald-500/[0.04]">
            <div className="flex items-center justify-between">
              <span className="grid size-9 place-items-center rounded-xl bg-emerald-400/10 text-emerald-300 border border-emerald-400/20">
                <ShieldAlert className="size-4.5" />
              </span>
              <span className="font-mono text-[11px] font-bold text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full">24/24 STOPPED</span>
            </div>
            <h2 className="mt-3 text-[14px] font-semibold text-white tracking-tight">Prompt Injection Defense</h2>
            <p className="mt-1 text-[12px] text-slate-400 leading-snug">
              100% of injection attacks stopped across 12 vectors and 3 production LLMs with 0 NEAR stolen.
            </p>
          </div>

          <div className="group rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 transition-all duration-200 hover:border-sky-400/40 hover:bg-sky-500/[0.04]">
            <div className="flex items-center justify-between">
              <span className="grid size-9 place-items-center rounded-xl bg-sky-400/10 text-sky-300 border border-sky-400/20">
                <KeyRound className="size-4.5" />
              </span>
              <span className="font-mono text-[11px] font-bold text-sky-400 bg-sky-400/10 px-2 py-0.5 rounded-full">PROTOCOL LEVEL</span>
            </div>
            <h2 className="mt-3 text-[14px] font-semibold text-white tracking-tight">Autonomous Circuit Breaker</h2>
            <p className="mt-1 text-[12px] text-slate-400 leading-snug">
              Attacking transaction executes <code className="text-sky-300 font-mono text-[11px]">Promise::delete_key</code>, killing access immediately.
            </p>
          </div>

          <div className="group rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 transition-all duration-200 hover:border-violet-400/40 hover:bg-violet-500/[0.04]">
            <div className="flex items-center justify-between">
              <span className="grid size-9 place-items-center rounded-xl bg-violet-400/10 text-violet-300 border border-violet-400/20">
                <Lock className="size-4.5" />
              </span>
              <span className="font-mono text-[11px] font-bold text-violet-400 bg-violet-400/10 px-2 py-0.5 rounded-full">UNSTEERABLE</span>
            </div>
            <h2 className="mt-3 text-[14px] font-semibold text-white tracking-tight">Contract-Built Audit Facts</h2>
            <p className="mt-1 text-[12px] text-slate-400 leading-snug">
              Prevents the agent from forging audit evidence. The contract verifies both prompt hash and evidence hash.
            </p>
          </div>

          <div className="group rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 transition-all duration-200 hover:border-teal-400/40 hover:bg-teal-500/[0.04]">
            <div className="flex items-center justify-between">
              <span className="grid size-9 place-items-center rounded-xl bg-teal-400/10 text-teal-300 border border-teal-400/20">
                <Globe className="size-4.5" />
              </span>
              <span className="font-mono text-[11px] font-bold text-teal-400 bg-teal-400/10 px-2 py-0.5 rounded-full">CHAIN ABSTRACTION</span>
            </div>
            <h2 className="mt-3 text-[14px] font-semibold text-white tracking-tight">Chain Signatures &amp; Intents</h2>
            <p className="mt-1 text-[12px] text-slate-400 leading-snug">
              EIP-1559 MPC execution confirmed on Base Sepolia, with 1Click dry quotes bound to each signed request. No agent holds an EVM key.
            </p>
          </div>
        </div>

        {/* Live Metrics Ribbon */}
        <div className="relative mt-7 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/[0.06] bg-black/40 px-5 py-3.5 backdrop-blur-md">
          <div className="flex flex-wrap items-center gap-6 sm:gap-8">
            <div className="flex flex-col">
              <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Funds Stolen</span>
              <span className="num text-[17px] font-bold text-emerald-400">0 NEAR</span>
            </div>
            <div className="h-7 w-px bg-white/10 hidden sm:block" />
            <div className="flex flex-col">
              <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Automated Tests</span>
              <span className="num text-[17px] font-bold text-white">200 Total</span>
            </div>
            <div className="h-7 w-px bg-white/10 hidden sm:block" />
            <div className="flex flex-col">
              <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Testnet Evidence</span>
              <span className="num text-[17px] font-bold text-white">65 Verified TXs</span>
            </div>
            <div className="h-7 w-px bg-white/10 hidden sm:block" />
            <div className="flex flex-col">
              <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Governance</span>
              <span className="num text-[17px] font-bold text-white">2-of-3 SputnikDAO</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <a
              href="https://github.com/AmirMP12/PhalanxSwarm"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-slate-400 hover:text-white transition-colors"
            >
              GitHub Repository
              <ExternalLink className="size-3.5" />
            </a>
          </div>
        </div>
      </div>

      {/* Interactive Controls & Scenario Switcher Bar */}
      <div className="relative z-20 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-2xl border border-white/10 bg-[#0c1018]/90 p-3 sm:p-4 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <SegmentedControl<OverviewTab>
            label="Interactive Demo Mode"
            value={tab}
            onChange={setOverviewTab}
            fullWidth
            className="w-full sm:w-auto"
            options={[
              {
                value: "try",
                label: "Guided 3-Step Demo",
                icon: MousePointerClick,
                hint: "Experience key deletion, forged facts rejection, and DAO challenge window in action",
              },
              {
                value: "judge",
                label: "Full Judge Scenario (11 Steps)",
                icon: FlaskConical,
                hint: "Execute all 11 end-to-end hackathon verification stages with in-browser PhalanxSim",
              },
            ]}
          />
        </div>

        <div className="flex items-center gap-2.5 self-end sm:self-auto">
          {/* One primary action: run the attack demo, the fastest route to the thesis. Deployment
              is a secondary link, not the thing a judge should click first. */}
          <Button variant="primary" size="sm" icon={MousePointerClick} onClick={() => setOverviewTab("try")}>
            Run the attack demo
          </Button>
          <Button
            as="a"
            href="https://github.com/AmirMP12/PhalanxSwarm/blob/main/docs/QUICKSTART.md"
            target="_blank"
            rel="noopener noreferrer"
            variant="ghost"
            size="sm"
            icon={Rocket}
          >
            Deploy in 10 Min
          </Button>
          <RuntimeMenu />
        </div>
      </div>

      {/* Step Execution Area */}
      <div className="relative z-10 min-w-0">{tab === "try" ? <TryIt /> : <JudgeMode />}</div>
    </div>
  );
}

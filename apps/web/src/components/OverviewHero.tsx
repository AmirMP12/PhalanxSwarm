"use client";

import type { IntentsMode } from "@aegis/agent-swarm-sdk";
import { Bot, FlaskConical, Globe, MousePointerClick, WifiOff, Zap } from "lucide-react";
import { useSyncExternalStore } from "react";

import { useAegis, type AgentBrains } from "@/lib/aegis-context";

import { JudgeMode } from "./JudgeModeBar";
import { TryIt } from "./TryIt";
import { Badge, SegmentedControl, Tooltip } from "./ui";

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

/** 1Click quote mode and agent models. Changing either restarts the sandbox with the new setting. */
function SandboxSettings() {
  const { mode, brains, agentsInfo, configure, scenario, busy, status } = useAegis();
  const disabled = scenario.running || busy !== null || status !== "ready";
  return (
    <div className="flex min-w-0 w-full lg:w-auto flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2.5 sm:gap-3 rounded-xl border border-white/[0.07] bg-[#0c1018]/80 p-2 sm:p-0 sm:border-0 sm:bg-transparent text-[12px]">
      <div className="flex min-w-0 flex-col min-[380px]:flex-row min-[380px]:items-center justify-between gap-1.5 sm:gap-2">
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-slate-400 sm:text-[12px] sm:normal-case sm:tracking-normal sm:text-slate-500">
          1Click quotes
        </span>
        <SegmentedControl<IntentsMode>
          label="1Click quote mode"
          value={mode}
          onChange={(m) => void configure({ mode: m })}
          disabled={disabled}
          size="sm"
          fullWidth
          className="w-full sm:w-auto"
          options={[
            { value: "auto", label: "Auto", icon: Zap, hint: "Live dry quotes; a labeled offline engine if 1Click is unreachable" },
            { value: "live", label: "Live only", icon: Globe, hint: "Live dry quotes only; fails if 1Click is unreachable" },
            { value: "offline", label: "Offline", icon: WifiOff, hint: "Deterministic offline quotes and stand-in agents: the sandbox makes no network calls" },
          ]}
        />
      </div>
      <div className="flex min-w-0 flex-col min-[380px]:flex-row min-[380px]:items-center justify-between gap-1.5 sm:gap-2">
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-slate-400 sm:text-[12px] sm:normal-case sm:tracking-normal sm:text-slate-500">
          Agent models
        </span>
        {agentsInfo?.enabled ? (
          <SegmentedControl<AgentBrains>
            label="Agent models"
            value={mode === "offline" ? "standin" : brains}
            onChange={(b) => void configure({ brains: b })}
            disabled={disabled || mode === "offline"}
            size="sm"
            fullWidth
            className="w-full sm:w-auto"
            options={[
              {
                value: "nearai",
                label: agentsInfo.provider === "nearai" ? "NEAR AI Cloud" : "Live LLM",
                icon: Bot,
                hint: `${agentsInfo.model}: ${agentsInfo.provider === "nearai" ? "TEE-signed completions" : "Live model reasoning"}, verified on-chain`,
              },
              { value: "standin", label: "Stand-in", hint: "Deterministic local model with the same signed format (no TEE)" },
            ]}
          />
        ) : (
          <Tooltip content="Set NEARAI_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY for live models. Without a key, agents use the deterministic stand-in.">
            <span tabIndex={0}>
              <Badge tone="amber" dot>
                stand-in (no TEE)
              </Badge>
            </span>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

export function OverviewHero() {
  const tab = useOverviewTab();
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SegmentedControl<OverviewTab>
          label="Overview"
          value={tab}
          onChange={setOverviewTab}
          fullWidth
          className="w-full sm:w-auto"
          options={[
            {
              value: "try",
              label: "Guided demo",
              icon: MousePointerClick,
              hint: "Three steps: a fooled agent loses its key, an approval over invented facts is rejected, a new vendor waits for the DAO",
            },
            { value: "judge", label: "Judge scenario", icon: FlaskConical, hint: "All 11 steps with every check" },
          ]}
        />
        <SandboxSettings />
      </div>
      {tab === "try" ? <TryIt /> : <JudgeMode />}
    </div>
  );
}

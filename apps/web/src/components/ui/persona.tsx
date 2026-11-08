"use client";

import type { AgentRecordT, PersonaId } from "@phalanx/agent-swarm-sdk";
import { Cpu, ShieldCheck, Skull, TrendingUp, Workflow, type LucideIcon } from "lucide-react";
import { useCallback } from "react";

import { usePhalanx } from "@/lib/phalanx-context";

import { cx } from "./format";
import type { Tone } from "./primitives";

export const PERSONAS: PersonaId[] = ["nexus", "rhea", "sentinel", "cipher", "mallory"];

export const PERSONA_META: Record<PersonaId, { hex: string; icon: LucideIcon; role: string }> = {
  nexus: { hex: "#7dd3fc", icon: Workflow, role: "Orchestrator" },
  rhea: { hex: "#fcd34d", icon: TrendingUp, role: "Yield strategist" },
  sentinel: { hex: "#c4b5fd", icon: ShieldCheck, role: "Sentinel" },
  cipher: { hex: "#5eead4", icon: Cpu, role: "Compute worker" },
  mallory: { hex: "#f9a8d4", icon: Skull, role: "Third-party worker" },
};

/** Agent handles are the same in the sandbox and on testnet (`<handle>.<contract>`). */
const HANDLE_PERSONA: Record<string, PersonaId> = {
  "nexus-orchestrator": "nexus",
  "rhea-yield-strategist": "rhea",
  "phalanx-sentinel": "sentinel",
  "cipher-compute-worker": "cipher",
  "mallory-ap-agent": "mallory",
};

export function personaForHandle(handle: string | null | undefined): PersonaId | undefined {
  return handle ? HANDLE_PERSONA[handle] : undefined;
}

export type AgentStatusKind = AgentRecordT["status"]["kind"];

export function statusTone(kind: AgentStatusKind | undefined): Tone {
  return kind === "active" ? "emerald" : kind === "quarantined" ? "red" : kind === "provisioning" ? "amber" : "slate";
}

const statusRing: Record<Tone, string> = {
  emerald: "bg-emerald-400",
  red: "bg-red-400",
  amber: "bg-amber-300",
  sky: "bg-sky-300",
  violet: "bg-violet-300",
  slate: "bg-slate-500",
};

export function PersonaAvatar({ persona, size = 32, status, className }: { persona: PersonaId; size?: number; status?: AgentStatusKind; className?: string }) {
  const m = PERSONA_META[persona];
  const Icon = m.icon;
  return (
    <span
      className={cx("relative grid shrink-0 place-items-center rounded-[10px] border", className)}
      style={{
        width: size,
        height: size,
        borderColor: `${m.hex}55`,
        background: `linear-gradient(140deg, ${m.hex}38, ${m.hex}0d 70%)`,
        color: m.hex,
        boxShadow: `0 0 18px -6px ${m.hex}88`,
      }}
      aria-hidden
    >
      <Icon style={{ width: size * 0.5, height: size * 0.5 }} />
      {status && <span className={cx("absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-[#0b0e15]", statusRing[statusTone(status)])} />}
    </span>
  );
}

/** Maps an on-chain account id back to its persona (for avatars in tables and lists). */
export function usePersonaOf(): (accountId: string | null | undefined) => PersonaId | undefined {
  const { runtime } = usePhalanx();
  return useCallback(
    (accountId) => {
      if (!runtime || !accountId) return undefined;
      return PERSONAS.find((p) => runtime.agents[p].accountId === accountId);
    },
    [runtime],
  );
}

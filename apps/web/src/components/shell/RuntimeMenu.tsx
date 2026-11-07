"use client";

import type { IntentsMode } from "@aegis/agent-swarm-sdk";
import { ArrowRight, Bot, Globe, Settings2, WifiOff, Zap } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useAegis, type AgentBrains } from "@/lib/aegis-context";

import { Badge, SegmentedControl, StatusDot, cx, short, type Tone } from "../ui";

/** 1Click quote mode and agent models. Changing either restarts the sandbox with the new setting. */
function SandboxSettings() {
  const { mode, brains, agentsInfo, configure, scenario, busy, status } = useAegis();
  const disabled = scenario.running || busy !== null || status !== "ready";
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="text-[11.5px] font-medium text-slate-400">1Click quotes</div>
        <SegmentedControl<IntentsMode>
          label="1Click quote mode"
          value={mode}
          onChange={(m) => void configure({ mode: m })}
          disabled={disabled}
          size="sm"
          fullWidth
          options={[
            { value: "auto", label: "Auto", icon: Zap, hint: "Live dry quotes; a labeled offline engine if 1Click is unreachable" },
            { value: "live", label: "Live only", icon: Globe, hint: "Live dry quotes only; fails if 1Click is unreachable" },
            { value: "offline", label: "Offline", icon: WifiOff, hint: "Deterministic offline quotes and stand-in agents: the sandbox makes no network calls" },
          ]}
        />
      </div>
      <div className="space-y-1.5">
        <div className="text-[11.5px] font-medium text-slate-400">Agent models</div>
        {agentsInfo?.enabled ? (
          <SegmentedControl<AgentBrains>
            label="Agent models"
            value={mode === "offline" ? "standin" : brains}
            onChange={(b) => void configure({ brains: b })}
            disabled={disabled || mode === "offline"}
            size="sm"
            fullWidth
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
          <p className="text-[11.5px] leading-relaxed text-slate-500">
            <Badge tone="amber" dot>
              stand-in (no TEE)
            </Badge>{" "}
            Set NEARAI_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY for live models. Without a key, agents use the deterministic stand-in.
          </p>
        )}
      </div>
      <p className="text-[11px] text-slate-500">Changing a setting restarts the local contract.</p>
    </div>
  );
}

function RuntimeDetails() {
  const { wasm, dashboard, mode, inference, agentsInfo } = useAegis();
  const live = inference === "nearai" || inference === "generic_llm";
  const rows: Array<[string, string]> = [
    ["wasm", wasm ? `${Math.round(wasm.size / 1024)} KB` : "—"],
    ["sha256", wasm ? short(wasm.sha256, 6, 4) : "—"],
    ["block", dashboard ? `#${dashboard.block_height}` : "—"],
    ["1Click", `${mode} · dry`],
    [
      "agents",
      inference === "nearai" ? "NEAR AI Cloud" : inference === "generic_llm" ? "live LLM (no TEE)" : inference === "standin" ? "stand-in (no TEE)" : "—",
    ],
    ...(live && agentsInfo?.model ? ([["model", short(agentsInfo.model, 24, 0)]] as Array<[string, string]>) : []),
  ];
  const agentTone = inference === "nearai" ? "text-emerald-300" : inference === "generic_llm" ? "text-sky-300" : "text-amber-200";
  return (
    <dl className="num space-y-1 text-[11px]">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3">
          <dt className="text-slate-500">{k}</dt>
          <dd className={cx("min-w-0 truncate text-right", k === "agents" ? agentTone : "text-slate-300")} title={v}>
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The one place for how the demo runs: status, the sandbox settings and runtime details. */
export function RuntimeMenu({ className }: { className?: string }) {
  const { status } = useAegis();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const tone: Tone = status === "ready" ? "emerald" : status === "error" ? "red" : "amber";
  return (
    <div ref={root} className={cx("relative", className)}>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        title="Local contract: status and settings"
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "touch-target inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-[12.5px] font-medium transition",
          open ? "border-white/20 bg-white/[0.08] text-white" : "border-white/10 bg-white/[0.03] text-slate-300 hover:border-white/20 hover:text-white",
        )}
      >
        <StatusDot tone={tone} pulse={status === "loading"} />
        {status === "ready" ? "Local contract" : status === "error" ? "Local contract failed" : "Starting local contract…"}
        <Settings2 className="size-3.5 text-slate-400" aria-hidden />
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute right-0 top-full z-40 mt-2 w-[min(22rem,calc(100vw-1.5rem))] space-y-3 rounded-xl border border-white/10 bg-[#0c1018] p-3.5 text-left shadow-2xl shadow-black/60"
      >
        <p className="text-[12px] leading-relaxed text-slate-400">
          This tab runs the compiled contract (<span className="num text-slate-300">aegis_core.wasm</span>) locally, in your browser. The same steps also ran on
          NEAR testnet; each step&apos;s details link to its transaction.
        </p>
        <SandboxSettings />
        <div className="border-t border-white/[0.06] pt-3">
          <RuntimeDetails />
        </div>
        <a href="#onchain" onClick={() => setOpen(false)} className="inline-flex items-center gap-1 text-[12px] text-sky-300 hover:text-sky-200">
          Live testnet state <ArrowRight className="size-3" aria-hidden />
        </a>
      </div>
    </div>
  );
}

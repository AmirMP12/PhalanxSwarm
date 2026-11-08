"use client";

/**
 * Browser runtime: loads /phalanx_core.wasm, boots the PhalanxSim VM with the swarm, and exposes the
 * contract dashboard plus actions to every panel. The judge scenario replaces the runtime with a
 * fresh one and replays every judge step.
 *
 * Agent models: when the server has NEARAI_API_KEY, agents think through /api/agents/complete
 * (NEAR AI Cloud, TEE-signed completions) and each signing key is registered on-chain only after
 * /api/tee/attest verifies its model attestation. Otherwise they use the labeled offline stand-in.
 * If a live call fails, that call falls back to the stand-in and a toast says so.
 */
import { toast } from "@/components/ui/toast";
import {
  DEFAULT_NEARAI_MODEL,
  runJudgeScenario,
  sha256Hex,
  SwarmRuntime,
  toTxRecord,
  type AttestationResultT,
  type CallResult,
  type DashboardT,
  type IntentsMode,
  type ModelAttestationResult,
  type RuntimeOptions,
  type Signer,
  type StepReport,
  type TxRecord,
} from "@phalanx/agent-swarm-sdk";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface ActivityItem extends TxRecord {
  id: number;
  at: number;
}

export interface ScenarioState {
  running: boolean;
  steps: StepReport[];
  activeIndex: number | null;
  result: {
    passed: boolean;
    assertionCount: number;
    failed: number;
    quoteSources: string[];
    inference: "nearai" | "generic_llm" | "standin";
    durationMs: number;
  } | null;
}

/** Which model backend the agents use: live models (server key) or the offline stand-in. */
export type AgentBrains = "nearai" | "standin";

export interface AgentsInfo {
  /** The server has NEARAI_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY and serves /api/agents/complete. */
  enabled: boolean;
  model: string;
  provider?: "nearai" | "generic_llm" | null;
}

interface PhalanxContextValue {
  status: "loading" | "ready" | "error";
  error: string | null;
  runtime: SwarmRuntime | null;
  dashboard: DashboardT | null;
  attestation: AttestationResultT | null;
  wasm: { size: number; sha256: string } | null;
  mode: IntentsMode;
  brains: AgentBrains;
  agentsInfo: AgentsInfo | null;
  /** Backend of the running sandbox (`nearai` or `generic_llm` only when live agents are on and quotes are not offline). */
  inference: "nearai" | "generic_llm" | "standin" | null;
  /** Changes 1Click mode and/or agent models, then restarts the sandbox with them. */
  configure: (next: { mode?: IntentsMode; brains?: AgentBrains }) => Promise<void>;
  setMode: (m: IntentsMode) => void;
  activity: ActivityItem[];
  busy: string | null;
  scenario: ScenarioState;
  refresh: () => Promise<void>;
  reset: () => Promise<void>;
  runScenario: () => Promise<void>;
  /** Runs one contract call, records it in the activity log and refreshes the dashboard. */
  act: <T>(label: string, signer: Signer, method: string, fn: (rt: SwarmRuntime) => Promise<CallResult<T>>) => Promise<CallResult<T> | null>;
  /** Records activity produced elsewhere (e.g. multi-step flows). */
  log: (records: TxRecord[]) => void;
}

const PhalanxContext = createContext<PhalanxContextValue | null>(null);
const QUOTE_ENDPOINT = "/api/intents/quote";
const TEE_ENDPOINT = "/api/tee/attest";
const AGENTS_ENDPOINT = "/api/agents/complete";
/** Longer than the proxy's upstream timeout (PHALANX_INTENTS_TIMEOUT_MS, 6 s) so the proxy's error arrives first. */
const CLIENT_QUOTE_TIMEOUT_MS = 9_000;
const NO_AGENTS: AgentsInfo = { enabled: false, model: DEFAULT_NEARAI_MODEL, provider: null };

async function fetchAgentsInfo(): Promise<AgentsInfo> {
  try {
    const res = await fetch(AGENTS_ENDPOINT, { cache: "no-store" });
    if (!res.ok) return NO_AGENTS;
    const info = (await res.json()) as Partial<AgentsInfo>;
    return {
      enabled: info.enabled === true,
      model: typeof info.model === "string" ? info.model : DEFAULT_NEARAI_MODEL,
      provider: info.provider ?? null,
    };
  } catch {
    return NO_AGENTS;
  }
}

/** Asks the server to DCAP-verify the attestation of a NEAR AI model signing key. */
async function verifyModelKey(signingAddress: string, model: string): Promise<ModelAttestationResult> {
  const url = `${TEE_ENDPOINT}?model=${encodeURIComponent(model)}&signing_address=${encodeURIComponent(signingAddress)}`;
  const res = await fetch(url, { cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as ModelAttestationResult & { message?: string };
  if (!res.ok) throw new Error(body.message ?? `model attestation HTTP ${res.status}`);
  return body;
}

export function PhalanxProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<PhalanxContextValue["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<SwarmRuntime | null>(null);
  const [dashboard, setDashboard] = useState<DashboardT | null>(null);
  const [attestation, setAttestation] = useState<AttestationResultT | null>(null);
  const [wasm, setWasm] = useState<PhalanxContextValue["wasm"]>(null);
  const [mode, setModeState] = useState<IntentsMode>("auto");
  const [brains, setBrains] = useState<AgentBrains>("standin");
  const [agentsInfo, setAgentsInfo] = useState<AgentsInfo | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [scenario, setScenario] = useState<ScenarioState>({ running: false, steps: [], activeIndex: null, result: null });
  const wasmBytes = useRef<Uint8Array | null>(null);
  const seq = useRef(0);
  const rtRef = useRef<SwarmRuntime | null>(null);
  /** Current settings, read by boot/run callbacks without re-creating them. */
  const config = useRef<{ mode: IntentsMode; brains: AgentBrains; agents: AgentsInfo }>({ mode: "auto", brains: "standin", agents: NO_AGENTS });

  const log = useCallback((records: TxRecord[]) => {
    setActivity((prev) => [...records.map((r) => ({ ...r, id: ++seq.current, at: Date.now() })).reverse(), ...prev].slice(0, 80));
  }, []);

  /** A live model call failed and the stand-in answered instead: say so, at most every 15 s. */
  const lastFallback = useRef(0);
  const onInferenceFallback = useCallback((reason: string, role: string | null) => {
    console.warn(`live agent model failed${role ? ` (${role})` : ""}; using the stand-in:`, reason);
    if (Date.now() - lastFallback.current < 15_000) return;
    lastFallback.current = Date.now();
    toast({
      tone: "warning",
      title: "Live model did not answer",
      description: `${role ? `${role}: ` : ""}${reason.slice(0, 160)}. This call used the offline stand-in (no TEE).`,
      duration: 9_000,
    });
  }, []);

  const refreshFrom = useCallback(async (rt: SwarmRuntime | null) => {
    if (!rt) return;
    const d = await rt.dashboard();
    if (rtRef.current === rt) {
      setDashboard(d);
      setAttestation(rt.attestation);
    }
  }, []);

  const refresh = useCallback(() => refreshFrom(rtRef.current), [refreshFrom]);

  const install = useCallback(
    async (rt: SwarmRuntime) => {
      rtRef.current = rt;
      setRuntime(rt);
      await refreshFrom(rt);
    },
    [refreshFrom],
  );

  const runtimeOptions = useCallback((): Omit<RuntimeOptions, "wasm"> => {
    const { mode: m, brains: b, agents } = config.current;
    const live = b === "nearai" && agents.enabled && m !== "offline";
    const isNearAi = agents.provider === "nearai";
    return {
      intentsMode: m,
      quoteEndpoint: QUOTE_ENDPOINT,
      intentsTimeoutMs: CLIENT_QUOTE_TIMEOUT_MS,
      teeMode: m === "offline" ? "offline" : "auto",
      teeEndpoint: TEE_ENDPOINT,
      ...(live
        ? {
            nearAiEndpoint: AGENTS_ENDPOINT,
            nearAiModel: agents.model,
            onInferenceFallback,
            ...(isNearAi ? { modelAttestationVerifier: verifyModelKey } : {}),
          }
        : {}),
    };
  }, [onInferenceFallback]);

  const loadWasm = useCallback(async (): Promise<Uint8Array> => {
    if (!wasmBytes.current) {
      const res = await fetch("/phalanx_core.wasm");
      if (!res.ok) throw new Error(`GET /phalanx_core.wasm → HTTP ${res.status}. Run pnpm build:contract.`);
      wasmBytes.current = new Uint8Array(await res.arrayBuffer());
      setWasm({ size: wasmBytes.current.length, sha256: sha256Hex(wasmBytes.current) });
    }
    return wasmBytes.current;
  }, []);

  const bootFresh = useCallback(async () => {
    const rt = await SwarmRuntime.boot({ wasm: await loadWasm(), ...runtimeOptions() });
    log(await rt.bootstrap({ attest: false }));
    await install(rt);
    void rt
      .attestGateway()
      .then(() => refreshFrom(rt))
      .catch((e: unknown) => console.warn("NEAR AI gateway evidence unavailable:", e instanceof Error ? e.message : e));
  }, [install, loadWasm, log, refreshFrom, runtimeOptions]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const agents = await fetchAgentsInfo();
      if (cancelled) return;
      const b: AgentBrains = agents.enabled ? "nearai" : "standin";
      config.current = { mode: "auto", brains: b, agents };
      setAgentsInfo(agents);
      setBrains(b);
      await bootFresh();
      if (!cancelled) setStatus("ready");
    })().catch((e: unknown) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    });
    return () => {
      cancelled = true;
    };
  }, [bootFresh]);

  const reset = useCallback(async () => {
    setBusy("Restarting sandbox");
    setError(null);
    try {
      setActivity([]);
      setScenario({ running: false, steps: [], activeIndex: null, result: null });
      await bootFresh();
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [bootFresh]);

  const configure = useCallback(
    async (next: { mode?: IntentsMode; brains?: AgentBrains }) => {
      const cur = config.current;
      const wanted = next.brains ?? cur.brains;
      config.current = { ...cur, mode: next.mode ?? cur.mode, brains: wanted === "nearai" && !cur.agents.enabled ? "standin" : wanted };
      setModeState(config.current.mode);
      setBrains(config.current.brains);
      await reset();
    },
    [reset],
  );

  const setMode = useCallback((m: IntentsMode) => void configure({ mode: m }), [configure]);

  const runScenario = useCallback(async () => {
    setScenario({ running: true, steps: [], activeIndex: 1, result: null });
    setActivity([]);
    setError(null);
    try {
      const report = await runJudgeScenario({
        wasm: await loadWasm(),
        ...runtimeOptions(),
        stepDelayMs: 700,
        listener: {
          onBoot: (rt) => {
            void install(rt);
          },
          onStepStart: (index) => setScenario((s) => ({ ...s, activeIndex: index })),
          onStep: (step) => {
            setScenario((s) => ({ ...s, steps: [...s.steps, step] }));
            log(step.txs);
            void refresh();
          },
        },
      });
      setScenario((s) => ({
        ...s,
        running: false,
        activeIndex: null,
        result: {
          passed: report.passed,
          assertionCount: report.assertionCount,
          failed: report.failedAssertions.length,
          quoteSources: report.quoteSources,
          inference: report.inference,
          durationMs: report.durationMs,
        },
      }));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setScenario((s) => ({ ...s, running: false, activeIndex: null }));
    }
  }, [install, loadWasm, log, refresh, runtimeOptions]);

  const act = useCallback(
    async <T,>(label: string, signer: Signer, method: string, fn: (rt: SwarmRuntime) => Promise<CallResult<T>>): Promise<CallResult<T> | null> => {
      const rt = rtRef.current;
      if (!rt) return null;
      setBusy(label);
      try {
        const r = await fn(rt);
        log([toTxRecord(label, signer, method, r)]);
        await refresh();
        return r;
      } finally {
        setBusy(null);
      }
    },
    [log, refresh],
  );

  const inference = runtime?.inferenceSource ?? null;
  const value = useMemo<PhalanxContextValue>(
    () => ({
      status,
      error,
      runtime,
      dashboard,
      attestation,
      wasm,
      mode,
      brains,
      agentsInfo,
      inference,
      configure,
      setMode,
      activity,
      busy,
      scenario,
      refresh,
      reset,
      runScenario,
      act,
      log,
    }),
    [
      status,
      error,
      runtime,
      dashboard,
      attestation,
      wasm,
      mode,
      brains,
      agentsInfo,
      inference,
      configure,
      setMode,
      activity,
      busy,
      scenario,
      refresh,
      reset,
      runScenario,
      act,
      log,
    ],
  );
  return <PhalanxContext.Provider value={value}>{children}</PhalanxContext.Provider>;
}

export function usePhalanx(): PhalanxContextValue {
  const ctx = useContext(PhalanxContext);
  if (!ctx) throw new Error("usePhalanx must be used inside <PhalanxProvider>");
  return ctx;
}

"use client";

import { JUDGE_STEPS, type JudgeStepId, type StepReport } from "@phalanx/agent-swarm-sdk";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRightLeft,
  BadgeCheck,
  Bot,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleX,
  Coins,
  CornerDownRight,
  Cpu,
  FileWarning,
  Fingerprint,
  FlaskConical,
  Gavel,
  Hash,
  LoaderCircle,
  Play,
  Rocket,
  RotateCcw,
  ShieldCheck,
  ShieldX,
  UsersRound,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { usePhalanx } from "@/lib/phalanx-context";

import { Badge, Button, CopyButton, IconButton, Label, ProgressRing, cx, short, toast } from "./ui";

const STEP_META: Record<JudgeStepId, { label: string; icon: LucideIcon }> = {
  boot: { label: "Boot & fund", icon: Rocket },
  spawn: { label: "Spawn agents", icon: UsersRound },
  plan: { label: "Plan RFPs", icon: Workflow },
  auction: { label: "Swarm auction", icon: Gavel },
  execute: { label: "Verified work", icon: Cpu },
  intent: { label: "Settlements", icon: ArrowRightLeft },
  attack: { label: "Invoice fraud", icon: FileWarning },
  recipients: { label: "Blocklist & hold", icon: ShieldX },
  forgery: { label: "Forged audits", icon: Fingerprint },
  revenue: { label: "Revenue split", icon: Coins },
  verify: { label: "Invariants", icon: BadgeCheck },
};

function StepDetail({
  step,
  index,
  onNav,
  onClose,
  count,
}: {
  step: StepReport;
  index: number;
  count: number;
  onNav: (i: number) => void;
  onClose: () => void;
}) {
  const passed = step.assertions.filter((a) => a.passed).length;
  return (
    <div className="rounded-xl border border-white/[0.08] bg-black/30">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cx(
              "grid size-8 shrink-0 place-items-center rounded-lg",
              step.passed ? "bg-emerald-400/15 text-emerald-300" : "bg-red-500/15 text-red-300",
            )}
          >
            {step.passed ? <CircleCheck className="size-4" aria-hidden /> : <CircleX className="size-4" aria-hidden />}
          </span>
          <div className="min-w-0">
            <div className="num text-[11px] text-slate-500">STEP {String(index + 1).padStart(2, "0")}</div>
            <div className="text-[14px] font-medium text-slate-100">{step.title}</div>
          </div>
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
          <Badge tone={step.passed ? "emerald" : "red"} dot>
            {passed}/{step.assertions.length} checks
          </Badge>
          <Badge tone="slate">
            <span className="num">{step.durationMs} ms</span>
          </Badge>
          <div className="flex items-center">
            <IconButton icon={ChevronLeft} label="Previous step" disabled={index === 0} onClick={() => onNav(index - 1)} />
            <IconButton icon={ChevronRight} label="Next step" disabled={index >= count - 1} onClick={() => onNav(index + 1)} />
            <IconButton icon={X} label="Close step details" onClick={onClose} />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-5 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="space-y-2">
          <Label>What happened</Label>
          {step.actors.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {step.actors.map((a) => (
                <Badge key={a} tone="slate" className="num">
                  {short(a, 22, 0)}
                </Badge>
              ))}
            </div>
          )}
          <ol className="space-y-2">
            {step.narrative.map((line, i) => (
              <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-slate-300">
                <span className="num mt-[3px] text-[10px] text-slate-600">{i + 1}</span>
                <span>{line}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="space-y-2">
          <Label>Transactions ({step.txs.length})</Label>
          <div tabIndex={0} role="region" aria-label={`Transactions of step ${index + 1}`} className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
            {step.txs.map((tx, i) => (
              <div key={i} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-[12px]">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium text-slate-200">{tx.label}</span>
                  <Badge tone={tx.ok ? "emerald" : "red"}>{tx.ok ? "ok" : "rejected"}</Badge>
                </div>
                <div className="num mt-1 break-all text-[11px] text-slate-500">
                  {short(tx.signer, 26, 4)} → <span className="text-slate-300">{tx.method}</span>
                </div>
                {tx.error && <div className="num mt-1.5 break-words rounded-md bg-red-500/10 px-2 py-1 text-[11px] text-red-300">{tx.error}</div>}
                {tx.events.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {tx.events.map((e, j) => (
                      <span
                        key={j}
                        className="num rounded border border-emerald-400/20 bg-emerald-400/[0.06] px-1.5 text-[10.5px] leading-[18px] text-emerald-200"
                      >
                        {e}
                      </span>
                    ))}
                  </div>
                )}
                {tx.receipts.slice(1).map((r, j) => (
                  <div key={j} className="num mt-1 flex gap-1 break-words text-[10.5px] text-slate-500">
                    <CornerDownRight className="mt-px size-3 shrink-0" aria-hidden />
                    <span className="min-w-0">
                      <span className="text-slate-400">{r.receiver}</span>: {r.actions}{" "}
                      {r.status !== "success" && <span className="text-red-300">({r.status})</span>}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <Label>Assertions</Label>
          <ul className="space-y-1.5">
            {step.assertions.map((a, i) => (
              <li key={i} className="flex gap-2 text-[12.5px]">
                {a.passed ? (
                  <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-300" aria-label="passed" />
                ) : (
                  <CircleX className="mt-0.5 size-3.5 shrink-0 text-red-300" aria-label="failed" />
                )}
                <span className="min-w-0 text-slate-300">
                  {a.label}
                  {a.detail && <span className="num block break-all text-[10.5px] text-slate-500">{a.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export function JudgeMode() {
  const { scenario, runScenario, mode, inference, agentsInfo, wasm, status, reset, busy, dashboard } = usePhalanx();
  const [open, setOpen] = useState<number | null>(null);
  const [wasRunning, setWasRunning] = useState(scenario.running);
  if (scenario.running !== wasRunning) {
    setWasRunning(scenario.running);
    if (scenario.running) setOpen(null);
  }
  const done = scenario.steps.length;
  const passedAssertions = scenario.steps.reduce((n, s) => n + s.assertions.filter((a) => a.passed).length, 0);
  const totalAssertions = scenario.steps.reduce((n, s) => n + s.assertions.length, 0);
  const result = scenario.result;
  const ringTone = result ? (result.passed ? "emerald" : "red") : "sky";
  const progress = scenario.running ? Math.max(done, (scenario.activeIndex ?? 1) - 1) : done;

  useEffect(() => {
    if (!result) return;
    toast(
      result.passed
        ? {
            tone: "success",
            title: "ALL CHECKS PASSED",
            description: `${result.assertionCount - result.failed}/${result.assertionCount} assertions · ${result.durationMs} ms`,
          }
        : { tone: "error", title: `${result.failed} CHECKS FAILED`, description: "Open the red step for details." },
    );
  }, [result]);

  return (
    <section aria-labelledby="judge-title" className={cx("surface relative overflow-hidden rounded-2xl", scenario.running && "beam")}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_320px_at_0%_0%,rgb(0_236_151/0.12),transparent_60%),radial-gradient(700px_300px_at_100%_0%,rgb(125_211_252/0.08),transparent_60%)]"
      />
      <div className="relative grid grid-cols-1 gap-5 p-4 sm:gap-6 sm:p-7 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/[0.07] py-1 pl-1.5 pr-3 text-[11.5px] font-medium text-emerald-200">
            <span className="grid size-5 place-items-center rounded-full bg-emerald-400/20">
              <FlaskConical className="size-3" aria-hidden />
            </span>
            PhalanxSim local rehearsal of artifacts/phalanx_core.wasm · the live proofs are below
          </div>
          <h2 id="judge-title" className="mt-4 max-w-3xl text-balance text-[26px] font-semibold leading-[1.15] tracking-tight text-white sm:text-[32px]">
            Step 3 kills invoice fraud. Then the swarm runs the business.
          </h2>
          <p className="mt-3 max-w-2xl text-[13.5px] leading-relaxed text-slate-400">
            Reproducible rehearsal of the compiled <span className="num text-emerald-300">phalanx_core.wasm</span> inside PhalanxSim. Attack is intentionally
            early so the security kill is the hero.
            {mode === "offline" ? (
              " Quotes come from the deterministic offline engine."
            ) : (
              <>
                {" "}
                1Click quotes are live dry runs (<span className="num text-slate-300">dry: true</span>).
              </>
            )}{" "}
            Agents use{" "}
            {inference === "nearai" ? (
              <b className="font-medium text-slate-300">NEAR AI Cloud ({agentsInfo?.model})</b>
            ) : inference === "generic_llm" ? (
              <b className="font-medium text-slate-300">Live LLM ({agentsInfo?.model})</b>
            ) : (
              <b className="font-medium text-slate-300">the labeled offline stand-in</b>
            )}
            . <b className="font-medium text-slate-300">Live network proofs</b> below verify real MPC, TEE, wallet and economic evidence on testnet.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
            <Badge tone="slate" icon={Cpu}>
              <span className="num">{wasm ? `${Math.round(wasm.size / 1024)} KB wasm` : "loading wasm…"}</span>
            </Badge>
            <Badge tone={inference === "nearai" ? "emerald" : inference === "generic_llm" ? "sky" : "amber"} icon={Bot}>
              {inference === "nearai"
                ? "NEAR AI agents (TEE)"
                : inference === "generic_llm"
                  ? `Live LLM (${short(agentsInfo?.model ?? "model", 18, 0)})`
                  : "stand-in agents (no TEE)"}
            </Badge>
            {wasm && (
              <span className="inline-flex h-[22px] items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] pl-2 text-[11.5px] text-slate-300">
                <Hash className="size-3" aria-hidden />
                <span className="num">sha256 {short(wasm.sha256, 12, 6)}</span>
                <span className="-my-1 scale-75">
                  <CopyButton text={wasm.sha256} label="Copy WASM sha256" iconOnly />
                </span>
              </span>
            )}
            {dashboard && (
              <Badge tone="slate" icon={ShieldCheck}>
                {dashboard.enclaves.length} registered model {dashboard.enclaves.length === 1 ? "key" : "keys"}
              </Badge>
            )}
          </div>

          <div className="mt-6 grid w-full grid-cols-1 items-center gap-3 min-[480px]:flex min-[480px]:flex-wrap">
            <Button
              className="w-full min-[480px]:w-auto"
              size="lg"
              variant="primary"
              icon={Play}
              shine
              loading={scenario.running}
              onClick={() => void runScenario()}
              disabled={scenario.running || status !== "ready" || busy !== null}
            >
              {scenario.running ? `Running step ${scenario.activeIndex ?? done}/${JUDGE_STEPS.length}…` : "Run judge scenario (local)"}
            </Button>
            <Button
              className="w-full min-[480px]:w-auto"
              size="lg"
              variant="secondary"
              icon={RotateCcw}
              onClick={() => void reset()}
              disabled={scenario.running || status !== "ready" || busy !== null}
            >
              Reset sandbox
            </Button>
          </div>
          {inference === "nearai" && !scenario.running && !result && (
            <p className="mt-2 text-[11.5px] text-slate-500">
              With NEAR AI agents the run makes about 10 model calls and takes one to three minutes. A call that fails falls back to the stand-in, with a
              notice.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 place-items-center gap-5 rounded-2xl border border-white/[0.07] bg-black/20 p-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:place-items-center lg:grid-cols-1 lg:justify-center lg:px-7">
          <ProgressRing value={result ? passedAssertions : progress} max={result ? totalAssertions || 1 : JUDGE_STEPS.length} tone={ringTone} size={136}>
            <div>
              <div className="num text-[26px] font-semibold leading-none text-white">{result ? passedAssertions : `${progress}/${JUDGE_STEPS.length}`}</div>
              <div className="num mt-1 text-[11px] text-slate-500">{result ? `of ${totalAssertions} checks` : "steps"}</div>
            </div>
          </ProgressRing>
          <div className="min-w-0 text-center sm:text-left lg:text-center" aria-live="polite">
            {result ? (
              <Badge tone={result.passed ? "emerald" : "red"} dot>
                {result.passed ? "ALL CHECKS PASSED" : `${result.failed} CHECKS FAILED`}
              </Badge>
            ) : scenario.running ? (
              <Badge tone="sky">
                <LoaderCircle className="size-3 animate-spin" aria-hidden /> running
              </Badge>
            ) : (
              <Badge tone="slate">ready · {JUDGE_STEPS.length} steps</Badge>
            )}
            <div className="num mt-2 text-[11px] text-slate-500">
              {result ? (
                <>
                  {passedAssertions}/{totalAssertions} assertions · {result.durationMs} ms
                  <br />
                  quotes: {result.quoteSources.join("+") || "n/a"} · agents:{" "}
                  {result.inference === "nearai" ? "NEAR AI (TEE)" : result.inference === "generic_llm" ? "Live LLM" : "stand-in"}
                </>
              ) : (
                `${progress}/${JUDGE_STEPS.length} steps complete`
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="relative border-t border-white/[0.06] p-4 sm:px-7 sm:py-5">
        <div className="mb-3 flex flex-col items-start gap-1.5 min-[480px]:flex-row min-[480px]:items-center min-[480px]:justify-between min-[480px]:gap-3">
          <Label>Verification pipeline</Label>
          {done > 0 && <span className="text-[11.5px] text-slate-500">Select a step for its transactions, receipts, NEP-297 events and checks</span>}
        </div>
        <div className="mb-3 h-1 overflow-hidden rounded-full bg-white/[0.05]">
          <motion.div
            className={cx(
              "h-full rounded-full bg-gradient-to-r",
              result && !result.passed ? "from-red-500 to-red-300" : "from-emerald-500 via-emerald-300 to-sky-300",
            )}
            initial={false}
            animate={{ width: `${(Math.min(progress, JUDGE_STEPS.length) / JUDGE_STEPS.length) * 100}%` }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          />
        </div>
        <ol className="grid grid-cols-2 gap-2 min-[440px]:grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-11">
          {JUDGE_STEPS.map((def, i) => {
            const step = scenario.steps[i];
            const active = scenario.running && scenario.activeIndex === i + 1 && !step;
            const state = step ? (step.passed ? "pass" : "fail") : active ? "run" : "idle";
            const meta = STEP_META[def.id];
            const Icon = meta.icon;
            return (
              <li key={def.id}>
                <button
                  type="button"
                  disabled={!step}
                  title={def.title}
                  aria-expanded={open === i}
                  aria-label={`Step ${i + 1}: ${def.title}${step ? (step.passed ? ", passed" : ", failed") : active ? ", running" : ""}`}
                  onClick={() => setOpen(open === i ? null : i)}
                  className={cx(
                    "group relative flex h-full w-full flex-col overflow-hidden rounded-xl border p-2.5 text-left transition-all duration-200 disabled:cursor-default",
                    state === "pass" && "border-emerald-400/30 bg-emerald-400/[0.07] hover:border-emerald-400/60 hover:bg-emerald-400/[0.12]",
                    state === "fail" && "border-red-400/40 bg-red-500/10 hover:border-red-400/70",
                    state === "run" && "border-sky-400/50 bg-sky-400/[0.08] shadow-[0_0_24px_-6px_rgb(125_211_252/0.5)]",
                    state === "idle" && "border-white/[0.06] bg-white/[0.015]",
                    open === i && "ring-2 ring-emerald-300/60",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={cx(
                        "grid size-7 place-items-center rounded-lg",
                        state === "pass"
                          ? "bg-emerald-400/15 text-emerald-300"
                          : state === "fail"
                            ? "bg-red-500/15 text-red-300"
                            : state === "run"
                              ? "bg-sky-400/15 text-sky-300"
                              : "bg-white/[0.04] text-slate-500",
                      )}
                    >
                      <Icon className="size-3.5" aria-hidden />
                    </span>
                    {state === "pass" ? (
                      <CircleCheck className="size-4 text-emerald-300" aria-hidden />
                    ) : state === "fail" ? (
                      <CircleX className="size-4 text-red-300" aria-hidden />
                    ) : state === "run" ? (
                      <LoaderCircle className="size-4 animate-spin text-sky-300" aria-hidden />
                    ) : (
                      <Circle className="size-4 text-slate-700" aria-hidden />
                    )}
                  </div>
                  <span className="num mt-2 text-[10px] text-slate-500">{String(i + 1).padStart(2, "0")}</span>
                  <span className={cx("text-[12px] font-medium leading-tight", state === "idle" ? "text-slate-400" : "text-slate-100")}>{meta.label}</span>
                  <span className="num mt-1 text-[10.5px] text-slate-500">
                    {step ? `${step.assertions.filter((a) => a.passed).length}/${step.assertions.length} checks` : active ? "running…" : "pending"}
                  </span>
                  {active && (
                    <motion.span
                      className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-sky-300"
                      initial={{ scaleX: 0 }}
                      animate={{ scaleX: 1 }}
                      transition={{ duration: 0.7, repeat: Infinity }}
                      aria-hidden
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ol>

        <AnimatePresence initial={false} mode="wait">
          {open !== null && scenario.steps[open] && (
            <motion.div
              key={open}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <div className="pt-4">
                <StepDetail step={scenario.steps[open]!} index={open} count={scenario.steps.length} onNav={setOpen} onClose={() => setOpen(null)} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

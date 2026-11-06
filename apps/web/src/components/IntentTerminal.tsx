"use client";

import {
  NATIVE_ASSET,
  parseNear,
  type CrossChainIntentRequestT,
  type IntentRecordT,
  type RankedRoute,
  type SentinelAudit,
  type SettlementOutcomeT,
} from "@aegis/agent-swarm-sdk";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRightLeft,
  Ban,
  Check,
  Clock,
  Cpu,
  FileSignature,
  FileWarning,
  ListOrdered,
  OctagonAlert,
  Route,
  ScanEye,
  Send,
  ShieldCheck,
  Signature,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useAegis } from "@/lib/aegis-context";
import { useAction } from "@/lib/use-action";

import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  CodeBlock,
  CopyButton,
  EmptyState,
  Field,
  KV,
  PersonaAvatar,
  SkeletonBlock,
  Spinner,
  cx,
  describeViolation,
  ethFmt,
  nearFmt,
  scrollToSection,
  short,
  useCommands,
  usePersonaOf,
  type Tone,
} from "./ui";

interface Draft {
  request: CrossChainIntentRequestT;
  message: string;
  nep413Hash: string;
  route: RankedRoute;
}

type StepState = "done" | "current" | "pending";

function Step({
  n,
  state,
  title,
  description,
  action,
  children,
  last,
}: {
  n: number;
  state: StepState;
  title: string;
  description: string;
  action: ReactNode;
  children?: ReactNode;
  last?: boolean;
}) {
  return (
    <li className="relative flex gap-3 sm:gap-4">
      {!last && <span className={cx("absolute left-[15px] top-9 bottom-0 w-px", state === "done" ? "bg-emerald-400/40" : "bg-white/[0.08]")} aria-hidden />}
      <span
        className={cx(
          "relative z-10 grid size-[31px] shrink-0 place-items-center rounded-full border text-[12px] font-semibold",
          state === "done" && "border-emerald-400/50 bg-emerald-400/15 text-emerald-300",
          state === "current" && "border-sky-300/60 bg-sky-400/10 text-sky-200 shadow-[0_0_0_4px_rgb(125_211_252/0.08)]",
          state === "pending" && "border-white/10 bg-white/[0.03] text-slate-500",
        )}
        aria-hidden
      >
        {state === "done" ? <Check className="size-3.5" /> : n}
      </span>
      <div className={cx("min-w-0 flex-1", last ? "pb-1" : "pb-6")}>
        <div className="flex min-w-0 flex-col items-stretch gap-2 min-[480px]:flex-row min-[480px]:flex-wrap min-[480px]:items-start min-[480px]:justify-between">
          <div className="min-w-0 pt-1 min-[480px]:flex-1">
            <div className={cx("text-[13.5px] font-medium", state === "pending" ? "text-slate-400" : "text-slate-100")}>{title}</div>
            <div className="text-[12px] text-slate-500">{description}</div>
          </div>
          <div className="w-full max-w-full min-[480px]:w-auto">{action}</div>
        </div>
        <AnimatePresence initial={false}>
          {children && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="pt-3">{children}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </li>
  );
}

export function IntentTerminal() {
  const { runtime, dashboard, busy } = useAegis();
  const action = useAction();
  const [amount, setAmount] = useState("5");
  const [slippage, setSlippage] = useState("50");
  const [routes, setRoutes] = useState<RankedRoute[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [pick, setPick] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [audit, setAudit] = useState<SentinelAudit | null>(null);
  const [outcome, setOutcome] = useState<SettlementOutcomeT | null>(null);
  const [attackOutcome, setAttackOutcome] = useState<{ outcome: SettlementOutcomeT; fooled: boolean; recipient: string } | null>(null);
  const [record, setRecord] = useState<IntentRecordT | null>(null);
  const [mpc, setMpc] = useState<{ recovered: string; expected: string; valid: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const disabled = busy !== null || working !== null || !runtime;
  const amountError = (() => {
    try {
      return parseNear(amount) > 0n ? null : "Must be more than 0";
    } catch {
      return "Enter a wNEAR amount, e.g. 5 or 2.5";
    }
  })();
  const slippageError = /^\d+$/.test(slippage.trim()) && Number(slippage) <= 10_000 ? null : "Whole number of bps, 0 to 10000";
  const invalid = amountError !== null || slippageError !== null;
  const rhea = runtime && dashboard ? dashboard.agents.find((a) => a.agent_id === runtime.agents.rhea.accountId) : undefined;

  const run = async (label: string, fn: () => Promise<void>) => {
    setWorking(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  };

  const quote = () =>
    run("Quoting routes", async () => {
      if (!runtime) return;
      const r = await runtime.rankYieldRoutes(parseNear(amount), Number(slippage));
      setRoutes(r.allowed);
      setExcluded(r.excluded.map((e) => `${e.candidate.label}: ${e.reason}`));
      setPick(0);
      setDraft(null);
      setAudit(null);
      setOutcome(null);
      setAttackOutcome(null);
      setRecord(null);
      setMpc(null);
    });

  const signAndAudit = () =>
    run("Signing & auditing", async () => {
      if (!runtime) return;
      const route = routes[pick];
      if (!route) throw new Error("quote routes first");
      const built = runtime.buildIntent("rhea", {
        kind: "swap",
        route,
        amount: parseNear(amount),
        slippageBps: Number(slippage),
        memo: "command center rebalance",
      });
      setDraft({ ...built, route });
      setAudit(await runtime.auditIntent("rhea", built.request, built.nep413Hash));
      setOutcome(null);
      setRecord(null);
      setMpc(null);
    });

  const submit = () =>
    run("Submitting", async () => {
      if (!runtime || !draft || !audit) return;
      const r = await action(
        "Rhea requests settlement",
        runtime.agents.rhea.signer,
        "request_intent_settlement",
        (rt) => rt.submitIntent("rhea", { ...draft.request, attestation: audit.receipt }),
        (res) =>
          res.ok && res.value
            ? {
                tone: res.value.status === "rejected" ? "error" : "success",
                title: `Intent #${res.value.intent_id} → ${res.value.status}`,
                description: "request_intent_settlement",
              }
            : undefined,
      );
      if (!r) return;
      if (!r.ok || !r.value) throw new Error(r.error ?? "settlement failed");
      setOutcome(r.value);
      const rec = await runtime.contract.intent(r.value.intent_id);
      setRecord(rec);
      setMpc(rec ? runtime.verifyMpcAuthorization(rec) : null);
    });

  const confirm = () =>
    run("Confirming", async () => {
      if (!runtime || !record || !draft) return;
      const ref = `1click-${draft.route.result.source}:${draft.route.result.response.correlationId.slice(0, 36)}`;
      const r = await action("Sentinel closes the dry run", runtime.agents.sentinel.signer, "confirm_intent_settlement", (rt) =>
        rt.confirmIntent(record.intent_id, ref),
      );
      if (r?.value) setRecord(r.value);
    });

  const attack = () =>
    run("Mallory reads the poisoned invoice", async () => {
      if (!runtime) return;
      const fraud = await runtime.invoiceFraudAttempt();
      const r = await action(
        "Mallory pays the invoice's 'updated bank details'",
        runtime.agents.mallory.signer,
        "request_intent_settlement",
        (rt) => rt.submitIntent("mallory", fraud.request),
        (res) =>
          res.ok && res.value
            ? {
                tone: "warning",
                title: res.value.quarantined ? "Invoice fraud blocked · Mallory quarantined" : `Invoice payment ${res.value.status}`,
                description: res.value.decision.violations.map((v) => v.code).join(", "),
              }
            : { tone: "warning", title: "Rejected before execution", description: res.error ?? undefined },
      );
      if (r?.value) setAttackOutcome({ outcome: r.value, fooled: fraud.fooled, recipient: fraud.submitted.recipient });
      else if (r) setError(`Rejected before execution: ${r.error}`);
      setDraft(null);
      setAudit(null);
      setOutcome(null);
      setRecord(null);
      setMpc(null);
    });

  useCommands(
    () => [
      {
        id: "intent-quote",
        group: "Settlement",
        title: "Quote routes (dry)",
        subtitle: `${amount} wNEAR · ${slippage} bps via NEAR Intents 1Click`,
        icon: Route,
        disabled: disabled || invalid,
        disabledReason: invalid ? "Fix the amount or slippage first" : "Busy",
        run: () => void quote(),
      },
      {
        id: "intent-attack",
        group: "Settlement",
        title: "Poisoned invoice attack",
        subtitle: "Mallory's model reads 'updated bank details' and tries to pay the attacker",
        icon: FileWarning,
        tone: "danger",
        keywords: "attack mallory fraud injection circuit breaker",
        disabled,
        disabledReason: "Busy",
        run: () => {
          scrollToSection("intents");
          void attack();
        },
      },
    ],
    [disabled, invalid, amount, slippage, runtime],
  );

  const s1: StepState = routes.length ? "done" : "current";
  const s2: StepState = audit ? "done" : routes.length ? "current" : "pending";
  const s3: StepState = outcome ? "done" : audit ? "current" : "pending";
  const s4: StepState = record?.status === "settled" ? "done" : record?.status === "signed" ? "current" : "pending";

  return (
    <Card className="flex h-full flex-col p-4 sm:p-5">
      <CardHeader
        icon={ArrowRightLeft}
        eyebrow="NEAR Intents 1Click · NEP-413 · Chain Signatures"
        title="Intent terminal"
        description="Rhea rehearses a cross-chain rebalance to the treasury's own MPC address: dry quote, NEP-413 signature, Sentinel audit, policy engine, MPC authorization. A dry run moves no funds and is booked as such."
        actions={
          <Button size="sm" variant="danger" icon={FileWarning} disabled={disabled} onClick={() => void attack()}>
            Poisoned invoice attack
          </Button>
        }
      />

      {!runtime ? (
        <div className="mt-5">
          <SkeletonBlock rows={6} />
        </div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Amount (wNEAR from treasury)"
              suffix="wNEAR"
              inputMode="decimal"
              value={amount}
              error={amountError}
              onChange={(e) => setAmount(e.target.value)}
              presets={["1", "5", "10"]}
              onPreset={setAmount}
            />
            <Field
              label="Slippage (bps)"
              suffix="bps"
              inputMode="numeric"
              value={slippage}
              error={slippageError}
              onChange={(e) => setSlippage(e.target.value)}
              presets={["30", "50", "100"]}
              onPreset={setSlippage}
            />
          </div>

          <div aria-live="polite" className="mt-3 space-y-2">
            {working && (
              <div className="flex items-center gap-2 text-[12.5px] text-sky-300">
                <Spinner className="size-3.5" /> {working}…
              </div>
            )}
            {error && (
              <Callout tone="red" icon={Ban}>
                <span className="num">{error}</span>
              </Callout>
            )}
            {attackOutcome && (
              <Callout
                tone="red"
                icon={OctagonAlert}
                title={`intent #${attackOutcome.outcome.intent_id} → ${attackOutcome.outcome.status} · severity ${attackOutcome.outcome.decision.severity}`}
              >
                <div>
                  {attackOutcome.fooled
                    ? `Mallory's model followed the injected instruction and asked to pay ${short(attackOutcome.recipient, 8, 6)}.`
                    : `Mallory's model resisted; the injected instruction (pay ${short(attackOutcome.recipient, 8, 6)}) was submitted anyway.`}
                </div>
                {attackOutcome.outcome.decision.violations
                  .filter((v) => v.code !== "missing_tee_attestation")
                  .map((v, i) => (
                    <div key={i} className="mt-1">
                      • {describeViolation(v)}
                    </div>
                  ))}
                {attackOutcome.outcome.quarantined && <div className="mt-1">Circuit breaker tripped: agent quarantined, contract key deleted on-chain.</div>}
              </Callout>
            )}
          </div>

          <ol className="mt-5">
            <Step
              n={1}
              state={s1}
              title="Quote routes"
              description="Dry 1Click quotes for every route Rhea's on-chain allow-list permits, ranked by value net of latency."
              action={
                <Button
                  size="sm"
                  variant={s1 === "current" ? "primary" : "secondary"}
                  icon={Route}
                  className="w-full min-[480px]:w-auto"
                  disabled={disabled || invalid}
                  onClick={() => void quote()}
                >
                  1 · Quote routes (dry)
                </Button>
              }
            >
              {routes.length > 0 && (
                <div className="space-y-2">
                  <div role="radiogroup" aria-label="Routes" className="space-y-1.5">
                    {routes.map((r, i) => (
                      <button
                        key={r.candidate.label}
                        type="button"
                        role="radio"
                        aria-checked={pick === i}
                        onClick={() => setPick(i)}
                        className={cx(
                          "flex w-full items-start gap-3 rounded-xl border p-3 text-left text-[12px] transition",
                          pick === i ? "border-emerald-400/50 bg-emerald-400/[0.07]" : "border-white/[0.07] bg-white/[0.02] hover:border-white/15",
                        )}
                      >
                        <span
                          className={cx(
                            "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
                            pick === i ? "border-emerald-300 bg-emerald-400" : "border-white/20",
                          )}
                          aria-hidden
                        >
                          {pick === i && <span className="size-1.5 rounded-full bg-[#04140d]" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-slate-100">{r.candidate.label}</span>
                            {i === 0 && (
                              <Badge tone="emerald" icon={Sparkles}>
                                best
                              </Badge>
                            )}
                            <Badge tone={r.result.source === "live" ? "emerald" : "amber"} className="ml-auto">
                              {r.result.source === "live" ? "live 1Click" : "offline engine"}
                            </Badge>
                          </span>
                          <span className="num mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-slate-400">
                            <span className="text-slate-200">
                              → {r.result.response.quote.amountOutFormatted} USDC (${Number(r.result.response.quote.amountOutUsd).toFixed(2)})
                            </span>
                            <span>min {r.result.response.quote.minAmountOut}</span>
                            <span className="flex items-center gap-1">
                              <Clock className="size-3" aria-hidden />~{r.timeEstimateSec}s
                            </span>
                            <span>to {short(r.candidate.recipient, 8, 6)}</span>
                          </span>
                          {r.result.fallbackReason && (
                            <span className="num mt-1 block text-[10.5px] text-amber-300/80">fallback: {r.result.fallbackReason}</span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                  {excluded.map((e) => (
                    <p key={e} className="flex items-start gap-1.5 text-[11.5px] text-slate-500">
                      <Ban className="mt-0.5 size-3 shrink-0" aria-hidden /> excluded · {e}
                    </p>
                  ))}
                </div>
              )}
            </Step>

            <Step
              n={2}
              state={s2}
              title="Sign & audit"
              description="Rhea signs a NEP-413 intent; the Sentinel's model audits it with the facts from evaluate_intent (an on-chain dry run) and signs its verdict."
              action={
                <Button
                  size="sm"
                  variant={s2 === "current" ? "primary" : "secondary"}
                  icon={FileSignature}
                  className="w-full min-[480px]:w-auto"
                  disabled={disabled || invalid || routes.length === 0}
                  onClick={() => void signAndAudit()}
                >
                  2 · Sign NEP-413 + Sentinel audit
                </Button>
              }
            >
              {(draft || audit) && (
                <div className="space-y-3">
                  {draft && (
                    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-1">
                      <KV k="NEP-413 hash (recipient = contract)" v={short(draft.nep413Hash, 16, 8)} />
                      <KV k="signature" v={short(draft.request.signature, 18, 6)} />
                    </div>
                  )}
                  {draft && (
                    <CodeBlock
                      title="intent message"
                      json={JSON.stringify(JSON.parse(draft.message), null, 2)}
                      actions={<CopyButton text={draft.message} label="Copy intent message" iconOnly />}
                    />
                  )}
                  {audit && (
                    <div
                      className={cx(
                        "rounded-xl border p-3 text-[12px]",
                        audit.verdict === "approve" ? "border-emerald-400/25 bg-emerald-400/[0.05]" : "border-red-400/30 bg-red-500/[0.06]",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2 text-slate-200">
                          <ScanEye className="size-4 shrink-0 text-violet-300" aria-hidden />
                          <span className="min-w-0 truncate">
                            Sentinel audit · {audit.completion.source === "nearai" ? "NEAR AI, TEE-signed" : "stand-in model"} · key{" "}
                            <span className="num">{audit.receipt.kind === "near_ai" ? audit.receipt.enclave_id : audit.receipt.receipt.enclave_id}</span>
                          </span>
                        </span>
                        <Badge tone={audit.verdict === "approve" ? "emerald" : "red"} dot>
                          {audit.verdict}
                        </Badge>
                      </div>
                      {audit.findings.map((f) => (
                        <div key={f} className="mt-1 text-red-300">
                          • {f}
                        </div>
                      ))}
                      <div className="num mt-2 text-[11px] text-slate-500">
                        evaluate_intent (on-chain dry run): approved={String(audit.assessment.decision.approved)} · signature_valid=
                        {String(audit.assessment.signature_valid)} · velocity {audit.assessment.velocity_requests}/{dashboard?.policy.velocity_limit}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Step>

            <Step
              n={3}
              state={s3}
              title="Submit to the policy engine"
              description="request_intent_settlement checks every limit, the approved-recipient list, the price floor and the signed audit, then asks the MPC contract to sign."
              action={
                <Button
                  size="sm"
                  variant={s3 === "current" ? "primary" : "secondary"}
                  icon={Send}
                  className="w-full min-[480px]:w-auto"
                  disabled={disabled || !audit || audit.verdict !== "approve"}
                  onClick={() => void submit()}
                >
                  3 · Submit to policy engine
                </Button>
              }
            >
              {outcome && (
                <div
                  className={cx(
                    "rounded-xl border p-3 text-[12.5px]",
                    outcome.status === "rejected" ? "border-red-400/40 bg-red-500/10" : "border-emerald-400/25 bg-emerald-400/[0.05]",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="num text-slate-200">
                      intent #{outcome.intent_id} → <b>{outcome.status}</b>
                      {record && record.intent_id === outcome.intent_id && record.status !== outcome.status && (
                        <>
                          {" "}
                          → after MPC callback: <b className="text-emerald-300">{record.status}</b>
                        </>
                      )}
                    </span>
                    <Badge tone={outcome.decision.severity === "critical" ? "red" : outcome.decision.severity === "none" ? "emerald" : "amber"}>
                      {outcome.decision.severity}
                    </Badge>
                  </div>
                  {outcome.decision.violations.length > 0 && (
                    <div className="num mt-1 text-[11px] text-red-200">{outcome.decision.violations.map((v) => v.code).join(" · ")}</div>
                  )}
                  {outcome.quarantined && (
                    <div className="mt-1 text-red-300">
                      {rhea?.spawn_mode === "contract_key"
                        ? "Circuit breaker tripped: agent quarantined, contract key deleted on-chain."
                        : "Circuit breaker tripped: Rhea is quarantined. Her key is on her own sub-account, which the contract cannot delete, so it now rejects every call she signs."}
                    </div>
                  )}
                </div>
              )}
            </Step>

            <Step
              n={4}
              state={s4}
              last
              title="Close the rehearsal"
              description="The Sentinel recovers the MPC signer with ecrecover and closes the dry run: the reservation returns to liquidity and nothing is booked as deployed."
              action={
                <Button
                  size="sm"
                  variant={s4 === "current" ? "primary" : "secondary"}
                  icon={ShieldCheck}
                  className="w-full min-[480px]:w-auto"
                  disabled={disabled || !record || record.status !== "signed"}
                  onClick={() => void confirm()}
                >
                  4 · Close dry run
                </Button>
              }
            >
              {record?.mpc && (
                <div className="rounded-xl border border-violet-400/25 bg-violet-400/[0.05] px-3 py-2 text-[12px]">
                  <div className="mb-1 flex items-center gap-2 text-violet-200">
                    <Signature className="size-4" aria-hidden />
                    Chain Signatures authorization ({record.mpc.mpc_contract_id}, path {record.mpc.path})
                  </div>
                  <KV k="payload = keccak256(EIP-191 ‖ commitment)" v={short(record.mpc.payload, 14, 8)} />
                  {record.mpc.signature && (
                    <KV
                      k="big_r / s / v"
                      v={`${short(record.mpc.signature.big_r, 8, 4)} / ${short(record.mpc.signature.s, 6, 4)} / ${record.mpc.signature.recovery_id + 27}`}
                    />
                  )}
                  {mpc && (
                    <KV
                      k="ecrecover"
                      v={
                        <span className={mpc.valid ? "text-emerald-300" : "text-red-300"}>
                          {short(mpc.recovered, 8, 6)} {mpc.valid ? "= treasury address ✔" : "≠ treasury address ✘"}
                        </span>
                      }
                    />
                  )}
                  <KV
                    k="status"
                    v={
                      <Badge tone={record.status === "settled" ? "emerald" : "sky"}>
                        {record.status}
                        {record.dry_run ? " · dry run" : ""}
                      </Badge>
                    }
                  />
                </div>
              )}
            </Step>
          </ol>
        </>
      )}
    </Card>
  );
}

const intentTone = (s: string): Tone =>
  s === "settled" || s === "signed" || s === "confirmed"
    ? "emerald"
    : s === "rejected" || s === "authorization_failed" || s === "payment_failed"
      ? "red"
      : s === "pending_approval"
        ? "amber"
        : "sky";

export function IntentLedger() {
  const { dashboard } = useAegis();
  const personaOf = usePersonaOf();
  const count = dashboard ? dashboard.intents.length + dashboard.evm_txs.length : 0;
  return (
    <Card className="flex h-full flex-col p-4 sm:p-5">
      <CardHeader
        icon={ListOrdered}
        eyebrow="On-chain settlement records"
        title="Settlement ledger"
        description="Real NEAR payments, dry-run rehearsals and MPC-signed EVM transactions, as the contract stores them."
        actions={
          dashboard && (
            <Badge tone="slate">
              {count} {count === 1 ? "record" : "records"}
            </Badge>
          )
        }
      />
      <div className="mt-4 flex flex-1 flex-col justify-center">
        {!dashboard ? (
          <SkeletonBlock rows={5} />
        ) : count === 0 ? (
          <EmptyState
            icon={ArrowRightLeft}
            title="No settlements yet"
            hint="Pay an invoice in Try it, submit a route in the Intent terminal, or run the judge scenario."
          />
        ) : (
          <ul className="space-y-1.5">
            {dashboard.intents.map((i) => {
              const p = personaOf(i.agent_id);
              const label = i.kind === "vendor_payment" && i.destination_chain === "near" ? "NEAR payment" : i.dry_run ? "dry run" : i.kind;
              return (
                <li key={`i-${i.intent_id}`} className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5">
                  {p ? <PersonaAvatar persona={p} size={28} /> : <TriangleAlert className="size-4 text-slate-500" aria-hidden />}
                  <div className="min-w-0 flex-1">
                    <div className="num flex flex-wrap items-center gap-2 text-[12.5px] text-slate-200">
                      #{i.intent_id} <span className="text-slate-400">{nearFmt(i.amount, 1)}</span> →{" "}
                      <span className="truncate text-slate-300" title={i.recipient}>
                        {i.destination_chain === "near" ? short(i.recipient, 18, 0) : i.destination_chain}
                      </span>
                    </div>
                    <div className="num truncate text-[11px] text-slate-500" title={i.agent_id}>
                      {short(i.agent_id, 22, 0)} · {label}
                    </div>
                  </div>
                  <Badge tone={intentTone(i.status)} dot>
                    {i.status}
                  </Badge>
                </li>
              );
            })}
            {dashboard.evm_txs.map((t) => {
              const p = personaOf(t.agent_id);
              return (
                <li
                  key={`e-${t.tx_id}`}
                  className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-violet-400/15 bg-violet-400/[0.03] p-2.5"
                >
                  {p ? <PersonaAvatar persona={p} size={28} /> : <Cpu className="size-4 text-violet-300" aria-hidden />}
                  <div className="min-w-0 flex-1">
                    <div className="num flex flex-wrap items-center gap-2 text-[12.5px] text-slate-200">
                      EVM #{t.tx_id} <span className="text-slate-400">{t.asset === NATIVE_ASSET ? ethFmt(t.amount) : `${t.amount} token units`}</span> →{" "}
                      <span className="text-slate-300" title={t.to}>
                        {short(t.to, 8, 4)}
                      </span>
                    </div>
                    <div className="num truncate text-[11px] text-slate-500" title={t.tx_hash ?? t.signing_hash}>
                      {t.chain} ({t.chain_id}) · {t.tx_hash ? `tx ${short(t.tx_hash, 10, 6)}` : `hash ${short(t.signing_hash, 10, 6)}`}
                    </div>
                  </div>
                  <Badge tone={intentTone(t.status)} dot>
                    {t.status}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

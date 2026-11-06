"use client";

import {
  ACCOUNTS,
  ATTACKER_EVM,
  VENDOR_EVM,
  formatNear,
  parseNear,
  sha256Hex,
  type CrossChainIntentRequestT,
  type GlobalPolicyT,
  type PaymentInstructionT,
  type PolicyViolationT,
  type PreflightDecision,
  type SettlementOutcomeT,
} from "@aegis/agent-swarm-sdk";
import { AnimatePresence } from "framer-motion";
import {
  Ban,
  BadgeCheck,
  Briefcase,
  ChevronDown,
  FileWarning,
  Fingerprint,
  Gavel,
  Hourglass,
  OctagonAlert,
  Play,
  RotateCcw,
  ScanEye,
  ShieldCheck,
  ShieldX,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useAegis } from "@/lib/aegis-context";
import { useTestnetTxs } from "@/lib/testnet-evidence";
import { useAction } from "@/lib/use-action";

import { Reveal, StepCard, TestnetLink } from "./demo-parts";
import { Badge, Button, Callout, Field, PersonaAvatar, SegmentedControl, Spinner, Switch, cx, describeViolation, nearFmt, short } from "./ui";

const VENDOR_NEAR_ENTRY = `near:${ACCOUNTS.vendor}`;
const VENDOR_EVM_SUFFIX = `:${VENDOR_EVM.toLowerCase()}`;
const VENDOR_EVM_CHAINS = ["basesepolia", "base", "arb"];
/** The memo of Cipher's real request: what an honest audit must see. */
const REDIRECT_MEMO = "advance per changed bank details in vendor email";

interface Limits {
  maxTx: string;
  cap: string;
  vendorNear: boolean;
  vendorEvm: boolean;
  /** `hold`: a new recipient waits for the DAO instead of quarantining the agent. */
  holdNew: boolean;
}

type JobVendor = "a" | "b";

/** yoctoNEAR → the shortest decimal NEAR string (for inputs). */
const nearInput = (yocto: string) => formatNear(BigInt(yocto), 6).replace(/\.?0+$/, "");
const sameNear = (input: string, yocto: string) => {
  try {
    return parseNear(input) === BigInt(yocto);
  } catch {
    return false;
  }
};

function limitsOf(p: GlobalPolicyT): Limits {
  return {
    maxTx: nearInput(p.max_tx_amount_yocto),
    cap: nearInput(p.epoch_spending_cap_yocto),
    vendorNear: p.allowed_recipients.includes(VENDOR_NEAR_ENTRY),
    vendorEvm: p.allowed_recipients.some((r) => r.endsWith(VENDOR_EVM_SUFFIX)),
    holdNew: p.unknown_recipient === "hold",
  };
}

function limitsChanged(p: GlobalPolicyT, l: Limits): boolean {
  const saved = limitsOf(p);
  return (
    !sameNear(l.maxTx, p.max_tx_amount_yocto) ||
    !sameNear(l.cap, p.epoch_spending_cap_yocto) ||
    l.vendorNear !== saved.vendorNear ||
    l.vendorEvm !== saved.vendorEvm ||
    l.holdNew !== saved.holdNew
  );
}

function withLimits(p: GlobalPolicyT, l: Limits): GlobalPolicyT {
  const rest = p.allowed_recipients.filter((r) => r !== VENDOR_NEAR_ENTRY && !r.endsWith(VENDOR_EVM_SUFFIX));
  return {
    ...p,
    max_tx_amount_yocto: parseNear(l.maxTx).toString(),
    epoch_spending_cap_yocto: parseNear(l.cap).toString(),
    unknown_recipient: l.holdNew ? "hold" : "quarantine",
    allowed_recipients: [
      ...rest,
      ...(l.vendorNear ? [VENDOR_NEAR_ENTRY] : []),
      ...(l.vendorEvm ? VENDOR_EVM_CHAINS.map((c) => `${c}${VENDOR_EVM_SUFFIX}`) : []),
    ],
  };
}

const nearError = (v: string) => {
  try {
    return parseNear(v) > 0n ? null : "Must be more than 0";
  } catch {
    return "Enter a NEAR amount, e.g. 25 or 2.5";
  }
};

type ModelSource = "nearai" | "generic_llm" | "standin";
const sourceLabel = (s: ModelSource | null) => (s === "nearai" ? "NEAR AI, TEE-signed" : s === "generic_llm" ? "live LLM" : "stand-in");

interface JobResult {
  amount: string;
  recipient: string;
  /** Nexus's own pre-flight (`check_recipient`), before the Sentinel is asked. */
  preflight: PreflightDecision;
  /** `null` when Nexus's pre-flight stopped the payment before any audit. */
  verdict: "approve" | "reject" | null;
  findings: string[];
  modelSource: ModelSource | null;
  /** What the contract's dry run (`evaluate_intent`) found, proof checks left out. */
  precheck: PolicyViolationT[];
  /** The signed request, kept when the Sentinel rejected it so it can be sent anyway. */
  unsent: CrossChainIntentRequestT | null;
  /** Sent without the Sentinel's approval. */
  ignoredSentinel: boolean;
  outcome: SettlementOutcomeT | null;
  finalStatus: string | null;
  vendorGain: bigint;
  /** The DAO approved a held payment. */
  approvedByDao?: boolean;
  /** Step 3 switched the DAO's rule for new recipients to `hold` first. */
  switchedToHold?: boolean;
  error: string | null;
}

const PROOF_CODES = new Set(["missing_tee_attestation", "invalid_tee_attestation"]);

interface AttackResult {
  invoice: string;
  instruction: PaymentInstructionT;
  fooled: boolean;
  submitted: PaymentInstructionT;
  modelSource: ModelSource;
  outcome: SettlementOutcomeT | null;
  keyDeleted: boolean;
  liquidUnchanged: boolean;
  /** The Sentinel put the attacker on the shared blocklist after the rejection. */
  blocklisted: boolean;
  error: string | null;
}

interface ForgeryResult {
  signatureValid: boolean;
  signingAddress: string;
  modelSource: ModelSource;
  outcome: SettlementOutcomeT | null;
  paid: boolean;
  error: string | null;
}

interface FactsResult {
  /** The Sentinel's verdict on the contract's own facts. */
  honestVerdict: "approve" | "reject";
  honestFindings: string[];
  realHash: string;
  inventedHash: string;
  /** Fields the agent changed in its copy of the facts. */
  changes: Array<{ field: string; real: string; invented: string }>;
  verdict: "approve" | "reject";
  signatureValid: boolean;
  modelSource: ModelSource;
  outcome: SettlementOutcomeT | null;
  paid: boolean;
  error: string | null;
}

/** Leaf fields that differ between two JSON documents, as `a.b` paths. */
function changedFields(real: unknown, invented: unknown, path = ""): Array<{ field: string; real: string; invented: string }> {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (isObj(real) && isObj(invented)) {
    return [...new Set([...Object.keys(real), ...Object.keys(invented)])].flatMap((k) => changedFields(real[k], invented[k], path ? `${path}.${k}` : k));
  }
  const a = JSON.stringify(real ?? null);
  const b = JSON.stringify(invented ?? null);
  return a === b ? [] : [{ field: path, real: a, invented: b }];
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The guided demo: a fooled agent loses its key, an approval over invented facts fails, a new vendor waits for the DAO. */
export function TryIt() {
  const { runtime, dashboard, busy, reset, inference, agentsInfo, scenario } = useAegis();
  const action = useAction();
  const txs = useTestnetTxs();
  const [limits, setLimits] = useState<Limits>({ maxTx: "", cap: "", vendorNear: true, vendorEvm: true, holdNew: false });
  const [jobVendor, setJobVendor] = useState<JobVendor>("a");
  const [forgery, setForgery] = useState<ForgeryResult | null>(null);
  const policy = dashboard?.policy ?? null;
  const policyVersion = dashboard?.policy_version ?? null;
  // Every dashboard refresh returns a new object. Re-sync the form only when the saved policy
  // changed, so unsaved edits survive contract calls made elsewhere on the page.
  const policyKey = policy ? JSON.stringify(policy) : null;
  const [syncedKey, setSyncedKey] = useState<string | null>(null);
  if (policyKey !== syncedKey) {
    setSyncedKey(policyKey);
    if (policy) setLimits(limitsOf(policy));
  }
  const [jobAmount, setJobAmount] = useState("2");
  const [savedOnce, setSavedOnce] = useState(false);
  const [job, setJob] = useState<JobResult | null>(null);
  const [attack, setAttack] = useState<AttackResult | null>(null);
  const [facts, setFacts] = useState<FactsResult | null>(null);
  const [held, setHeld] = useState<JobResult | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rtSeen, setRtSeen] = useState(runtime);
  if (runtime !== rtSeen) {
    setRtSeen(runtime);
    setJob(null);
    setAttack(null);
    setFacts(null);
    setHeld(null);
    setForgery(null);
    setSavedOnce(false);
    setError(null);
    // A new sandbox discards unsaved limit edits too.
    setSyncedKey(null);
  }

  const errors = useMemo(() => {
    const maxTx = nearError(limits.maxTx);
    // The contract rejects a policy whose epoch cap is below its per-payment limit.
    const cap = nearError(limits.cap) ?? (maxTx === null && parseNear(limits.cap) < parseNear(limits.maxTx) ? "Must be at least the max per payment" : null);
    return { maxTx, cap, job: nearError(jobAmount) };
  }, [limits, jobAmount]);
  const disabled = !runtime || !dashboard || busy !== null || working !== null || scenario.running;
  const dirty = policy !== null && limitsChanged(policy, limits);
  const agentRecord = (persona: "mallory" | "nexus" | "rhea" | "cipher") =>
    runtime && dashboard ? dashboard.agents.find((a) => a.agent_id === runtime.agents[persona].accountId) : undefined;
  const mallory = agentRecord("mallory");
  const nexus = agentRecord("nexus");
  const rhea = agentRecord("rhea");
  const cipher = agentRecord("cipher");
  const blocked = dashboard?.blocked_recipients ?? [];
  const brain =
    inference === "nearai"
      ? `NEAR AI Cloud (${agentsInfo?.model ?? "TEE model"})`
      : inference === "generic_llm"
        ? `Live LLM (${agentsInfo?.model ?? "model"})`
        : "the offline stand-in model";

  const run = async (label: string, fn: () => Promise<void>) => {
    setWorking(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking(null);
    }
  };

  const saveLimits = () =>
    run("Saving limits", async () => {
      if (!runtime || !policy || errors.maxTx || errors.cap) return;
      // Sent with the version it was read at: a stale edit fails instead of overwriting a newer policy.
      const r = await action("owner (DAO) sets the spending limits", runtime.owner, "update_global_policy", (rt) =>
        rt.updatePolicy(withLimits(policy, limits), policyVersion),
      );
      if (r?.ok) setSavedOnce(true);
      else if (r) throw new Error(r.error ?? "update_global_policy failed");
    });

  const vendorName = (recipient: string) => (recipient === ACCOUNTS.newVendor ? "GPU Vendor B" : "GPU Vendor A");

  /** Sends the payment to the contract; `proof` is the Sentinel's signed approval, or null when Nexus ignores its checks. */
  const sendPayment = async (request: CrossChainIntentRequestT, proof: CrossChainIntentRequestT["attestation"], amountLabel: string) => {
    if (!runtime) return null;
    const before = runtime.vm.balanceOf(request.recipient);
    const r = await action(
      `Nexus pays ${amountLabel} NEAR to ${vendorName(request.recipient)}${proof ? "" : " (ignoring its checks)"}`,
      runtime.agents.nexus.signer,
      "request_intent_settlement",
      (rt) => rt.submitIntent("nexus", { ...request, attestation: proof }),
      (res) =>
        res.ok && res.value
          ? res.value.status === "pending_approval"
            ? { tone: "info", title: "Waiting for the DAO", description: `intent #${res.value.intent_id} · new recipient, nothing moved yet` }
            : res.value.decision.approved
              ? { tone: "success", title: "Vendor paid", description: `intent #${res.value.intent_id} · real NEAR transfer` }
              : { tone: "warning", title: "Payment blocked by the contract", description: res.value.decision.violations.map((v) => v.code).join(", ") }
          : undefined,
    );
    const record = r?.value ? await runtime.contract.intent(r.value.intent_id) : null;
    return {
      outcome: r?.value ?? null,
      finalStatus: record?.status ?? null,
      vendorGain: runtime.vm.balanceOf(request.recipient) - before,
      error: r && !r.ok ? r.error : null,
    };
  };

  /** Pre-flight, Sentinel audit, then the contract: what an honest Nexus does with an invoice. */
  const payInvoice = async (recipient: string, amount: bigint, memo: string): Promise<JobResult | null> => {
    if (!runtime) return null;
    const pay = runtime.buildVendorPayment("nexus", recipient, amount, memo);
    setWorking("Nexus checks the recipient");
    const preflight = await runtime.preflight("near", recipient);
    const base: JobResult = {
      amount: formatNear(amount, 2),
      recipient,
      preflight,
      verdict: null,
      findings: [],
      modelSource: null,
      precheck: [],
      unsent: null,
      ignoredSentinel: false,
      outcome: null,
      finalStatus: null,
      vendorGain: 0n,
      error: null,
    };
    // The agent-side wrapper: never sign for a blocked recipient, or for a new one the DAO has not approved.
    if (preflight.action === "refuse" || preflight.action === "ask_dao_to_allow_list") return { ...base, unsent: pay.request };
    setWorking(`${inference === "nearai" ? "NEAR AI " : ""}Sentinel audits the payment`);
    const audit = await runtime.auditIntent("nexus", pay.request, pay.nep413Hash);
    const audited: JobResult = {
      ...base,
      verdict: audit.verdict,
      findings: audit.findings,
      modelSource: audit.completion.source,
      precheck: audit.assessment.decision.violations.filter((v) => !PROOF_CODES.has(v.code)),
    };
    if (audit.verdict !== "approve") return { ...audited, unsent: pay.request };
    setWorking("Policy engine checks the payment");
    const sent = await sendPayment(pay.request, audit.receipt, formatNear(amount, 2));
    return sent ? { ...audited, ...sent } : audited;
  };

  const approveFlow = async (r: JobResult): Promise<JobResult> => {
    const intentId = r.outcome?.intent_id;
    if (!runtime || !intentId) return r;
    setWorking("The DAO reviews the payment");
    const before = runtime.vm.balanceOf(r.recipient);
    const res = await action(
      "Owner (DAO) approves the held payment",
      runtime.owner,
      "approve_intent",
      (rt) => rt.approveIntent(intentId),
      (x) =>
        x.ok
          ? { tone: "success", title: "Paid after DAO approval", description: `intent #${intentId} · real NEAR transfer` }
          : { tone: "error", title: "Approval rejected", description: x.error ?? undefined },
    );
    const record = await runtime.contract.intent(intentId);
    return {
      ...r,
      finalStatus: record?.status ?? r.finalStatus,
      vendorGain: runtime.vm.balanceOf(r.recipient) - before,
      approvedByDao: Boolean(res?.ok),
      error: res && !res.ok ? res.error : null,
    };
  };

  // Step 1: a prompt-injected agent pays an attacker inside every limit.
  const attackFlow = async (): Promise<AttackResult | null> => {
    if (!runtime) return null;
    setWorking(`${inference === "nearai" ? "NEAR AI: " : ""}Mallory reads the invoice`);
    const liquidBefore = (await runtime.contract.treasury()).liquid;
    const fraud = await runtime.invoiceFraudAttempt();
    setWorking("Policy engine checks the payment");
    const r = await action(
      "Mallory pays the invoice's 'updated bank details'",
      runtime.agents.mallory.signer,
      "request_intent_settlement",
      (rt) => rt.submitIntent("mallory", fraud.request),
      (res) =>
        res.ok && res.value
          ? {
              tone: "warning",
              title: res.value.quarantined ? "Fraud blocked · Mallory's key deleted" : `Payment ${res.value.status}`,
              description: res.value.decision.violations.map((v) => v.code).join(", "),
            }
          : { tone: "warning", title: "Rejected before execution", description: res.error ?? undefined },
    );
    const keyDeleted = !runtime.keysOf(ACCOUNTS.contract).some((k) => k.publicKey === runtime.agents.mallory.keyPair.publicKeyString);
    // One incident protects every agent: the Sentinel reports the address, with the rejected request as evidence.
    let blocklisted = false;
    const rejected = r?.value && !r.value.decision.approved ? r.value : null;
    if (rejected) {
      setWorking("Sentinel reports the attacker");
      const b = await action(
        "Sentinel adds the attacker to the shared blocklist",
        runtime.agents.sentinel.signer,
        "block_recipient",
        (rt) =>
          rt.blockRecipient(fraud.request.destination_chain, fraud.request.recipient, "BEC invoice fraud INV-2291: paying agent stopped", rejected.nep413_hash),
        () => null,
      );
      blocklisted = Boolean(b?.ok);
    }
    return {
      blocklisted,
      invoice: fraud.invoice,
      instruction: fraud.instruction,
      fooled: fraud.fooled,
      submitted: fraud.submitted,
      modelSource: fraud.completion.source,
      outcome: r?.value ?? null,
      keyDeleted,
      liquidUnchanged: (await runtime.contract.treasury()).liquid === liquidBefore,
      error: r && !r.ok ? r.error : null,
    };
  };

  // Step 2: the pinned audit prompt, but evidence the agent wrote itself.
  const factsFlow = async (): Promise<FactsResult | null> => {
    if (!runtime) return null;
    const pay = runtime.buildVendorPayment("cipher", ACCOUNTS.vendor, parseNear("1"), REDIRECT_MEMO);
    setWorking(`${inference === "nearai" ? "NEAR AI " : ""}Sentinel audits the contract's facts`);
    const honest = await runtime.auditIntent("cipher", pay.request, pay.nep413Hash);
    setWorking("Cipher shows the model its own version of the facts");
    const forged = await runtime.forgeFacts("cipher", pay.request, pay.nep413Hash);
    setWorking("Policy engine checks the proof");
    const before = runtime.vm.balanceOf(ACCOUNTS.vendor);
    const r = await action(
      "Cipher pays with an approval over invented facts",
      runtime.agents.cipher.signer,
      "request_intent_settlement",
      (rt) => rt.submitIntent("cipher", { ...pay.request, attestation: forged.receipt }),
      (res) =>
        res.ok && res.value
          ? {
              tone: "warning",
              title: res.value.quarantined ? "Invented facts · Cipher quarantined" : `Payment ${res.value.status}`,
              description: res.value.decision.violations.map((v) => (v.code === "invalid_tee_attestation" ? `${v.code}: ${v.reason}` : v.code)).join(", "),
            }
          : undefined,
    );
    return {
      honestVerdict: honest.verdict,
      honestFindings: honest.findings,
      realHash: forged.realFacts.facts_hash,
      inventedHash: sha256Hex(forged.inventedFacts),
      changes: changedFields(JSON.parse(forged.realFacts.facts), JSON.parse(forged.inventedFacts)),
      verdict: forged.verdict,
      signatureValid: forged.signatureValid,
      modelSource: forged.completion.source,
      outcome: r?.value ?? null,
      paid: runtime.vm.balanceOf(ACCOUNTS.vendor) > before,
      error: r && !r.ok ? r.error : null,
    };
  };

  // Step 3: a vendor nobody approved yet; the DAO's rule holds the payment for a vote.
  const newVendorFlow = async (): Promise<JobResult | null> => {
    if (!runtime) return null;
    const current = await runtime.contract.policy();
    let switchedToHold = false;
    if (current.unknown_recipient !== "hold") {
      setWorking("The DAO holds payments to new recipients for review");
      const r = await action("Owner (DAO) sets new recipients to wait for its vote", runtime.owner, "update_global_policy", async (rt) =>
        rt.updatePolicy({ ...current, unknown_recipient: "hold" }, await rt.contract.policyVersion()),
      );
      if (!r?.ok) throw new Error(r?.error ?? "update_global_policy failed");
      switchedToHold = true;
    }
    const r = await payInvoice(ACCOUNTS.newVendor, parseNear("1"), "GPU capacity deposit vendor-b");
    return r ? { ...r, switchedToHold } : null;
  };

  const runAttack = () => run("Mallory reads the invoice", async () => setAttack(await attackFlow()));
  const runFacts = () => run("Cipher writes its own evidence", async () => setFacts(await factsFlow()));
  const runNewVendor = () => run("Nexus pays a new vendor", async () => setHeld(await newVendorFlow()));
  const approveNewVendor = () =>
    run("The DAO reviews the payment", async () => {
      if (held) setHeld(await approveFlow(held));
    });
  const runAll = () =>
    run("Step 1", async () => {
      const a = await attackFlow();
      setAttack(a);
      const f = await factsFlow();
      setFacts(f);
      const h = await newVendorFlow();
      setHeld(h);
      if (h?.finalStatus === "pending_approval") setHeld(await approveFlow(h));
    });

  // Explore: free-form tools.
  const runJob = () =>
    run("Nexus checks the recipient", async () => {
      if (errors.job) return;
      const recipient = jobVendor === "a" ? ACCOUNTS.vendor : ACCOUNTS.newVendor;
      setJob(await payInvoice(recipient, parseNear(jobAmount), `GPU capacity deposit vendor-${jobVendor}`));
    });

  const sendAnyway = () =>
    run("Policy engine checks the payment", async () => {
      if (!job?.unsent) return;
      const sent = await sendPayment(job.unsent, null, formatNear(BigInt(job.unsent.amount), 2));
      if (sent) setJob({ ...job, ...sent, unsent: null, ignoredSentinel: true });
    });

  const approveJob = () =>
    run("The DAO reviews the payment", async () => {
      if (job) setJob(await approveFlow(job));
    });

  const runForgery = () =>
    run("Rhea asks the model for her own approval", async () => {
      if (!runtime) return;
      const pay = runtime.buildVendorPayment("rhea", ACCOUNTS.vendor, parseNear("1"), "GPU capacity top-up vendor-a");
      const forged = await runtime.forgeAudit("rhea", pay.request, pay.nep413Hash);
      setWorking("Policy engine checks the proof");
      const before = runtime.vm.balanceOf(ACCOUNTS.vendor);
      const r = await action(
        "Rhea pays with an approval she wrote herself",
        runtime.agents.rhea.signer,
        "request_intent_settlement",
        (rt) => rt.submitIntent("rhea", { ...pay.request, attestation: forged.receipt }),
        (res) =>
          res.ok && res.value
            ? {
                tone: "warning",
                title: res.value.quarantined ? "Forged proof · Rhea quarantined" : `Payment ${res.value.status}`,
                description: res.value.decision.violations.map((v) => (v.code === "invalid_tee_attestation" ? `${v.code}: ${v.reason}` : v.code)).join(", "),
              }
            : undefined,
      );
      setForgery({
        signatureValid: forged.signatureValid,
        signingAddress: forged.completion.signingAddress,
        modelSource: forged.completion.source,
        outcome: r?.value ?? null,
        paid: runtime.vm.balanceOf(ACCOUNTS.vendor) > before,
        error: r && !r.ok ? r.error : null,
      });
    });

  const attackBlocked = Boolean(attack?.outcome && !attack.outcome.decision.approved && attack.liquidUnchanged);
  const factsRejected = Boolean(
    facts?.outcome &&
    !facts.outcome.decision.approved &&
    !facts.paid &&
    facts.outcome.decision.violations.some((v) => v.code === "invalid_tee_attestation" && v.reason === "facts_mismatch"),
  );
  const heldPaid = held?.finalStatus === "settled" && held.vendorGain > 0n && held.approvedByDao === true;
  const nextStep = !attackBlocked ? 1 : !factsRejected ? 2 : !heldPaid ? 3 : 0;
  const canRunAll = !disabled && mallory?.status.kind === "active" && cipher?.status.kind === "active" && nexus?.status.kind === "active";

  return (
    <section aria-labelledby="try-title" className="surface relative overflow-hidden rounded-2xl">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_320px_at_0%_0%,rgb(0_236_151/0.12),transparent_60%),radial-gradient(700px_300px_at_100%_0%,rgb(125_211_252/0.08),transparent_60%)]"
      />
      <div className="relative p-4 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-500/[0.08] py-1 pl-1.5 pr-3 text-[11.5px] font-medium text-emerald-200">
              <span className="grid size-5 place-items-center rounded-full bg-emerald-500/20">
                <ShieldCheck className="size-3" aria-hidden />
              </span>
              Guided demo · 3 steps on the compiled contract
            </div>
            <h2 id="try-title" className="mt-3 text-balance text-[26px] font-semibold leading-[1.15] tracking-tight text-white sm:text-[32px]">
              The contract decides whether an AI&apos;s decision counts.
            </h2>
            <p className="mt-3 text-[13.5px] leading-relaxed text-slate-400">
              An agent&apos;s model can be prompt-injected, and an approval can be forged. PhalanxSwarm&apos;s NEAR contract checks every AI decision against
              rules only the DAO can change, before any money moves. A fooled agent loses its key in the same transaction; an audit counts only if it judged the
              facts the contract built itself; a payment to someone new waits for the DAO&apos;s vote.
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Button className="w-full min-[480px]:w-auto" size="sm" variant="primary" icon={Play} disabled={!canRunAll} onClick={() => void runAll()}>
              Run all 3 steps
            </Button>
            <Button
              className="w-full min-[480px]:w-auto"
              size="sm"
              variant="ghost"
              icon={RotateCcw}
              disabled={busy !== null || working !== null || scenario.running}
              onClick={() => void reset()}
            >
              Start over
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px]">
          <span className="rounded-lg sm:rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-medium text-slate-300 max-w-full break-words">
            Rehearsal: compiled WASM in AegisSim · the same steps ran on testnet (links in each step)
          </span>
          <Badge tone={inference === "nearai" ? "emerald" : inference === "generic_llm" ? "sky" : "amber"} dot>
            {inference === "nearai"
              ? `Agents: NEAR AI Cloud · ${short(agentsInfo?.model ?? "", 26, 0)}`
              : inference === "generic_llm"
                ? `Agents: Live LLM · ${short(agentsInfo?.model ?? "", 26, 0)}`
                : "Agents: offline stand-in (no TEE)"}
          </Badge>
        </div>

        <div aria-live="polite" className="mt-3 min-h-0 space-y-2">
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
        </div>

        <ol className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-3">
          <StepCard
            n={1}
            icon={FileWarning}
            title="A fooled agent loses its key"
            done={attackBlocked}
            current={nextStep === 1}
            lead={
              <>
                Mallory, a third-party accounts-payable agent, reads an invoice with a forwarded &ldquo;our bank details changed&rdquo; message. The payment it
                asks for is small and uses an allowed chain and route. Only the recipient check stops it.
              </>
            }
          >
            <div className="flex h-11 min-w-0 items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[12px]">
              {runtime && <PersonaAvatar persona="mallory" size={28} status={mallory?.status.kind} />}
              <span className="min-w-0 flex-1 truncate text-slate-300">
                Mallory-AP-Agent · rep {mallory ? `${(mallory.reputation_bps / 100).toFixed(0)}%` : "…"}
              </span>
              {mallory && <Badge tone={mallory.status.kind === "active" ? "emerald" : "red"}>{mallory.status.kind}</Badge>}
            </div>
            <Button
              className="w-full"
              variant="danger"
              icon={FileWarning}
              shine={nextStep === 1}
              disabled={disabled || mallory?.status.kind !== "active"}
              onClick={() => void runAttack()}
            >
              Let Mallory pay the poisoned invoice
            </Button>
            {mallory && mallory.status.kind !== "active" && !attack && (
              <p className="text-[11.5px] text-slate-500">Mallory is already {mallory.status.kind}. Start over to replay the attack.</p>
            )}
            <AnimatePresence initial={false}>
              {attack && (
                <Reveal>
                  <div className="space-y-2">
                    <details className="rounded-xl border border-white/[0.06] bg-black/30 text-[11.5px]">
                      <summary className="cursor-pointer px-3 py-2 text-slate-300">Invoice INV-2291 (what the model read)</summary>
                      <pre className="num whitespace-pre-wrap break-words px-3 pb-3 text-[11px] leading-relaxed text-slate-400">{attack.invoice}</pre>
                    </details>
                    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-[12px] text-slate-300">
                      <span className="text-slate-500">Model ({sourceLabel(attack.modelSource)}) decided: </span>
                      {attack.instruction.action === "hold" ? (
                        <span>hold the payment: &ldquo;{attack.instruction.reason.slice(0, 200)}&rdquo;</span>
                      ) : (
                        <span className="num">
                          pay {attack.instruction.amount_near} NEAR to {short(attack.instruction.recipient, 10, 6)} on {attack.instruction.chain}
                        </span>
                      )}
                      {!attack.fooled && (
                        <div className="mt-1 text-amber-200">
                          The model resisted. The treasury must not rely on that, so the injected instruction (pay {short(attack.submitted.recipient, 8, 6)})
                          was submitted anyway.
                        </div>
                      )}
                    </div>
                    <div
                      className={cx(
                        "space-y-1.5 rounded-xl border p-3 text-[12px]",
                        attackBlocked ? "border-emerald-400/25 bg-emerald-400/[0.05]" : "border-red-400/40 bg-red-500/10",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-slate-100">{attackBlocked ? "Blocked by the contract" : "Not blocked"}</span>
                        {attack.outcome && (
                          <Badge tone={attack.outcome.decision.severity === "critical" ? "red" : "amber"}>{attack.outcome.decision.severity}</Badge>
                        )}
                      </div>
                      {attack.outcome?.decision.violations
                        .filter((v) => v.code !== "missing_tee_attestation")
                        .map((v, i) => (
                          <div key={i} className="flex gap-1.5 text-red-200">
                            <OctagonAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {describeViolation(v)}
                          </div>
                        ))}
                      {attack.error && <div className="num text-red-300">{attack.error}</div>}
                      {attack.keyDeleted && (
                        <div className="font-medium text-slate-100">
                          Mallory was quarantined and its access key deleted (a DeleteKey action), in the same transaction as the rejection.
                        </div>
                      )}
                      <div className="text-slate-400">
                        {attack.liquidUnchanged ? "Treasury balance unchanged." : "Treasury balance changed."} The attacker address{" "}
                        <span className="num">{short(ATTACKER_EVM, 8, 6)}</span> was never on the DAO&apos;s list.
                      </div>
                      {attack.blocklisted && (
                        <div className="flex gap-1.5 text-slate-300">
                          <ShieldX className="mt-0.5 size-3.5 shrink-0 text-red-300" aria-hidden />
                          The Sentinel added it to the shared blocklist, with the rejected request as evidence. Every agent&apos;s pre-flight now refuses it.
                        </div>
                      )}
                      <TestnetLink href={txs.invoice_fraud_attempt} label="The same attack on testnet (key deleted)" />
                    </div>
                  </div>
                </Reveal>
              )}
            </AnimatePresence>
          </StepCard>

          <StepCard
            n={2}
            icon={Fingerprint}
            title="An approval over invented facts is rejected"
            done={factsRejected}
            current={nextStep === 2}
            lead={
              <>
                Cipher is compromised and knows the DAO-pinned audit prompt. Its real payment carries a &ldquo;changed bank details&rdquo; memo. It asks the
                model to approve a copy of the facts with a harmless memo. The model really signs. The contract compares the audit&apos;s input with the facts
                it built itself.
              </>
            }
          >
            <div className="flex h-11 min-w-0 items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[12px]">
              {runtime && <PersonaAvatar persona="cipher" size={28} status={cipher?.status.kind} />}
              <span className="min-w-0 flex-1 truncate text-slate-300" title="Cipher-Compute-Worker · pays allow-listed GPU Vendor A, 1 NEAR">
                Cipher-Compute · GPU Vendor A
              </span>
              {cipher && <Badge tone={cipher.status.kind === "active" ? "emerald" : "red"}>{cipher.status.kind}</Badge>}
            </div>
            <Button
              className="w-full"
              variant="danger"
              icon={Fingerprint}
              shine={nextStep === 2}
              disabled={disabled || cipher?.status.kind !== "active"}
              onClick={() => void runFacts()}
            >
              Let Cipher forge the evidence
            </Button>
            {cipher && cipher.status.kind !== "active" && !facts && (
              <p className="text-[11.5px] text-slate-500">Cipher is {cipher.status.kind}. Start over to replay the forgery.</p>
            )}
            <AnimatePresence initial={false}>
              {facts && (
                <Reveal>
                  <div className="space-y-2">
                    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-[12px] text-slate-300">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5">
                          <ScanEye className="size-3.5 text-violet-300" aria-hidden /> Sentinel on the contract&apos;s facts ({sourceLabel(facts.modelSource)})
                        </span>
                        <Badge tone={facts.honestVerdict === "approve" ? "emerald" : "red"}>{facts.honestVerdict}</Badge>
                      </div>
                      {facts.honestFindings.length > 0 && <div className="mt-1 text-slate-400">{facts.honestFindings.join(" · ")}</div>}
                    </div>
                    <div className="rounded-xl border border-white/[0.06] bg-black/30 p-3 text-[11.5px]">
                      <div className="mb-1.5 text-slate-300">What Cipher changed in its copy of the facts</div>
                      {facts.changes.map((c) => (
                        <div key={c.field} className="num space-y-0.5 border-t border-white/[0.05] py-1.5 first:border-0">
                          <div className="text-slate-500 break-all">{c.field}</div>
                          <div className="break-all text-red-200/90">contract: {c.real}</div>
                          <div className="break-all text-amber-200/90">Cipher: {c.invented}</div>
                        </div>
                      ))}
                      <div className="num mt-1.5 text-slate-500">
                        sha256 {short(facts.realHash, 8, 4)} (contract) ≠ {short(facts.inventedHash, 8, 4)} (Cipher)
                      </div>
                    </div>
                    <div
                      className={cx(
                        "space-y-1.5 rounded-xl border p-3 text-[12px]",
                        factsRejected ? "border-emerald-400/25 bg-emerald-400/[0.05]" : "border-red-400/40 bg-red-500/10",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-300">
                          Model verdict on the invented facts: <b className="text-slate-100">{facts.verdict}</b>, signature
                        </span>
                        <Badge tone={facts.signatureValid ? "emerald" : "red"}>{facts.signatureValid ? "valid" : "invalid"}</Badge>
                      </div>
                      {facts.outcome?.decision.violations
                        .filter((v) => v.code !== "missing_tee_attestation")
                        .map((v, i) => (
                          <div key={i} className="flex gap-1.5 text-red-200">
                            <OctagonAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                            {v.code === "invalid_tee_attestation" && v.reason === "facts_mismatch"
                              ? "The audit judged a document the contract did not build: rejected as a forgery (facts_mismatch)."
                              : describeViolation(v)}
                          </div>
                        ))}
                      {facts.error && <div className="num text-red-300">{facts.error}</div>}
                      <div className="text-slate-300">
                        {facts.outcome?.quarantined ? "Severity critical: Cipher was quarantined. " : ""}
                        {facts.paid ? "The vendor was paid." : "Nothing was paid."}
                      </div>
                      {txs.invented_facts_audit_attempt ? (
                        <TestnetLink href={txs.invented_facts_audit_attempt} label="The same forgery on testnet" />
                      ) : (
                        <TestnetLink
                          href={txs.forged_audit_attempt}
                          label="The self-written-prompt forgery on testnet (the recorded v2.2 run predates this check)"
                        />
                      )}
                    </div>
                  </div>
                </Reveal>
              )}
            </AnimatePresence>
          </StepCard>

          <StepCard
            n={3}
            icon={Gavel}
            title="A new vendor waits for the DAO"
            done={heldPaid}
            current={nextStep === 3}
            lead={
              <>
                Nexus pays GPU Vendor B, which nobody approved yet. The DAO&apos;s rule for new recipients is &ldquo;hold&rdquo;: after the pre-flight and a
                Sentinel audit with {brain}, the contract reserves the funds and waits for the DAO&apos;s vote. Nexus keeps its key.
              </>
            }
          >
            <div className="flex h-11 min-w-0 items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[12px]">
              {runtime && <PersonaAvatar persona="nexus" size={28} status={nexus?.status.kind} />}
              <span className="min-w-0 flex-1 truncate text-slate-300" title={`Nexus-Orchestrator → ${ACCOUNTS.newVendor}, 1 NEAR`}>
                Nexus → {ACCOUNTS.newVendor}
              </span>
              <Badge tone={policy?.unknown_recipient === "hold" ? "amber" : "slate"}>rule: {policy?.unknown_recipient ?? "…"}</Badge>
            </div>
            {!held || held.finalStatus !== "pending_approval" ? (
              <Button
                className="w-full"
                variant="primary"
                icon={Wallet}
                shine={nextStep === 3}
                disabled={disabled || nexus?.status.kind !== "active"}
                onClick={() => void runNewVendor()}
              >
                Let Nexus pay the new vendor
              </Button>
            ) : (
              <Button className="w-full" variant="primary" icon={Gavel} shine disabled={disabled} onClick={() => void approveNewVendor()}>
                Approve as the DAO
              </Button>
            )}
            <AnimatePresence initial={false}>
              {held && (
                <Reveal>
                  <JobReport r={held} txs={txs} nexus={nexus} quarantineAfter={policy?.quarantine_after_strikes ?? 3} />
                </Reveal>
              )}
            </AnimatePresence>
          </StepCard>
        </ol>

        <details className="group mt-4 rounded-2xl border border-white/[0.08] bg-black/20">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[13px] font-medium text-slate-200 [&::-webkit-details-marker]:hidden">
            <ChevronDown className="size-4 text-slate-400 transition-transform group-open:rotate-180" aria-hidden />
            Explore: set the DAO&apos;s limits, pay any invoice, try the simpler forgery
          </summary>
          <div className="grid grid-cols-1 gap-3 px-4 pb-4 xl:grid-cols-3">
            <ExploreCard
              icon={SlidersHorizontal}
              title="Set the limits"
              lead="You are the owner (a DAO). These rules live in the contract; no agent key can change them."
            >
              <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
                <Field
                  label="Max per payment"
                  suffix="NEAR"
                  inputMode="decimal"
                  value={limits.maxTx}
                  error={errors.maxTx}
                  hint={nexus ? `Nexus's own limit is ${nearFmt(nexus.policy.max_tx_amount_yocto, 0)}; the lower one applies.` : undefined}
                  onChange={(e) => setLimits({ ...limits, maxTx: e.target.value })}
                />
                <Field
                  label="Cap per epoch"
                  suffix="NEAR"
                  inputMode="decimal"
                  value={limits.cap}
                  error={errors.cap}
                  onChange={(e) => setLimits({ ...limits, cap: e.target.value })}
                />
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-1">
                <div className="pt-2 text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">Approved recipients</div>
                <Switch
                  checked={limits.vendorNear}
                  onChange={(v) => setLimits({ ...limits, vendorNear: v })}
                  label="GPU Vendor A on NEAR"
                  description={<span className="num">{ACCOUNTS.vendor}</span>}
                />
                <Switch
                  checked={limits.vendorEvm}
                  onChange={(v) => setLimits({ ...limits, vendorEvm: v })}
                  label="GPU Vendor A on EVM chains"
                  description={<span className="num">{short(VENDOR_EVM, 8, 6)} · Base Sepolia, Base, Arbitrum</span>}
                />
                <div className="flex items-center justify-between gap-3 border-t border-white/[0.05] py-2.5 text-[12px]">
                  <span className="text-slate-400">The treasury&apos;s own MPC addresses</span>
                  <Badge tone="emerald">always</Badge>
                </div>
              </div>
              <div className="space-y-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">A recipient nobody approved</div>
                <SegmentedControl<"quarantine" | "hold">
                  label="Unknown recipient rule"
                  size="sm"
                  value={limits.holdNew ? "hold" : "quarantine"}
                  onChange={(v) => setLimits({ ...limits, holdNew: v === "hold" })}
                  disabled={disabled}
                  options={[
                    { value: "quarantine", label: "Quarantine the agent", hint: "Treat it as an attack: critical, and a contract-account key is deleted" },
                    { value: "hold", label: "Hold for the DAO", hint: "The payment waits for DAO approval; the agent keeps its key" },
                  ]}
                />
                <p className="text-[11.5px] leading-snug text-slate-500">
                  {limits.holdNew
                    ? "Settlements to new recipients wait for your approval; nothing moves until you approve."
                    : "Paying a new recipient is treated as an attack. Blocked recipients are critical under either rule."}
                </p>
              </div>
              {blocked.length > 0 && (
                <div className="space-y-1.5 rounded-xl border border-red-400/20 bg-red-500/[0.04] p-3 text-[12px]">
                  <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-red-300/80">Shared blocklist</div>
                  {blocked.map((b) => (
                    <div key={b.recipient} className="flex gap-1.5 text-slate-300">
                      <ShieldX className="mt-0.5 size-3.5 shrink-0 text-red-300" aria-hidden />
                      <span className="min-w-0">
                        <span className="num">{short(b.recipient, 14, 6)}</span>: {b.reason}{" "}
                        <span className="text-slate-500">(reported by {short(b.reported_by, 14, 0)})</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center justify-end gap-2">
                {dirty && <span className="mr-auto text-[12px] text-amber-200">Unsaved changes</span>}
                {savedOnce && !dirty && <span className="mr-auto text-[12px] text-emerald-300">Saved · policy version {policyVersion}</span>}
                <Button
                  size="sm"
                  variant={dirty ? "primary" : "secondary"}
                  icon={ShieldCheck}
                  disabled={disabled || !dirty || Boolean(errors.maxTx || errors.cap)}
                  onClick={() => void saveLimits()}
                >
                  Save as owner
                </Button>
              </div>
            </ExploreCard>

            <ExploreCard
              icon={Briefcase}
              title="Pay any invoice"
              lead={
                <>
                  Nexus asks the contract about the recipient, the Sentinel audits the payment with {brain}, and the contract verifies the audit, applies the
                  limits and transfers the NEAR.
                </>
              }
            >
              <SegmentedControl<JobVendor>
                label="Vendor"
                size="sm"
                value={jobVendor}
                onChange={setJobVendor}
                disabled={disabled}
                options={[
                  { value: "a", label: "Vendor A (approved)", hint: ACCOUNTS.vendor },
                  { value: "b", label: "Vendor B (new)", hint: ACCOUNTS.newVendor },
                ]}
              />
              <Field
                label="Invoice amount"
                suffix="NEAR"
                inputMode="decimal"
                value={jobAmount}
                error={errors.job}
                onChange={(e) => setJobAmount(e.target.value)}
                presets={["2", "10", "30"]}
                onPreset={setJobAmount}
                hint="Try more than the per-payment limit, or switch the vendor off in Set the limits."
              />
              <Button
                className="w-full"
                variant="secondary"
                icon={Wallet}
                disabled={disabled || Boolean(errors.job) || nexus?.status.kind !== "active"}
                onClick={() => void runJob()}
              >
                Let Nexus pay the invoice
              </Button>
              {nexus && nexus.status.kind !== "active" && (
                <p className="text-[11.5px] text-amber-200">Nexus is {nexus.status.kind} after a policy violation. Start over to reset the sandbox.</p>
              )}
              <AnimatePresence initial={false}>
                {job && (
                  <Reveal>
                    <JobReport
                      r={job}
                      txs={txs}
                      nexus={nexus}
                      quarantineAfter={policy?.quarantine_after_strikes ?? 3}
                      onApprove={job.finalStatus === "pending_approval" ? () => void approveJob() : undefined}
                      onSendAnyway={job.unsent ? () => void sendAnyway() : undefined}
                      disabled={disabled}
                    />
                  </Reveal>
                )}
              </AnimatePresence>
            </ExploreCard>

            <ExploreCard
              icon={Fingerprint}
              title="The simpler forgery: a self-written prompt"
              lead="Rhea skips the Sentinel and asks the model herself, with instructions she wrote. The answer carries a valid signature from the registered model key. Only the DAO-pinned prompt hash tells it apart."
            >
              <Button
                className="w-full"
                variant="danger"
                icon={Fingerprint}
                disabled={disabled || rhea?.status.kind !== "active"}
                onClick={() => void runForgery()}
              >
                Let Rhea forge the audit
              </Button>
              {rhea && rhea.status.kind !== "active" && !forgery && (
                <p className="text-[11.5px] text-slate-500">Rhea is {rhea.status.kind}. Start over to replay the forgery.</p>
              )}
              <AnimatePresence initial={false}>
                {forgery && (
                  <Reveal>
                    <div
                      className={cx(
                        "space-y-1.5 rounded-xl border p-3 text-[12px]",
                        forgery.outcome && !forgery.outcome.decision.approved && !forgery.paid
                          ? "border-emerald-400/25 bg-emerald-400/[0.05]"
                          : "border-red-400/40 bg-red-500/10",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-300">
                          Signature by {forgery.modelSource === "nearai" ? "the NEAR AI TEE key" : "the registered model key"}{" "}
                          <span className="num">{short(forgery.signingAddress, 8, 4)}</span>
                        </span>
                        <Badge tone={forgery.signatureValid ? "emerald" : "red"}>{forgery.signatureValid ? "valid" : "invalid"}</Badge>
                      </div>
                      {forgery.outcome?.decision.violations
                        .filter((v) => v.code !== "missing_tee_attestation")
                        .map((v, i) => (
                          <div key={i} className="flex gap-1.5 text-red-200">
                            <OctagonAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                            {v.code === "invalid_tee_attestation" && v.reason === "prompt_mismatch"
                              ? "The proof's system prompt is not the DAO-pinned audit prompt: a forged attestation."
                              : describeViolation(v)}
                          </div>
                        ))}
                      {forgery.error && <div className="num text-red-300">{forgery.error}</div>}
                      <div className="text-slate-300">
                        {forgery.outcome?.quarantined ? "Severity critical: Rhea was quarantined. " : ""}
                        {forgery.paid ? "The vendor was paid." : "Nothing was paid."}
                      </div>
                      <TestnetLink href={txs.forged_audit_attempt} label="The same forgery on testnet" />
                    </div>
                  </Reveal>
                )}
              </AnimatePresence>
            </ExploreCard>
          </div>
        </details>
      </div>
    </section>
  );
}

function ExploreCard({ icon: Icon, title, lead, children }: { icon: typeof Wallet; title: string; lead: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full min-w-0 flex-col justify-between gap-3 rounded-2xl border border-white/[0.08] bg-black/20 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-[14px] font-semibold text-slate-50">
          <Icon className="size-4 shrink-0 text-emerald-300" aria-hidden />
          {title}
        </h3>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-400">{lead}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-3">{children}</div>
    </div>
  );
}

/** What happened to one of Nexus's payments: pre-flight, audit, the contract's answer and the DAO. */
function JobReport({
  r,
  txs,
  nexus,
  quarantineAfter,
  onApprove,
  onSendAnyway,
  disabled = false,
}: {
  r: JobResult;
  txs: Record<string, string>;
  nexus: { status: { kind: string }; spawn_mode: string; violations: number } | undefined;
  quarantineAfter: number;
  onApprove?: () => void;
  onSendAnyway?: () => void;
  disabled?: boolean;
}) {
  const paid = r.finalStatus === "settled" && r.vendorGain > 0n;
  return (
    <div
      className={cx(
        "space-y-2 rounded-xl border p-3 text-[12px]",
        paid ? "border-emerald-400/25 bg-emerald-400/[0.05]" : "border-amber-400/30 bg-amber-400/[0.05]",
      )}
    >
      {r.switchedToHold && (
        <div className="flex gap-1.5 text-slate-300">
          <Hourglass className="mt-0.5 size-3.5 shrink-0 text-amber-200" aria-hidden />
          The DAO first set its rule for new recipients to hold (update_global_policy, sent with the policy version it read).
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-slate-200">
          <ShieldCheck className="size-3.5 text-sky-300" aria-hidden /> Nexus&apos;s pre-flight
        </span>
        <Badge tone={r.preflight.check.verdict === "allow" ? "emerald" : r.preflight.check.verdict === "warn" ? "amber" : "red"}>
          {r.preflight.check.verdict}
        </Badge>
      </div>
      <div className="text-slate-400 break-words">{r.preflight.check.reasons.join("; ")}.</div>
      {r.verdict && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-2">
          <span className="flex items-center gap-1.5 text-slate-200">
            <ScanEye className="size-3.5 text-violet-300" aria-hidden /> Sentinel ({sourceLabel(r.modelSource)})
          </span>
          <Badge tone={r.verdict === "approve" ? "emerald" : "red"}>{r.verdict}</Badge>
        </div>
      )}
      {r.findings.length > 0 && <div className={r.verdict === "approve" ? "text-slate-400" : "text-amber-200"}>{r.findings.join(" · ")}</div>}
      {r.unsent && !r.verdict && (
        <div className="text-slate-300">
          {r.preflight.action === "refuse"
            ? "The recipient is blocked, so Nexus refused to sign."
            : "Paying a new recipient would quarantine Nexus, so it asks the DAO to approve the vendor first (or set the rule to Hold for the DAO)."}
        </div>
      )}
      {r.finalStatus === "pending_approval" && (
        <div className="space-y-2 border-t border-white/[0.06] pt-2">
          <div className="text-slate-300">
            The contract accepted the audit and parked the payment for the DAO: the funds are reserved, nothing has moved, and Nexus keeps its key.
          </div>
          {onApprove && (
            <Button size="sm" variant="primary" icon={Gavel} className="w-full" disabled={disabled} onClick={onApprove}>
              Approve as the DAO
            </Button>
          )}
        </div>
      )}
      {r.unsent && r.verdict && (
        <div className="space-y-2 border-t border-white/[0.06] pt-2">
          {r.precheck.length > 0 && (
            <div className="text-slate-400">
              The contract&apos;s dry run (<span className="num">evaluate_intent</span>) agrees:
              {r.precheck.map((v, i) => (
                <div key={i} className="mt-1 flex gap-1.5 text-red-200">
                  <OctagonAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {describeViolation(v)}
                </div>
              ))}
            </div>
          )}
          <div className="text-slate-300">Nexus followed its auditor and did not send the payment.</div>
        </div>
      )}
      {r.unsent && onSendAnyway && (
        <Button size="sm" variant="danger" className="w-full" disabled={disabled} onClick={onSendAnyway}>
          Send it anyway (compromised agent)
        </Button>
      )}
      {r.outcome && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-2">
          <span className="text-slate-300">Policy engine{r.ignoredSentinel ? " (no signed audit attached)" : ""}</span>
          <Badge tone={r.outcome.decision.approved ? "emerald" : "red"}>
            {r.outcome.status === "pending_approval" ? "held for the DAO" : r.outcome.decision.approved ? "approved" : "blocked"}
          </Badge>
        </div>
      )}
      {r.outcome?.decision.violations.map((v, i) => (
        <div key={i} className="flex gap-1.5 text-red-200">
          <OctagonAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {describeViolation(v)}
        </div>
      ))}
      {r.outcome && !r.outcome.decision.approved && nexus && (
        <div className="text-slate-400">
          {r.outcome.quarantined || nexus.status.kind === "quarantined"
            ? nexus.spawn_mode === "contract_key"
              ? "Severity critical: Nexus was quarantined and its key deleted."
              : "Severity critical: Nexus was quarantined. Its key sits on its own sub-account, which the contract cannot delete, so the contract now rejects every call it signs."
            : `Nexus received a strike (${nexus.violations} of ${quarantineAfter} before quarantine).`}
        </div>
      )}
      {r.error && <div className="num text-red-300">{r.error}</div>}
      <div className="border-t border-white/[0.06] pt-2 text-slate-300 break-words">
        {paid ? (
          <>
            <BadgeCheck className="mr-1 inline size-3.5 text-emerald-300" aria-hidden />
            <span className="num break-all">{r.recipient}</span> received <b className="num text-emerald-200">{nearFmt(r.vendorGain)}</b>: a real NEAR transfer
            from the contract
            {r.approvedByDao ? ", after the DAO approved it." : "."}
          </>
        ) : r.finalStatus === "pending_approval" ? (
          <>Nothing has moved yet.</>
        ) : (
          <>No NEAR left the treasury.</>
        )}
      </div>
      {paid && (
        <TestnetLink
          href={r.approvedByDao ? txs.held_payment_approved : txs.vendor_payment}
          label={r.approvedByDao ? "The same DAO approval on testnet" : "The same vendor payment on testnet"}
        />
      )}
    </div>
  );
}

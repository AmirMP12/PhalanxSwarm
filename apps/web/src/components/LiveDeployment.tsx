"use client";

import {
  PhalanxViews,
  EVM_CHAINS,
  NATIVE_ASSET,
  nearHistorySource,
  parseNear,
  preflightRecipient,
  type AgentRecordT,
  type DashboardT,
  type EvmTxRecordT,
  type IntentRecordT,
  type PreflightAction,
  type PreflightDecision,
} from "@phalanx/agent-swarm-sdk";
import {
  Ban,
  Circle,
  CircleCheck,
  CircleX,
  CloudDownload,
  Coins,
  ExternalLink,
  Fingerprint,
  Gavel,
  KeyRound,
  Landmark,
  ListChecks,
  OctagonAlert,
  Pause,
  Play,
  RadioTower,
  RefreshCw,
  ScanSearch,
  ScrollText,
  ShieldCheck,
  ShieldX,
  Signature,
  Store,
  TriangleAlert,
  UsersRound,
  Vote,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { usePhalanx } from "@/lib/phalanx-context";
import { useReproEvidence, useSwarmEvidence, type SwarmEvidence } from "@/lib/evidence";
import { loadLive, setLiveContract, startLive, useLiveDeployment, type LiveSnapshot } from "@/lib/live-deployment";
import { accountUrl, FallbackRpcTransport, txUrl } from "@/lib/near-rpc";
import { connectWallet, useWalletAccount } from "@/lib/use-wallet";
import { describeOutcome, NETWORK, TESTNET_CONTRACT_ID, walletCall } from "@/lib/wallet";

import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  CopyButton,
  EmptyState,
  Field,
  KV,
  Label,
  PersonaAvatar,
  SkeletonBlock,
  StatusDot,
  Tooltip,
  ago,
  cx,
  describeViolation,
  ethFmt,
  nearFmt,
  personaForHandle,
  short,
  statusTone,
  toast,
  type Tone,
} from "./ui";

/** Step names of `pnpm testnet:swarm` (artifacts/testnet-swarm.json), in plain words. */
const TX_LABELS: Record<string, string> = {
  dao_create: "Create the SputnikDAO",
  vendor_account: "Create vendor A's account",
  new_vendor_account: "Create vendor B's account (not allow-listed)",
  contract_account: "Create the contract account",
  deploy_and_init: "Deploy phalanx_core.wasm and call new() in one batch",
  delete_deploy_key: "Delete the deployer's key: no FullAccess key remains",
  fund_treasury: "Fund the treasury (capital)",
  deposit_revenue: "A customer pays revenue",
  spawn_nexus: "Spawn Nexus (sub-account, scoped key)",
  spawn_rhea: "Spawn Rhea (sub-account, scoped key)",
  spawn_sentinel: "Spawn the Sentinel (sub-account, scoped key)",
  spawn_cipher: "Spawn Cipher (sub-account, scoped key)",
  spawn_mallory: "Spawn Mallory (key on the contract account)",
  transfer_ownership: "Hand ownership to the DAO",
  post_task_rfp: "Nexus posts the procurement RFP",
  mallory_bid_rejected: "Mallory's bid fails the reputation floor",
  cipher_commit: "Cipher commits a sealed bid",
  cipher_reveal: "Cipher reveals its bid",
  close_auction: "Nexus closes the auction; escrow locked",
  execute_verified_task: "Cipher's NEAR AI-signed work releases escrow",
  cipher_withdraw: "Cipher withdraws earnings to its payout account",
  winner_withdraw: "The auction winner withdraws earnings to its payout account",
  spawn_vega: "Spawn Vega (sub-account, scoped key)",
  spawn_orion: "Spawn Orion (sub-account, scoped key)",
  customer_account: "Create the customer's account",
  big_vendor_account: "Create vendor C's account (not allow-listed)",
  rfp1_close: "Nexus closes round 1; the best score wins",
  order_placed: "A customer buys a procurement plan (payment held until delivery)",
  rfp2_post: "Nexus posts a reverse-Dutch RFP for the order",
  rfp2_orion_accept: "Orion accepts the Dutch price and promises 60 s",
  rfp2_expired: "Orion misses its deadline: escrow returned, reputation cut, order reopened",
  rfp3_post: "Nexus re-procures the order by sealed bid",
  rfp3_close: "Nexus closes round 3",
  rfp3_delivery: "The winner's signed work delivers the order; its price becomes revenue",
  duplicate_invoice_refused: "The same invoice again: refused without a strike",
  held_small_payment: "A small first payment to vendor B waits out the challenge window",
  held_small_released: "Vendor B releases its payment after the window, without a vote",
  vendor_payment: "The treasury pays vendor A (real NEAR transfer)",
  evm_transfer_request: "Chain Signatures signs a contract-built Base Sepolia transfer",
  invoice_fraud_attempt: "Poisoned invoice rejected; Mallory quarantined and her key deleted",
  block_recipient: "The Sentinel blocklists the attacker",
  hold_rule_proposal: "DAO proposal: hold payments to new recipients",
  hold_rule_approved: "DAO vote: hold rule approved",
  held_payment: "A larger first payment to vendor C waits for the DAO",
  held_payment_proposal: "DAO proposal: approve the held payment",
  held_payment_approved: "DAO vote: held payment approved and paid",
  forged_audit_attempt: "Self-written audit rejected as a forgery; Rhea quarantined",
  invented_facts_audit_attempt: "Audit over invented facts rejected (facts_mismatch); Cipher quarantined",
  rubber_stamp_rfp_refused: "Nexus's always-pass RFP refused by the DAO's prompt registry",
  council_account_2: "Create council member 2",
  council_account_3: "Create council member 3",
  hold_rule_vote_1: "DAO vote 1 of 2: hold rule",
  held_payment_vote_1: "DAO vote 1 of 2: held payment",
  evm_nonce_sync_proposal: "DAO proposal: sync the treasury's EVM nonce",
  evm_nonce_sync_vote_1: "DAO vote 1 of 2: EVM nonce sync",
  evm_nonce_sync_approved: "DAO vote: EVM nonce synced",
  evm_transfer_confirm: "The Sentinel confirms the mined EVM transfer",
  distribute_revenue: "Profit split to the DAO, operators and reserve",
  dao_add_proposal: "DAO proposal: revoke Mallory",
  dao_approve: "DAO vote: Mallory revoked",
  dao_revoke_proposal: "DAO proposal: revoke Mallory",
  dao_revoke_vote_1: "DAO vote 1 of 2: revoke Mallory",
  dao_revoke_approved: "DAO vote: Mallory revoked",
};

const txLabel = (name: string) =>
  TX_LABELS[name] ?? (name.startsWith("register_") ? `Register the attested model key ${name.slice("register_".length)}` : name.replaceAll("_", " "));

const nsDate = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function useNow(ms = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Ext({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cx("inline-flex min-w-0 max-w-full items-center gap-1 align-bottom text-sky-300 hover:text-sky-200", className)}
    >
      {children}
      <ExternalLink className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

function Acct({ id, head = 18, tail = 0 }: { id: string; head?: number; tail?: number }) {
  return (
    <Ext href={accountUrl(id)} className="num">
      <span className="truncate" title={id}>
        {short(id, head, tail)}
      </span>
    </Ext>
  );
}

function CheckRow({ ok, label, detail }: { ok: boolean | null; label: ReactNode; detail?: ReactNode }) {
  return (
    <li className="flex min-w-0 gap-2 text-[12.5px]">
      {ok === null ? (
        <Circle className="mt-0.5 size-3.5 shrink-0 text-slate-600" aria-label="not checked" />
      ) : ok ? (
        <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-300" aria-label="passed" />
      ) : (
        <CircleX className="mt-0.5 size-3.5 shrink-0 text-red-300" aria-label="failed" />
      )}
      <span className="min-w-0">
        <span className="text-slate-200">{label}</span>
        {detail && <span className="num block break-all text-[11px] text-slate-500">{detail}</span>}
      </span>
    </li>
  );
}

function Stat({ icon: Icon, label, value, sub, tone = "slate" }: { icon: LucideIcon; label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  const color = {
    emerald: "text-emerald-300",
    red: "text-red-300",
    amber: "text-amber-200",
    sky: "text-sky-300",
    violet: "text-violet-300",
    slate: "text-slate-400",
  }[tone];
  return (
    <div className="min-w-0 rounded-xl border border-white/[0.06] bg-black/20 p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
        <Icon className={cx("size-3.5", color)} aria-hidden />
        {label}
      </div>
      <div className="num mt-1 truncate text-[18px] font-semibold text-white">{value}</div>
      {sub && <div className="num truncate text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

const intentTone = (s: string): Tone =>
  s === "settled" || s === "signed"
    ? "emerald"
    : s === "rejected" || s === "authorization_failed" || s === "payment_failed"
      ? "red"
      : s === "pending_approval"
        ? "amber"
        : "sky";
const proposalTone = (s: string): Tone => (s === "Approved" ? "emerald" : s === "InProgress" ? "sky" : s === "Rejected" || s === "Failed" ? "red" : "amber");
const verdictTone = (v: string): Tone => (v === "allow" ? "emerald" : v === "warn" ? "amber" : "red");
const ACTION_TEXT: Record<PreflightAction, string> = {
  sign: "sign and submit the payment.",
  refuse: "refuse to sign: the recipient is on the shared blocklist.",
  submit_for_dao_approval: "submit the payment; it waits for the DAO's vote and the agent keeps its key.",
  ask_dao_to_allow_list: "ask the DAO to allow-list the recipient first; paying it now would quarantine the agent.",
  ask_dao_to_confirm: "ask the DAO to confirm before paying: the recipient is allow-listed, but its history shows a risk.",
};

/** Everything the deployment proves about itself, recomputed from this read. */
function useChecks(s: LiveSnapshot, swarm: SwarmEvidence | null) {
  const repro = useReproEvidence();
  const { wasm } = usePhalanx();
  const d = s.dashboard;
  const canonical = repro?.wasm_sha256 ?? (swarm?.contract_id === s.contractId ? swarm.wasm_sha256 : null);
  // The deployment runs the build its recorded run used, and this repository now builds a newer one.
  const olderRelease =
    s.codeHashHex !== null && canonical !== null && s.codeHashHex !== canonical && swarm?.contract_id === s.contractId && swarm.wasm_sha256 === s.codeHashHex;
  const olderDetail = olderRelease
    ? `runs the v${d.info.version} build its recorded run deployed (${short(s.codeHashHex ?? "", 8, 4)}); this repository now builds ${short(canonical ?? "", 8, 4)}, not deployed yet`
    : null;
  const subAccounts = d.agents.filter((a) => a.spawn_mode === "sub_account");
  const agentKeys = subAccounts.map((a) => s.agentKeys[a.agent_id]);
  const scopedOnly = agentKeys.every((k) => k !== undefined && k.full_access === 0 && k.scoped === k.public_keys.length);
  const contractKeyAgents = d.agents.filter((a) => a.spawn_mode === "contract_key" && a.status.kind !== "active");
  const deletedKeys = contractKeyAgents.filter((a) => !a.key_active && !s.contractKeys.public_keys.includes(a.public_key));
  return [
    {
      ok: canonical && s.codeHashHex ? s.codeHashHex === canonical : null,
      label: "Deployed code is the reproducible build",
      detail: olderDetail ?? (s.codeHashHex ? `sha256 ${s.codeHashHex}` : "no code on this account"),
    },
    {
      ok: wasm && s.codeHashHex ? s.codeHashHex === wasm.sha256 : null,
      label: "The sandbox in this tab runs the same bytes",
      detail: wasm
        ? `this tab: ${short(wasm.sha256, 16, 8)}${olderRelease ? ` (the newer build; the deployment runs ${short(s.codeHashHex ?? "", 8, 4)})` : ""}`
        : "loading the WASM…",
    },
    {
      ok: s.contractKeys.full_access === 0,
      label: "No FullAccess key on the contract account",
      detail: `${s.contractKeys.public_keys.length} access keys · only the owner can change the code, and only after a published delay (propose_upgrade → execute_upgrade)`,
    },
    {
      ok: s.dao !== null && s.dao.id === d.owner_id,
      label: "The owner is a SputnikDAO",
      detail: s.dao ? `${d.owner_id} · council of ${s.dao.council.length}, ${s.dao.threshold}` : `${d.owner_id} does not answer SputnikDAO views`,
    },
    {
      ok: subAccounts.length > 0 ? scopedOnly : null,
      label: "Agent sub-accounts hold only FunctionCall keys for this contract",
      detail: `${subAccounts.length} sub-accounts · ${agentKeys.reduce((n, k) => n + (k?.scoped ?? 0), 0)} scoped keys · ${agentKeys.reduce((n, k) => n + (k?.full_access ?? 0), 0)} FullAccess`,
    },
    {
      ok: contractKeyAgents.length > 0 ? deletedKeys.length === contractKeyAgents.length : null,
      label: "Stopped contract-key agents have no key left",
      detail: contractKeyAgents.length
        ? contractKeyAgents.map((a) => `${a.handle}: ${a.status.kind}, key ${deletedKeys.includes(a) ? "deleted" : "present"}`).join(" · ")
        : "no stopped contract-key agent",
    },
    {
      ok: Boolean(d.policy.audit_prompt_hash),
      label: "The DAO pinned the Sentinel's audit prompt",
      detail: d.policy.audit_prompt_hash ? `sha256 ${d.policy.audit_prompt_hash}` : "NEAR AI audit proofs are rejected until a prompt is pinned",
    },
    {
      ok: d.treasury.unbacked_liquidity === "0",
      label: "The ledger is backed by the account balance",
      detail: `solvent ${nearFmt(d.treasury.solvent_liquidity)} · unbacked ${nearFmt(d.treasury.unbacked_liquidity)}`,
    },
  ];
}

function ContractPicker({ current, loading }: { current: string; loading: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? current;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setLiveContract(value);
    setDraft(null);
  };
  return (
    <form onSubmit={submit} className="flex min-w-0 flex-wrap items-center gap-2">
      <label className="flex min-w-0 w-full flex-1 items-center gap-2 sm:w-auto sm:min-w-[300px]">
        <span className="shrink-0 text-[12px] text-slate-500">Contract</span>
        <input
          aria-label="Testnet contract account"
          value={value}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`phalanx-….${NETWORK}`}
          spellCheck={false}
          className="touch-target num h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2.5 text-[12.5px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-violet-400/50"
        />
      </label>
      <Button type="submit" size="sm" icon={CloudDownload} loading={loading} disabled={!value.trim()}>
        Read
      </Button>
      {TESTNET_CONTRACT_ID && current !== TESTNET_CONTRACT_ID && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft(null);
            setLiveContract(TESTNET_CONTRACT_ID);
          }}
        >
          Back to the recorded deployment
        </Button>
      )}
    </form>
  );
}

function Header({ s, loading, swarm }: { s: LiveSnapshot; loading: boolean; swarm: SwarmEvidence | null }) {
  const d = s.dashboard;
  const now = useNow();
  const checks = useChecks(s, swarm);
  const passed = checks.filter((c) => c.ok === true).length;
  const failed = checks.filter((c) => c.ok === false).length;
  const active = d.agents.filter((a) => a.status.kind === "active").length;
  const stopped = (["quarantined", "revoked", "provisioning"] as const)
    .map((k) => [k, d.agents.filter((a) => a.status.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(" · ");
  const settled = d.intents.filter((i) => i.status === "settled").length;
  const rejected = d.intents.filter((i) => i.status === "rejected").length + d.evm_txs.filter((t) => t.status === "rejected").length;
  const critical = d.security_events.filter((e) => e.severity === "critical").length;
  const proofs = d.enclaves.reduce((n, e) => n + e.receipts_verified, 0);
  const approved = s.dao?.proposals.filter((p) => p.status === "Approved").length ?? 0;
  return (
    <Card className="p-4 sm:p-5">
      <CardHeader
        icon={RadioTower}
        eyebrow={`NEAR ${NETWORK} · read in this tab over public RPC · no key`}
        title={
          <Ext href={accountUrl(s.contractId)} className="num text-slate-50 hover:text-white">
            <span className="truncate">{s.contractId}</span>
          </Ext>
        }
        descriptionVisible
        description={
          <>
            PhalanxCore v{d.info.version} · owner <Acct id={d.owner_id} head={28} />
            {s.dao ? " (SputnikDAO)" : ""} · block <span className="num">#{d.block_height}</span> · read {ago(s.readAtMs, now)} via{" "}
            <span className="num">{s.rpcHost}</span>
          </>
        }
        actions={
          <>
            <Badge tone={d.paused ? "red" : "emerald"} dot>
              {d.paused ? "paused" : "live"}
            </Badge>
            <Badge tone={failed ? "red" : "emerald"} icon={ListChecks}>
              {passed}/{checks.length} checks
            </Badge>
            <Button size="sm" icon={RefreshCw} loading={loading} onClick={() => void loadLive()}>
              Refresh
            </Button>
          </>
        }
      />
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Stat icon={Landmark} tone="emerald" label="Treasury liquid" value={nearFmt(d.treasury.liquid)} sub={`available ${nearFmt(d.treasury.available)}`} />
        <Stat
          icon={UsersRound}
          tone={active === d.agents.length ? "emerald" : "amber"}
          label="Agents active"
          value={`${active}/${d.agents.length}`}
          sub={stopped || "none stopped"}
        />
        <Stat icon={Coins} tone="sky" label="Settlements" value={`${settled} settled`} sub={`${rejected} rejected · ${d.evm_txs.length} EVM`} />
        <Stat
          icon={OctagonAlert}
          tone={critical ? "red" : "slate"}
          label="Critical events"
          value={critical}
          sub={`${d.blocked_recipients.length} blocklisted`}
        />
        <Stat
          icon={Fingerprint}
          tone="violet"
          label="Signed proofs verified"
          value={proofs}
          sub={`${d.enclaves.length} model key${d.enclaves.length === 1 ? "" : "s"}`}
        />
        <Stat
          icon={Vote}
          tone="sky"
          label="DAO proposals"
          value={s.dao ? `${approved} approved` : "—"}
          sub={s.dao ? `${s.dao.proposals.length} total` : "owner is not a DAO"}
        />
      </div>
      <div className="mt-4 rounded-xl border border-white/[0.06] bg-black/20 p-3 sm:p-4">
        <Label className="mb-2">What this read proves</Label>
        <ul className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
          {checks.map((c) => (
            <CheckRow key={c.label} ok={c.ok} label={c.label} detail={c.detail} />
          ))}
        </ul>
      </div>
      <div className="mt-4 border-t border-white/[0.06] pt-3">
        <ContractPicker current={s.contractId} loading={loading} />
      </div>
    </Card>
  );
}

function agentName(d: DashboardT, id: string | null | undefined): string {
  if (!id) return "—";
  return d.agents.find((a) => a.agent_id === id)?.handle ?? (id === d.owner_id ? "owner (DAO)" : short(id, 22, 0));
}

function AgentRow({ a, keys }: { a: AgentRecordT; keys: LiveSnapshot["agentKeys"][string] | undefined }) {
  const persona = personaForHandle(a.handle);
  const keyText =
    a.spawn_mode === "sub_account"
      ? keys
        ? `${keys.scoped} scoped key${keys.scoped === 1 ? "" : "s"}${keys.full_access ? ` · ${keys.full_access} FullAccess` : ""}`
        : "keys unknown"
      : a.key_active
        ? "key on the contract account"
        : "contract key deleted";
  return (
    <li className="min-w-0 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        {persona ? <PersonaAvatar persona={persona} size={32} status={a.status.kind} /> : <KeyRound className="size-4 text-slate-500" aria-hidden />}
        <div className="min-w-0 flex-1">
          <Ext href={accountUrl(a.agent_id)} className="text-[13px] font-medium">
            <span className="truncate" title={a.agent_id}>
              {a.handle}
            </span>
          </Ext>
          <div className="text-[11px] text-slate-500">
            {a.role.replace("_", " ")} · {a.spawn_mode === "sub_account" ? "own sub-account" : "key on the contract account"}
          </div>
        </div>
        {a.status.kind === "quarantined" ? (
          <Tooltip content={a.status.reason}>
            <span tabIndex={0}>
              <Badge tone="red" dot>
                quarantined
              </Badge>
            </span>
          </Tooltip>
        ) : (
          <Badge tone={statusTone(a.status.kind)} dot>
            {a.status.kind}
          </Badge>
        )}
      </div>
      <div className="num mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
        <span className={cx("flex items-center gap-1", a.key_active ? "" : "text-red-300")}>
          <KeyRound className="size-3" aria-hidden />
          <span title={a.allowed_methods.join("\n")}>
            {keyText} · {a.allowed_methods.length} methods
          </span>
        </span>
        <span>rep {(a.reputation_bps / 100).toFixed(1)}%</span>
        <span className={a.violations ? "text-red-300" : undefined}>
          {a.violations} strike{a.violations === 1 ? "" : "s"}
        </span>
        <span title={`earned ${nearFmt(a.total_earned)} · committed ${nearFmt(a.total_spent)}`}>balance {nearFmt(a.balance)}</span>
        <span>
          tasks {a.tasks_completed}✔ {a.tasks_failed}✘
        </span>
      </div>
    </li>
  );
}

function Agents({ s }: { s: LiveSnapshot }) {
  const d = s.dashboard;
  return (
    <Card id="onchain-keys" className="scroll-mt-24 p-4 sm:p-5 lg:scroll-mt-28">
      <CardHeader
        icon={UsersRound}
        eyebrow="get_dashboard · view_access_key_list"
        title="Agents and their keys"
        description="Each agent signs with a FunctionCall key limited to named methods of this contract. Quarantine and revocation are contract state; for a contract-account key the same transaction deleted it."
        actions={<Badge tone="slate">{d.agents.length}</Badge>}
      />
      <ul className="mt-4 space-y-2">
        {d.agents.map((a) => (
          <AgentRow key={a.agent_id} a={a} keys={s.agentKeys[a.agent_id]} />
        ))}
      </ul>
    </Card>
  );
}

function Recipients({ s }: { s: LiveSnapshot }) {
  const p = s.dashboard.policy;
  const blocked = s.dashboard.blocked_recipients;
  const chains = useMemo(() => [...new Set(["near", ...p.allowed_target_chains, ...p.evm_chains.map((c) => c.chain)])], [p]);
  const presets = useMemo(() => {
    const out: Array<{ label: string; chain: string; recipient: string }> = [];
    const split = (key: string) => ({ chain: key.slice(0, key.indexOf(":")), recipient: key.slice(key.indexOf(":") + 1) });
    if (blocked[0]) out.push({ label: "Blocklisted", ...split(blocked[0].recipient) });
    const vendor = p.allowed_recipients.find((r) => r.startsWith("near:"));
    if (vendor) out.push({ label: "Allow-listed", ...split(vendor) });
    out.push({ label: "Unknown", chain: "near", recipient: `not-on-the-list.${NETWORK}` });
    return out;
  }, [blocked, p.allowed_recipients]);
  const [chain, setChain] = useState(presets[0]?.chain ?? "near");
  const [recipient, setRecipient] = useState(presets[0]?.recipient ?? "");
  const [result, setResult] = useState<PreflightDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const history = useMemo(() => nearHistorySource({ network: NETWORK }), []);

  const check = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!recipient.trim()) return;
    setChecking(true);
    setError(null);
    try {
      // The contract's answer, then the recipient's on-chain history: signals can only make it stricter.
      setResult(await preflightRecipient(new PhalanxViews(new FallbackRpcTransport(s.contractId)), chain, recipient.trim(), { history }));
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Card id="onchain-preflight" className="scroll-mt-24 flex flex-col p-4 sm:p-5 lg:scroll-mt-28">
      <CardHeader
        icon={ScanSearch}
        eyebrow="check_recipient · list_blocked_recipients"
        title="Recipients"
        description="Ask the deployed contract what paying an address would do. Agents run the same pre-flight before they sign."
      />
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
        <span className="text-slate-500">Unknown recipient rule</span>
        <Badge tone={p.unknown_recipient === "hold" ? "amber" : "red"}>{p.unknown_recipient === "hold" ? "hold for the DAO" : "quarantine the agent"}</Badge>
        <Badge tone="emerald">{p.allowed_recipients.length} approved</Badge>
        <Badge tone="red">{blocked.length} blocklisted</Badge>
      </div>
      <form onSubmit={(e) => void check(e)} className="mt-3 space-y-2 rounded-xl border border-white/[0.06] bg-black/20 p-3">
        <div className="flex flex-wrap gap-1.5">
          {presets.map((x) => (
            <button
              key={x.label}
              type="button"
              onClick={() => {
                setChain(x.chain);
                setRecipient(x.recipient);
                setResult(null);
              }}
              className={cx(
                "touch-target rounded-md px-2 text-[11px] leading-6 transition",
                chain === x.chain && recipient === x.recipient ? "bg-sky-400/15 text-sky-200" : "bg-white/[0.04] text-slate-400 hover:text-slate-200",
              )}
            >
              {x.label}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-wrap gap-2">
          <select
            aria-label="Chain"
            value={chain}
            onChange={(e) => setChain(e.target.value)}
            className="touch-target num h-9 w-full min-[380px]:w-auto rounded-lg border border-white/10 bg-black/40 px-2 text-[12.5px] text-slate-200 outline-none focus:border-sky-400/50"
          >
            {chains.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            aria-label="Recipient address"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="account.testnet or 0x…"
            spellCheck={false}
            className="touch-target num h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2.5 text-[12.5px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-sky-400/50"
          />
          <Button type="submit" size="sm" icon={ScanSearch} className="w-full min-[480px]:w-auto" loading={checking} disabled={!recipient.trim()}>
            Pre-flight
          </Button>
        </div>
        {error && <p className="num break-words text-[11.5px] text-red-300">{error}</p>}
        {result && (
          <div className="space-y-1.5 border-t border-white/[0.06] pt-2 text-[12px]">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={verdictTone(result.verdict)} dot>
                {result.verdict}
              </Badge>
              {result.verdict !== result.check.verdict && (
                <span className="text-[11px] text-amber-200">contract: {result.check.verdict}, raised by history</span>
              )}
              <span className="num min-w-0 break-all text-slate-300">
                {result.check.chain}:{result.check.recipient}
              </span>
            </div>
            {result.check.reasons.map((r) => (
              <p key={r} className="break-words text-slate-400">
                {r}
              </p>
            ))}
            {result.signals.length > 0 && (
              <ul className="space-y-0.5 rounded-lg border border-white/[0.05] bg-white/[0.02] p-2">
                <li className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-slate-500">On-chain history (advisory)</li>
                {result.signals.map((sig, i) => (
                  <li key={i} className={cx("flex gap-1.5 break-words", sig.level === "risk" ? "text-amber-200" : "text-slate-400")}>
                    {sig.level === "risk" ? (
                      <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                    ) : (
                      <Circle className="mt-1 size-2 shrink-0" aria-hidden />
                    )}
                    {sig.detail}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-slate-200">
              <span className="text-slate-500">An agent should: </span>
              {ACTION_TEXT[result.action]}
            </p>
          </div>
        )}
      </form>
      <div className="mt-3">
        <Label className="mb-1.5">Shared blocklist</Label>
        {blocked.length === 0 ? (
          <p className="text-[12px] text-slate-500">Empty. The DAO or an active Sentinel adds entries with an evidence hash.</p>
        ) : (
          <ul className="space-y-1.5">
            {blocked.map((b) => (
              <li key={b.recipient} className="rounded-lg border border-red-400/20 bg-red-500/[0.04] p-2.5 text-[12px]">
                <div className="flex gap-1.5 text-slate-200">
                  <ShieldX className="mt-0.5 size-3.5 shrink-0 text-red-300" aria-hidden />
                  <span className="num min-w-0 break-all">{b.recipient}</span>
                </div>
                <p className="mt-1 text-slate-400">{b.reason}</p>
                <p className="num mt-0.5 text-[11px] text-slate-500">
                  by {agentName(s.dashboard, b.reported_by)} · {nsDate(b.at_ns)} · evidence {short(b.evidence_hash, 10, 6)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <details className="mt-3 text-[12px]">
        <summary className="cursor-pointer text-slate-400 hover:text-slate-200">Approved recipients ({p.allowed_recipients.length})</summary>
        <ul className="num mt-2 space-y-0.5 text-[11.5px] text-slate-400">
          {p.allowed_recipients.map((r) => (
            <li key={r} className="break-all">
              {r}
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

function IntentRow({ i, d }: { i: IntentRecordT; d: DashboardT }) {
  const persona = personaForHandle(d.agents.find((a) => a.agent_id === i.agent_id)?.handle);
  const label = i.kind === "vendor_payment" ? (i.destination_chain === "near" ? "NEAR payment" : "vendor payment") : i.kind.replace("_", " ");
  return (
    <li className="min-w-0 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 sm:gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5 flex-1">
          {persona ? <PersonaAvatar persona={persona} size={26} /> : <TriangleAlert className="size-4 text-slate-500" aria-hidden />}
          <div className="num min-w-0 flex-1 text-[12.5px] text-slate-200">
            #{i.intent_id} {label} <span className="text-slate-400">{nearFmt(i.amount)}</span> →{" "}
            {i.destination_chain === "near" ? (
              <Acct id={i.recipient} head={24} />
            ) : (
              <span title={i.recipient}>
                {i.destination_chain}:{short(i.recipient, 8, 4)}
              </span>
            )}
          </div>
        </div>
        <Badge tone={intentTone(i.status)} dot>
          {i.status.replace("_", " ")}
        </Badge>
      </div>
      <div className="mt-1 pl-9 text-[11px] text-slate-500">
        {agentName(d, i.agent_id)} · {nsDate(i.created_at_ns)}
        {i.dry_run && " · dry run"}
        {i.decision.approval_reasons.length > 0 && ` · held: ${i.decision.approval_reasons.join(", ")}`}
        {i.settlement_ref && ` · ${i.settlement_ref}`}
      </div>
      {i.decision.violations.length > 0 && (
        <ul className="mt-1 space-y-0.5 pl-9">
          {i.decision.violations.map((v, k) => (
            <li key={k} className="flex gap-1.5 text-[11.5px] text-red-200">
              <OctagonAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
              {v.code === "invalid_tee_attestation" && v.reason === "prompt_mismatch"
                ? "The proof's system prompt is not the DAO-pinned audit prompt: a forgery."
                : describeViolation(v)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function EvmRow({ t, d }: { t: EvmTxRecordT; d: DashboardT }) {
  const chain = EVM_CHAINS[t.chain];
  const onChain = t.status === "confirmed" && t.tx_hash && chain;
  return (
    <li className="min-w-0 rounded-xl border border-violet-400/15 bg-violet-400/[0.03] p-2.5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 sm:gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5 flex-1">
          <Signature className="size-4 shrink-0 text-violet-300" aria-hidden />
          <div className="num min-w-0 flex-1 text-[12.5px] text-slate-200">
            EVM #{t.tx_id} {chain?.label ?? t.chain}{" "}
            <span className="text-slate-400">{t.asset === NATIVE_ASSET ? ethFmt(t.amount) : `${t.amount} token units`}</span> →{" "}
            <span title={t.to}>{short(t.to, 8, 4)}</span>
          </div>
        </div>
        <Badge tone={intentTone(t.status)} dot>
          {t.status}
        </Badge>
      </div>
      <div className="num mt-1 space-y-0.5 pl-6 text-[11px] text-slate-500">
        <div>
          {agentName(d, t.agent_id)} · signed by {t.mpc_contract_id} · path {t.path}
        </div>
        {t.tx_hash && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2">
            <span className="break-all">tx {t.tx_hash}</span>
            {onChain ? (
              <Ext href={`${chain.explorer}/tx/${t.tx_hash}`}>explorer</Ext>
            ) : (
              <span className="text-amber-200/80">signed, not broadcast yet (pnpm evm:relay)</span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function Settlements({ s }: { s: LiveSnapshot }) {
  const d = s.dashboard;
  const count = d.intents.length + d.evm_txs.length;
  return (
    <Card className="flex flex-col p-4 sm:p-5">
      <CardHeader
        icon={Coins}
        eyebrow="list_intents · list_evm_txs"
        title="Settlements"
        description="NEAR vendor payments are real transfers. Rejected requests stay on record with the policy engine's reasons; the EVM transfer is built by the contract and signed by Chain Signatures."
        actions={<Badge tone="slate">{count}</Badge>}
      />
      <div className="mt-4 flex-1">
        {count === 0 ? (
          <EmptyState icon={Coins} title="No settlements yet" />
        ) : (
          <ul className="space-y-1.5">
            {d.intents.map((i) => (
              <IntentRow key={`i-${i.intent_id}`} i={i} d={d} />
            ))}
            {d.evm_txs.map((t) => (
              <EvmRow key={`e-${t.tx_id}`} t={t} d={d} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function SecurityLog({ s }: { s: LiveSnapshot }) {
  const events = s.dashboard.security_events;
  return (
    <Card className="flex flex-col p-4 sm:p-5">
      <CardHeader
        icon={OctagonAlert}
        eyebrow="get_security_events"
        title="Security log"
        description="Written by the policy engine in the same transaction as each decision."
        actions={
          <div className="flex gap-1.5">
            <Badge tone="red">{events.filter((e) => e.severity === "critical").length} critical</Badge>
            <Badge tone="slate">{events.length}</Badge>
          </div>
        }
      />
      <div className="mt-4 flex-1">
        {events.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No security events" />
        ) : (
          <ol tabIndex={0} aria-label="Security log entries" className="fade-bottom max-h-[520px] space-y-1.5 overflow-y-auto pb-4 pr-1">
            {events.map((e) => (
              <li
                key={e.seq}
                className={cx(
                  "rounded-xl border p-2.5 text-[12px]",
                  e.severity === "critical" ? "border-red-400/25 bg-red-500/[0.06]" : "border-white/[0.06] bg-white/[0.02]",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="num min-w-0 text-slate-200">
                    #{e.seq} {e.kind}
                    {e.agent_id && <span className="text-slate-500"> · {agentName(s.dashboard, e.agent_id)}</span>}
                  </span>
                  <Badge tone={e.severity === "critical" ? "red" : e.severity === "warning" ? "amber" : e.severity === "notice" ? "sky" : "slate"}>
                    {e.severity}
                  </Badge>
                </div>
                <p className="mt-1 break-words text-slate-400">{e.detail}</p>
                <div className="num mt-1 flex flex-wrap gap-1 text-[10.5px] text-slate-500">
                  {e.codes.map((c) => (
                    <span key={c} className="rounded bg-white/[0.05] px-1.5 leading-[18px] text-slate-400">
                      {c}
                    </span>
                  ))}
                  <span className="leading-[18px]">
                    block #{e.block_height} · {nsDate(e.at_ns)}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}

function Line({ label, value, tone }: { label: string; value: string; tone?: "plus" | "minus" | "strong" }) {
  return (
    <div className={cx("flex items-baseline justify-between gap-3 py-1 text-[12.5px]", tone === "strong" && "border-t border-white/[0.08] pt-1.5")}>
      <span className={tone === "strong" ? "font-medium text-slate-200" : "text-slate-400"}>{label}</span>
      <span
        className={cx(
          "num",
          tone === "plus" ? "text-emerald-300" : tone === "minus" ? "text-amber-200" : tone === "strong" ? "font-semibold text-white" : "text-slate-300",
        )}
      >
        {value}
      </span>
    </div>
  );
}

const amountError = (v: string) => {
  try {
    return parseNear(v) > 0n ? null : "Must be more than 0";
  } catch {
    return "Enter a NEAR amount, e.g. 0.1";
  }
};

function Treasury({ s }: { s: LiveSnapshot }) {
  const d = s.dashboard;
  const t = d.treasury;
  const account = useWalletAccount();
  const [amount, setAmount] = useState("0.1");
  const [sending, setSending] = useState<string | null>(null);
  const [last, setLast] = useState<{ label: string; hash: string | null; failure: string | null } | null>(null);
  const error = amountError(amount);
  const distributable = BigInt(t.distributable_profit);
  const canDistribute = !d.paused && distributable > 0n && distributable >= BigInt(d.config.min_distribution);

  const send = async (id: string, label: string, method: string, args: Record<string, unknown>, deposit?: bigint) => {
    setSending(id);
    setLast(null);
    try {
      const outcome = await walletCall(method, args, { contractId: s.contractId, deposit: deposit?.toString() });
      const r = describeOutcome(outcome);
      setLast({ label, ...r });
      toast(
        r.failure
          ? { tone: "error", title: `${label}: rejected by the contract`, description: r.failure }
          : { tone: "success", title: label, description: r.hash ? `testnet transaction ${short(r.hash, 8, 6)}` : method },
      );
      await loadLive();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setLast({ label, hash: null, failure: message });
      toast({ tone: "error", title: `${label} failed`, description: message });
    } finally {
      setSending(null);
    }
  };

  return (
    <Card className="flex flex-col p-4 sm:p-5">
      <CardHeader
        icon={Landmark}
        eyebrow="get_treasury · get_revenue_splits"
        title="Treasury and revenue"
        description="The contract's own ledger, checked against the account balance."
      />
      <div className="mt-3 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2">
        <Line label="Revenue" value={`+${nearFmt(t.total_revenue)}`} tone="plus" />
        <Line label="Agent pay and vendor payments" value={`−${nearFmt(t.total_operating_costs)}`} tone="minus" />
        <Line label="Net profit" value={nearFmt(t.net_profit)} tone="strong" />
        <Line label="Distributed" value={nearFmt(t.total_distributed)} />
        <Line label="Retained (reserve)" value={nearFmt(t.total_retained)} />
        <Line label="Distributable now" value={nearFmt(t.distributable_profit)} />
        <div className="num mt-1 flex flex-wrap justify-between gap-x-3 gap-y-0.5 border-t border-white/[0.05] pt-1.5 text-[11px] text-slate-500">
          <span>capital in {nearFmt(t.total_capital_in)}</span>
          <span>owed to agents {nearFmt(t.agent_balances)}</span>
          <span>account {nearFmt(t.account_balance)}</span>
        </div>
      </div>
      <div className="mt-3">
        <Label className="mb-1.5">Revenue splits (bps, set by the DAO)</Label>
        <ul className="space-y-1">
          {d.revenue_splits.map((r) => (
            <li key={r.label} className="flex items-center justify-between gap-2 text-[12px]">
              <span className="min-w-0 text-slate-300">
                {r.label} <span className="text-slate-500">· {r.kind.replace("_", " ")}</span>
                <span className="block">
                  <Acct id={r.account_id} head={30} />
                </span>
              </span>
              <span className="num text-slate-100">{r.bps / 100}%</span>
            </li>
          ))}
        </ul>
        {d.distributions.map((x) => (
          <p key={x.distribution_id} className="num mt-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2 text-[11px] text-slate-400">
            Distribution #{x.distribution_id}: {nearFmt(x.total)} · {x.payouts.map((p) => `${p.label} ${nearFmt(p.amount)}`).join(" · ")} · retained{" "}
            {nearFmt(x.retained)}
            {x.failed !== "0" && <span className="text-red-300"> · bounced {nearFmt(x.failed)}</span>} · {nsDate(x.at_ns)}
          </p>
        ))}
      </div>
      <div className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11.5px] font-medium text-slate-300">Enterprise Accounting Export</span>
          <Badge tone="slate">QuickBooks & CSV</Badge>
        </div>
        <p className="mt-1 text-[11px] text-slate-500">Reconciled double-entry ledger entries and trial balance from testnet deployment.</p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <a
            href="/api/accounting/export?format=csv"
            download="phalanx-testnet-ledger.csv"
            className="touch-target inline-flex items-center gap-1 rounded border border-white/[0.1] bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-white/[0.08] hover:text-white"
          >
            <CloudDownload className="size-3 text-emerald-400" aria-hidden />
            CSV Ledger
          </a>
          <a
            href="/api/accounting/export?format=quickbooks_iif"
            download="phalanx-testnet.iif"
            className="touch-target inline-flex items-center gap-1 rounded border border-white/[0.1] bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-white/[0.08] hover:text-white"
          >
            <ScrollText className="size-3 text-sky-400" aria-hidden />
            QuickBooks (.IIF)
          </a>
        </div>
      </div>
      <div className="mt-auto space-y-2 border-t border-white/[0.06] pt-3">
        <Label>Run the business loop with your wallet ({NETWORK})</Label>
        <p className="text-[11.5px] leading-snug text-slate-500">
          Anyone may pay revenue and anyone may trigger the split: the amounts are computed on-chain. Owner methods need a DAO proposal.
        </p>
        {!account ? (
          <Button size="sm" icon={Wallet} onClick={() => void connectWallet()}>
            Connect a {NETWORK} wallet
          </Button>
        ) : (
          <>
            <Field
              label="Revenue to pay"
              suffix="NEAR"
              inputMode="decimal"
              value={amount}
              error={error}
              presets={["0.1", "0.5", "1"]}
              onPreset={setAmount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                icon={Coins}
                className="w-full min-[480px]:w-auto"
                loading={sending === "deposit"}
                disabled={sending !== null || Boolean(error)}
                onClick={() =>
                  void send(
                    "deposit",
                    "Revenue paid",
                    "deposit_revenue",
                    { customer_ref: account, memo: "paid from the PhalanxSwarm command center" },
                    parseNear(amount),
                  )
                }
              >
                Pay {error ? "" : amount} Ⓝ as a customer
              </Button>
              <Tooltip
                content={
                  canDistribute ? "Calls distribute_revenue" : `Distributable profit is below the on-chain minimum of ${nearFmt(d.config.min_distribution)}`
                }
              >
                <span tabIndex={canDistribute ? -1 : 0} className="w-full min-[480px]:w-auto inline-block">
                  <Button
                    size="sm"
                    icon={Coins}
                    className="w-full min-[480px]:w-auto"
                    loading={sending === "distribute"}
                    disabled={sending !== null || !canDistribute}
                    onClick={() => void send("distribute", "Profit distributed", "distribute_revenue", {})}
                  >
                    Distribute profit
                  </Button>
                </span>
              </Tooltip>
              {account === d.owner_id && (
                <Button
                  size="sm"
                  variant={d.paused ? "primary" : "danger"}
                  icon={d.paused ? Play : Pause}
                  className="w-full min-[480px]:w-auto"
                  disabled={sending !== null}
                  loading={sending === "pause"}
                  onClick={() =>
                    void send("pause", d.paused ? "Protocol resumed" : "Protocol paused", "set_protocol_paused", {
                      paused: !d.paused,
                      reason: "owner via NEAR Connect",
                    })
                  }
                >
                  {d.paused ? "Resume" : "Pause"}
                </Button>
              )}
            </div>
            {last && (
              <p className={cx("num break-words text-[11.5px]", last.failure ? "text-red-300" : "text-emerald-300")}>
                {last.label}: {last.failure ?? "ok"}
                {last.hash && (
                  <>
                    {" "}
                    · <Ext href={txUrl(last.hash)}>{short(last.hash, 8, 6)}</Ext>
                  </>
                )}
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function Governance({ s }: { s: LiveSnapshot }) {
  const p = s.dashboard.policy;
  const dao = s.dao;
  return (
    <Card id="onchain-history" className="scroll-mt-24 flex flex-col p-4 sm:p-5 lg:scroll-mt-28">
      <CardHeader
        icon={Gavel}
        eyebrow="get_global_policy · SputnikDAO get_proposals"
        title="Rules and governance"
        description="Only the DAO changes these rules. Every change below went through a proposal and a vote."
      />
      <div className="mt-3 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-1">
        <KV k="max per payment / epoch cap" v={`${nearFmt(p.max_tx_amount_yocto, 0)} / ${nearFmt(p.epoch_spending_cap_yocto, 0)}`} />
        <KV k="velocity" v={`${p.velocity_limit} requests / ${p.velocity_window_sec} s`} />
        <KV k="max slippage" v={`${p.max_slippage_bps} bps`} />
        <KV k="DAO approval at or above" v={nearFmt(p.dao_approval_threshold, 0)} />
        <KV k="signed audit required" v={p.require_tee_attestation ? "yes" : "no"} />
        <KV k="quarantine after" v={`${p.quarantine_after_strikes} strikes${p.auto_quarantine ? "" : " (auto off)"}`} />
        <KV k="price floors / assets" v={`${p.price_floors.length} / ${p.allowed_assets.length}`} />
        {p.evm_chains.map((c) => (
          <KV
            key={c.chain}
            k={`${EVM_CHAINS[c.chain]?.label ?? c.chain} (${c.chain_id})`}
            v={`≤ ${ethFmt(c.max_value_wei)}/tx · ${ethFmt(c.epoch_cap_wei)}/epoch${c.tokens.length ? ` · ${c.tokens.map((t) => t.symbol).join(", ")}` : ""}`}
          />
        ))}
      </div>
      <div className="mt-3 flex-1">
        {!dao ? (
          <p className="text-[12px] text-slate-500">
            The owner <Acct id={s.dashboard.owner_id} /> is not a SputnikDAO, so there are no proposals to show.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-slate-400">
              <Vote className="size-3.5 text-sky-300" aria-hidden />
              <Acct id={dao.id} head={30} />
              <span>
                · council {dao.council.map((c) => short(c, 20, 0)).join(", ") || "—"} · {dao.threshold} · bond {nearFmt(dao.bond, 0)}
              </span>
            </div>
            {dao.proposals.length === 0 ? (
              <p className="mt-2 text-[12px] text-slate-500">No proposals yet.</p>
            ) : (
              <ol className="mt-2 space-y-1.5">
                {dao.proposals.map((x) => (
                  <li key={x.id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-[12px]">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 text-slate-200">
                        <span className="num text-slate-500">#{x.id}</span> {x.description}
                      </span>
                      <Badge tone={proposalTone(x.status)}>{x.status}</Badge>
                    </div>
                    {x.calls.map((c, k) => (
                      <p key={k} className="num mt-1 break-all text-[11px] text-slate-400">
                        {x.receiver === s.contractId ? "" : `${x.receiver ?? x.kind} · `}
                        <span className="text-emerald-200">{c.method}</span> {c.args}
                      </p>
                    ))}
                    <p className="num mt-0.5 text-[10.5px] text-slate-500">
                      {Object.entries(x.votes)
                        .map(([who, v]) => `${short(who, 20, 0)}: ${v}`)
                        .join(" · ") || "no votes"}{" "}
                      · {nsDate(x.submitted_at_ns)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function Work({ s }: { s: LiveSnapshot }) {
  const d = s.dashboard;
  return (
    <Card className="flex h-full flex-col p-4 sm:p-5">
      <CardHeader
        icon={Store}
        eyebrow="list_tasks · list_enclaves · list_attestations"
        title="Work, escrow and signed proofs"
        description="Escrow is released only when the winner's signed model output verifies on-chain under the pinned prompt."
      />
      <div className="mt-3 space-y-1.5">
        {d.tasks.length === 0 && <p className="text-[12px] text-slate-500">No RFPs yet.</p>}
        {d.tasks.map((t) => (
          <div key={t.task.task_id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-[12px]">
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 text-slate-200">
                <span className="num text-slate-500">RFP #{t.task.task_id}</span> {t.task.title}
              </span>
              <Badge tone={t.task.status === "completed" ? "emerald" : t.task.status === "failed" || t.task.status === "expired" ? "red" : "sky"}>
                {t.task.status}
              </Badge>
            </div>
            <p className="num mt-1 text-[11px] text-slate-400">
              {t.task.auction.replace("_", " ")} · ceiling {nearFmt(t.task.budget_ceiling)} · {t.bids.length} bid{t.bids.length === 1 ? "" : "s"}
              {t.task.winner && ` · won by ${agentName(d, t.task.winner)} at ${nearFmt(t.task.winning_price)}`}
              {t.escrow && ` · escrow ${t.escrow.status}`}
            </p>
            <p className="num mt-0.5 text-[10.5px] text-slate-500">
              {t.task.verification.prompt_hash
                ? `prompt pinned ${short(t.task.verification.prompt_hash, 8, 4)}${t.task.verification.input_pinned ? " with its spec" : ""}`
                : "no pinned prompt: enclave receipts only"}
              {t.task.receipt_hash && ` · proof ${short(t.task.receipt_hash, 8, 4)}`}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-3">
        <Label className="mb-1.5">Registered model keys</Label>
        {d.enclaves.length === 0 ? (
          <p className="text-[12px] text-slate-500">None registered.</p>
        ) : (
          d.enclaves.map((e) => (
            <div key={e.enclave_id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-[12px]">
              <div className="flex items-center justify-between gap-2">
                <span className="num min-w-0 truncate text-slate-200" title={e.enclave_id}>
                  {e.enclave_id}
                </span>
                <Badge tone={e.tee_type === "none" ? "amber" : e.active ? "emerald" : "slate"}>
                  {e.tee_type === "none" ? "no TEE" : e.active ? e.tee_type : "inactive"}
                </Badge>
              </div>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {e.vendor} · <span className="num">{e.model_id}</span> · {e.receipts_verified} proofs verified
              </p>
              <p className="num mt-0.5 break-all text-[10.5px] text-slate-600">{e.attestation_ref}</p>
            </div>
          ))
        )}
      </div>
      <div className="mt-3">
        <Label className="mb-1.5">Verified proofs ({d.attestations.length})</Label>
        <ul className="space-y-1">
          {d.attestations.map((a) => (
            <li key={a.receipt_hash} className="num flex flex-wrap items-center justify-between gap-x-2 text-[11px] text-slate-400">
              <span>
                {a.receipt.subject_kind} #{a.receipt.subject_id} · {agentName(d, a.receipt.agent_id)} · {a.receipt.verdict}
              </span>
              <span className="text-slate-500" title={a.receipt_hash}>
                {a.proof_kind === "near_ai" ? "NEAR AI" : "receipt"} · block #{a.block_height}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function RecordedRun({ s, swarm }: { s: LiveSnapshot; swarm: SwarmEvidence | null }) {
  if (!swarm || swarm.contract_id !== s.contractId) return null;
  const txs = Object.entries(swarm.transactions);
  return (
    <Card className="p-4 sm:p-5">
      <details>
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-emerald-300">
              <ScrollText className="size-[18px]" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500">artifacts/testnet-swarm.json</span>
              <span className="block text-[15px] font-semibold text-slate-50">Every transaction of the recorded run ({txs.length})</span>
            </span>
          </span>
          <span className="text-[12px] text-sky-300">Show</span>
        </summary>
        <ol className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2">
          {txs.map(([name, tx], i) => (
            <li key={name} className="flex min-w-0 flex-wrap sm:flex-nowrap items-baseline gap-2 text-[12px]">
              <span className="num w-5 shrink-0 text-right text-[10.5px] text-slate-600">{i + 1}</span>
              <span className="min-w-0 flex-1 break-words text-slate-300">{txLabel(name)}</span>
              <Ext href={tx.explorer} className="num shrink-0 text-[11px]">
                {short(tx.hash, 6, 0)}
              </Ext>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-[11px] text-slate-500">
          Recorded {new Date(swarm.timestamp).toLocaleString()} by <span className="num">pnpm testnet:swarm</span>; agents used{" "}
          {swarm.inference === "nearai"
            ? `NEAR AI Cloud (${swarm.model})`
            : swarm.inference === "generic_llm"
              ? `a live LLM (${swarm.model})`
              : "the offline stand-in"}
          . <span className="num">pnpm verify:live</span> re-checks these transactions without a key.
        </p>
      </details>
    </Card>
  );
}

/** The live testnet deployment: every panel reads the chain, not the sandbox. */
export function LiveDeployment() {
  const live = useLiveDeployment();
  const swarm = useSwarmEvidence();
  useEffect(() => startLive(), []);
  const s = live.snapshot;
  const loading = live.status === "loading";

  if (!s) {
    return (
      <Card className="p-4 sm:p-5">
        <CardHeader
          icon={RadioTower}
          eyebrow={`NEAR ${NETWORK} · public RPC · no key`}
          title={live.contractId || "No deployment selected"}
          actions={
            live.contractId && (
              <Button size="sm" icon={RefreshCw} loading={loading} onClick={() => void loadLive()}>
                Retry
              </Button>
            )
          }
        />
        <div className="mt-4 space-y-3">
          {live.status === "error" ? (
            <Callout tone="red" icon={Ban} title="Could not read the deployment">
              <span className="num">{live.error}</span>
            </Callout>
          ) : live.contractId ? (
            <SkeletonBlock rows={6} />
          ) : (
            <p className="text-[12.5px] text-slate-400">
              Enter a PhalanxCore v3.0 account below, or deploy one with <span className="num text-slate-300">pnpm testnet:swarm</span>.
            </p>
          )}
          <ContractPicker current={live.contractId} loading={loading} />
        </div>
      </Card>
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      {live.status === "error" && (
        <Callout tone="amber" icon={TriangleAlert} title="Refresh failed; showing the previous read">
          <span className="num">{live.error}</span>
        </Callout>
      )}
      <Header s={s} loading={loading} swarm={swarm} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Agents s={s} />
        <Recipients s={s} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Settlements s={s} />
        <SecurityLog s={s} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        <Treasury s={s} />
        <Governance s={s} />
        <div className="min-w-0 lg:col-span-2 2xl:col-span-1">
          <Work s={s} />
        </div>
      </div>
      <RecordedRun s={s} swarm={swarm} />
      <p className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <StatusDot tone="emerald" />
        Read-only views over JSON-RPC; the wallet buttons send real {NETWORK} transactions. Copy this contract id:
        <CopyButton text={s.contractId} label="Copy contract id" iconOnly />
      </p>
    </div>
  );
}

"use client";

import { formatNear, parseNear, type GlobalPolicyT } from "@phalanx/agent-swarm-sdk";
import { Info, KeyRound, OctagonAlert, Play, Power, ShieldCheck, ShieldEllipsis, ShieldX, Snowflake, TriangleAlert, Undo2, UserCog } from "lucide-react";
import { useMemo, useState } from "react";

import { usePhalanx } from "@/lib/phalanx-context";
import { useAction } from "@/lib/use-action";

import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Gauge,
  Label,
  Meter,
  PersonaAvatar,
  SkeletonBlock,
  StatusDot,
  Switch,
  cx,
  ethFmt,
  nearFmt,
  short,
  statusTone,
  toNear,
  useCommands,
  usePersonaOf,
  type Tone,
} from "./ui";

const sevTone: Record<string, Tone> = { none: "slate", notice: "sky", warning: "amber", critical: "red" };
const sevIcon = { none: Info, notice: Info, warning: TriangleAlert, critical: OctagonAlert } as const;

interface Draft {
  maxTx: string;
  cap: string;
  velocity: string;
  slippage: string;
  tee: boolean;
}

/** Exact decimal NEAR for an input: 2.5 NEAR stays 2.5, so saving another field never rounds a limit. */
const nearInput = (yocto: string) => formatNear(BigInt(yocto), 24).replace(/\.?0+$/, "");

function fromPolicy(p: GlobalPolicyT): Draft {
  return {
    maxTx: nearInput(p.max_tx_amount_yocto),
    cap: nearInput(p.epoch_spending_cap_yocto),
    velocity: String(p.velocity_limit),
    slippage: String(p.max_slippage_bps),
    tee: p.require_tee_attestation,
  };
}

const nearError = (v: string) => {
  try {
    return parseNear(v) > 0n ? null : "Must be more than 0";
  } catch {
    return "Enter a NEAR amount, e.g. 25 or 2.5";
  }
};
/** Bounds match `GlobalPolicy::validate`, so the form never submits a policy the contract rejects. */
const intError = (v: string, min: number, max: number) =>
  /^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max ? null : `Whole number between ${min} and ${max}`;

/** Kill switch / resume, shared by the card header and the command palette. */
function usePauseControls() {
  const { runtime, dashboard, busy } = usePhalanx();
  const action = useAction();
  const pause = () =>
    runtime &&
    void action(
      "sentinel emergency pause",
      runtime.agents.sentinel.signer,
      "set_protocol_paused",
      (rt) => rt.setPaused(true, "sentinel emergency brake", rt.agents.sentinel.signer),
      (r) =>
        r.ok ? { tone: "warning", title: "Protocol paused by the Sentinel", description: "Every agent spend is rejected until the owner resumes." } : undefined,
    );
  const resume = () =>
    runtime && void action("owner resumes protocol", runtime.owner, "set_protocol_paused", (rt) => rt.setPaused(false, "owner review complete"));
  useCommands(
    () => [
      dashboard?.paused
        ? {
            id: "policy-resume",
            group: "Security",
            title: "Resume protocol",
            subtitle: "Owner lifts the pause",
            icon: Play,
            tone: "primary" as const,
            disabled: !runtime || busy !== null,
            disabledReason: "Busy",
            run: resume,
          }
        : {
            id: "policy-pause",
            group: "Security",
            title: "Sentinel kill switch",
            subtitle: "Pause every agent spend (sentinel key)",
            icon: Power,
            tone: "danger" as const,
            keywords: "pause emergency brake",
            disabled: !runtime || busy !== null || !dashboard,
            disabledReason: "Busy",
            run: pause,
          },
    ],
    [runtime, busy, dashboard?.paused],
  );
  return { pause, resume };
}

export function PolicyFirewall() {
  const { runtime, dashboard, busy } = usePhalanx();
  const action = useAction();
  const { pause, resume } = usePauseControls();
  const [draft, setDraft] = useState<Draft>({ maxTx: "", cap: "", velocity: "", slippage: "", tee: true });
  const policy = dashboard?.policy ?? null;
  // Re-sync on a changed policy, not on every dashboard refresh: unsaved edits survive other actions.
  const policyKey = policy ? JSON.stringify(policy) : null;
  const [syncedKey, setSyncedKey] = useState<string | null>(null);
  const [rtSeen, setRtSeen] = useState(runtime);
  if (runtime !== rtSeen) {
    setRtSeen(runtime);
    setSyncedKey(null);
  }
  if (policyKey !== syncedKey) {
    setSyncedKey(policyKey);
    if (policy) setDraft(fromPolicy(policy));
  }

  const errors = useMemo(() => {
    const maxTx = nearError(draft.maxTx);
    const cap = nearError(draft.cap) ?? (maxTx === null && parseNear(draft.cap) < parseNear(draft.maxTx) ? "Must be at least the max per tx" : null);
    return { maxTx, cap, velocity: intError(draft.velocity, 1, 1000), slippage: intError(draft.slippage, 0, 2000) };
  }, [draft]);

  if (!runtime || !dashboard)
    return (
      <Card className="p-4 sm:p-5">
        <CardHeader icon={ShieldCheck} eyebrow="AI security policy engine · circuit breaker" title="Policy firewall" />
        <div className="mt-5">
          <SkeletonBlock rows={8} />
        </div>
      </Card>
    );

  const p = dashboard.policy;
  const t = dashboard.treasury;
  const disabled = busy !== null;
  const saved = fromPolicy(p);
  const dirty = (Object.keys(saved) as Array<keyof Draft>).some((k) => saved[k] !== draft[k]);
  const invalid = Object.values(errors).some(Boolean);
  const spent = toNear(t.epoch_spent);
  const cap = toNear(p.epoch_spending_cap_yocto);
  const hot = BigInt(t.epoch_spent) * 10n > BigInt(p.epoch_spending_cap_yocto) * 8n;

  const apply = () => {
    if (invalid) return;
    const policy: GlobalPolicyT = {
      ...p,
      max_tx_amount_yocto: parseNear(draft.maxTx).toString(),
      epoch_spending_cap_yocto: parseNear(draft.cap).toString(),
      velocity_limit: Number(draft.velocity),
      max_slippage_bps: Number(draft.slippage),
      require_tee_attestation: draft.tee,
    };
    void action("owner updates global policy", runtime.owner, "update_global_policy", (rt) => rt.updatePolicy(policy));
  };

  return (
    <Card className="flex h-full flex-col p-4 sm:p-5">
      <CardHeader
        icon={ShieldCheck}
        eyebrow="AI security policy engine · circuit breaker"
        title="Policy firewall"
        actions={
          dashboard.paused ? (
            <Button size="sm" variant="primary" icon={Play} disabled={disabled} onClick={resume}>
              Resume protocol
            </Button>
          ) : (
            <Button size="sm" variant="danger" icon={Power} disabled={disabled} onClick={pause}>
              Sentinel kill switch
            </Button>
          )
        }
      />

      <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-[auto_minmax(0,1fr)]">
        <div className="flex flex-col items-center justify-center rounded-xl border border-white/[0.06] bg-black/20 px-5 py-4">
          <Gauge value={spent} max={cap} tone={hot ? "amber" : "emerald"}>
            <div className="num text-[20px] font-semibold text-white">{nearFmt(t.epoch_spent, 1)}</div>
            <div className="num text-[11px] text-slate-500">of {nearFmt(p.epoch_spending_cap_yocto, 0)} epoch cap</div>
          </Gauge>
          <div className="mt-2 flex items-center gap-1.5 text-[12px]">
            <StatusDot tone={dashboard.paused ? "red" : "emerald"} pulse />
            <span className={dashboard.paused ? "text-red-300" : "text-slate-300"}>{dashboard.paused ? "Protocol paused" : "Protocol live"}</span>
          </div>
        </div>

        <div className="min-w-0">
          <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
            <Field
              label="Max per tx"
              suffix="Ⓝ"
              inputMode="decimal"
              value={draft.maxTx}
              error={errors.maxTx}
              onChange={(e) => setDraft({ ...draft, maxTx: e.target.value })}
            />
            <Field
              label="Epoch cap"
              suffix="Ⓝ"
              inputMode="decimal"
              value={draft.cap}
              error={errors.cap}
              onChange={(e) => setDraft({ ...draft, cap: e.target.value })}
            />
            <Field
              label="Velocity limit"
              suffix={`req / ${p.velocity_window_sec}s`}
              inputMode="numeric"
              value={draft.velocity}
              error={errors.velocity}
              onChange={(e) => setDraft({ ...draft, velocity: e.target.value })}
            />
            <Field
              label="Max slippage"
              suffix="bps"
              inputMode="numeric"
              value={draft.slippage}
              error={errors.slippage}
              onChange={(e) => setDraft({ ...draft, slippage: e.target.value })}
            />
          </div>
          <div className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
            <Switch
              checked={draft.tee}
              onChange={(tee) => setDraft({ ...draft, tee })}
              label="Require a signed audit"
              description="Every payment must carry a proof from a registered model key (NEAR AI completion or receipt signer)"
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            {dirty && (
              <span className="mr-auto flex items-center gap-1.5 text-[12px] text-amber-200">
                <StatusDot tone="amber" /> Unsaved policy changes
              </span>
            )}
            <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setDraft(saved)}>
              Discard
            </Button>
            <Button size="sm" icon={ShieldEllipsis} disabled={disabled || invalid || !dirty} onClick={apply}>
              Apply as owner DAO
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 border-t border-white/[0.06] pt-4 sm:grid-cols-2">
        <div>
          <Label className="mb-2">Allowed target chains</Label>
          <div className="flex flex-wrap gap-1.5">
            {p.allowed_target_chains.map((c) => (
              <Badge key={c} tone="sky" dot>
                {c}
              </Badge>
            ))}
          </div>
        </div>
        <div>
          <Label className="mb-2">Allowed contracts</Label>
          <div className="flex flex-wrap gap-1.5">
            {p.allowed_contract_ids.map((c) => (
              <Badge key={c} tone="violet" className="num">
                {c}
              </Badge>
            ))}
          </div>
        </div>
        <div className="sm:col-span-2">
          <Label className="mb-2">Approved recipients ({p.allowed_recipients.length})</Label>
          <div className="flex flex-wrap gap-1.5">
            {p.allowed_recipients.map((r) => {
              const at = r.indexOf(":");
              const chain = r.slice(0, at);
              const address = r.slice(at + 1);
              return (
                <Badge key={r} tone="emerald" className="num">
                  <span title={r}>
                    {chain}:{short(address, address.startsWith("0x") ? 6 : 20, address.startsWith("0x") ? 4 : 0)}
                  </span>
                </Badge>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">
            {p.unknown_recipient === "hold"
              ? "A settlement to anything else waits for the DAO (approve_intent); other payments to it are rejected without a strike."
              : "Payments to anything else are rejected as critical and quarantine the agent, whatever the amount."}{" "}
            Blocklisted recipients are critical under either rule.
          </p>
        </div>
        <BlockedRecipients />
        <div className="sm:col-span-2">
          <Label className="mb-2">EVM chains (Chain Signatures)</Label>
          <ul className="flex flex-wrap gap-1.5">
            {p.evm_chains.map((c) => (
              <li key={c.chain} className="num rounded-lg border border-violet-400/25 bg-violet-400/10 px-2 py-0.5 text-[11.5px] text-violet-300">
                {c.chain} ({c.chain_id}) · ≤ {ethFmt(c.max_value_wei)}/tx · {ethFmt(c.epoch_cap_wei)}/epoch
                {c.tokens.length > 0 && ` · ${c.tokens.map((t) => t.symbol).join(", ")}`}
              </li>
            ))}
          </ul>
        </div>
        <div className="sm:col-span-2">
          <Label className="mb-2">Rules</Label>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="slate" className="num">
              <span title={p.allowed_assets.join("\n")}>{p.allowed_assets.length} assets</span>
            </Badge>
            <Badge tone="slate">{p.price_floors.length} DAO price floors</Badge>
            <Badge tone={p.unknown_recipient === "hold" ? "amber" : "slate"}>
              unknown recipient: {p.unknown_recipient === "hold" ? "hold for the DAO" : "quarantine"}
            </Badge>
            <Badge tone="slate">quarantine after {p.quarantine_after_strikes} strikes</Badge>
            <Badge tone={p.auto_quarantine ? "emerald" : "amber"}>auto quarantine {p.auto_quarantine ? "on" : "off"}</Badge>
            <Badge tone="slate">DAO approval ≥ {nearFmt(p.dao_approval_threshold, 0)}</Badge>
            <Badge tone={p.audit_prompt_hash ? "emerald" : "amber"} className="num">
              <span
                title={
                  p.audit_prompt_hash
                    ? `sha256 of the Sentinel's audit prompt: ${p.audit_prompt_hash}`
                    : "NEAR AI audit proofs are rejected until the DAO pins a prompt"
                }
              >
                audit prompt {p.audit_prompt_hash ? `pinned ${p.audit_prompt_hash.slice(0, 8)}…` : "not pinned"}
              </span>
            </Badge>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** The shared blocklist: an active Sentinel or the DAO adds an address with its evidence; only the owner removes one. */
function BlockedRecipients() {
  const { runtime, dashboard, busy } = usePhalanx();
  const action = useAction();
  const blocked = dashboard?.blocked_recipients ?? [];
  return (
    <div className="sm:col-span-2">
      <Label className="mb-2">Shared blocklist ({blocked.length})</Label>
      {blocked.length === 0 ? (
        <p className="text-[11px] text-slate-500">
          Empty. After an incident the Sentinel adds the address with the hash of its evidence (block_recipient); paying it is then critical for every agent.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {blocked.map((b) => {
            const at = b.recipient.indexOf(":");
            const chain = b.recipient.slice(0, at);
            const address = b.recipient.slice(at + 1);
            return (
              <li
                key={b.recipient}
                className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-red-400/20 bg-red-500/[0.04] p-2.5 text-[12px]"
              >
                <span className="flex min-w-0 gap-1.5">
                  <ShieldX className="mt-0.5 size-3.5 shrink-0 text-red-300" aria-hidden />
                  <span className="min-w-0">
                    <span className="num break-all text-slate-200" title={b.recipient}>
                      {chain}:{short(address, 12, 6)}
                    </span>
                    <span className="block text-slate-400">{b.reason}</span>
                    <span className="num block text-[10.5px] text-slate-500">
                      reported by {short(b.reported_by, 18, 0)} · evidence {short(b.evidence_hash, 8, 4)}
                    </span>
                  </span>
                </span>
                {runtime && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Undo2}
                    disabled={busy !== null}
                    onClick={() =>
                      void action(`owner unblocks ${chain}:${short(address, 8, 4)}`, runtime.owner, "unblock_recipient", (rt) =>
                        rt.contract.call(rt.owner, "unblock_recipient", { chain, recipient: address }, null),
                      )
                    }
                  >
                    Unblock (owner)
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function SecurityEvents() {
  const { dashboard } = usePhalanx();
  const events = dashboard?.security_events ?? [];
  const count = (s: string) => events.filter((e) => e.severity === s).length;
  return (
    <Card className="flex h-full flex-col p-4 sm:p-5">
      <CardHeader
        icon={OctagonAlert}
        eyebrow="On-chain security log (get_security_events)"
        title="Security events"
        actions={
          dashboard && (
            <div className="flex gap-1.5">
              <Badge tone="red">{count("critical")} critical</Badge>
              <Badge tone="amber">{count("warning")} warning</Badge>
            </div>
          )
        }
      />
      <div className="mt-4 flex-1">
        {!dashboard ? (
          <SkeletonBlock rows={6} />
        ) : events.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No security events"
            hint="The firewall has not blocked anything yet. Poison an agent in Try it, or run the judge scenario."
          />
        ) : (
          <ol tabIndex={0} aria-label="Security events" className="fade-bottom max-h-[460px] space-y-2 overflow-y-auto pb-4 pr-1">
            {events.map((e) => {
              const Icon = sevIcon[e.severity];
              return (
                <li
                  key={e.seq}
                  className={cx(
                    "rounded-xl border p-3 text-[12px]",
                    e.severity === "critical" ? "border-red-400/25 bg-red-500/[0.06]" : "border-white/[0.06] bg-white/[0.02]",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <Icon
                        className={cx(
                          "size-3.5 shrink-0",
                          e.severity === "critical" ? "text-red-300" : e.severity === "warning" ? "text-amber-200" : "text-sky-300",
                        )}
                        aria-hidden
                      />
                      <span className="num text-slate-200">
                        #{e.seq} {e.kind}
                      </span>
                      {e.agent_id && <span className="num truncate text-slate-500">· {short(e.agent_id, 18, 0)}</span>}
                    </span>
                    <Badge tone={sevTone[e.severity]}>{e.severity}</Badge>
                  </div>
                  <p className="mt-1 text-slate-400">{e.detail}</p>
                  {e.codes.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {e.codes.map((c) => (
                        <span key={c} className="num rounded bg-white/[0.05] px-1.5 text-[10.5px] leading-[18px] text-slate-400">
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Card>
  );
}

export function AgentControls() {
  const { runtime, dashboard, busy } = usePhalanx();
  const action = useAction();
  const personaOf = usePersonaOf();
  const controlFor = (a: NonNullable<typeof dashboard>["agents"][number], full = false) => {
    if (!runtime) return null;
    if (a.status.kind === "quarantined") {
      return (
        <Button
          className={full ? "w-full" : undefined}
          size="sm"
          icon={Undo2}
          disabled={busy !== null}
          onClick={() => void action(`owner reinstates ${a.handle}`, runtime.owner, "reinstate_agent", (rt) => rt.reinstate(a.agent_id))}
        >
          Reinstate
        </Button>
      );
    }
    if (a.status.kind !== "active") return null;
    return (
      <Button
        className={full ? "w-full" : undefined}
        size="sm"
        variant="danger"
        icon={Snowflake}
        disabled={busy !== null}
        onClick={() =>
          void action(`owner freezes ${a.handle}`, runtime.owner, "freeze_agent", (rt) => rt.freeze(a.agent_id, "manual review from command center"))
        }
      >
        Freeze
      </Button>
    );
  };
  return (
    <Card className="p-4 sm:p-5">
      <CardHeader
        icon={UserCog}
        eyebrow="Scoped FunctionCall keys · per-agent limits · on-chain balances"
        title="Agent access & controls"
        description="Owner actions: freeze an active agent, or reinstate one the circuit breaker quarantined. Earnings are credited to each agent's on-chain balance; agents spend them with pay_from_balance or withdraw to their owner-set payout account."
      />
      <div className="mt-4">
        {!runtime || !dashboard ? (
          <SkeletonBlock rows={5} />
        ) : (
          <>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:hidden">
              {dashboard.agents.map((a) => {
                const p = personaOf(a.agent_id);
                return (
                  <li key={a.agent_id} className="min-w-0 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      {p && <PersonaAvatar persona={p} size={34} />}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-slate-100">{a.handle}</div>
                        <div className="text-[11px] text-slate-500">{a.role.replace("_", " ")}</div>
                      </div>
                      <Badge tone={statusTone(a.status.kind)} dot>
                        {a.status.kind}
                      </Badge>
                    </div>

                    <div className="mt-3 grid grid-cols-1 gap-3 min-[440px]:grid-cols-2 text-[11.5px]">
                      <div className="min-w-0">
                        <Label>Key scope</Label>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-slate-300">
                          <KeyRound className={cx("size-3.5 shrink-0", a.key_active ? "text-emerald-300" : "text-red-300")} aria-hidden />
                          <span className="num">{a.allowed_methods.length} methods</span>
                          <span className={a.key_active ? "text-slate-400" : "text-red-300"}>{a.key_active ? "live" : "deleted"}</span>
                        </div>
                        <div className="num mt-0.5 text-[10.5px] text-slate-500">allowance {nearFmt(a.allowance_cap)}</div>
                      </div>
                      <dl className="grid grid-cols-3 gap-2 text-right max-[439px]:text-left max-[439px]:pt-2 max-[439px]:border-t max-[439px]:border-white/[0.04]">
                        <div>
                          <dt className="text-[10.5px] uppercase tracking-wider text-slate-500">Balance</dt>
                          <dd className="num mt-1 text-slate-200">{nearFmt(a.balance, 1)}</dd>
                        </div>
                        <div>
                          <dt className="text-[10.5px] uppercase tracking-wider text-slate-500">Rep</dt>
                          <dd className="num mt-1 text-slate-200">{(a.reputation_bps / 100).toFixed(1)}%</dd>
                        </div>
                        <div>
                          <dt className="text-[10.5px] uppercase tracking-wider text-slate-500">Strikes</dt>
                          <dd className={cx("num mt-1", a.violations ? "text-red-300" : "text-slate-200")}>{a.violations}</dd>
                        </div>
                      </dl>
                    </div>

                    <div className="mt-3">
                      <div className="num mb-1 flex flex-wrap justify-between gap-2 text-[11px] text-slate-500">
                        <span>Epoch spend</span>
                        <span className="text-slate-300">
                          {nearFmt(a.spend.spent_in_epoch, 1)} / {nearFmt(a.policy.epoch_spending_cap_yocto, 0)}
                        </span>
                      </div>
                      <Meter value={BigInt(a.spend.spent_in_epoch)} max={BigInt(a.policy.epoch_spending_cap_yocto)} label={`${a.handle} epoch spend`} />
                    </div>
                    <div className="mt-3">{controlFor(a, true)}</div>
                  </li>
                );
              })}
            </ul>

            <div className="hidden overflow-x-auto xl:block" role="region" aria-label="Agent access table" tabIndex={0}>
              <table className="w-full min-w-[840px] text-left text-[12.5px]">
                <thead className="text-[10.5px] uppercase tracking-wider text-slate-500">
                  <tr className="border-b border-white/[0.06]">
                    <th className="pb-2 pr-3 font-medium">Agent</th>
                    <th className="pb-2 pr-3 font-medium">Status</th>
                    <th className="pb-2 pr-3 font-medium">Key scope</th>
                    <th className="pb-2 pr-3 font-medium">Epoch spend</th>
                    <th className="pb-2 pr-3 text-right font-medium">Balance</th>
                    <th className="pb-2 pr-3 text-right font-medium">Reputation</th>
                    <th className="pb-2 pr-3 text-right font-medium">Strikes</th>
                    <th className="pb-2 text-right font-medium">Control</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.agents.map((a) => {
                    const p = personaOf(a.agent_id);
                    return (
                      <tr key={a.agent_id} className="border-b border-white/[0.04] transition-colors last:border-0 hover:bg-white/[0.02]">
                        <td className="py-2.5 pr-3">
                          <div className="flex items-center gap-2.5">
                            {p && <PersonaAvatar persona={p} size={30} />}
                            <div className="min-w-0">
                              <div className="font-medium text-slate-100">{a.handle}</div>
                              <div className="text-[11px] text-slate-500">{a.role.replace("_", " ")}</div>
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 pr-3">
                          <Badge tone={statusTone(a.status.kind)} dot>
                            {a.status.kind}
                          </Badge>
                        </td>
                        <td className="py-2.5 pr-3">
                          <div className="flex items-center gap-1.5 text-slate-300">
                            <KeyRound className={cx("size-3.5", a.key_active ? "text-emerald-300" : "text-red-300")} aria-hidden />
                            <span className="num">{a.allowed_methods.length} methods</span>
                            <span className="text-slate-600">·</span>
                            <span className={a.key_active ? "text-slate-400" : "text-red-300"}>{a.key_active ? "key live" : "key deleted"}</span>
                          </div>
                          <div className="num text-[11px] text-slate-500">allowance {nearFmt(a.allowance_cap)}</div>
                        </td>
                        <td className="w-48 py-2.5 pr-3">
                          <div className="num mb-1 text-[11.5px] text-slate-300">
                            {nearFmt(a.spend.spent_in_epoch, 1)} <span className="text-slate-500">/ {nearFmt(a.policy.epoch_spending_cap_yocto, 0)}</span>
                          </div>
                          <Meter value={BigInt(a.spend.spent_in_epoch)} max={BigInt(a.policy.epoch_spending_cap_yocto)} label={`${a.handle} epoch spend`} />
                        </td>
                        <td className="num py-2.5 pr-3 text-right text-slate-300" title={`earned ${nearFmt(a.total_earned)} · spent ${nearFmt(a.total_spent)}`}>
                          {nearFmt(a.balance)}
                        </td>
                        <td className="num py-2.5 pr-3 text-right text-slate-300">{(a.reputation_bps / 100).toFixed(1)}%</td>
                        <td className="py-2.5 pr-3 text-right">
                          <span
                            className={cx(
                              "num inline-grid min-w-6 place-items-center rounded-md px-1.5 text-[11.5px] leading-5",
                              a.violations ? "bg-red-500/15 text-red-300" : "bg-white/[0.04] text-slate-400",
                            )}
                          >
                            {a.violations}
                          </span>
                        </td>
                        <td className="py-2.5 text-right">
                          {a.status.kind === "quarantined" ? (
                            <Button
                              size="sm"
                              icon={Undo2}
                              disabled={busy !== null}
                              onClick={() => void action(`owner reinstates ${a.handle}`, runtime.owner, "reinstate_agent", (rt) => rt.reinstate(a.agent_id))}
                            >
                              Reinstate
                            </Button>
                          ) : a.status.kind === "active" ? (
                            <Button
                              size="sm"
                              variant="danger"
                              icon={Snowflake}
                              disabled={busy !== null}
                              onClick={() =>
                                void action(`owner freezes ${a.handle}`, runtime.owner, "freeze_agent", (rt) =>
                                  rt.freeze(a.agent_id, "manual review from command center"),
                                )
                              }
                            >
                              Freeze
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

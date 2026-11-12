"use client";

import { ACCOUNTS, type AgentRecordT, type PersonaId } from "@phalanx/agent-swarm-sdk";
import { useReducedMotion } from "framer-motion";
import { ArrowRightLeft, Fingerprint, KeyRound, Landmark, Network, Signature, TriangleAlert, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { usePhalanx } from "@/lib/phalanx-context";

import {
  Badge,
  Callout,
  Card,
  CardHeader,
  CopyButton,
  KV,
  Label,
  Meter,
  PERSONAS,
  PERSONA_META,
  PersonaAvatar,
  SkeletonBlock,
  StatusDot,
  cx,
  nearFmt,
  short,
  statusTone,
  toneHex,
} from "./ui";

const W = 1000;
const H = 560;
const HUB = { x: 500, y: 280 };
const LAYOUT: Record<PersonaId, { x: number; y: number }> = {
  nexus: { x: 205, y: 140 },
  sentinel: { x: 795, y: 140 },
  rhea: { x: 170, y: 378 },
  cipher: { x: 830, y: 378 },
  mallory: { x: 500, y: 492 },
};
const EXTERNAL: Array<{ id: string; label: string; sub: string; x: number; y: number; hex: string; icon: LucideIcon }> = [
  { id: ACCOUNTS.owner, label: "Owner DAO", sub: "SputnikDAO / Trezu", x: 500, y: 52, hex: toneHex.sky, icon: Landmark },
  { id: ACCOUNTS.intents, label: "NEAR Intents", sub: "1Click dry quotes", x: 120, y: 515, hex: toneHex.amber, icon: ArrowRightLeft },
  { id: ACCOUNTS.mpc, label: "MPC signer", sub: "Chain Signatures (local responder)", x: 880, y: 515, hex: toneHex.violet, icon: Signature },
];

const edgeColor = (a?: AgentRecordT) =>
  !a ? "#334155" : a.status.kind === "active" ? toneHex.emerald : a.status.kind === "quarantined" ? toneHex.red : toneHex.amber;

/** Gentle quadratic curve from `a` to `b`. */
function curve(a: { x: number; y: number }, b: { x: number; y: number }, bend = 0.12): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return `M${a.x},${a.y} Q${mx - dy * bend},${my + dx * bend} ${b.x},${b.y}`;
}

const at = (p: { x: number; y: number }) => ({ left: `${(p.x / W) * 100}%`, top: `${(p.y / H) * 100}%` });

export function SwarmTopology() {
  const { runtime, dashboard, attestation, activity } = usePhalanx();
  const reduce = useReducedMotion();
  const [selected, setSelected] = useState<PersonaId>("nexus");
  const last = activity[0];
  const lastSigner = last?.signer ?? "";

  const byPersona = useMemo(() => {
    const m = new Map<PersonaId, AgentRecordT>();
    if (!runtime || !dashboard) return m;
    for (const p of PERSONAS) {
      const rec = dashboard.agents.find((a) => a.agent_id === runtime.agents[p].accountId);
      if (rec) m.set(p, rec);
    }
    return m;
  }, [runtime, dashboard]);

  const isHot = (p: PersonaId) => {
    if (!runtime) return false;
    const h = runtime.agents[p];
    return lastSigner.startsWith(
      h.signer.accountId === ACCOUNTS.contract ? `${ACCOUNTS.contract} [key ${h.keyPair.publicKeyString.slice(8, 18)}` : h.accountId,
    );
  };

  const sel = runtime?.agents[selected];
  const selRec = byPersona.get(selected);
  const keys =
    sel && runtime
      ? runtime.keysOf(sel.spawnMode === "sub_account" ? sel.accountId : ACCOUNTS.contract).filter((k) => k.publicKey === sel.keyPair.publicKeyString)
      : [];
  const loading = !runtime || !dashboard;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="flex flex-col p-4 sm:p-5">
          <CardHeader
            icon={Network}
            eyebrow="Swarm topology · sub-accounts & scoped keys"
            title="Agent swarm around the PhalanxCore treasury"
            actions={
              <div className="flex items-center gap-3 text-[11.5px] text-slate-500">
                <span className="flex items-center gap-1.5">
                  <StatusDot tone="emerald" /> active
                </span>
                <span className="flex items-center gap-1.5">
                  <StatusDot tone="red" /> quarantined
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-px w-4 border-t border-dashed border-slate-500" /> external
                </span>
              </div>
            }
          />

          <div className="@container mt-4 flex flex-1 flex-col justify-center">
            {loading ? (
              <div className="skeleton aspect-[25/14] w-full rounded-xl" />
            ) : (
              <>
                {/* Graph: SVG edges + HTML nodes (crisp text, real buttons). */}
                <div className="bg-dots relative hidden aspect-[25/14] w-full overflow-hidden rounded-xl border border-white/[0.06] bg-black/30 @3xl:block">
                  <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full" aria-hidden>
                    <defs>
                      <radialGradient id="hub-glow" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stopColor="#00EC97" stopOpacity="0.28" />
                        <stop offset="100%" stopColor="#00EC97" stopOpacity="0" />
                      </radialGradient>
                    </defs>
                    {EXTERNAL.map((e) => (
                      <path key={e.id} d={curve(e, HUB, 0.05)} fill="none" stroke={e.hex} strokeOpacity={0.35} strokeWidth={1.2} strokeDasharray="2 7" />
                    ))}
                    {PERSONAS.map((p) => {
                      const rec = byPersona.get(p);
                      const c = edgeColor(rec);
                      const d = curve(LAYOUT[p], HUB);
                      const activeEdge = rec?.status.kind === "active";
                      return (
                        <g key={p}>
                          <path d={d} fill="none" stroke={c} strokeOpacity={0.12} strokeWidth={7} />
                          <path
                            d={d}
                            fill="none"
                            stroke={c}
                            strokeOpacity={activeEdge ? 0.7 : 0.45}
                            strokeWidth={activeEdge ? 1.8 : 1.4}
                            strokeDasharray={activeEdge ? undefined : "4 8"}
                            className={activeEdge && !reduce ? "edge-flow" : undefined}
                          />
                          {isHot(p) && !reduce && last && (
                            <circle key={last.id} r={6} fill={c} style={{ filter: `drop-shadow(0 0 8px ${c})` }}>
                              <animateMotion
                                ref={(el: SVGAnimationElement | null) => {
                                  el?.beginElement();
                                }}
                                begin="indefinite"
                                dur="1.1s"
                                repeatCount="3"
                                fill="remove"
                                path={d}
                              />
                            </circle>
                          )}
                        </g>
                      );
                    })}
                    <circle cx={HUB.x} cy={HUB.y} r={130} fill="url(#hub-glow)" />
                    <g className={reduce ? undefined : "animate-spin-slow"} style={{ transformOrigin: `${HUB.x}px ${HUB.y}px` }}>
                      <circle cx={HUB.x} cy={HUB.y} r={84} fill="none" stroke="#00EC97" strokeOpacity={0.35} strokeWidth={1} strokeDasharray="3 9" />
                    </g>
                    <circle cx={HUB.x} cy={HUB.y} r={70} fill="none" stroke="#00EC97" strokeOpacity={0.12} strokeWidth={10} />
                  </svg>

                  <div
                    className="absolute grid size-[124px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-emerald-400/50 bg-[#0a0f14] text-center shadow-[0_0_48px_-8px_rgb(0_236_151/0.5)]"
                    style={at(HUB)}
                  >
                    <div>
                      <div className="text-[13px] font-semibold text-emerald-300">PhalanxCore</div>
                      <div className="num text-[10px] text-slate-500">{ACCOUNTS.contract}</div>
                      <div className="num mt-1 text-[13px] text-slate-100">{nearFmt(dashboard.treasury.liquid, 1)}</div>
                    </div>
                  </div>

                  {EXTERNAL.map((e) => {
                    const Icon = e.icon;
                    return (
                      <div
                        key={e.id}
                        className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-lg border border-dashed bg-[#0b0f17]/90 px-2.5 py-1.5"
                        style={{ ...at(e), borderColor: `${e.hex}66` }}
                        title={e.id}
                      >
                        <Icon className="size-3.5" style={{ color: e.hex }} aria-hidden />
                        <div className="leading-tight">
                          <div className="text-[11.5px] font-medium text-slate-200">{e.label}</div>
                          <div className="text-[10px] text-slate-500">{e.sub}</div>
                        </div>
                      </div>
                    );
                  })}

                  {PERSONAS.map((p) => {
                    const rec = byPersona.get(p);
                    const h = runtime.agents[p];
                    const on = selected === p;
                    const tone = statusTone(rec?.status.kind);
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setSelected(p)}
                        aria-pressed={on}
                        aria-label={`${h.displayName}, ${rec?.status.kind ?? "unknown"}`}
                        className={cx(
                          "absolute flex w-[188px] -translate-x-1/2 -translate-y-1/2 items-center gap-2.5 rounded-xl border bg-[#0b0f17]/95 p-2 pr-3 text-left shadow-lg shadow-black/40 transition duration-200 hover:-translate-y-[calc(50%+2px)]",
                          on
                            ? "border-emerald-400/60 ring-4 ring-emerald-400/10"
                            : tone === "red"
                              ? "border-red-400/50"
                              : "border-white/10 hover:border-white/25",
                        )}
                        style={at(LAYOUT[p])}
                      >
                        <PersonaAvatar persona={p} size={34} status={rec?.status.kind} />
                        <span className="min-w-0">
                          <span className="block truncate text-[12.5px] font-medium text-slate-100">{h.displayName}</span>
                          <span className="block text-[10.5px] text-slate-500">
                            {h.spawnMode === "sub_account" ? "sub-account · FC key" : "contract key · FC key"}
                          </span>
                          <span
                            className={cx(
                              "num block text-[10.5px]",
                              tone === "emerald" ? "text-emerald-300" : tone === "red" ? "text-red-300" : "text-amber-200",
                            )}
                          >
                            {rec ? `${rec.status.kind.toUpperCase()} · rep ${(rec.reputation_bps / 100).toFixed(1)}%` : "…"}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Narrow containers: central hub & external actors summary, then the agent list. */}
                <div className="mb-3 rounded-xl border border-emerald-400/30 bg-gradient-to-r from-emerald-500/[0.08] to-emerald-950/[0.05] p-3 @3xl:hidden">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-emerald-300">PhalanxCore Treasury</div>
                      <div className="num truncate text-[11px] text-slate-400">{ACCOUNTS.contract}</div>
                    </div>
                    <div className="num shrink-0 text-[14px] font-bold text-white">{nearFmt(dashboard.treasury.liquid, 1)}</div>
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-white/[0.06] pt-2">
                    {EXTERNAL.map((e) => {
                      const Icon = e.icon;
                      return (
                        <span
                          key={e.id}
                          className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[10.5px] text-slate-300"
                        >
                          <Icon className="size-3" style={{ color: e.hex }} aria-hidden />
                          {e.label}
                        </span>
                      );
                    })}
                  </div>
                </div>

                <ul className="space-y-2 @3xl:hidden">
                  {PERSONAS.map((p) => {
                    const rec = byPersona.get(p);
                    const h = runtime.agents[p];
                    return (
                      <li key={p}>
                        <button
                          type="button"
                          onClick={() => setSelected(p)}
                          aria-pressed={selected === p}
                          className={cx(
                            "flex w-full items-center gap-3 rounded-xl border p-2.5 text-left",
                            selected === p ? "border-emerald-400/50 bg-emerald-400/[0.05]" : "border-white/[0.07] bg-white/[0.02]",
                          )}
                        >
                          <PersonaAvatar persona={p} size={32} status={rec?.status.kind} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-slate-100">{h.displayName}</span>
                            <span className="num block text-[11px] text-slate-500">
                              {rec ? `${rec.status.kind} · rep ${(rec.reputation_bps / 100).toFixed(1)}%` : "…"}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </Card>

        <Card className="flex flex-col p-4 sm:p-5">
          {!sel || loading ? (
            <SkeletonBlock rows={8} />
          ) : (
            <>
              <Label>Agent inspector</Label>
              <div className="mt-3 flex items-center gap-3">
                <PersonaAvatar persona={selected} size={44} status={selRec?.status.kind} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-semibold text-slate-50">{sel.displayName}</div>
                  <div className="text-[12px] text-slate-500">{PERSONA_META[selected].role}</div>
                </div>
                {selRec && (
                  <Badge tone={statusTone(selRec.status.kind)} dot>
                    {selRec.status.kind}
                  </Badge>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Select agent">
                {PERSONAS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setSelected(p)}
                    aria-pressed={selected === p}
                    aria-label={runtime.agents[p].displayName}
                    className={cx(
                      "touch-target-square grid size-10 place-items-center rounded-[12px] transition",
                      selected === p ? "ring-2 ring-emerald-400/60" : "opacity-60 hover:opacity-100",
                    )}
                  >
                    <PersonaAvatar persona={p} size={26} />
                  </button>
                ))}
              </div>
              <p className="mt-3 text-[12.5px] leading-relaxed text-slate-400">{sel.description}</p>
              <div className="mt-3">
                <KV k="agent id" v={<span title={sel.accountId}>{short(sel.accountId, 18, 14)}</span>} />
                <KV k="role" v={sel.role} />
                <KV k="spawn mode" v={sel.spawnMode} />
                <KV k="public key" v={<span title={sel.keyPair.publicKeyString}>{short(sel.keyPair.publicKeyString, 14, 6)}</span>} />
                <KV
                  k="on-chain key"
                  v={
                    keys.length ? (
                      <span className="inline-flex items-center gap-1 text-emerald-300">
                        <KeyRound className="size-3" aria-hidden />
                        {keys[0]!.permission.kind === "function_call" ? "FunctionCall" : "FullAccess"}
                      </span>
                    ) : (
                      <span className="text-red-300">revoked</span>
                    )
                  }
                />
                {selRec && (
                  <>
                    <KV k="max tx / epoch cap" v={`${nearFmt(selRec.policy.max_tx_amount_yocto, 0)} / ${nearFmt(selRec.policy.epoch_spending_cap_yocto, 0)}`} />
                    <KV k="spent this epoch" v={nearFmt(selRec.spend.spent_in_epoch)} />
                    <KV k="on-chain balance" v={nearFmt(selRec.balance)} />
                    <KV k="earned / spent" v={`${nearFmt(selRec.total_earned)} / ${nearFmt(selRec.total_spent)}`} />
                    <KV k="payout account" v={<span title={selRec.payout_account}>{short(selRec.payout_account, 18, 0)}</span>} />
                    <KV k="tasks ✔ / ✘" v={`${selRec.tasks_completed} / ${selRec.tasks_failed}`} />
                    <KV k="strikes" v={selRec.violations} />
                  </>
                )}
              </div>
              {selRec && (
                <div className="mt-3">
                  <div className="mb-1 flex justify-between text-[11px] text-slate-500">
                    <span>epoch budget used</span>
                    <span className="num">{nearFmt(selRec.spend.spent_in_epoch, 1)}</span>
                  </div>
                  <Meter
                    value={BigInt(selRec.spend.spent_in_epoch)}
                    max={BigInt(selRec.policy.epoch_spending_cap_yocto)}
                    label={`${sel.displayName} epoch budget used`}
                  />
                </div>
              )}
              {selRec && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {selRec.allowed_methods.map((m) => (
                    <span key={m} className="num rounded-md border border-emerald-400/20 bg-emerald-400/[0.05] px-1.5 text-[10.5px] leading-5 text-emerald-200">
                      {m}
                    </span>
                  ))}
                </div>
              )}
              {selRec?.status.kind === "quarantined" && (
                <Callout tone="red" icon={TriangleAlert} title="Quarantined by the circuit breaker" className="mt-3">
                  {selRec.status.reason}
                </Callout>
              )}
            </>
          )}
        </Card>
      </div>

      {(attestation || (dashboard && dashboard.enclaves.length > 0)) && (
        <Card id="model-tee-evidence" className="scroll-mt-24 p-4 sm:p-5 lg:scroll-mt-28">
          <CardHeader
            icon={Fingerprint}
            eyebrow="Who signs agent output"
            title="Model keys & TEE evidence"
            actions={
              attestation && (
                <Badge tone={attestation.verified && !attestation.stale ? "emerald" : attestation.source === "binding-only" ? "slate" : "amber"} dot>
                  {attestation.source === "live"
                    ? `gateway DCAP ${attestation.status}`
                    : attestation.source === "cached"
                      ? `gateway DCAP ${attestation.status} · ${attestation.stale ? "stale" : "cached"}`
                      : "offline"}
                </Badge>
              )
            }
          />
          <p className="mt-3 text-[12.5px] leading-relaxed text-slate-400">
            The contract accepts an agent&apos;s output only if it is signed by a registered key. NEAR AI keys are registered after their model attestation
            passes DCAP and binds the key to a fresh nonce; the stand-in key is registered with an explicit &ldquo;no TEE&rdquo; label.
          </p>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {dashboard && dashboard.enclaves.length > 0 && (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Registered Model Enclaves</div>
                <ul className="space-y-1.5">
                  {dashboard.enclaves.map((e) => (
                    <li key={e.enclave_id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-[12px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="num truncate text-slate-200" title={e.enclave_id}>
                          {short(e.enclave_id, 22, 0)}
                        </span>
                        <Badge tone={e.tee_type === "none" ? "amber" : "emerald"}>{e.tee_type === "none" ? "no TEE" : e.tee_type}</Badge>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        {e.vendor} · <span className="num">{short(e.model_id, 26, 0)}</span> · {e.receipts_verified} proofs verified
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {attestation && attestation.source !== "binding-only" && (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">NEAR AI Gateway Attestation</div>
                <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                  <p className="text-[11.5px] text-slate-400">
                    {attestation.source === "live"
                      ? "NEAR AI gateway: Intel TDX quote verified now against Intel collateral (dcap-qvl) and bound to this tab's nonce."
                      : `NEAR AI gateway: fresh check failed; showing DCAP evidence from ${attestation.verifiedAt ? new Date(attestation.verifiedAt).toLocaleString() : "the build"}${attestation.stale ? " (older than 7 days)" : ""}.`}
                  </p>
                  <div className="mt-2.5 space-y-1">
                    <KV
                      k="gateway mr_td"
                      v={
                        <span className="inline-flex items-center gap-1">
                          {short(attestation.measurement, 14, 8)}
                          <span className="-my-1.5 scale-75">
                            <CopyButton text={attestation.measurement} label="Copy measurement" iconOnly />
                          </span>
                        </span>
                      }
                    />
                    <KV k="gateway signing key" v={short(attestation.signingAddress, 14, 8)} />
                    {attestation.advisoryIds.length > 0 && <KV k="advisories" v={attestation.advisoryIds.join(", ")} />}
                  </div>
                </div>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

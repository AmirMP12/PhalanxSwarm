"use client";

import { Binary, ExternalLink, Fingerprint, KeyRound, Network, RadioTower, RefreshCw, ShieldCheck, WalletCards, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useAegis } from "@/lib/aegis-context";
import { loadEvidence, type ReproEvidence, type SwarmEvidence } from "@/lib/evidence";

import { Badge, Card, CardHeader, CodeBlock, SkeletonBlock, short } from "./ui";

/** The transactions a judge should open first, in order. */
const KEY_TXS: Array<[name: string, label: string]> = [
  ["invoice_fraud_attempt", "fraud blocked + key deleted"],
  ["invented_facts_audit_attempt", "audit over invented facts rejected"],
  ["forged_audit_attempt", "forged audit rejected"],
  ["rubber_stamp_rfp_refused", "unapproved task prompt refused"],
  ["execute_verified_task", "signed work releases escrow"],
  ["block_recipient", "attacker blocklisted"],
  ["held_payment_approved", "new vendor paid after DAO vote"],
  // Runs before the 2-of-3 council recorded the revocation as dao_approve.
  ["dao_approve", "DAO revokes the agent"],
  ["dao_revoke_approved", "DAO revokes the agent"],
  ["vendor_payment", "real vendor payment"],
  ["evm_transfer_request", "MPC-signed EVM transfer"],
  ["deploy_and_init", "deploy + init"],
];
/** artifacts/testnet-smoke.json: the v1 deployment's real MPC signature. */
interface MpcEvidence {
  contract_id: string;
  mpc_contract_id: string;
  mpc_recovered_address: string;
  final_status: string;
  timestamp: string;
  transactions: Record<string, { hash: string; explorer: string }>;
}
interface WalletEvidence {
  wallet_connector: string;
  account_id: string;
  login_observed: boolean;
  pause_observed: boolean;
  resume_observed: boolean;
  transactions: Array<{ method: string; explorer: string }>;
  timestamp: string;
}
interface TeeEvidence {
  status: string;
  verified: boolean;
  nonce_bound: boolean;
  measurement_match: boolean;
  measurement_mr_td: string;
  timestamp: string;
}
interface LiveEvidence {
  passed: boolean;
  checked_at: string;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  oneclick?: { correlation_id: string; dry: boolean };
}
interface Evidence {
  repro: ReproEvidence | null;
  swarm: SwarmEvidence | null;
  mpc: MpcEvidence | null;
  wallet: WalletEvidence | null;
  tee: TeeEvidence | null;
  live: LiveEvidence | null;
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

function Proof({
  icon: Icon,
  title,
  badge,
  children,
  links,
}: {
  icon: LucideIcon;
  title: string;
  badge: ReactNode;
  children: ReactNode;
  links?: Array<{ label: string; href: string }>;
}) {
  return (
    <div className="flex h-full min-w-0 flex-col rounded-xl border border-white/[0.07] bg-black/20 p-3.5 transition-colors hover:border-white/10 hover:bg-black/25">
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-emerald-400/[0.08] text-emerald-300 ring-1 ring-emerald-400/15">
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <h4 className="text-[13px] font-semibold text-slate-100">{title}</h4>
            {badge}
          </div>
        </div>
      </div>
      <div className="mt-2.5 flex-1 text-[11.5px] leading-relaxed text-slate-400">{children}</div>
      {links && links.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 border-t border-white/[0.05] pt-2">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              target="_blank"
              rel="noreferrer"
              className="touch-target inline-flex min-h-7 items-center gap-1 py-0.5 text-[11px] text-sky-300 hover:text-sky-200"
            >
              {l.label} <ExternalLink className="size-3" aria-hidden />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

const missing = (cmd: string) => (
  <span>
    Not recorded yet. Run <code className="num rounded bg-white/[0.05] px-1 text-slate-300">{cmd}</code>.
  </span>
);

/** Public proof bundle: every link and hash can be re-checked without any private key. */
export function LiveProofs() {
  const { wasm, attestation } = useAegis();
  const [data, setData] = useState<Evidence | null>(null);

  useEffect(() => {
    void (async () => {
      const [repro, swarm, mpc, wallet, tee, live] = await Promise.all([
        loadEvidence<ReproEvidence>("reproducible-build.json"),
        loadEvidence<SwarmEvidence>("testnet-swarm.json"),
        loadEvidence<MpcEvidence>("testnet-smoke.json"),
        loadEvidence<WalletEvidence>("wallet-smoke.json"),
        loadEvidence<TeeEvidence>("nearai-attestation.json"),
        loadEvidence<LiveEvidence>("live-verification.json"),
      ]);
      setData({ repro, swarm, mpc, wallet, tee, live });
    })();
  }, []);

  const tabMatches = data?.repro && wasm ? data.repro.wasm_sha256 === wasm.sha256 : null;
  const swarm = data?.swarm ?? null;
  const swarmLinks = swarm
    ? [
        ...KEY_TXS.flatMap(([name, label]) => (swarm.transactions[name] ? [{ label, href: swarm.transactions[name].explorer }] : [])),
        ...(swarm.evm?.explorer && ["mined", "confirmed"].includes(swarm.evm.status)
          ? [{ label: `${swarm.evm.chain} transaction`, href: swarm.evm.explorer }]
          : []),
      ]
    : [];

  return (
    <Card className="p-4 sm:p-5">
      <CardHeader
        icon={RadioTower}
        eyebrow="Primary evidence · public, keyless re-check"
        title="Live network proofs (not the sandbox)"
        description="AegisSim above is a local rehearsal. This panel lists the public evidence: testnet transactions, the reproducible build and NEAR AI hardware attestation. pnpm verify:live re-checks all of it without a key, and the On-chain section below reads the deployment itself."
        actions={
          data?.live && (
            <Badge tone={data.live.passed ? "emerald" : "red"} dot>
              {data.live.checks.filter((c) => c.passed).length}/{data.live.checks.length} live checks · {day(data.live.checked_at)}
            </Badge>
          )
        }
      />
      {!data ? (
        <div className="mt-4 space-y-3">
          <SkeletonBlock rows={3} />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <SkeletonBlock rows={4} />
            <SkeletonBlock rows={4} />
            <SkeletonBlock rows={4} />
            <SkeletonBlock rows={4} />
            <SkeletonBlock rows={4} />
            <SkeletonBlock rows={4} />
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {swarm && (
            <div className="rounded-xl border border-emerald-400/25 bg-gradient-to-br from-emerald-500/[0.05] via-white/[0.02] to-transparent p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] pb-3">
                <div className="flex items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-emerald-400/15 text-emerald-300 ring-1 ring-emerald-400/30">
                    <Network className="size-4.5" aria-hidden />
                  </span>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-[14px] font-semibold text-white">Testnet Swarm Run (v2)</h4>
                      <Badge tone={swarm.deployer_full_access_keys === 0 && swarm.owner_id === swarm.dao_id ? "emerald" : "amber"} dot>
                        DAO-owned · {swarm.deployer_full_access_keys} FullAccess keys
                      </Badge>
                    </div>
                    <p className="text-[11.5px] text-slate-400">
                      Multi-agent testnet deployment under SputnikDAO governance with recorded autonomous transactions
                    </p>
                  </div>
                </div>
                <span className="num text-[11.5px] text-slate-500">Recorded {day(swarm.timestamp)}</span>
              </div>

              <div className="mt-3.5 grid grid-cols-1 gap-4 xl:grid-cols-[1.25fr_1fr]">
                <div className="space-y-2.5 text-[12px] leading-relaxed text-slate-300">
                  <p>
                    Contract <span className="num font-medium text-emerald-300">{swarm.contract_id}</span> (v{swarm.contract_version}) is owned by SputnikDAO{" "}
                    <span className="num text-sky-300">{swarm.dao_id}</span>. Agents operate under scoped FunctionCall keys with models on{" "}
                    {swarm.inference === "nearai"
                      ? `NEAR AI Cloud (${swarm.model})`
                      : swarm.inference === "generic_llm"
                        ? `Live LLM (${swarm.model})`
                        : "the stand-in model"}
                    .
                  </p>
                  <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3">
                    <div className="rounded-lg border border-white/[0.06] bg-black/20 p-2">
                      <span className="text-slate-500">Vendor Payment</span>
                      <div className="num font-medium text-slate-200">
                        {swarm.vendor_payment ? `${swarm.vendor_payment.amount_near} NEAR · ${swarm.vendor_payment.status}` : "—"}
                      </div>
                    </div>
                    <div className="rounded-lg border border-white/[0.06] bg-black/20 p-2">
                      <span className="text-slate-500">MPC Cross-Chain</span>
                      <div className="num font-medium text-slate-200">{swarm.evm ? `${swarm.evm.chain} · ${swarm.evm.status}` : "—"}</div>
                    </div>
                    <div className="rounded-lg border border-white/[0.06] bg-black/20 p-2">
                      <span className="text-slate-500">Fraud Circuit Breaker</span>
                      <div className="num font-medium text-red-300">{swarm.attack ? "key deleted & quarantined" : "active"}</div>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-white/[0.06] bg-black/30 p-3">
                  <div className="mb-2 flex items-center justify-between text-[10.5px]">
                    <span className="font-semibold uppercase tracking-wider text-slate-400">Verified On-Chain Receipts</span>
                    <span className="num text-slate-500">{swarmLinks.length} transactions</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {swarmLinks.map((l) => (
                      <a
                        key={l.href}
                        href={l.href}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[11px] text-sky-300 transition hover:border-sky-400/40 hover:bg-sky-400/[0.08] hover:text-sky-200"
                      >
                        {l.label} <ExternalLink className="size-2.5 opacity-70" aria-hidden />
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Proof
              icon={Binary}
              title="Byte-identical WASM"
              badge={
                data.repro ? (
                  <Badge tone={tabMatches === false ? "amber" : "emerald"} dot>
                    {tabMatches === null ? "reproducible" : tabMatches ? "matches this tab" : "differs from this tab"}
                  </Badge>
                ) : (
                  <Badge tone="slate">missing</Badge>
                )
              }
            >
              {data.repro ? (
                <>
                  Two clean builds in pinned image <span className="num">{short(data.repro.image, 18, 8)}</span> produced the same{" "}
                  <span className="num">{data.repro.size_bytes.toLocaleString()} B</span> binary.
                  {tabMatches === false && " The WASM in this tab is a local build, not the canonical one."}
                  <CodeBlock className="mt-2" label="Reproducible build sha256">
                    <span className="break-all">sha256 {data.repro.wasm_sha256}</span>
                  </CodeBlock>
                </>
              ) : (
                missing("pnpm verify:reproducible")
              )}
            </Proof>

            <Proof
              icon={Fingerprint}
              title="NEAR AI Cloud TDX attestation"
              badge={
                attestation && attestation.source !== "binding-only" ? (
                  <Badge tone={attestation.verified && !attestation.stale ? "emerald" : "amber"} dot>
                    {attestation.source === "live"
                      ? `fresh · DCAP ${attestation.status}`
                      : `${attestation.stale ? "stale" : "cached"} · DCAP ${attestation.status}`}
                  </Badge>
                ) : data.tee ? (
                  <Badge tone={data.tee.verified ? "emerald" : "red"} dot>
                    DCAP {data.tee.status}
                  </Badge>
                ) : (
                  <Badge tone="slate">missing</Badge>
                )
              }
            >
              {attestation?.source === "live" ? (
                <>This tab just fetched a gateway quote with a fresh nonce and the server verified it against Intel collateral. No API key is needed.</>
              ) : data.tee ? (
                <>
                  Saved check from {day(data.tee.timestamp)}: nonce bound <b className="text-slate-200">{String(data.tee.nonce_bound)}</b>, measurement match{" "}
                  <b className="text-slate-200">{String(data.tee.measurement_match)}</b>.
                </>
              ) : (
                missing("pnpm verify:tee")
              )}
              {(attestation?.measurement ?? data.tee?.measurement_mr_td) && (
                <div className="num mt-2 break-all rounded-md border border-white/[0.05] bg-white/[0.03] p-1.5 text-[10px] text-slate-400">
                  mr_td {attestation?.source === "live" ? attestation.measurement : data.tee?.measurement_mr_td}
                </div>
              )}
            </Proof>

            <Proof
              icon={KeyRound}
              title="Real Chain Signatures MPC"
              badge={
                data.mpc ? (
                  <Badge tone={data.mpc.final_status === "settled" ? "emerald" : "red"} dot>
                    v1 deployment · {data.mpc.final_status}
                  </Badge>
                ) : (
                  <Badge tone="slate">missing</Badge>
                )
              }
              links={data.mpc?.transactions.intent ? [{ label: "MPC intent transaction", href: data.mpc.transactions.intent.explorer }] : []}
            >
              {data.mpc ? (
                <>
                  On {day(data.mpc.timestamp)} <span className="num">{data.mpc.mpc_contract_id}</span> signed a settlement payload for contract{" "}
                  <span className="num">{short(data.mpc.contract_id, 14, 8)}</span>. <span className="num">ecrecover</span> returned derived treasury address{" "}
                  <span className="num">{short(data.mpc.mpc_recovered_address, 10, 6)}</span> (v2 uses the same derivation).
                </>
              ) : (
                missing("pnpm testnet:smoke")
              )}
            </Proof>

            <Proof
              icon={WalletCards}
              title="NEAR Connect wallet flow"
              badge={
                data.wallet ? (
                  <Badge tone={data.wallet.login_observed && data.wallet.pause_observed && data.wallet.resume_observed ? "emerald" : "red"} dot>
                    login + 2 txs
                  </Badge>
                ) : (
                  <Badge tone="slate">missing</Badge>
                )
              }
              links={data.wallet?.transactions.map((t, i) => ({ label: i === 0 ? "pause tx" : "resume tx", href: t.explorer }))}
            >
              {data.wallet ? (
                <>
                  <span className="num">{data.wallet.wallet_connector}</span> logged a disposable wallet into{" "}
                  <span className="num">{short(data.wallet.account_id, 14, 8)}</span>, loaded RPC state and signed owner pause/resume on{" "}
                  {day(data.wallet.timestamp)} (v1 deployment).
                </>
              ) : (
                missing("pnpm testnet:wallet")
              )}
            </Proof>

            <Proof
              icon={RefreshCw}
              title="Live 1Click quote"
              badge={
                data.live?.oneclick ? (
                  <Badge tone={data.live.oneclick.dry ? "emerald" : "red"} dot>
                    dry: {String(data.live.oneclick.dry)}
                  </Badge>
                ) : (
                  <Badge tone="slate">missing</Badge>
                )
              }
            >
              {data.live?.oneclick ? (
                <>
                  The latest no-key recheck got correlation id <span className="num">{short(data.live.oneclick.correlation_id, 12, 8)}</span> from 1Click. Dry
                  quotes create no deposit address and move no funds.
                </>
              ) : (
                missing("pnpm verify:live")
              )}
            </Proof>

            <Proof
              icon={ShieldCheck}
              title="Keyless live verification"
              badge={
                data.live ? (
                  <Badge tone={data.live.passed ? "emerald" : "red"} dot>
                    {data.live.checks.filter((c) => c.passed).length}/{data.live.checks.length} checks passed
                  </Badge>
                ) : (
                  <Badge tone="slate">missing</Badge>
                )
              }
            >
              {data.live ? (
                <>
                  Automated public verification script verified all {data.live.checks.length} testnet properties: reproducible bytecode, TDX quotes, SputnikDAO
                  governance, and fraud prevention.
                  <div className="num mt-2 text-[10.5px] text-slate-500">
                    Re-check locally: <code className="rounded bg-white/[0.05] px-1 text-slate-300">pnpm verify:live</code>
                  </div>
                </>
              ) : (
                missing("pnpm verify:live")
              )}
            </Proof>
          </div>
        </div>
      )}
      {data?.live && (
        <p className="mt-3 text-[10.5px] text-slate-600">
          Last public recheck: {new Date(data.live.checked_at).toLocaleString()} · evidence files: artifacts/*.json
        </p>
      )}
    </Card>
  );
}

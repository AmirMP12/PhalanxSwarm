"use client";

import { ACCOUNTS, quarterLabel } from "@aegis/agent-swarm-sdk";
import { BadgeCheck, Banknote, Coins, FileJson, Landmark, Plus, SquareTerminal, Vote } from "lucide-react";
import { useMemo, useState } from "react";

import { useAegis } from "@/lib/aegis-context";
import { useAction } from "@/lib/use-action";

import {
  AnimatedNumber,
  Badge,
  Button,
  Card,
  CardHeader,
  CodeBlock,
  CopyButton,
  Donut,
  Label,
  SegmentedControl,
  SkeletonBlock,
  Tooltip,
  cx,
  nearFmt,
  pct,
  short,
  toNear,
  toneHex,
  useCommands,
  type ChartTone,
} from "./ui";

type ProposalKind = "distribute" | "revoke" | "splits";

function Allocation({ parts }: { parts: Array<{ label: string; value: bigint; tone: ChartTone }> }) {
  const total = parts.reduce((n, p) => n + p.value, 0n);
  return (
    <div>
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-white/[0.05]">
        {parts.map((p) =>
          p.value > 0n ? (
            <div
              key={p.label}
              className="h-full transition-[width] duration-700 first:rounded-l-full last:rounded-r-full"
              style={{ width: `${pct(p.value, total)}%`, background: toneHex[p.tone] }}
              title={`${p.label}: ${nearFmt(p.value)}`}
            />
          ) : null,
        )}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        {parts.map((p) => (
          <div key={p.label} className="min-w-0">
            <dt className="flex items-center gap-1.5 text-[11.5px] text-slate-500">
              <span className="size-2 shrink-0 rounded-sm" style={{ background: toneHex[p.tone] }} aria-hidden />
              <span className="truncate" title={p.label}>
                {p.label}
              </span>
            </dt>
            <dd className="num mt-0.5 text-[12.5px] text-slate-200">{nearFmt(p.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Line({ label, value, tone, strong }: { label: string; value: string; tone?: "plus" | "minus" | "result"; strong?: boolean }) {
  return (
    <div className={cx("flex items-baseline justify-between gap-3 py-1.5 text-[12.5px]", strong && "border-t border-white/[0.08] pt-2")}>
      <span className={strong ? "font-medium text-slate-200" : "text-slate-400"}>{label}</span>
      <span
        className={cx(
          "num",
          tone === "plus" ? "text-emerald-300" : tone === "minus" ? "text-amber-200" : strong ? "font-semibold text-white" : "text-slate-300",
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function TreasuryVault() {
  const { runtime, dashboard, busy } = useAegis();
  const action = useAction();

  const minDist = dashboard ? BigInt(dashboard.config.min_distribution) : 0n;
  const distributable = dashboard ? BigInt(dashboard.treasury.distributable_profit) : 0n;
  // Mirrors distribute_revenue: the protocol is live and the profit is above zero and the on-chain minimum.
  const canDistribute = dashboard ? !dashboard.paused && distributable > 0n && distributable >= minDist : false;
  const distributeBlocked = dashboard?.paused ? "The protocol is paused" : `Distributable profit is below the ${nearFmt(minDist)} minimum`;
  const customerPays = () =>
    runtime && void action("customer pays 10 NEAR", runtime.customer, "deposit_revenue", (rt) => rt.recordRevenue(10, "acme-robotics", "usage-based invoice"));
  const distribute = () => runtime && void action("keeper triggers distribute_revenue", runtime.keeper, "distribute_revenue", (rt) => rt.distribute());

  useCommands(
    () => [
      {
        id: "treasury-revenue",
        group: "Treasury",
        title: "Customer pays 10 Ⓝ",
        subtitle: "deposit_revenue from acme-robotics.testnet",
        icon: Plus,
        disabled: !runtime || busy !== null,
        disabledReason: "Busy",
        run: customerPays,
      },
      {
        id: "treasury-distribute",
        group: "Treasury",
        title: "Distribute profit",
        subtitle: "Keeper calls distribute_revenue (on-chain splits)",
        icon: Coins,
        tone: "primary",
        disabled: !runtime || busy !== null || !canDistribute,
        disabledReason: !canDistribute ? distributeBlocked : "Busy",
        run: distribute,
      },
    ],
    [runtime, busy, canDistribute, distributeBlocked],
  );

  if (!runtime || !dashboard)
    return (
      <Card className="p-4 sm:p-5">
        <CardHeader icon={Landmark} eyebrow="Autonomous business · PnL · revenue splits" title="Treasury vault" />
        <div className="mt-5">
          <SkeletonBlock rows={9} />
        </div>
      </Card>
    );

  const t = dashboard.treasury;
  const disabled = busy !== null;
  const liquid = BigInt(t.liquid);
  const available = BigInt(t.available);
  const holdings = liquid + BigInt(t.reserved_for_tasks) + BigInt(t.escrow_locked) + BigInt(t.reserved_for_intents);
  const splitTone = (kind: string, i: number): ChartTone =>
    kind === "reserve" ? "amber" : kind === "operator" ? "sky" : kind === "investor" ? "violet" : i === 0 ? "emerald" : "violet";

  return (
    <Card className="flex h-full flex-col p-4 sm:p-5">
      <CardHeader
        icon={Landmark}
        eyebrow="Autonomous business · PnL · revenue splits"
        title="Treasury vault"
        actions={
          <>
            <Button size="sm" icon={Plus} disabled={disabled} onClick={customerPays}>
              Customer pays 10 Ⓝ
            </Button>
            {canDistribute ? (
              <Button size="sm" variant="primary" icon={Coins} disabled={disabled} onClick={distribute}>
                Distribute profit
              </Button>
            ) : (
              <Tooltip content={distributeBlocked}>
                {/* A disabled button takes no focus: the wrapper lets keyboard users read why. */}
                <span tabIndex={0}>
                  <Button size="sm" variant="primary" icon={Coins} disabled>
                    Distribute profit
                  </Button>
                </span>
              </Tooltip>
            )}
          </>
        }
      />

      <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <Label>Total holdings</Label>
          <div className="mt-1 flex items-baseline gap-2">
            <AnimatedNumber value={toNear(holdings)} className="text-[30px] font-semibold tracking-tight text-white" />
            <span className="text-[15px] text-slate-500">Ⓝ</span>
          </div>
          <p className="text-[12px] text-slate-500">
            liquid <span className="num text-slate-300">{nearFmt(liquid)}</span> · account balance{" "}
            <span className="num text-slate-300">{nearFmt(t.account_balance)}</span>
          </p>
          <div className="mt-4">
            <Allocation
              parts={[
                { label: "Available", value: available, tone: "emerald" },
                { label: "Operating reserve", value: liquid - available, tone: "slate" },
                { label: "Task budgets", value: BigInt(t.reserved_for_tasks), tone: "sky" },
                { label: "Escrow locked", value: BigInt(t.escrow_locked), tone: "violet" },
                { label: "Intent reserves", value: BigInt(t.reserved_for_intents), tone: "amber" },
              ]}
            />
          </div>
        </div>

        <div className="min-w-0 rounded-xl border border-white/[0.06] bg-black/20 p-4">
          <Label className="mb-1">Profit & loss</Label>
          <Line label="Revenue" value={`+${nearFmt(t.total_revenue)}`} tone="plus" />
          <Line label="Agent earnings + vendor payments" value={`−${nearFmt(t.total_operating_costs)}`} tone="minus" />
          <Line label="Net profit" value={nearFmt(t.net_profit)} strong />
          <Line label="Distributed" value={nearFmt(t.total_distributed)} />
          <Line label="Retained (reserve)" value={nearFmt(t.total_retained)} />
          <Line label="Distributable now" value={nearFmt(t.distributable_profit)} />
          <div className="num mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-white/[0.05] pt-2 text-[11px] text-slate-500">
            <span>capital in {nearFmt(t.total_capital_in)}</span>
            <span>deployed {nearFmt(t.total_deployed_capital)}</span>
          </div>
          <div className="num mt-1 flex flex-wrap justify-between gap-x-4 gap-y-1 text-[11px] text-slate-500">
            <span title="Agent earnings held by the contract until the agent spends or withdraws them">owed to agents {nearFmt(t.agent_balances)}</span>
            <span title="Gas allowances of contract-account agent keys, booked as obligations">gas allowances {nearFmt(t.contract_key_allowances)}</span>
            <span className={t.unbacked_liquidity === "0" ? "text-emerald-300/80" : "text-red-300"}>
              {t.unbacked_liquidity === "0" ? "fully backed" : `unbacked ${nearFmt(t.unbacked_liquidity)}`}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 border-t border-white/[0.06] pt-5 lg:grid-cols-[auto_minmax(0,1fr)]">
        <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
          <Donut segments={dashboard.revenue_splits.map((s, i) => ({ label: s.label, value: s.bps, tone: splitTone(s.kind, i) }))}>
            <div>
              <div className="num text-[17px] font-semibold text-white">{dashboard.revenue_splits.reduce((n, s) => n + s.bps, 0) / 100}%</div>
              <div className="text-[10.5px] text-slate-500">on-chain bps</div>
            </div>
          </Donut>
          <ul className="w-full space-y-2.5 min-[380px]:w-auto min-[380px]:flex-1">
            {dashboard.revenue_splits.map((s, i) => (
              <li key={s.label} className="min-w-0">
                <div className="flex items-center gap-2 text-[12.5px]">
                  <span className="size-2 rounded-sm" style={{ background: toneHex[splitTone(s.kind, i)] }} aria-hidden />
                  <span className="text-slate-200">{s.label}</span>
                  <span className="num ml-auto pl-3 text-slate-100">{s.bps / 100}%</span>
                </div>
                <div className="num pl-4 text-[11px] text-slate-500" title={s.account_id}>
                  {short(s.account_id, 22, 0)}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="min-w-0">
          <Label className="mb-2">Distributions</Label>
          {dashboard.distributions.length === 0 ? (
            <p className="rounded-lg border border-dashed border-white/[0.08] p-3 text-[12px] text-slate-500">
              No distributions yet. Profit is split by the contract when a keeper calls distribute_revenue.
            </p>
          ) : (
            <ul className="space-y-2">
              {dashboard.distributions.map((d) => (
                <li key={d.distribution_id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-[12px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-slate-200">
                      <Banknote className="size-3.5 text-emerald-300" aria-hidden />
                      Distribution #{d.distribution_id}
                    </span>
                    <span className="num font-medium text-white">{nearFmt(d.total)}</span>
                  </div>
                  <div className="num mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
                    {d.payouts.map((p) => (
                      <span key={p.account_id}>
                        {p.label} {nearFmt(p.amount)}
                      </span>
                    ))}
                    <span>retained {nearFmt(d.retained)}</span>
                    {d.failed !== "0" && <span className="text-red-300">bounced {nearFmt(d.failed)}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

export function DaoExport() {
  const { runtime, dashboard, busy } = useAegis();
  const action = useAction();
  const [kind, setKind] = useState<ProposalKind>("revoke");
  const [view, setView] = useState<"json" | "cli">("json");
  const [executed, setExecuted] = useState<string | null>(null);

  const proposal = useMemo(() => {
    if (!runtime || !dashboard) return null;
    if (kind === "distribute")
      return runtime.daoProposal(
        "distribute_revenue",
        {},
        `Distribute PhalanxSwarm ${quarterLabel(runtime.nowNs())} profit according to on-chain revenue splits`,
      );
    if (kind === "revoke")
      return runtime.daoProposal(
        "revoke_agent",
        { agent_id: runtime.agents.mallory.accountId },
        "Permanently revoke mallory-ap-agent after the invoice-fraud incident",
      );
    return runtime.daoProposal(
      "set_revenue_splits",
      { splits: dashboard.revenue_splits },
      `Re-affirm revenue splits (${dashboard.revenue_splits.map((s) => `${s.label} ${s.bps / 100}%`).join(" / ")})`,
    );
  }, [runtime, dashboard, kind]);

  const executeAsDao = async () => {
    if (!runtime) return;
    setExecuted(null);
    if (kind === "distribute") {
      const r = await action("DAO owner executes distribute_revenue", runtime.owner, "distribute_revenue", (rt) => rt.distribute());
      if (r?.ok) setExecuted(`Distributed ${nearFmt(r.value?.total ?? "0")} to DAO / operators / reserve`);
      return;
    }
    if (kind === "revoke") {
      const r = await action("DAO owner executes revoke_agent(mallory)", runtime.owner, "revoke_agent", (rt) =>
        rt.contract.call(rt.owner, "revoke_agent", { agent_id: rt.agents.mallory.accountId }, null),
      );
      if (r?.ok) setExecuted("Mallory permanently revoked by the DAO owner");
      return;
    }
    const r = await action("DAO owner executes set_revenue_splits", runtime.owner, "set_revenue_splits", (rt) =>
      rt.contract.call(rt.owner, "set_revenue_splits", { splits: dashboard!.revenue_splits }, null),
    );
    if (r?.ok) setExecuted("Revenue splits re-affirmed on-chain");
  };

  return (
    <Card className="flex h-full flex-col p-4 sm:p-5">
      <CardHeader
        icon={Vote}
        eyebrow="Governance · propose → vote → execute"
        title="SputnikDAO / Trezu control plane"
        description={
          <>
            Owner is the DAO (<span className="num text-slate-300">{ACCOUNTS.owner}</span> in the sandbox). Export the <span className="num">add_proposal</span>{" "}
            payload, then execute the same call here as the DAO owner. The testnet DAO&apos;s real proposals and votes are listed in{" "}
            <a href="#onchain" className="text-sky-300 hover:text-sky-200">
              On-chain
            </a>
            .
          </>
        }
      />
      <ol className="mt-3 grid grid-cols-3 gap-2 text-center text-[10.5px] uppercase tracking-[0.12em] text-slate-500">
        {["1 · Propose", "2 · Vote", "3 · Execute"].map((label) => (
          <li key={label} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-2 text-slate-300">
            {label}
          </li>
        ))}
      </ol>
      <div className="mt-4">
        <SegmentedControl<ProposalKind>
          label="Proposal"
          value={kind}
          onChange={setKind}
          size="sm"
          options={[
            { value: "revoke", label: "Revoke", hint: "revoke_agent(mallory) after fraud" },
            { value: "distribute", label: "Distribute", hint: "distribute_revenue" },
            { value: "splits", label: "Splits", hint: "set_revenue_splits" },
          ]}
          className="max-w-full"
        />
      </div>
      {!proposal ? (
        <div className="mt-4">
          <SkeletonBlock rows={6} />
        </div>
      ) : (
        <>
          <CodeBlock
            className="mt-3 flex-1"
            label="DAO proposal payload"
            title={
              <span className="flex items-center gap-1">
                {(
                  [
                    ["json", "args.json", FileJson],
                    ["cli", "near-cli", SquareTerminal],
                  ] as const
                ).map(([v, label, Icon]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setView(v)}
                    aria-pressed={view === v}
                    className={cx(
                      "touch-target flex items-center gap-1 rounded px-2 py-1 transition",
                      view === v ? "bg-white/[0.08] text-slate-100" : "text-slate-500 hover:text-slate-300",
                    )}
                  >
                    <Icon className="size-3" aria-hidden />
                    {label}
                  </button>
                ))}
              </span>
            }
            actions={
              <CopyButton
                text={view === "json" ? JSON.stringify(proposal.args) : proposal.cli}
                label={view === "json" ? "Copy args JSON" : "Copy near-cli command"}
                iconOnly
              />
            }
            json={view === "json" ? JSON.stringify(proposal.args, null, 2) : undefined}
          >
            {view === "cli" ? <span className="whitespace-pre-wrap break-all text-slate-300">{proposal.cli}</span> : null}
          </CodeBlock>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" icon={Vote} disabled={!runtime || busy !== null} onClick={() => void executeAsDao()}>
              Execute as DAO owner
            </Button>
            <CopyButton text={JSON.stringify(proposal.args)} label="Copy args JSON" />
            <CopyButton text={proposal.cli} label="Copy near-cli command" />
            <Badge tone="slate" className="ml-auto">
              bond {nearFmt(proposal.attachedDeposit, 0)}
            </Badge>
          </div>
          {executed && (
            <p className="mt-2 text-[12px] text-emerald-300">
              <BadgeCheck className="mr-1 inline size-3.5" aria-hidden />
              {executed}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

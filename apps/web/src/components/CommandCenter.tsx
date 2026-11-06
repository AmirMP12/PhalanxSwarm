"use client";

import { MotionConfig } from "framer-motion";
import { ArrowRightLeft, Compass, FlaskConical, Landmark, Network, RadioTower, ScrollText, ShieldCheck } from "lucide-react";

import { AegisProvider, useAegis } from "@/lib/aegis-context";
import { useLiveDeployment } from "@/lib/live-deployment";

import { ActivityFeed } from "./ActivityFeed";
import { CoordinationMarket } from "./CoordinationMarket";
import { IntentLedger, IntentTerminal } from "./IntentTerminal";
import { LiveDeployment } from "./LiveDeployment";
import { LiveProofs } from "./LiveProofs";
import { MarketSimulation } from "./MarketSimulation";
import { OverviewHero } from "./OverviewHero";
import { OverviewStats } from "./OverviewStats";
import { AgentControls, PolicyFirewall, SecurityEvents } from "./PolicyFirewall";
import { AppShell } from "./shell/AppShell";
import { CommandPalette } from "./shell/CommandPalette";
import { SwarmTopology } from "./SwarmTopology";
import { DaoExport, TreasuryVault } from "./TreasuryVault";
import { Badge, Label, Section, Toaster } from "./ui";

function SwarmMeta() {
  const { dashboard } = useAegis();
  if (!dashboard) return null;
  const active = dashboard.agents.filter((a) => a.status.kind === "active").length;
  return (
    <Badge tone={active === dashboard.agents.length ? "emerald" : "amber"} dot>
      <span className="num">
        {active}/{dashboard.agents.length} active
      </span>
    </Badge>
  );
}

/** Marks a section whose data comes from the in-tab sandbox, with a way to the real deployment. */
function SandboxTag() {
  return (
    <span className="flex items-center gap-2 text-[11.5px]">
      <Badge tone="slate" icon={FlaskConical}>
        AegisSim sandbox
      </Badge>
      <a href="#onchain" className="text-sky-300 hover:text-sky-200">
        testnet state →
      </a>
    </span>
  );
}

function LiveMeta() {
  const live = useLiveDeployment();
  const s = live.snapshot;
  if (live.status === "error" && !s) return <Badge tone="red">RPC unreachable</Badge>;
  if (!s) return <Badge tone="slate">reading…</Badge>;
  return (
    <Badge tone={s.dashboard.paused ? "red" : "emerald"} dot>
      <span className="num">
        v{s.dashboard.info.version} · block #{s.dashboard.block_height}
      </span>
    </Badge>
  );
}

/** Where the guided demo ends and the full command center begins. */
function ExploreDivider() {
  return (
    <div aria-labelledby="explore-title" role="note" className="min-w-0 space-y-2">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-gradient-to-r from-transparent to-white/15" aria-hidden />
        <span id="explore-title" className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          <Compass className="size-3.5" aria-hidden /> Explore
        </span>
        <span className="h-px flex-1 bg-gradient-to-l from-transparent to-white/15" aria-hidden />
      </div>
      <p className="text-center text-[12.5px] text-slate-500">
        Everything behind the demo: the live testnet deployment, the swarm market, treasury accounting, the policy engine, cross-chain settlement and every
        transaction this tab sent.
      </p>
    </div>
  );
}

function Page() {
  return (
    <AppShell>
      <section id="overview" aria-label="Guided demo" className="min-w-0 space-y-4">
        <OverviewHero />
        <div id="live-proofs" className="scroll-mt-24 lg:scroll-mt-28">
          <LiveProofs />
        </div>
      </section>

      <ExploreDivider />

      <section id="sandbox-state" aria-label="Sandbox state" className="min-w-0 space-y-3 scroll-mt-24 lg:scroll-mt-28">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>Sandbox state in this tab (AegisSim)</Label>
          <a href="#onchain" className="text-[12px] text-sky-300 hover:text-sky-200">
            Live testnet state →
          </a>
        </div>
        <OverviewStats />
      </section>

      <Section
        id="onchain"
        icon={RadioTower}
        title="Live on NEAR testnet"
        description="The DAO-owned deployment, read from the chain in this tab: code, keys, agents, recipients, settlements, security log, treasury, governance and proofs."
        meta={<LiveMeta />}
      >
        <LiveDeployment />
      </Section>

      <Section
        id="swarm"
        icon={Network}
        title="Agent swarm"
        description="Four agents and one unvetted third party on scoped FunctionCall keys, hiring each other through RFPs and paid into on-chain balances."
        meta={
          <>
            <SandboxTag />
            <SwarmMeta />
          </>
        }
      >
        <div id="swarm-topology" className="scroll-mt-24 lg:scroll-mt-28">
          <SwarmTopology />
        </div>
        <div id="coordination-market" className="scroll-mt-24 lg:scroll-mt-28">
          <CoordinationMarket />
        </div>
        <div id="market-simulation" className="scroll-mt-24 lg:scroll-mt-28">
          <MarketSimulation />
        </div>
      </Section>

      <Section
        id="treasury"
        icon={Landmark}
        title="Treasury"
        description="Revenue vs. capital accounting, programmable on-chain splits and DAO-ready governance payloads."
        meta={<SandboxTag />}
      >
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div id="treasury-vault" className="h-full scroll-mt-24 lg:scroll-mt-28">
            <TreasuryVault />
          </div>
          <div id="dao-export" className="h-full scroll-mt-24 lg:scroll-mt-28">
            <DaoExport />
          </div>
        </div>
      </Section>

      <Section
        id="policy"
        icon={ShieldCheck}
        title="Security"
        description="On-chain policy engine: per-payment, epoch and velocity limits, approved recipients, the shared blocklist, price floors, EVM caps, circuit breaker and kill switch."
        meta={<SandboxTag />}
      >
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div id="policy-firewall" className="h-full scroll-mt-24 lg:scroll-mt-28">
            <PolicyFirewall />
          </div>
          <div id="security-events" className="h-full scroll-mt-24 lg:scroll-mt-28">
            <SecurityEvents />
          </div>
        </div>
        <div id="agent-controls" className="scroll-mt-24 lg:scroll-mt-28">
          <AgentControls />
        </div>
      </Section>

      <Section
        id="intents"
        icon={ArrowRightLeft}
        title="Cross-chain settlement"
        description="Rehearsed cross-chain rebalances (1Click dry quotes, NEP-413, Sentinel audit, Chain Signatures) and the real payments: NEAR vendor transfers and MPC-signed EVM transactions."
        meta={<SandboxTag />}
      >
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
          <div id="intent-terminal" className="h-full scroll-mt-24 lg:scroll-mt-28">
            <IntentTerminal />
          </div>
          <div id="intent-ledger" className="h-full scroll-mt-24 lg:scroll-mt-28">
            <IntentLedger />
          </div>
        </div>
      </Section>

      <Section
        id="activity"
        icon={ScrollText}
        title="Activity"
        description="Every transaction this tab sent to the sandbox contract, with receipts and NEP-297 events."
      >
        <div id="activity-feed" className="scroll-mt-24 lg:scroll-mt-28">
          <ActivityFeed />
        </div>
      </Section>
    </AppShell>
  );
}

export function CommandCenter() {
  return (
    <AegisProvider>
      <MotionConfig reducedMotion="user">
        <Page />
        <CommandPalette />
        <Toaster />
      </MotionConfig>
    </AegisProvider>
  );
}

"use client";

import {
  ArrowRightLeft,
  CheckCircle2,
  Cpu,
  FileCheck2,
  FileCode2,
  Fingerprint,
  FlaskConical,
  Gauge,
  KeyRound,
  Landmark,
  LayoutDashboard,
  MousePointerClick,
  Network,
  RadioTower,
  Scale,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

export interface NavSubItem {
  id: string;
  label: string;
  href: string;
  icon?: LucideIcon;
  action?: "try" | "judge";
}

export interface NavSection {
  id: "overview" | "onchain" | "swarm" | "treasury" | "policy" | "intents" | "activity";
  label: string;
  icon: LucideIcon;
  /** `start`: the guided demo. `explore`: everything behind it. */
  group: "start" | "explore";
  subItems?: NavSubItem[];
}

export const SECTIONS: NavSection[] = [
  {
    id: "overview",
    label: "Guided demo",
    icon: LayoutDashboard,
    group: "start",
    subItems: [
      { id: "demo-try", label: "3-Step Walkthrough", href: "#overview", icon: MousePointerClick, action: "try" },
      { id: "demo-judge", label: "Judge Scenario (11 steps)", href: "#overview", icon: FlaskConical, action: "judge" },
      { id: "live-proofs", label: "Live Proofs", href: "#live-proofs", icon: FileCheck2 },
      { id: "sandbox-state", label: "Sandbox State", href: "#sandbox-state", icon: Gauge },
    ],
  },
  {
    id: "onchain",
    label: "On-chain",
    icon: RadioTower,
    group: "explore",
    subItems: [
      { id: "onchain-deployment", label: "Testnet Contract & Keys", href: "#onchain", icon: KeyRound },
      { id: "onchain-preflight", label: "Recipient Pre-flight", href: "#onchain-preflight", icon: ShieldCheck },
      { id: "onchain-history", label: "Execution & Audit Log", href: "#onchain-history", icon: FileCode2 },
    ],
  },
  {
    id: "swarm",
    label: "Agent swarm",
    icon: Network,
    group: "explore",
    subItems: [
      { id: "swarm-topology", label: "Swarm Topology", href: "#swarm-topology", icon: Cpu },
      { id: "swarm-tee", label: "Model Keys & TEE Evidence", href: "#model-tee-evidence", icon: Fingerprint },
      { id: "swarm-market", label: "Coordination Market", href: "#coordination-market", icon: Scale },
      { id: "swarm-sim", label: "Market Simulation", href: "#market-simulation", icon: TrendingUp },
    ],
  },
  {
    id: "treasury",
    label: "Treasury",
    icon: Landmark,
    group: "explore",
    subItems: [
      { id: "treasury-vault", label: "Treasury Vault", href: "#treasury-vault", icon: Landmark },
      { id: "treasury-dao", label: "DAO Export & Governance", href: "#dao-export", icon: FileCode2 },
    ],
  },
  {
    id: "policy",
    label: "Security",
    icon: ShieldCheck,
    group: "explore",
    subItems: [
      { id: "policy-firewall", label: "Policy Firewall", href: "#policy-firewall", icon: ShieldCheck },
      { id: "policy-events", label: "Security Events Log", href: "#security-events", icon: ShieldAlert },
      { id: "policy-controls", label: "Agent Controls", href: "#agent-controls", icon: Sliders },
    ],
  },
  {
    id: "intents",
    label: "Settlement",
    icon: ArrowRightLeft,
    group: "explore",
    subItems: [
      { id: "intents-terminal", label: "Cross-chain Terminal", href: "#intent-terminal", icon: ArrowRightLeft },
      { id: "intents-ledger", label: "Settlement Ledger", href: "#intent-ledger", icon: ScrollText },
    ],
  },
  {
    id: "activity",
    label: "Activity",
    icon: ScrollText,
    group: "explore",
    subItems: [{ id: "activity-feed", label: "Transaction Feed & Receipts", href: "#activity-feed", icon: CheckCircle2 }],
  },
];

/** The section that crosses the upper third of the viewport. */
export function useScrollSpy(): NavSection["id"] {
  const [active, setActive] = useState<NavSection["id"]>("overview");
  useEffect(() => {
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => e !== null);
    const visible = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting);
        const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
        const first = atBottom ? SECTIONS[SECTIONS.length - 1] : SECTIONS.find((s) => visible.get(s.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return active;
}

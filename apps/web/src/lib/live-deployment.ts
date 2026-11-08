"use client";

/**
 * The live testnet deployment, read in this tab over public RPC (no key): `get_dashboard`, the
 * contract account (code hash, access keys), every sub-account agent's access keys, and the
 * owner SputnikDAO's policy and proposals. One shared store, so the section, the navigation
 * badge and the command palette show the same read.
 */
import { PhalanxViews, fromBase58, fromBase64, fromUtf8, toHex, type DashboardT } from "@phalanx/agent-swarm-sdk";
import { useSyncExternalStore } from "react";

import { currentRpcHost, FallbackRpcTransport, viewAccessKeys, viewAccount, viewFunction, type AccessKeyPermission } from "./near-rpc";
import { TESTNET_CONTRACT_ID } from "./wallet";

export interface KeyAudit {
  public_keys: string[];
  full_access: number;
  /** FunctionCall keys whose receiver is the PhalanxCore contract. */
  scoped: number;
}

export interface DaoProposal {
  id: number;
  proposer: string;
  description: string;
  status: string;
  kind: string;
  receiver: string | null;
  calls: Array<{ method: string; args: string }>;
  votes: Record<string, string>;
  submitted_at_ns: string;
}

export interface DaoState {
  id: string;
  council: string[];
  threshold: string;
  bond: string;
  proposals: DaoProposal[];
}

export interface LiveSnapshot {
  contractId: string;
  rpcHost: string;
  readAtMs: number;
  dashboard: DashboardT;
  /** sha256 of the deployed code, hex. `null` when the account has no code. */
  codeHashHex: string | null;
  storageUsage: number;
  contractKeys: KeyAudit;
  /** Sub-account agents only: a contract-account agent's key lives in `contractKeys`. */
  agentKeys: Record<string, KeyAudit>;
  /** `null` when the owner does not answer SputnikDAO views. */
  dao: DaoState | null;
}

export interface LiveState {
  contractId: string;
  status: "idle" | "loading" | "ready" | "error";
  snapshot: LiveSnapshot | null;
  error: string | null;
}

const STORAGE_KEY = "phalanx-testnet-contract";
const INITIAL: LiveState = { contractId: TESTNET_CONTRACT_ID, status: "idle", snapshot: null, error: null };

let state: LiveState = INITIAL;
let seq = 0;
const listeners = new Set<() => void>();

function set(next: Partial<LiveState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function audit(keys: Array<{ public_key: string; permission: AccessKeyPermission }>, contractId: string): KeyAudit {
  return {
    public_keys: keys.map((k) => k.public_key),
    full_access: keys.filter((k) => k.permission === "FullAccess").length,
    scoped: keys.filter((k) => typeof k.permission === "object" && k.permission.FunctionCall.receiver_id === contractId).length,
  };
}

function decodeArgs(b64: string): unknown {
  try {
    const text = fromUtf8(fromBase64(b64));
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } catch {
    return b64;
  }
}

function summarizeArgs(args: unknown): string {
  if (args && typeof args === "object" && "policy" in args) {
    const p = (args as { policy?: { unknown_recipient?: string; allowed_recipients?: unknown[] } }).policy;
    return `policy · unknown_recipient: ${p?.unknown_recipient ?? "quarantine"} · ${p?.allowed_recipients?.length ?? 0} approved recipients`;
  }
  const text = typeof args === "string" ? args : JSON.stringify(args);
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

interface SputnikPolicy {
  roles: Array<{ name: string; kind: unknown }>;
  default_vote_policy: { threshold: unknown };
  proposal_bond: string;
}

interface SputnikProposal {
  id: number;
  proposer: string;
  description: string;
  kind: unknown;
  status: string;
  votes: Record<string, string>;
  submission_time: string;
}

async function readDao(owner: string): Promise<DaoState | null> {
  let policy: SputnikPolicy;
  let last: number;
  try {
    [policy, last] = await Promise.all([viewFunction<SputnikPolicy>(owner, "get_policy"), viewFunction<number>(owner, "get_last_proposal_id")]);
  } catch {
    return null;
  }
  if (!policy || !Array.isArray(policy.roles) || typeof last !== "number") return null;
  const raw = last > 0 ? await viewFunction<SputnikProposal[]>(owner, "get_proposals", { from_index: Math.max(0, last - 20), limit: 20 }).catch(() => []) : [];
  const council = policy.roles.flatMap((r) => {
    const group = typeof r.kind === "object" && r.kind !== null && "Group" in r.kind ? (r.kind as { Group: unknown }).Group : null;
    return Array.isArray(group) ? group.filter((m): m is string => typeof m === "string") : [];
  });
  const t = policy.default_vote_policy?.threshold;
  const threshold = Array.isArray(t) && t.length === 2 ? `${t[0]}/${t[1]} of the council` : `${String(t)} votes`;
  const proposals = raw
    .map<DaoProposal>((p) => {
      const kindName = typeof p.kind === "string" ? p.kind : (Object.keys(p.kind as object)[0] ?? "unknown");
      const fc =
        typeof p.kind === "object" && p.kind !== null && "FunctionCall" in p.kind
          ? (p.kind as { FunctionCall: { receiver_id: string; actions: Array<{ method_name: string; args: string }> } }).FunctionCall
          : null;
      return {
        id: p.id,
        proposer: p.proposer,
        description: p.description,
        status: p.status,
        kind: kindName,
        receiver: fc?.receiver_id ?? null,
        calls: fc?.actions.map((a) => ({ method: a.method_name, args: summarizeArgs(decodeArgs(a.args)) })) ?? [],
        votes: p.votes ?? {},
        submitted_at_ns: String(p.submission_time),
      };
    })
    .reverse();
  return { id: owner, council: [...new Set(council)], threshold, bond: String(policy.proposal_bond), proposals };
}

async function readDeployment(contractId: string): Promise<LiveSnapshot> {
  const info = await viewFunction<{ version?: unknown } | null>(contractId, "contract_info");
  const version = typeof info?.version === "string" ? info.version : "unknown";
  if (!version.startsWith("2.")) throw new Error(`${contractId} runs PhalanxCore ${version}; this page reads v2.2. Deploy v2.2 with pnpm testnet:swarm.`);
  const views = new PhalanxViews(new FallbackRpcTransport(contractId));
  const [dashboard, account, keys] = await Promise.all([
    views.dashboard().catch((e: unknown) => {
      const issue = (e as { name?: string; issues?: Array<{ path?: unknown[]; message?: string }> }) ?? {};
      if (issue.name === "ZodError" && issue.issues?.[0]) {
        throw new Error(
          `get_dashboard of v${version} does not match the v2.2 schema this page reads (${issue.issues[0].path?.join(".")}: ${issue.issues[0].message})`,
        );
      }
      throw e;
    }),
    viewAccount(contractId),
    viewAccessKeys(contractId),
  ]);
  const subAccounts = dashboard.agents.filter((a) => a.spawn_mode === "sub_account");
  const [agentKeyLists, dao] = await Promise.all([
    Promise.all(subAccounts.map((a) => viewAccessKeys(a.agent_id).catch(() => []))),
    readDao(dashboard.owner_id),
  ]);
  const code = toHex(fromBase58(account.code_hash));
  return {
    contractId,
    rpcHost: currentRpcHost(),
    readAtMs: Date.now(),
    dashboard,
    codeHashHex: /^0+$/.test(code) ? null : code,
    storageUsage: account.storage_usage,
    contractKeys: audit(keys, contractId),
    agentKeys: Object.fromEntries(subAccounts.map((a, i) => [a.agent_id, audit(agentKeyLists[i] ?? [], contractId)])),
    dao,
  };
}

/** Reads `contractId` (default: the current one). Concurrent reads: the newest wins. */
export async function loadLive(contractId: string = state.contractId): Promise<void> {
  const id = contractId.trim();
  const mine = ++seq;
  if (!id) {
    set({ contractId: id, status: "idle", snapshot: null, error: null });
    return;
  }
  set({ contractId: id, status: "loading", error: null, snapshot: state.snapshot?.contractId === id ? state.snapshot : null });
  try {
    const snapshot = await readDeployment(id);
    if (mine === seq) set({ status: "ready", snapshot, error: null });
  } catch (e) {
    if (mine === seq) set({ status: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

/** First read on mount. Without a build-time contract id, the last one entered in this browser. */
export function startLive(): void {
  if (state.status !== "idle" || seq > 0) return;
  let id = state.contractId;
  if (!id) {
    try {
      id = localStorage.getItem(STORAGE_KEY) ?? "";
    } catch {
      id = "";
    }
  }
  if (id) void loadLive(id);
  else set({ contractId: "" });
}

export function setLiveContract(contractId: string): void {
  const id = contractId.trim();
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage is optional (private mode).
  }
  void loadLive(id);
}

export function useLiveDeployment(): LiveState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => state,
    () => INITIAL,
  );
}

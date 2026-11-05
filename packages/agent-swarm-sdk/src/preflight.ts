/**
 * Agent-side pre-flight: ask the contract about a recipient before signing a payment, and, with a
 * history source, check the recipient's on-chain history too.
 *
 * The contract's answer is authoritative and enforced on-chain whether or not an agent asks:
 * - `allow`: sign and submit.
 * - `block`: refuse. The recipient is on the shared blocklist.
 * - `warn` (a new recipient): never pay it on the agent's own judgment. Under the DAO's `hold` rule,
 *   submit the settlement so it waits for DAO approval; under `quarantine`, ask the DAO to
 *   allow-list it first, because paying it would cost the agent its key.
 *
 * History signals are advisory and can only make the answer stricter: account age (first
 * transaction), activity (transaction count), whether the recipient is a contract and whether its
 * code changed recently, and prior payments from this treasury. An allow-listed recipient with a
 * risk signal (a new account, a recent code change, an account that does not exist) becomes `warn`,
 * and the agent asks the DAO to confirm instead of signing.
 *
 * Data sources: NEAR JSON-RPC `view_account` for existence and code hash, the archival RPC for the
 * code hash some days ago, FastNEAR's transaction API (`tx.<network>.fastnear.com/v0/account`) for
 * account history, Ethereum JSON-RPC for EVM addresses, and the contract's own settlement records
 * for prior payments.
 */
import type { AegisViews } from "./contract-client.ts";
import { EVM_CHAINS } from "./evm.ts";
import type { RecipientCheckT } from "./types.ts";

export type PreflightAction = "sign" | "submit_for_dao_approval" | "ask_dao_to_allow_list" | "ask_dao_to_confirm" | "refuse";

export interface HistorySignal {
  id: "account_missing" | "account_age" | "activity" | "contract" | "code_changed" | "prior_payments" | "unavailable";
  /** `risk` turns an allow-listed recipient into `warn`; `info` only explains. */
  level: "info" | "risk";
  detail: string;
}

/** Where pre-flight looks up a recipient's history. Any part may be missing; signals then say so. */
export interface HistorySource {
  near(accountId: string): Promise<HistorySignal[]>;
  evm?(chain: string, address: string): Promise<HistorySignal[]>;
}

export interface PreflightDecision {
  action: PreflightAction;
  check: RecipientCheckT;
  /** The answer after history signals: as strict as the contract's, or stricter. */
  verdict: "allow" | "warn" | "block";
  /** History signals (empty without a history source). */
  signals: HistorySignal[];
  /** One line for a log or a human reviewer. */
  summary: string;
}

export interface PreflightOptions {
  /** Recipient history lookups; without it only the contract is asked. */
  history?: HistorySource;
  /** Count settled payments from this treasury to the recipient (contract records, last 50). Default: with `history`. */
  priorPayments?: boolean;
}

const risks = (signals: HistorySignal[]) => signals.filter((s) => s.level === "risk");
const detailList = (signals: HistorySignal[]) => signals.map((s) => s.detail).join("; ");

/** The decision for a `check_recipient` answer and optional history signals. */
export function decidePreflight(check: RecipientCheckT, signals: HistorySignal[] = []): PreflightDecision {
  const target = `${check.chain}:${check.recipient}`;
  const extra = signals.length ? ` | history: ${detailList(signals)}` : "";
  if (check.verdict === "block") {
    return { action: "refuse", check, verdict: "block", signals, summary: `block ${target}: ${check.reasons.join("; ")}${extra}` };
  }
  if (check.verdict === "allow") {
    const flagged = risks(signals);
    if (flagged.length === 0) {
      return { action: "sign", check, verdict: "allow", signals, summary: `allow ${target}: ${check.reasons.join("; ")}${extra}` };
    }
    return {
      action: "ask_dao_to_confirm",
      check,
      verdict: "warn",
      signals,
      summary: `warn ${target}: allow-listed, but ${detailList(flagged)}; ask the DAO to confirm before paying`,
    };
  }
  return check.unknown_recipient === "hold"
    ? {
        action: "submit_for_dao_approval",
        check,
        verdict: "warn",
        signals,
        summary: `warn ${target}: new recipient, the settlement will wait for DAO approval${extra}`,
      }
    : {
        action: "ask_dao_to_allow_list",
        check,
        verdict: "warn",
        signals,
        summary: `warn ${target}: new recipient; paying it would quarantine this agent, so ask the DAO to allow-list it${extra}`,
      };
}

/** Settled payments from this treasury to the recipient, from the contract's recent records. */
export async function priorPaymentSignal(views: AegisViews, chain: string, recipient: string): Promise<HistorySignal> {
  const target = recipient.toLowerCase();
  try {
    const [intents, evm] = await Promise.all([views.recentIntents(50), views.recentEvmTxs(50)]);
    const settled = intents.filter((i) => i.destination_chain === chain && i.recipient.toLowerCase() === target && i.status === "settled").length;
    const confirmed = evm.filter((t) => t.chain === chain && t.to.toLowerCase() === target && t.status === "confirmed" && t.kind === "transfer").length;
    const n = settled + confirmed;
    return {
      id: "prior_payments",
      level: "info",
      detail: n === 0 ? "no earlier payment from this treasury" : `${n} earlier payment${n === 1 ? "" : "s"} from this treasury`,
    };
  } catch (err) {
    return { id: "unavailable", level: "info", detail: `prior payments unavailable (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** Asks the contract (`check_recipient`), optionally checks the recipient's history, and decides what the agent may do. */
export async function preflightRecipient(views: AegisViews, chain: string, recipient: string, opts: PreflightOptions = {}): Promise<PreflightDecision> {
  const check = await views.checkRecipient(chain, recipient);
  const signals: HistorySignal[] = [];
  if (opts.history && check.verdict !== "block") {
    try {
      if (chain === "near") signals.push(...(await opts.history.near(recipient)));
      else if (opts.history.evm && recipient.startsWith("0x")) signals.push(...(await opts.history.evm(chain, recipient)));
    } catch (err) {
      signals.push({ id: "unavailable", level: "info", detail: `history unavailable (${err instanceof Error ? err.message : String(err)})` });
    }
  }
  if (opts.priorPayments ?? Boolean(opts.history)) signals.push(await priorPaymentSignal(views, chain, recipient));
  return decidePreflight(check, signals);
}

// History sources

const EMPTY_CODE_HASH = "11111111111111111111111111111111";
const DAY_MS = 86_400_000;

export interface NearHistoryOptions {
  network: "testnet" | "mainnet";
  rpcUrl?: string;
  archivalRpcUrl?: string;
  /** FastNEAR transaction API, `POST {account_id}` -> `{ account_txs, txs_count }`. */
  txApiUrl?: string;
  /** A recipient younger than this, or whose code changed within it, is a risk. Default 7. */
  recentDays?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

interface RpcAccount {
  exists: boolean;
  codeHash: string | null;
}

/** NEAR account history from public RPC and FastNEAR's transaction API. */
export function nearHistorySource(opts: NearHistoryOptions): HistorySource {
  const test = opts.network === "testnet";
  const rpcUrl = opts.rpcUrl ?? (test ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com");
  const archivalUrl = opts.archivalRpcUrl ?? (test ? "https://archival-rpc.testnet.fastnear.com" : "https://archival-rpc.mainnet.fastnear.com");
  const txApiUrl = opts.txApiUrl ?? (test ? "https://tx.test.fastnear.com/v0/account" : "https://tx.main.fastnear.com/v0/account");
  const recentDays = opts.recentDays ?? 7;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const nowMs = opts.nowMs ?? (() => Date.now());

  const post = async <T>(url: string, body: unknown): Promise<T> => {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  const rpc = async <T>(url: string, method: string, params: unknown): Promise<T> => {
    const body = await post<{ result?: T; error?: { cause?: { name?: string }; message?: string } }>(url, { jsonrpc: "2.0", id: "aegis", method, params });
    if (body.error) throw Object.assign(new Error(body.error.cause?.name ?? body.error.message ?? "RPC error"), { cause: body.error.cause?.name });
    return body.result as T;
  };
  const viewAccount = async (url: string, accountId: string, blockId?: number): Promise<RpcAccount> => {
    try {
      const params =
        blockId === undefined
          ? { request_type: "view_account", finality: "final", account_id: accountId }
          : { request_type: "view_account", block_id: blockId, account_id: accountId };
      const r = await rpc<{ code_hash: string }>(url, "query", params);
      return { exists: true, codeHash: r.code_hash };
    } catch (err) {
      if ((err as { cause?: unknown }).cause === "UNKNOWN_ACCOUNT" || String(err).includes("UNKNOWN_ACCOUNT")) return { exists: false, codeHash: null };
      throw err;
    }
  };
  /** Height of a block about `days` ago, from the current block rate. */
  const heightDaysAgo = async (days: number): Promise<number> => {
    const head = await rpc<{ header: { height: number; timestamp: number } }>(archivalUrl, "block", { finality: "final" });
    const sampleSpan = 10_000;
    const sample = await rpc<{ header: { height: number; timestamp: number } }>(archivalUrl, "block", { block_id: head.header.height - sampleSpan });
    const msPerBlock = (head.header.timestamp - sample.header.timestamp) / 1e6 / (head.header.height - sample.header.height);
    return Math.max(1, Math.round(head.header.height - (days * DAY_MS) / Math.max(msPerBlock, 1)));
  };
  const ago = (ms: number) => {
    if (ms < DAY_MS) return `${Math.max(1, Math.round(ms / 3_600_000))} h`;
    const days = Math.round(ms / DAY_MS);
    return `${days} day${days === 1 ? "" : "s"}`;
  };

  return {
    async near(accountId: string): Promise<HistorySignal[]> {
      const now = await viewAccount(rpcUrl, accountId);
      if (!now.exists)
        return [{ id: "account_missing", level: "risk", detail: `${accountId} does not exist on ${opts.network}; a transfer to it would bounce` }];
      const signals: HistorySignal[] = [];
      try {
        const h = await post<{ account_txs?: Array<{ tx_block_timestamp: string }>; txs_count?: number }>(txApiUrl, { account_id: accountId });
        const txs = h.account_txs ?? [];
        const count = h.txs_count ?? txs.length;
        const oldestNs = txs.reduce(
          (min, t) => (BigInt(t.tx_block_timestamp) < min ? BigInt(t.tx_block_timestamp) : min),
          BigInt(Number.MAX_SAFE_INTEGER) * 1_000_000n,
        );
        const complete = count <= txs.length;
        if (txs.length > 0) {
          const ageMs = nowMs() - Number(oldestNs / 1_000_000n);
          const young = complete && ageMs < recentDays * DAY_MS;
          signals.push({
            id: "account_age",
            level: young ? "risk" : "info",
            detail: `${complete ? "first seen" : "active for at least"} ${ago(ageMs)} ago${young ? " (new account)" : ""}`,
          });
        }
        signals.push({ id: "activity", level: "info", detail: `${count} transaction${count === 1 ? "" : "s"}` });
      } catch (err) {
        signals.push({ id: "unavailable", level: "info", detail: `account history unavailable (${err instanceof Error ? err.message : String(err)})` });
      }
      const isContract = Boolean(now.codeHash && now.codeHash !== EMPTY_CODE_HASH);
      if (!isContract) {
        signals.push({ id: "contract", level: "info", detail: "plain account, no contract code" });
        return signals;
      }
      try {
        const before = await viewAccount(archivalUrl, accountId, await heightDaysAgo(recentDays));
        if (before.exists && before.codeHash !== now.codeHash) {
          signals.push({
            id: "code_changed",
            level: "risk",
            detail: `contract code changed in the last ${recentDays} days (${(before.codeHash ?? "").slice(0, 8)}… -> ${(now.codeHash ?? "").slice(0, 8)}…)`,
          });
        } else {
          signals.push({
            id: "contract",
            level: "info",
            detail: before.exists ? `contract, code unchanged for ${recentDays} days` : "contract deployed recently",
          });
        }
      } catch (err) {
        signals.push({ id: "unavailable", level: "info", detail: `code history unavailable (${err instanceof Error ? err.message : String(err)})` });
      }
      return signals;
    },

    async evm(chain: string, address: string): Promise<HistorySignal[]> {
      const rpcUrl = EVM_CHAINS[chain]?.rpc;
      if (!rpcUrl) return [{ id: "unavailable", level: "info", detail: `no public RPC configured for ${chain}` }];
      const call = (method: string, params: unknown[]) => rpc<string>(rpcUrl, method, params);
      const [nonce, code] = await Promise.all([call("eth_getTransactionCount", [address, "latest"]), call("eth_getCode", [address, "latest"])]);
      const sent = Number(BigInt(nonce));
      const contract = code !== "0x" && code !== "0x0";
      return [
        { id: "activity", level: "info", detail: `${sent} transaction${sent === 1 ? "" : "s"} sent from ${address.slice(0, 10)}… on ${chain}` },
        { id: "contract", level: "info", detail: contract ? "an EVM contract" : "an externally owned account" },
      ];
    },
  };
}

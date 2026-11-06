/**
 * NEAR RPC helpers shared by the scripts (Node only). Credentials are read from files outside the
 * repository and never printed; agent keys created by a script are stored like near-cli stores
 * them (`~/.near-credentials/<network>/<account>.json`, mode 0600).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import {
  Account,
  actions,
  FailoverRpcProvider,
  getTransactionLastResult,
  JsonRpcProvider,
  KeyPairSigner,
  type Action,
  type KeyPairString,
  type Provider,
} from "near-api-js";

import type { Ed25519KeyPair } from "../../packages/agent-swarm-sdk/src/index.ts";

export type Network = "testnet" | "mainnet" | "sandbox";

export interface NetworkConfig {
  network: Network;
  /** RPC endpoints for transactions and recent state, tried in order. */
  rpc: string[];
  /** Archival endpoints: regular nodes drop transactions after about 2.5 days. */
  archival: string[];
  explorer: (hash: string) => string;
  accountExplorer: (accountId: string) => string;
  mpcContract: string | null;
  daoFactory: string | null;
}

export function networkConfig(network: Network = (process.env.AEGIS_NETWORK as Network | undefined) ?? "testnet"): NetworkConfig {
  const override = process.env.AEGIS_NEAR_RPC ? [process.env.AEGIS_NEAR_RPC] : null;
  switch (network) {
    case "testnet":
      return {
        network,
        rpc: override ?? ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
        archival: ["https://archival-rpc.testnet.near.org", "https://archival-rpc.testnet.fastnear.com"],
        explorer: (h) => `https://testnet.nearblocks.io/txns/${h}`,
        accountExplorer: (a) => `https://testnet.nearblocks.io/address/${a}`,
        mpcContract: "v1.signer-prod.testnet",
        daoFactory: "sputnikv2.testnet",
      };
    case "mainnet":
      return {
        network,
        rpc: override ?? ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"],
        archival: ["https://archival-rpc.mainnet.near.org", "https://archival-rpc.mainnet.fastnear.com"],
        explorer: (h) => `https://nearblocks.io/txns/${h}`,
        accountExplorer: (a) => `https://nearblocks.io/address/${a}`,
        mpcContract: "v1.signer",
        daoFactory: "sputnik-dao.near",
      };
    case "sandbox":
      return {
        network,
        rpc: override ?? ["http://127.0.0.1:3030"],
        archival: override ?? ["http://127.0.0.1:3030"],
        explorer: (h) => `sandbox-tx:${h}`,
        accountExplorer: (a) => `sandbox-account:${a}`,
        mpcContract: null,
        daoFactory: null,
      };
    default:
      throw new Error(`unknown AEGIS_NETWORK ${String(network)}`);
  }
}

export function providerFor(cfg: NetworkConfig): Provider {
  const list = cfg.rpc.map((url) => new JsonRpcProvider({ url }));
  return list.length === 1 ? list[0]! : new FailoverRpcProvider(list);
}

export interface Credential {
  account_id: string;
  public_key: string;
  private_key: string;
}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Loads a near-cli style credential from outside the repository. */
export function loadCredential(path: string | undefined, cfg: NetworkConfig, variable = "AEGIS_TESTNET_CREDENTIAL"): Credential {
  if (!path) throw new Error(`set ${variable} to a ${cfg.network} credential JSON outside this repository`);
  const abs = resolve(path);
  const rel = relative(REPO_ROOT, abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error(`refusing: ${variable} must point outside the repository`);
  const cred = JSON.parse(readFileSync(abs, "utf8")) as Credential;
  if (!cred.account_id || !cred.private_key) throw new Error(`${variable}: expected { account_id, public_key, private_key }`);
  if (cfg.network === "testnet" && !cred.account_id.endsWith(".testnet")) throw new Error("refusing: credential is not a .testnet account");
  if (cfg.network === "mainnet" && cred.account_id.endsWith(".testnet")) throw new Error("refusing: a .testnet credential cannot sign mainnet transactions");
  return cred;
}

export function accountFor(cfg: NetworkConfig, accountId: string, secretKey: string): Account {
  return new Account(accountId, providerFor(cfg), KeyPairSigner.fromSecretKey(secretKey as KeyPairString));
}

/** Stores a key the way near-cli does, so it can be reused by later scripts. Returns the path. */
export function saveCredential(cfg: NetworkConfig, accountId: string, key: Ed25519KeyPair): string {
  const dir = join(homedir(), ".near-credentials", cfg.network);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${accountId}.json`);
  writeFileSync(path, JSON.stringify({ account_id: accountId, public_key: key.publicKeyString, private_key: key.secretKeyString }) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore on systems without POSIX permissions */
  }
  return path;
}

export function storedCredential(cfg: NetworkConfig, accountId: string): Credential | null {
  const path = join(homedir(), ".near-credentials", cfg.network, `${accountId}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Credential) : null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** JSON-RPC with retries, falling back across `urls`. */
export async function rpcCall<T>(urls: string[], method: string, params: unknown, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "aegis", method, params }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`${url} ${method}: HTTP ${res.status}`);
        const body = (await res.json()) as { result?: T; error?: unknown };
        if (body.error !== undefined || body.result === undefined) throw new Error(`${url} ${method}: ${JSON.stringify(body.error ?? "no result")}`);
        return body.result;
      } catch (err) {
        last = err;
      }
    }
    if (i < attempts - 1) await sleep(1_000 * 2 ** i);
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function view<T>(urls: string[], accountId: string, method: string, args: unknown = {}): Promise<T> {
  const raw = await rpcCall<{ result: number[] }>(urls, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: accountId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(raw.result).toString()) as T;
}

export interface AccessKeyEntry {
  public_key: string;
  access_key: { permission: "FullAccess" | { FunctionCall: { receiver_id: string; method_names: string[]; allowance: string | null } } };
}

export async function accessKeys(urls: string[], accountId: string): Promise<AccessKeyEntry[]> {
  const r = await rpcCall<{ keys: AccessKeyEntry[] }>(urls, "query", { request_type: "view_access_key_list", finality: "final", account_id: accountId });
  return r.keys;
}

export async function accountBalance(urls: string[], accountId: string): Promise<bigint> {
  const r = await rpcCall<{ amount: string }>(urls, "query", { request_type: "view_account", finality: "final", account_id: accountId });
  return BigInt(r.amount);
}

export async function accountExists(urls: string[], accountId: string): Promise<boolean> {
  try {
    await rpcCall<unknown>(urls, "query", { request_type: "view_account", finality: "final", account_id: accountId }, 3);
    return true;
  } catch (err) {
    if (String(err).includes("UNKNOWN_ACCOUNT") || String(err).includes("does not exist")) return false;
    throw err;
  }
}

export async function codeHash(urls: string[], accountId: string): Promise<Uint8Array> {
  const r = await rpcCall<{ code_base64: string }>(urls, "query", { request_type: "view_code", finality: "final", account_id: accountId });
  return Uint8Array.from(Buffer.from(r.code_base64, "base64"));
}

export interface TxResult {
  final_execution_status?: string;
  status: Record<string, unknown>;
  transaction: { hash: string; signer_id: string; receiver_id: string };
  receipts_outcome: Array<{
    id: string;
    outcome: { executor_id: string; logs: string[]; status: Record<string, unknown>; gas_burnt?: number };
  }>;
}

/** Transaction status from archival nodes (old transactions are gone from regular RPC). */
export function txStatus(cfg: NetworkConfig, hash: string, sender: string): Promise<TxResult> {
  return rpcCall<TxResult>(cfg.archival, "tx", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" });
}

export interface NepEvent {
  standard: string;
  event: string;
  data: Record<string, unknown>;
}

export function eventsOf(tx: Pick<TxResult, "receipts_outcome">): NepEvent[] {
  return tx.receipts_outcome
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)) as NepEvent);
}

export interface Sent<T> {
  hash: string;
  ok: boolean;
  value: T | null;
  error: string | null;
  failedReceipts: number;
  events: NepEvent[];
  burntTgas: number;
}

function failureText(status: Record<string, unknown>): string | null {
  return "Failure" in status ? JSON.stringify(status.Failure).slice(0, 600) : null;
}

/** Sends one transaction and summarises it (never throws on a contract-level failure). */
export async function send<T = unknown>(account: Account, receiverId: string, txActions: Action[]): Promise<Sent<T>> {
  const r = (await account.signAndSendTransaction({ receiverId, actions: txActions, waitUntil: "FINAL", throwOnFailure: false })) as unknown as TxResult & {
    transaction_outcome?: { outcome: { gas_burnt: number } };
    receipts_outcome: Array<{ outcome: { gas_burnt?: number } }>;
  };
  const error = failureText(r.status);
  let value: T | null = null;
  if (!error) {
    try {
      value = getTransactionLastResult(r as never) as T;
    } catch {
      value = null;
    }
  }
  const burnt = (r.transaction_outcome?.outcome.gas_burnt ?? 0) + r.receipts_outcome.reduce((n, o) => n + (o.outcome.gas_burnt ?? 0), 0);
  return {
    hash: r.transaction.hash,
    ok: !error,
    value,
    error,
    failedReceipts: r.receipts_outcome.filter((o) => "Failure" in o.outcome.status).length,
    events: eventsOf(r),
    burntTgas: Math.round(burnt / 1e12),
  };
}

export const TGAS = 10n ** 12n;

/** `true` when a contract version (`major.minor.patch`) is at least `major.minor`. */
export function versionAtLeast(version: string, major: number, minor: number): boolean {
  const [a = 0, b = 0] = version.split(".").map(Number);
  return a > major || (a === major && b >= minor);
}

export function call(method: string, args: object, tgas = 150n, deposit = 0n) {
  return actions.functionCall(method, args, tgas * TGAS, deposit);
}

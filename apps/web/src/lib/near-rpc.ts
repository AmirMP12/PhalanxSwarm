"use client";

/**
 * Read-only NEAR JSON-RPC with endpoint fallback, for the live deployment view.
 *
 * The near.org endpoints are deprecated and rate limited (docs.near.org/api/rpc/providers), so the
 * default order is FastNEAR first, then near.org. Any other `NEXT_PUBLIC_NEAR_RPC_URL` goes first.
 * Only transport failures (network error, timeout, HTTP 408/429/5xx) move on to the next endpoint;
 * a JSON-RPC or contract error is an answer and is thrown as is.
 */
import { fromUtf8, toBase64, utf8, type AegisTransport } from "@aegis/agent-swarm-sdk";

/** `testnet` unless the build sets exactly `mainnet`: an empty or mistyped value used to leave no RPC endpoint at all. */
export const NETWORK: "testnet" | "mainnet" = process.env.NEXT_PUBLIC_NEAR_NETWORK?.trim() === "mainnet" ? "mainnet" : "testnet";

const DEFAULT_RPC: Record<typeof NETWORK, string[]> = {
  testnet: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
  mainnet: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"],
};
/** Older configs name the deprecated near.org endpoint; it stays a fallback instead of going first. */
const DEPRECATED = new Set(["https://rpc.testnet.near.org", "https://rpc.mainnet.near.org"]);
const configured = process.env.NEXT_PUBLIC_NEAR_RPC_URL?.trim().replace(/\/+$/, "");

export const RPC_URLS: string[] = [
  ...new Set([configured && !DEPRECATED.has(configured) ? configured : null, ...DEFAULT_RPC[NETWORK]].filter((u): u is string => Boolean(u))),
];

export const EXPLORER = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
export const accountUrl = (accountId: string) => `${EXPLORER}/address/${accountId}`;
export const txUrl = (hash: string) => `${EXPLORER}/txns/${hash}`;

const TIMEOUT_MS = 10_000;

class TransportError extends Error {}

let preferred = 0;

/** One JSON-RPC call; returns the endpoint that answered. */
export async function rpcCall<T>(method: string, params: unknown): Promise<{ result: T; rpc: string }> {
  let lastError: unknown = null;
  for (let i = 0; i < RPC_URLS.length; i++) {
    const index = (preferred + i) % RPC_URLS.length;
    const rpc = RPC_URLS[index]!;
    let body: { result?: T; error?: { message?: string; cause?: { name?: string; info?: unknown }; data?: unknown } };
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "aegis-ui", method, params }),
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 408 || res.status === 429 || res.status >= 500) throw new TransportError(`${new URL(rpc).host} answered HTTP ${res.status}`);
      body = (await res.json()) as typeof body;
    } catch (e) {
      lastError = e;
      continue;
    }
    preferred = index;
    if (body.error) {
      const cause = body.error.cause?.name;
      const known: Record<string, string> = {
        UNKNOWN_ACCOUNT: "the account does not exist on this network",
        NO_CONTRACT_CODE: "the account has no contract deployed",
        CONTRACT_EXECUTION_ERROR: "the contract call failed",
      };
      const data = typeof body.error.data === "string" ? body.error.data : JSON.stringify(body.error.data ?? body.error);
      throw new Error(cause && known[cause] ? `${known[cause]} (${data.slice(0, 200)})` : `RPC error${cause ? ` (${cause})` : ""}: ${data.slice(0, 240)}`);
    }
    return { result: body.result as T, rpc };
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`no RPC endpoint answered (${RPC_URLS.map((u) => new URL(u).host).join(", ")}): ${reason}`);
}

interface CallFunctionResult {
  result?: number[];
  error?: string;
}

/** A view call on any contract (the AegisCore deployment, its SputnikDAO, ...). */
export async function viewFunction<T>(accountId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const { result } = await rpcCall<CallFunctionResult>("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: accountId,
    method_name: method,
    args_base64: toBase64(utf8(JSON.stringify(args))),
  });
  if (result.error) throw new Error(`view ${method} on ${accountId} failed: ${result.error}`);
  const bytes = Uint8Array.from(result.result ?? []);
  return (bytes.length ? JSON.parse(fromUtf8(bytes)) : null) as T;
}

export interface ViewAccount {
  amount: string;
  locked: string;
  code_hash: string;
  storage_usage: number;
  block_height: number;
}

export async function viewAccount(accountId: string): Promise<ViewAccount> {
  return (await rpcCall<ViewAccount>("query", { request_type: "view_account", finality: "final", account_id: accountId })).result;
}

export type AccessKeyPermission = "FullAccess" | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };

export async function viewAccessKeys(accountId: string): Promise<Array<{ public_key: string; permission: AccessKeyPermission }>> {
  const { result } = await rpcCall<{ keys: Array<{ public_key: string; access_key: { permission: AccessKeyPermission } }> }>("query", {
    request_type: "view_access_key_list",
    finality: "final",
    account_id: accountId,
  });
  return result.keys.map((k) => ({ public_key: k.public_key, permission: k.access_key.permission }));
}

/** `AegisTransport` for the SDK's typed views (`AegisViews`), over the fallback endpoints. */
export class FallbackRpcTransport implements AegisTransport {
  constructor(readonly contractId: string) {}

  view(method: string, args: Record<string, unknown>): Promise<unknown> {
    return viewFunction<unknown>(this.contractId, method, args);
  }
}

/** The endpoint the last successful call used, e.g. `test.rpc.fastnear.com`. */
export function currentRpcHost(): string {
  return new URL(RPC_URLS[preferred] ?? RPC_URLS[0]!).host;
}

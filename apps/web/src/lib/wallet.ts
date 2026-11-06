"use client";

/**
 * NEAR Connect (the wallet connector recommended by docs.near.org, successor of Wallet Selector)
 * for the live deployment: reads go through JSON-RPC (`near-rpc.ts`), writes are signed by the
 * user's wallet. Loaded lazily because it touches `window` / IndexedDB.
 */
import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";

import { NETWORK } from "./near-rpc";

type FinalExecutionOutcome = Awaited<ReturnType<NearWalletBase["signAndSendTransaction"]>>;

export { NETWORK };

/** The DAO-owned v2.3.0 deployment recorded in artifacts/testnet-swarm.json. */
const VERIFIED_TESTNET_CONTRACT_ID = "aegis-69b4.phalanxswarm.testnet";
export const TESTNET_CONTRACT_ID = process.env.NEXT_PUBLIC_AEGIS_CONTRACT_ID ?? VERIFIED_TESTNET_CONTRACT_ID;

let connectorPromise: Promise<NearConnector> | null = null;

export function getConnector(): Promise<NearConnector> {
  connectorPromise ??= import("@hot-labs/near-connect").then(({ NearConnector }) => new NearConnector({ network: NETWORK }));
  return connectorPromise;
}

export async function connectedAccount(): Promise<{ wallet: NearWalletBase; accountId: string } | null> {
  const connector = await getConnector();
  try {
    const { wallet, accounts } = await connector.getConnectedWallet();
    const accountId = accounts[0]?.accountId;
    return accountId ? { wallet, accountId } : null;
  } catch {
    return null;
  }
}

/** Sends a single FunctionCall to an AegisCore contract through the connected wallet. */
export async function walletCall(
  method: string,
  args: Record<string, unknown>,
  opts: { contractId?: string; deposit?: string; gas?: string } = {},
): Promise<FinalExecutionOutcome> {
  const contractId = opts.contractId ?? TESTNET_CONTRACT_ID;
  if (!contractId) throw new Error("enter a testnet contract id or set NEXT_PUBLIC_AEGIS_CONTRACT_ID");
  if (NETWORK === "testnet" && !contractId.endsWith(".testnet")) throw new Error("testnet contract id must end in .testnet");
  const session = await connectedAccount();
  if (!session) throw new Error("connect a wallet first");
  return session.wallet.signAndSendTransaction({
    receiverId: contractId,
    actions: [{ type: "FunctionCall", params: { methodName: method, args, gas: opts.gas ?? "100000000000000", deposit: opts.deposit ?? "0" } }],
  });
}

/** Transaction hash and contract failure (if any) of a wallet-sent transaction. */
export function describeOutcome(outcome: FinalExecutionOutcome | null | undefined): { hash: string | null; failure: string | null } {
  const o = outcome as
    | { transaction?: { hash?: string }; transaction_outcome?: { id?: string }; status?: unknown; receipts_outcome?: Array<{ outcome?: { status?: unknown } }> }
    | null
    | undefined;
  const hash = o?.transaction?.hash ?? o?.transaction_outcome?.id ?? null;
  const failed = [o?.status, ...(o?.receipts_outcome ?? []).map((r) => r.outcome?.status)].find(
    (s): s is { Failure: unknown } => typeof s === "object" && s !== null && "Failure" in s,
  );
  if (!failed) return { hash, failure: null };
  const text = JSON.stringify(failed.Failure);
  const panic = /"(?:panic_msg|PanicMsg|ExecutionError)"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  return { hash, failure: panic ?? text.slice(0, 240) };
}

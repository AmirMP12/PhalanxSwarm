#!/usr/bin/env node
/**
 * Optional, user-run mainnet funding: swaps a tiny amount of NEAR into native ETH on Base through
 * NEAR Intents 1Click and delivers it to the treasury's Chain Signatures address
 * (`pnpm oneclick:fund --contract <phalanx contract> [--amount-near 0.3]`).
 *
 * This spends real NEAR from a mainnet account you control (PHALANX_MAINNET_CREDENTIAL, outside the
 * repository). Without `--confirm-mainnet-spend` it only prints a `dry: true` quote. With it:
 *  1. requests a live quote (`dry: false`) and shows the deposit address 1Click returned;
 *  2. in one transaction to wrap.near: registers storage, wraps the NEAR and `ft_transfer`s the
 *     wNEAR to the deposit address;
 *  3. notifies 1Click (`/v0/deposit/submit`) and polls `/v0/status` until SUCCESS or REFUNDED.
 *
 * The treasury address is derived from the contract id with the MPC contract of the network the
 * contract lives on (`--contract-network testnet` by default). Afterwards the agents can move that
 * ETH on Base mainnet only through the contract's policy (`PHALANX_EVM_CHAIN=base pnpm testnet:swarm`).
 */
import { randomBytes } from "node:crypto";

import {
  deriveChildPublicKey,
  EVM_CHAINS,
  EvmRpc,
  evmAddressFromPublicKey,
  formatNear,
  fromBase58,
  ONE_NEAR,
  parseNear,
} from "../packages/agent-swarm-sdk/src/index.ts";
import { loadRootEnv } from "../packages/agent-swarm-sdk/src/node.ts";
import { accountBalance, accountFor, call, loadCredential, networkConfig, send, view, type Network } from "./lib/near.ts";

loadRootEnv();
const ONECLICK = process.env.ONECLICK_API_BASE || "https://1click.chaindefuser.com";
const BASE_ETH = "nep141:base.omft.near";
const WNEAR = "nep141:wrap.near";
const MAX_NEAR = parseNear("2");
const STORAGE = parseNear("0.00125");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (process.env.ONECLICK_JWT) {
    h.authorization = `Bearer ${process.env.ONECLICK_JWT}`;
    h["x-api-key"] = process.env.ONECLICK_JWT;
  }
  return h;
}

async function oneClick<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ONECLICK}${path}`, { ...init, headers: headers(), signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`1Click ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

interface Quote {
  correlationId: string;
  quote: {
    amountIn: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd: string;
    minAmountOut: string;
    depositAddress?: string;
    deadline?: string;
    timeEstimate: number;
  };
  quoteRequest: { dry: boolean; recipient?: string };
}

async function treasuryAddress(contractId: string, network: Network): Promise<string> {
  const cfg = networkConfig(network);
  if (!cfg.mpcContract) throw new Error(`no MPC contract on ${network}`);
  const path = "phalanx-treasury/base";
  const rootString = await view<string>(cfg.rpc, cfg.mpcContract, "public_key", { domain_id: 0 });
  const raw = fromBase58(rootString.replace("secp256k1:", ""));
  const root = new Uint8Array(65);
  root[0] = 0x04;
  root.set(raw, 1);
  return evmAddressFromPublicKey(deriveChildPublicKey(root, contractId, path));
}

async function main() {
  const mainnet = networkConfig("mainnet");
  const confirm = process.argv.includes("--confirm-mainnet-spend");
  const amount = parseNear(arg("amount-near") ?? "0.3");
  if (amount <= 0n || amount > MAX_NEAR) throw new Error(`--amount-near must be in (0, ${formatNear(MAX_NEAR, 0)}]`);
  const contract = arg("contract");
  const recipient = arg("to") ?? (contract ? await treasuryAddress(contract, (arg("contract-network") as Network | undefined) ?? "testnet") : undefined);
  if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error("pass --contract <phalanx contract id> or --to <0x address>");
  const cred = loadCredential(process.env.PHALANX_MAINNET_CREDENTIAL, mainnet, "PHALANX_MAINNET_CREDENTIAL");
  const balance = await accountBalance(mainnet.rpc, cred.account_id);
  const base = new EvmRpc(EVM_CHAINS.base!.rpc);
  const before = await base.balance(recipient);

  const request = (dry: boolean) => ({
    dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: WNEAR,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: BASE_ETH,
    amount: amount.toString(),
    recipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo: cred.account_id,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(Date.now() + 20 * 60_000).toISOString(),
    referral: "phalanx-swarm",
  });
  const preview = await oneClick<Quote>("/v0/quote", { method: "POST", body: JSON.stringify(request(true)) });
  console.log(
    [
      `from      ${cred.account_id} (mainnet, balance ${formatNear(balance, 3)} NEAR)`,
      `to        ${recipient} on Base mainnet${contract ? ` (treasury of ${contract})` : ""}, holds ${formatNear(before * 10n ** 6n, 6)} ETH`,
      `swap      ${formatNear(amount, 3)} NEAR -> about ${preview.quote.amountOutFormatted} ETH ($${preview.quote.amountOutUsd}), ~${preview.quote.timeEstimate}s`,
    ].join("\n"),
  );
  if (!confirm) {
    console.log("\nDry quote only. Re-run with --confirm-mainnet-spend to send real NEAR.");
    return;
  }
  if (balance < amount + 2n * STORAGE + ONE_NEAR / 20n) throw new Error("not enough NEAR for the swap, storage and gas");

  const live = await oneClick<Quote>("/v0/quote", { method: "POST", body: JSON.stringify(request(false)) });
  const depositAddress = live.quote.depositAddress;
  if (live.quoteRequest.dry !== false || !depositAddress) throw new Error("1Click returned no deposit address");
  if (BigInt(live.quote.amountIn) !== amount) throw new Error(`quote amountIn ${live.quote.amountIn} differs from ${amount}`);
  // The deposit follows without another prompt, so the live quote must still be the one shown above.
  const echoed = live.quoteRequest.recipient;
  if (echoed !== undefined && echoed.toLowerCase() !== recipient.toLowerCase())
    throw new Error(`live quote pays ${echoed}, not ${recipient}; nothing deposited`);
  const floor = (BigInt(preview.quote.minAmountOut) * 97n) / 100n;
  if (BigInt(live.quote.minAmountOut) < floor) {
    throw new Error(`live quote guarantees ${live.quote.minAmountOut} wei, more than 3% below the preview's ${preview.quote.minAmountOut}; nothing deposited`);
  }
  console.log(`live quote ${live.correlationId}: deposit ${formatNear(amount, 3)} wNEAR to ${depositAddress}`);

  const account = accountFor(mainnet, cred.account_id, cred.private_key);
  const sent = await send(account, "wrap.near", [
    call("storage_deposit", { account_id: cred.account_id, registration_only: true }, 10n, STORAGE),
    call("near_deposit", {}, 10n, amount),
    call("storage_deposit", { account_id: depositAddress, registration_only: true }, 10n, STORAGE),
    call("ft_transfer", { receiver_id: depositAddress, amount: amount.toString(), memo: `phalanx-fund-${randomBytes(3).toString("hex")}` }, 30n, 1n),
  ]);
  console.log(`${sent.ok ? "✔" : "✘"} deposit: ${mainnet.explorer(sent.hash)}`);
  if (!sent.ok) throw new Error(`deposit failed: ${sent.error}`);
  await oneClick("/v0/deposit/submit", { method: "POST", body: JSON.stringify({ depositAddress, txHash: sent.hash }) }).catch(() => undefined);

  for (let i = 0; i < 120; i++) {
    const status = await oneClick<{ status: string; swapDetails?: { destinationChainTxHashes?: Array<{ hash: string; explorerUrl?: string }> } }>(
      `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
    );
    if (["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"].includes(status.status)) {
      console.log(`1Click status ${status.status}`);
      for (const tx of status.swapDetails?.destinationChainTxHashes ?? []) console.log(`  Base tx ${tx.explorerUrl ?? tx.hash}`);
      if (status.status !== "SUCCESS") throw new Error(`swap ended as ${status.status}`);
      const after = await base.balance(recipient);
      console.log(`${recipient} now holds ${formatNear(after * 10n ** 6n, 6)} ETH on Base`);
      return;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error("swap still pending after 10 minutes; check https://explorer.near-intents.org");
}

main().catch((err) => {
  console.error("1CLICK FUNDING: FAIL", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

#!/usr/bin/env node
/**
 * Broadcasts an EVM transaction that aegis-core built and the MPC network signed, then records it
 * on-chain (`pnpm evm:relay <contract-id> <tx-id>`).
 *
 * Anyone can relay: the raw transaction is public and only the treasury's Chain Signatures key
 * could have produced the signature. Before broadcasting, the script rebuilds the EIP-1559
 * transaction from the request stored in the contract, checks the stored bytes against it and
 * recovers the sender, which must be the contract's MPC-derived address for that chain.
 *
 * The on-chain confirmation is signed with the Sentinel's key stored by `pnpm testnet:swarm`
 * (~/.near-credentials/<network>/aegis-sentinel.<contract>.json). Without it the script prints the
 * transaction hash for a DAO proposal instead.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assembleSignedTx,
  buildEvmTx,
  deriveChildPublicKey,
  EVM_CHAINS,
  EvmRpc,
  evmAddressFromPublicKey,
  fromBase58,
  fromHex,
  recoverTxSender,
  toHex,
  type EvmChainPolicyT,
  type EvmTransferRequestT,
  type EvmTxRecordT,
  type GlobalPolicyT,
} from "../packages/agent-swarm-sdk/src/index.ts";
import { accountFor, call, networkConfig, REPO_ROOT, send, storedCredential, view } from "./lib/near.ts";

const cfg = networkConfig();
const checkOnly = process.argv.includes("--check-only") || process.argv.includes("--dry-run");
const [contractId, txId] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!contractId || !txId) throw new Error("usage: pnpm evm:relay <contract-id> <tx-id> [--check-only]");

async function main() {
  const record = await view<EvmTxRecordT | null>(cfg.rpc, contractId!, "get_evm_tx", { tx_id: txId });
  if (!record) throw new Error(`no EVM transaction #${txId} on ${contractId}`);
  if (!["signed", "confirmed"].includes(record.status) || !record.signature || !record.raw_tx || !record.tx_hash) {
    throw new Error(`EVM transaction #${txId} is ${record.status}: nothing to relay`);
  }
  const policy = await view<GlobalPolicyT>(cfg.rpc, contractId!, "get_global_policy");
  const chainPolicy = policy.evm_chains.find((c) => c.chain === record.chain) as EvmChainPolicyT | undefined;
  const chain = EVM_CHAINS[record.chain];
  if (!chainPolicy || !chain) throw new Error(`chain ${record.chain} is not configured`);

  const request: EvmTransferRequestT = {
    chain: record.chain,
    to: record.to,
    asset: record.asset,
    amount: record.amount,
    nonce: record.nonce,
    gas_limit: record.gas_limit,
    max_fee_per_gas: record.max_fee_per_gas,
    max_priority_fee_per_gas: record.max_priority_fee_per_gas,
    memo: record.memo,
    attestation: null,
  };
  const built = buildEvmTx(chainPolicy, request);
  if (toHex(built.signingHash) !== record.signing_hash) throw new Error("the stored signing hash does not match the stored request");
  const assembled = assembleSignedTx(built, record.signature);
  if (assembled.rawTx !== record.raw_tx || assembled.txHash !== record.tx_hash)
    throw new Error("the stored raw transaction does not match its request and signature");
  const sender = recoverTxSender(fromHex(record.signing_hash), record.signature);
  if (!cfg.mpcContract) throw new Error("no MPC contract on this network");
  const path = `aegis-treasury/${record.chain}`;
  const rootString = await view<string>(cfg.rpc, cfg.mpcContract, "public_key", { domain_id: 0 });
  const raw = fromBase58(rootString.replace("secp256k1:", ""));
  const root = new Uint8Array(65);
  root[0] = 0x04;
  root.set(raw, 1);
  const treasury = evmAddressFromPublicKey(deriveChildPublicKey(root, contractId!, path));
  if (sender.toLowerCase() !== treasury.toLowerCase()) throw new Error(`sender ${sender} is not the treasury address ${treasury}`);
  console.log(`✔ ${chain.label} tx ${record.tx_hash}: sender ${sender} is the treasury's MPC address; ${record.amount} wei to ${record.to}`);

  if (checkOnly) {
    console.log(`\n✔ [CHECK-ONLY] Cryptographic verification passed:`);
    console.log(`  - EIP-1559 RLP payload and Keccak-256 hash match the on-chain request.`);
    console.log(`  - Real MPC signature from ${cfg.mpcContract} successfully ecrecovers to treasury address: ${sender}`);
    console.log(`  - Destination: ${record.to} on ${chain.label} (${chain.explorer}/address/${sender})`);
    console.log(`  - Raw signed transaction: ${record.raw_tx}`);
    console.log(`\nTo broadcast live to ${chain.label}: fund ${sender} with ~0.0002 testnet ETH and re-run without --check-only.`);
    return;
  }

  const rpc = new EvmRpc(chain.rpc);
  if ((await rpc.chainId()) !== BigInt(chainPolicy.chain_id)) throw new Error(`${chain.rpc} is not chain ${chainPolicy.chain_id}`);
  let receipt = await rpc.receipt(record.tx_hash);
  if (!receipt) {
    const cost = BigInt(record.tx_value) + BigInt(record.gas_limit) * BigInt(record.max_fee_per_gas);
    const balance = await rpc.balance(sender);
    if (balance < cost) {
      console.error(`\n✘ Treasury address holds insufficient ETH on ${chain.label} to broadcast this transaction.`);
      console.error(`  Treasury Address:  ${sender}`);
      console.error(`  Explorer:          ${chain.explorer}/address/${sender}`);
      console.error(`  Current Balance:   ${balance} wei`);
      console.error(`  Required (gas+val): ${cost} wei (~${(Number(cost) / 1e18).toFixed(6)} ETH)`);
      console.error(`  Free Faucets:      https://faucets.chain.link/base-sepolia or https://www.alchemy.com/faucets/base-sepolia`);
      console.error(`\nTip: Re-run with --check-only to verify the cryptographic validity and MPC signature recovery without broadcasting.\n`);
      throw new Error(`${sender} holds ${balance} wei; needs ${cost} wei on ${chain.label}`);
    }
    await rpc.sendRawTransaction(record.raw_tx);
    receipt = await rpc.waitForReceipt(record.tx_hash, 180_000);
  }
  console.log(`${receipt.status === "0x1" ? "✔" : "✘"} mined in block ${BigInt(receipt.blockNumber)}: ${chain.explorer}/tx/${record.tx_hash}`);
  if (receipt.status !== "0x1") throw new Error("the transaction reverted");

  let status = record.status;
  if (status !== "confirmed") {
    const sentinelId = `aegis-sentinel.${contractId}`;
    const cred = storedCredential(cfg, sentinelId);
    if (cred) {
      const sent = await send(accountFor(cfg, sentinelId, cred.private_key), contractId!, [
        call("confirm_evm_transfer", { tx_id: txId, tx_hash: record.tx_hash }, 50n),
      ]);
      console.log(`${sent.ok ? "✔" : "✘"} confirm_evm_transfer: ${cfg.explorer(sent.hash)}`);
      if (!sent.ok) throw new Error(`confirm_evm_transfer failed: ${sent.error}`);
      status = "confirmed";
    } else {
      console.log(`No Sentinel key found for ${sentinelId}. A DAO proposal can call confirm_evm_transfer({"tx_id":"${txId}","tx_hash":"${record.tx_hash}"}).`);
    }
  }

  const evidencePath = resolve(REPO_ROOT, "artifacts/testnet-swarm.json");
  if (existsSync(evidencePath)) {
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as { contract_id: string; evm?: { tx_id: string; status: string } | null };
    if (evidence.contract_id === contractId && evidence.evm && evidence.evm.tx_id === txId) {
      evidence.evm.status = status === "confirmed" ? "confirmed" : "mined";
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
      console.log("updated artifacts/testnet-swarm.json");
    }
  }
}

main().catch((err) => {
  console.error("EVM RELAY: FAIL", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

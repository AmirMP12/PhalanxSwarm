#!/usr/bin/env node
/**
 * Real testnet smoke test (no mocks): deploys the canonical WASM, initializes it, provisions a
 * real scoped FunctionCall key, obtains a live 1Click `dry:true` quote, submits a NEP-413 intent
 * with that agent key, and waits for a real signature from v1.signer-prod.testnet.
 *
 * Input: AEGIS_TESTNET_CREDENTIAL=/absolute/path/to/a disposable testnet credential JSON
 *        { account_id, public_key, private_key }. The file must be outside this repository.
 * Output: artifacts/testnet-smoke.json (public tx/account evidence, no secrets).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Account, actions, getTransactionLastResult, KeyPairSigner, type KeyPairString } from "near-api-js";
import {
  ASSETS,
  buildIntentMessage,
  deriveChildPublicKey,
  evmAddressFromPublicKey,
  fromBase58,
  nep413Hash,
  OneClickClient,
  randomKeyPair,
  recoverEvmAddress,
  signEd25519,
  toBase58,
  toBase64,
  toQuoteBinding,
  type CrossChainIntentRequestT,
  type GlobalPolicyT,
  type IntentRecordT,
  type UnsignedIntentRequest,
} from "../packages/agent-swarm-sdk/src/index.ts";

const RPC = "https://rpc.testnet.near.org";
const MPC = "v1.signer-prod.testnet";
const INTENTS = "intents.near";
const TGAS = 10n ** 12n;
const ONE_NEAR = 10n ** 24n;
const credentialPath = process.env.AEGIS_TESTNET_CREDENTIAL;
if (!credentialPath) throw new Error("set AEGIS_TESTNET_CREDENTIAL to a disposable .testnet credential JSON outside the repository");
const cred = JSON.parse(readFileSync(credentialPath, "utf8")) as { account_id: string; public_key: string; private_key: string };
if (!cred.account_id.endsWith(".testnet")) throw new Error("refusing: credential is not a .testnet account");
const contractId = cred.account_id;
const ownerSigner = KeyPairSigner.fromSecretKey(cred.private_key as KeyPairString);
const owner = new Account(contractId, RPC, ownerSigner);
const wasmPath = resolve("artifacts/aegis_core.wasm");
const wasm = new Uint8Array(readFileSync(wasmPath));

const txHash = (r: unknown): string => String((r as { transaction?: { hash?: string } }).transaction?.hash ?? "unknown");
const explorer = (h: string) => `https://testnet.nearblocks.io/txns/${h}`;

async function view<T>(accountId: string, method: string, args: unknown): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "aegis-testnet-smoke",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const body = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: unknown };
  if (!body.result?.result) throw new Error(`view ${accountId}.${method}: ${JSON.stringify(body.error ?? body.result)}`);
  return JSON.parse(Buffer.from(body.result.result).toString()) as T;
}

async function call(account: Account, method: string, args: object, gas = 150n * TGAS, deposit = 0n) {
  const r = await account.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(method, args, gas, deposit)],
    waitUntil: "FINAL",
    throwOnFailure: true,
  });
  console.log(`${method}: ${explorer(txHash(r))}`);
  return r;
}

async function main() {
  const evidence: Record<string, unknown> = {
    network: "testnet",
    contract_id: contractId,
    mpc_contract_id: MPC,
    wasm_sha256: readFileSync(resolve("artifacts/aegis_core.wasm.sha256"), "utf8").trim().split(/\s+/)[0],
    timestamp: new Date().toISOString(),
    transactions: {},
  };
  const txs = evidence.transactions as Record<string, string>;

  console.log(`Deploying canonical WASM to ${contractId} (testnet)`);
  const deployed = await owner.deployContract(wasm);
  txs.deploy = txHash(deployed);
  console.log(`deploy: ${explorer(txs.deploy)}`);

  const init = await call(
    owner,
    "new",
    {
      owner_id: contractId,
      config: {
        mpc_contract_id: MPC,
        mpc_domain_id: 0,
        mpc_sign_gas_tgas: 50,
        callback_gas_tgas: 20,
        intents_contract_id: INTENTS,
        min_operating_reserve: (ONE_NEAR / 10n).toString(),
        min_distribution: (ONE_NEAR / 100n).toString(),
        max_receipt_age_sec: 3600,
        max_intent_horizon_sec: 3600,
        subaccount_min_deposit: (ONE_NEAR / 10n).toString(),
      },
    },
    100n * TGAS,
  );
  txs.init = txHash(init);

  const funded = await call(owner, "fund_treasury", { memo: "real testnet MPC smoke liquidity" }, 50n * TGAS, ONE_NEAR);
  txs.fund = txHash(funded);

  const policy = await view<GlobalPolicyT>(contractId, "get_global_policy", {});
  policy.require_tee_attestation = false;
  const policyTx = await call(owner, "update_global_policy", { policy }, 80n * TGAS);
  txs.policy = txHash(policyTx);

  const agentKey = randomKeyPair();
  const handle = `rhea-real-${Date.now().toString(36).slice(-6)}`;
  const agentId = `${handle}.${contractId}`;
  const spawn = await call(
    owner,
    "register_and_spawn_agent",
    {
      agent_handle: handle,
      role: "yield_strategist",
      public_key: agentKey.publicKeyString,
      allowance_cap: (ONE_NEAR / 2n).toString(),
      spawn_mode: "contract_key",
      payout_account: contractId,
      policy: null,
    },
    150n * TGAS,
  );
  txs.spawn = txHash(spawn);
  const agentRecord = await view<{ status: { kind: string }; key_active: boolean; allowed_methods: string[] }>(contractId, "get_agent", { agent_id: agentId });
  if (agentRecord.status.kind !== "active" || !agentRecord.key_active) throw new Error(`agent not active: ${JSON.stringify(agentRecord)}`);
  if (agentRecord.allowed_methods.join(",") !== "submit_bid,execute_verified_task,request_intent_settlement") throw new Error("wrong access-key scope");

  const path = "aegis-treasury/arb";
  const rootString = await view<string>(MPC, "public_key", { domain_id: 0 });
  const rootRaw = fromBase58(rootString.replace("secp256k1:", ""));
  const root = new Uint8Array(65);
  root[0] = 0x04;
  root.set(rootRaw, 1);
  const realDerived = await view<string>(MPC, "derived_public_key", { path, predecessor: contractId, domain_id: 0 });
  const child = deriveChildPublicKey(root, contractId, path);
  const sdkDerived = `secp256k1:${toBase58(child.slice(1))}`;
  if (sdkDerived !== realDerived) throw new Error("SDK derivation does not match the real MPC contract");
  const recipient = evmAddressFromPublicKey(child);
  evidence.mpc_derived_public_key = realDerived;
  evidence.mpc_evm_address = recipient;

  const amount = ONE_NEAR / 10n;
  const oneClick = new OneClickClient({ mode: "live", timeoutMs: 20_000 });
  const quote = await oneClick.quote({
    originAsset: ASSETS.WNEAR,
    destinationAsset: ASSETS.USDC_ARB,
    amount,
    recipient,
    refundTo: contractId,
    slippageBps: 50,
    deadlineSec: 1800,
  });
  if (quote.source !== "live" || quote.response.quoteRequest.dry !== true) throw new Error("expected a live dry:true 1Click quote");
  const binding = toQuoteBinding(quote);
  evidence.oneclick_correlation_id = quote.response.correlationId;
  evidence.oneclick_dry = true;

  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const unsigned: UnsignedIntentRequest = {
    kind: "swap",
    destination_chain: "arb",
    origin_asset: ASSETS.WNEAR,
    destination_asset: ASSETS.USDC_ARB,
    amount: amount.toString(),
    min_amount_out: binding.min_amount_out,
    recipient,
    execution_contract: INTENTS,
    slippage_bps: 50,
    deadline_ns: (BigInt(Date.now() + 15 * 60_000) * 1_000_000n).toString(),
    quote: binding,
    nonce: toBase64(nonce),
    memo: "real testnet MPC smoke",
  };
  const message = buildIntentMessage(agentId, unsigned);
  const hash = nep413Hash(message, nonce, contractId);
  const request: CrossChainIntentRequestT = { ...unsigned, signature: signEd25519(agentKey, hash), attestation: null };

  const agent = new Account(contractId, RPC, KeyPairSigner.fromSecretKey(agentKey.secretKeyString as KeyPairString));
  const requested = await call(agent, "request_intent_settlement", { request }, 200n * TGAS);
  txs.intent = txHash(requested);
  const outcome = JSON.parse(JSON.stringify(getTransactionLastResult(requested))) as { intent_id: string; status: string };
  if (!outcome.intent_id) throw new Error(`missing intent id: ${JSON.stringify(outcome)}`);

  let record: IntentRecordT | null = null;
  for (let i = 0; i < 30; i++) {
    record = await view<IntentRecordT>(contractId, "get_intent", { intent_id: outcome.intent_id });
    if (["signed", "authorization_failed"].includes(record.status)) break;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  if (!record?.mpc?.signature || record.status !== "signed") throw new Error(`real MPC signature failed: ${JSON.stringify(record?.mpc)}`);
  const recovered = recoverEvmAddress(Uint8Array.from(Buffer.from(record.mpc.payload, "hex")), record.mpc.signature);
  if (recovered.toLowerCase() !== recipient.toLowerCase()) throw new Error(`ecrecover mismatch: ${recovered} != ${recipient}`);
  evidence.intent_id = record.intent_id;
  evidence.intent_status = record.status;
  evidence.nep413_hash = record.nep413_hash;
  evidence.mpc_payload = record.mpc.payload;
  evidence.mpc_recovered_address = recovered;

  const confirmed = await call(
    owner,
    "confirm_intent_settlement",
    { intent_id: record.intent_id, settlement_ref: `1click-dry:${quote.response.correlationId}` },
    80n * TGAS,
  );
  txs.confirm = txHash(confirmed);
  const finalRecord = await view<IntentRecordT>(contractId, "get_intent", { intent_id: record.intent_id });
  if (finalRecord.status !== "settled") throw new Error(`intent did not settle: ${finalRecord.status}`);
  evidence.final_status = finalRecord.status;
  evidence.transactions = Object.fromEntries(Object.entries(txs).map(([k, h]) => [k, { hash: h, explorer: explorer(h) }]));

  writeFileSync(resolve("artifacts/testnet-smoke.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log("REAL TESTNET SMOKE: PASS");
  console.log(
    JSON.stringify(
      {
        contract_id: contractId,
        intent_id: record.intent_id,
        final_status: finalRecord.status,
        mpc_evm_address: recipient,
        transactions: evidence.transactions,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("REAL TESTNET SMOKE: FAIL", err);
  process.exitCode = 1;
});

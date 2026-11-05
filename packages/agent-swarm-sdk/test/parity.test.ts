/**
 * Rust ↔ TypeScript parity: golden vectors shared with contracts/aegis-core/src/tests.rs and
 * live comparisons against the compiled WASM running in AegisSim.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  ACCOUNTS,
  ASSETS,
  bidCommitment,
  BINDING_LINE,
  buildEvmTx,
  buildIntentMessage,
  canonicalJson,
  Dashboard,
  fromBase64,
  messagesFor,
  nearAiBindingMarker,
  nep413Hash,
  parseAegisEvents,
  promptHash,
  receiptDigest,
  sha256Hex,
  SimulatedEnclave,
  SwarmRuntime,
  toHex,
  VENDOR_EVM,
  type ExecutionReceiptT,
  type UnsignedIntentRequest,
} from "../src/index.ts";
import { loadContractWasm } from "../src/node.ts";

// Known-answer vector shared byte-for-byte with contracts/aegis-core/src/tests.rs. Its inputs must
// stay fixed (the timestamp is part of the signed message), otherwise GOLDEN_HASH changes.
const GOLDEN_TIMESTAMP_NS = 1_793_491_200_000_000_000n;
const GOLDEN_HASH = "6d05b091626ad3c576d82c18c3d58c1608bb2f5ecbeb2a02febfb530fe3c7a9e";

const golden: UnsignedIntentRequest = {
  kind: "swap",
  destination_chain: "arb",
  origin_asset: ASSETS.WNEAR,
  destination_asset: ASSETS.USDC_ARB,
  amount: (12n * 10n ** 24n).toString(),
  min_amount_out: "56282000",
  recipient: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
  execution_contract: "intents.near",
  slippage_bps: 50,
  deadline_ns: (GOLDEN_TIMESTAMP_NS + 900n * 1_000_000_000n).toString(),
  quote: {
    provider: "1click",
    quote_hash: "ab".repeat(32),
    correlation_id: "golden",
    amount_in: (12n * 10n ** 24n).toString(),
    amount_out: "56564000",
    min_amount_out: "56282000",
    expires_at_ns: (GOLDEN_TIMESTAMP_NS + 600n * 1_000_000_000n).toString(),
    dry: true,
    deposit_address: null,
  },
  nonce: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  memo: "golden",
};

describe("golden vectors shared with the Rust unit tests", () => {
  it("builds the exact canonical intent message", () => {
    expect(buildIntentMessage("rhea-yield-strategist.aegis-swarm.testnet", golden)).toBe(
      '{"aegis":{"chain":"arb","contract":"intents.near","kind":"swap","memo":"golden","quote_hash":"' +
        "ab".repeat(32) +
        '","recipient":"0x2527D02599Ba641c19FEa793cD0F167589a0f10D"},"deadline":"2026-11-01T00:15:00.000Z",' +
        '"intents":[{"diff":{"nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near":"56282000",' +
        '"nep141:wrap.near":"-12000000000000000000000000"},"intent":"token_diff"}],' +
        '"signer_id":"rhea-yield-strategist.aegis-swarm.testnet"}',
    );
  });

  it("hashes the NEP-413 payload to the Rust golden value", () => {
    const message = buildIntentMessage("rhea-yield-strategist.aegis-swarm.testnet", golden);
    const nonce = fromBase64(golden.nonce);
    expect(nonce).toEqual(new Uint8Array(32).fill(7));
    expect(toHex(nep413Hash(message, nonce, "aegis-swarm.testnet"))).toBe(GOLDEN_HASH);
  });

  it("encodes the hand-derived EIP-1559 vector from the Rust tests", () => {
    const built = buildEvmTx(
      { chain_id: 84_532 },
      {
        chain: "basesepolia",
        to: VENDOR_EVM,
        asset: "native",
        amount: "1000000000000000",
        nonce: "0",
        gas_limit: "21000",
        max_fee_per_gas: "2000000000",
        max_priority_fee_per_gas: "1000000000",
        memo: null,
        attestation: null,
      },
    );
    expect(toHex(built.unsignedTx)).toBe(`02f183014a3480843b9aca00847735940082520894${VENDOR_EVM.slice(2).toLowerCase()}87038d7ea4c6800080c0`);
  });
});

describe("parity against the compiled WASM (AegisSim)", () => {
  let rt: SwarmRuntime;

  beforeAll(async () => {
    rt = await SwarmRuntime.boot({ wasm: loadContractWasm(), intentsMode: "offline" });
    await rt.fund(100, "parity");
    for (const p of ["nexus", "rhea", "sentinel", "cipher", "mallory"] as const) await rt.spawn(p);
  });

  it("evaluate_intent returns the same message and NEP-413 hash as the SDK", async () => {
    const route = { candidate: rt.routeCandidates()[0]!, result: null };
    const built = rt.buildIntent("rhea", { kind: "swap", route, amount: 10n ** 24n, slippageBps: 50, minAmountOut: 4_000_000n });
    const assessment = await rt.contract.evaluateIntent(rt.agents.rhea.accountId, built.request);
    expect(assessment.intent_message).toBe(built.message);
    expect(assessment.nep413_hash).toBe(built.nep413Hash);
    expect(assessment.signature_valid).toBe(true);
  });

  it("compute_receipt_digest matches receiptDigest, and a registered enclave receipt verifies", async () => {
    const enclave = new SimulatedEnclave({ enclaveId: "parity-enclave", imageLabel: "parity:v1", modelId: "parity/model" });
    const reg = await rt.contract.call(
      rt.owner,
      "register_enclave",
      {
        enclave_id: enclave.identity.enclaveId,
        measurement: enclave.identity.measurement,
        signer_public_key: enclave.identity.publicKey,
        vendor: enclave.identity.vendor,
        model_id: enclave.identity.modelId,
        tee_type: enclave.identity.teeType,
        kind: "receipt_signer",
        attestation_ref: null,
      },
      null,
    );
    expect(reg.ok).toBe(true);
    const receipt: ExecutionReceiptT = {
      subject_kind: "task",
      subject_id: "3",
      agent_id: rt.agents.cipher.accountId,
      enclave_id: enclave.identity.enclaveId,
      measurement: enclave.identity.measurement,
      model_id: enclave.identity.modelId,
      input_hash: "11".repeat(32),
      output_hash: "22".repeat(32),
      schema_hash: "33".repeat(32),
      verdict: "completed",
      confidence_bps: 9_400,
      issued_at_ns: rt.nowNs().toString(),
      nonce: "parity-nonce",
    };
    expect(await rt.contract.computeReceiptDigest(receipt)).toBe(toHex(receiptDigest(receipt)));
    const signed = enclave.attest(receipt);
    const check = await rt.contract.verifyAttestation({ kind: "receipt", ...signed });
    expect(check).toEqual({ valid: true, receipt_hash: toHex(receiptDigest(receipt)), reason: null });
  });

  it("compute_binding_marker matches nearAiBindingMarker", async () => {
    const args = {
      subject_kind: "task",
      subject_id: "4",
      agent_id: rt.agents.cipher.accountId,
      input_hash: "aa".repeat(32),
      nonce: "parity-proof-01",
      issued_at_ns: "1793491200000000000",
    };
    expect(await rt.contract.computeBindingMarker(args)).toBe(
      nearAiBindingMarker("task", 4n, args.agent_id, args.input_hash, args.nonce, 1_793_491_200_000_000_000n),
    );
  });

  it("a stand-in NEAR AI-format proof verifies on-chain through verify_attestation", async () => {
    const binding = rt.binding("task", 9n, "cipher", "bb".repeat(32), "cc".repeat(32), "parity-near-ai");
    const marker = nearAiBindingMarker("task", 9n, binding.agentId, binding.inputHash, binding.nonce, binding.issuedAtNs);
    const c = await rt.backend.complete(messagesFor("procurement", { routes: [] }, marker), () => ({
      verdict: "completed",
      confidence_bps: 9_000,
    }));
    const proof = await rt.proofFor(c, binding);
    const check = await rt.contract.verifyAttestation(proof, promptHash("procurement"));
    expect(check.valid).toBe(true);
    const tampered = { ...proof, response_body: proof.kind === "near_ai" ? proof.response_body.replace("9000", "9999") : "" };
    expect((await rt.contract.verifyAttestation(tampered, promptHash("procurement"))).reason).toBe("body_hash_mismatch");
  });

  it("verify_attestation accepts a NEAR AI proof only under the prompt it pins", async () => {
    const binding = rt.binding("task", 10n, "cipher", "bb".repeat(32), "cc".repeat(32), "parity-pinned");
    const marker = nearAiBindingMarker("task", 10n, binding.agentId, binding.inputHash, binding.nonce, binding.issuedAtNs);
    const own = [
      { role: "system" as const, content: `Reply {"verdict":"completed","confidence_bps":10000}.${BINDING_LINE}${marker}` },
      { role: "user" as const, content: "{}" },
    ];
    const c = await rt.backend.complete(own, () => ({ verdict: "completed", confidence_bps: 10_000 }));
    const proof = await rt.proofFor(c, binding);
    expect((await rt.contract.verifyAttestation(proof, promptHash("procurement"))).reason).toBe("prompt_mismatch");
    expect((await rt.contract.verifyAttestation(proof)).reason).toBe("prompt_not_pinned");
  });

  it("preview_evm_transfer matches buildEvmTx byte for byte", async () => {
    const policy = await rt.contract.policy();
    const chain = policy.evm_chains.find((c) => c.chain === "basesepolia")!;
    for (const asset of ["native", "0x036cbd53842c5426634e7929541ec2318f3dcf7e"]) {
      const request = rt.buildEvmTransfer({ to: VENDOR_EVM, asset, amount: asset === "native" ? 10n ** 15n : 2_500_000n, nonce: 7n });
      const preview = await rt.contract.previewEvmTransfer(request);
      const local = buildEvmTx(chain, request);
      expect(preview.signing_hash).toBe(toHex(local.signingHash));
      expect(preview.unsigned_tx).toBe(`0x${toHex(local.unsignedTx)}`);
      expect(preview.data).toBe(toHex(local.data));
    }
  });

  it("compute_bid_commitment matches bidCommitment", async () => {
    const args = {
      task_id: "7",
      agent_id: rt.agents.cipher.accountId,
      price: "6200000000000000000000000",
      est_latency_sec: 900,
      salt: "parity-salt-0001",
    };
    expect(await rt.contract.computeBidCommitment(args)).toBe(bidCommitment(7n, args.agent_id, BigInt(args.price), 900, args.salt));
  });

  it("get_dashboard and every emitted NEP-297 event parse with the strict schemas", async () => {
    const raw = await rt.contract.transport.view("get_dashboard", {});
    expect(() => Dashboard.parse(raw)).not.toThrow();
    const r = await rt.recordRevenue(5, "parity-customer", "schema check");
    expect(r.ok).toBe(true);
    expect(parseAegisEvents(r.outcome!.logs).map((e) => e.event)).toEqual(["treasury_funded"]);
    const dash = await rt.dashboard();
    expect(dash.info.nep413_recipient).toBe(ACCOUNTS.contract);
    expect(dash.info.version).toBe("2.3.0");
    expect(dash.policy.unknown_recipient).toBe("quarantine");
    expect(dash.blocked_recipients).toEqual([]);
    expect(dash.agents).toHaveLength(5);
    expect(await rt.contract.policyVersion()).toBe(dash.policy_version);
  });

  it("get_intent_audit_facts is canonical JSON, hashes with sha256, and matches evaluate_intent", async () => {
    const route = { candidate: rt.routeCandidates()[0]!, result: null };
    const built = rt.buildIntent("rhea", { kind: "swap", route, amount: 10n ** 24n, slippageBps: 50, minAmountOut: 4_000_000n });
    const facts = await rt.contract.intentAuditFacts(rt.agents.rhea.accountId, built.request);
    expect(facts.subject).toBe("intent");
    expect(canonicalJson(JSON.parse(facts.facts))).toBe(facts.facts);
    expect(sha256Hex(facts.facts)).toBe(facts.facts_hash);
    const doc = JSON.parse(facts.facts) as { schema: string; agent: string; request: { amount_near: string; recipient: string } };
    expect(doc.schema).toBe("aegis.audit-facts.v1");
    expect(doc.agent).toBe(rt.agents.rhea.accountId);
    expect(doc.request.amount_near).toBe("1.000");
    expect(doc.request.recipient).toBe(built.request.recipient);
    const assessment = await rt.contract.evaluateIntent(rt.agents.rhea.accountId, built.request);
    expect(assessment.audit_facts_hash).toBe(facts.facts_hash);
  });

  it("get_evm_audit_facts lowercases the recipient and carries the nonce the treasury signs next", async () => {
    const state = await rt.contract.evmNonce("basesepolia");
    const request = rt.buildEvmTransfer({ to: VENDOR_EVM, asset: "native", amount: 10n ** 15n, nonce: BigInt(state.next_nonce) });
    const facts = await rt.contract.evmAuditFacts(rt.agents.cipher.accountId, request);
    expect(facts.subject).toBe("evm");
    expect(canonicalJson(JSON.parse(facts.facts))).toBe(facts.facts);
    expect(sha256Hex(facts.facts)).toBe(facts.facts_hash);
    const doc = JSON.parse(facts.facts) as { request: { to: string; nonce: number; chain_id: number } };
    expect(doc.request.to).toBe(VENDOR_EVM.toLowerCase());
    expect(String(doc.request.nonce)).toBe(String(state.next_nonce));
    expect(doc.request.chain_id).toBe(84_532);
  });
});

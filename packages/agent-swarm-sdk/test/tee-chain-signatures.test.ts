import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import {
  evmAddressFromPublicKey,
  fromHex,
  measurementFor,
  mpcPayload,
  recoverEvmAddress,
  settlementCommitment,
  SimulatedEnclave,
  SimulatedMpcSigner,
  toHex,
  utf8,
  verifyEnclaveSignature,
  type MpcSignatureT,
} from "../src/index.ts";

describe("TEE prover", () => {
  const enclave = new SimulatedEnclave({ enclaveId: "test-enclave", imageLabel: "img:v1", modelId: "m" });

  it("binds input/output hashes and signs receipts with the enclave key", () => {
    const run = enclave.run(() => ({ output: { answer: 42 }, verdict: "completed", confidenceBps: 9_000 }), {
      subjectKind: "task",
      subjectId: 1n,
      agentId: "worker.aegis-swarm.testnet",
      inputHash: "aa".repeat(32),
      schemaHash: "bb".repeat(32),
      issuedAtNs: 1n,
      nonce: "n1",
    });
    expect(run.signed.receipt.measurement).toBe(measurementFor("img:v1"));
    expect(run.signed.receipt.output_hash).toBe(run.outputHash);
    expect(enclave.verify(run.signed)).toBe(true);
    const tampered = { ...run.signed, receipt: { ...run.signed.receipt, confidence_bps: 10_000 } };
    expect(verifyEnclaveSignature(tampered, enclave.identity.publicKey)).toBe(false);
    const other = new SimulatedEnclave({ enclaveId: "other", imageLabel: "img:v1", modelId: "m" });
    expect(verifyEnclaveSignature(run.signed, other.identity.publicKey)).toBe(false);
  });
});

describe("Chain Signatures tooling", () => {
  it("derives EIP-55 addresses (private key 1 → 0x7E5F…5Bdf)", () => {
    const pub = secp256k1.getPublicKey(fromHex("00".repeat(31) + "01"), false);
    expect(evmAddressFromPublicKey(pub)).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  });

  it("simulated MPC signatures recover to the address derived with the MPC KDF", () => {
    const mpc = new SimulatedMpcSigner("unit-test-root");
    const commitment = settlementCommitment({
      intent_id: "5",
      nep413_hash: "cd".repeat(32),
      quote: null,
      destination_chain: "arb",
      recipient: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
      amount: "12000000000000000000000000",
      min_amount_out: "56282000",
    });
    const payload = mpcPayload(commitment);
    const out = mpc.call({
      vm: undefined as never,
      receiverId: "v1.signer-prod.testnet",
      predecessorId: "aegis-swarm.testnet",
      signerId: "rhea.aegis-swarm.testnet",
      methodName: "sign",
      args: utf8(JSON.stringify({ request: { path: "aegis-treasury/arb", payload_v2: { Ecdsa: toHex(payload) }, domain_id: 0 } })),
      deposit: 1n,
    });
    const resp = JSON.parse(new TextDecoder().decode(out.value)) as {
      scheme: string;
      big_r: { affine_point: string };
      s: { scalar: string };
      recovery_id: number;
    };
    expect(resp.scheme).toBe("Secp256k1");
    const sig: MpcSignatureT = { big_r: resp.big_r.affine_point, s: resp.s.scalar, recovery_id: resp.recovery_id };
    expect(recoverEvmAddress(payload, sig)).toBe(mpc.addressFor("aegis-swarm.testnet", "aegis-treasury/arb"));
    expect(mpc.addressFor("aegis-swarm.testnet", "aegis-treasury/base")).not.toBe(mpc.addressFor("aegis-swarm.testnet", "aegis-treasury/arb"));
  });

  it("rejects sign calls without the 1 yoctoNEAR deposit", () => {
    const mpc = new SimulatedMpcSigner();
    expect(() =>
      mpc.call({
        vm: undefined as never,
        receiverId: "v1.signer-prod.testnet",
        predecessorId: "x.testnet",
        signerId: "x.testnet",
        methodName: "sign",
        args: utf8(JSON.stringify({ request: { path: "p", payload_v2: { Ecdsa: "00".repeat(32) }, domain_id: 0 } })),
        deposit: 0n,
      }),
    ).toThrow(/deposit/);
  });
});

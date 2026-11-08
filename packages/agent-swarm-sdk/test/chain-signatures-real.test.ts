import { describe, expect, it } from "vitest";

import {
  deriveChildPublicKey,
  deriveTweak,
  fromBase58,
  recoverEvmAddress,
  SimulatedMpcSigner,
  TESTNET_MPC_CONTRACT,
  toBase58,
  toEvmSignature,
} from "../src/index.ts";

/** View-calls the real testnet MPC contract. */
async function view(method: string, args: unknown): Promise<string> {
  const res = await fetch("https://rpc.testnet.near.org", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: TESTNET_MPC_CONTRACT,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const j = (await res.json()) as { result?: { result: number[] }; error?: unknown };
  if (!j.result) throw new Error(`RPC error: ${JSON.stringify(j.error)}`);
  return JSON.parse(Buffer.from(j.result.result).toString()) as string;
}

describe("Chain Signatures: offline derivation vectors & simulation", () => {
  const sim = new SimulatedMpcSigner("test-root-seed");

  it("derives deterministic tweaks for predecessor and path", () => {
    const tweak1 = deriveTweak("phalanx.testnet", "phalanx-treasury/arb");
    const tweak2 = deriveTweak("phalanx.testnet", "phalanx-treasury/arb");
    const tweakOther = deriveTweak("phalanx.testnet", "phalanx-treasury/base");

    expect(tweak1).toBe(tweak2);
    expect(tweak1).toBeGreaterThan(0n);
    expect(tweak1).not.toBe(tweakOther);
  });

  it("derives distinct EVM addresses for distinct chain paths", () => {
    const arbAddr = sim.addressFor("phalanx.testnet", "phalanx-treasury/arb");
    const baseAddr = sim.addressFor("phalanx.testnet", "phalanx-treasury/base");
    const solAddr = sim.addressFor("phalanx.testnet", "phalanx-treasury/sol");

    expect(arbAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(baseAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(solAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);

    expect(arbAddr).not.toBe(baseAddr);
    expect(arbAddr).not.toBe(solAddr);
  });

  it("simulated MPC signing produces valid signatures recovered via recoverEvmAddress", () => {
    const path = "phalanx-treasury/arb";
    const predecessorId = "phalanx.testnet";
    const expectedAddress = sim.addressFor(predecessorId, path);

    const payload = new Uint8Array(32);
    payload.fill(0x42);
    const payloadHex = Buffer.from(payload).toString("hex");

    const callRes = sim.call({
      vm: undefined as never,
      receiverId: "v1.signer-prod.testnet",
      predecessorId,
      signerId: predecessorId,
      methodName: "sign",
      args: Buffer.from(JSON.stringify({ request: { path, payload_v2: { Ecdsa: payloadHex } } })),
      deposit: 1n,
    });

    const parsed = JSON.parse(Buffer.from(callRes.value).toString()) as {
      big_r: { affine_point: string };
      s: { scalar: string };
      recovery_id: number;
    };

    const signature = {
      big_r: parsed.big_r.affine_point,
      s: parsed.s.scalar,
      recovery_id: parsed.recovery_id,
    };

    const recovered = recoverEvmAddress(payload, signature);
    expect(recovered.toLowerCase()).toBe(expectedAddress.toLowerCase());

    const evmSig = toEvmSignature(signature);
    expect(evmSig.r).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(evmSig.s).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect([27, 28]).toContain(evmSig.v);
  });
});

describe("Chain Signatures: SDK derivation vs the real MPC contract", () => {
  // Gated: proves deriveChildPublicKey reproduces v1.signer-prod.testnet.derived_public_key exactly.
  it.runIf(process.env.PHALANX_LIVE_MPC === "1")(
    "derives the same secp256k1 key as v1.signer-prod.testnet.derived_public_key",
    async () => {
      const predecessor = "phalanx-test.testnet";
      const path = "phalanx-treasury/arb";
      const rootStr = await view("public_key", { domain_id: 0 });
      const realDerived = await view("derived_public_key", { path, predecessor, domain_id: 0 });

      const rootRaw = fromBase58(rootStr.replace("secp256k1:", "")); // 64-byte NEAR secp256k1 key
      const uncompressed = new Uint8Array(65);
      uncompressed[0] = 0x04;
      uncompressed.set(rootRaw, 1);
      const child = deriveChildPublicKey(uncompressed, predecessor, path); // 65 bytes
      const sdkDerived = `secp256k1:${toBase58(child.slice(1))}`;

      expect(sdkDerived).toBe(realDerived);
    },
    40_000,
  );
});

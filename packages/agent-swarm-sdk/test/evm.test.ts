/** EIP-1559 encoding, MPC-signed transaction assembly and sender recovery. */
import { describe, expect, it } from "vitest";

import {
  assembleSignedTx,
  buildEvmTx,
  erc20TransferData,
  fromHex,
  keccak256Bytes,
  rlpDecode,
  recoverTxSender,
  SimulatedMpcSigner,
  toHex,
  utf8,
  VENDOR_EVM,
  type EvmTransferRequestT,
  type MpcSignatureT,
} from "../src/index.ts";

const request: EvmTransferRequestT = {
  chain: "basesepolia",
  to: VENDOR_EVM,
  asset: "native",
  amount: "1000000000000000",
  nonce: "3",
  gas_limit: "21000",
  max_fee_per_gas: "2000000000",
  max_priority_fee_per_gas: "1000000000",
  memo: null,
  attestation: null,
};

function mpcSign(mpc: SimulatedMpcSigner, predecessor: string, path: string, payload: Uint8Array): MpcSignatureT {
  const out = mpc.call({
    vm: undefined as never,
    receiverId: "v1.signer-prod.testnet",
    predecessorId: predecessor,
    signerId: predecessor,
    methodName: "sign",
    args: utf8(JSON.stringify({ request: { path, payload_v2: { Ecdsa: toHex(payload) }, domain_id: 0 } })),
    deposit: 1n,
  });
  const r = JSON.parse(new TextDecoder().decode(out.value)) as { big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number };
  return { big_r: r.big_r.affine_point, s: r.s.scalar, recovery_id: r.recovery_id };
}

describe("EVM transactions signed through Chain Signatures", () => {
  it("decodes back to the exact EIP-1559 fields", () => {
    const built = buildEvmTx({ chain_id: 84_532 }, request);
    expect(built.unsignedTx[0]).toBe(0x02);
    const fields = rlpDecode(built.unsignedTx.slice(1)) as Uint8Array[];
    expect(fields).toHaveLength(9);
    expect(BigInt(`0x${toHex(fields[0]!)}`)).toBe(84_532n);
    expect(BigInt(`0x${toHex(fields[1]!)}`)).toBe(3n);
    expect(`0x${toHex(fields[5]!)}`).toBe(VENDOR_EVM.toLowerCase());
    expect(BigInt(`0x${toHex(fields[6]!)}`)).toBe(10n ** 15n);
    expect(fields[7]).toHaveLength(0);
    expect(fields[8]).toEqual([]);
  });

  it("ERC-20 transfers move value into calldata to the token contract", () => {
    const token = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
    const built = buildEvmTx({ chain_id: 84_532 }, { ...request, asset: token, amount: "2500000", gas_limit: "65000" });
    expect(built.txTo).toBe(token);
    expect(built.txValue).toBe(0n);
    expect(toHex(built.data)).toBe(toHex(erc20TransferData(VENDOR_EVM, 2_500_000n)));
    expect(toHex(built.data).slice(0, 8)).toBe("a9059cbb");
  });

  it("assembles a raw transaction whose sender is the MPC-derived treasury address", () => {
    const mpc = new SimulatedMpcSigner("evm-test-root");
    const built = buildEvmTx({ chain_id: 84_532 }, request);
    const sig = mpcSign(mpc, "aegis-swarm.testnet", "aegis-treasury/basesepolia", built.signingHash);
    const { rawTx, txHash } = assembleSignedTx(built, sig);
    expect(txHash).toBe(`0x${toHex(keccak256Bytes(fromHex(rawTx)))}`);
    const decoded = rlpDecode(fromHex(rawTx).slice(1)) as Uint8Array[];
    expect(decoded).toHaveLength(12);
    expect(recoverTxSender(built.signingHash, sig)).toBe(mpc.addressFor("aegis-swarm.testnet", "aegis-treasury/basesepolia"));
    expect(recoverTxSender(built.signingHash, sig)).not.toBe(mpc.addressFor("aegis-swarm.testnet", "aegis-treasury/base"));
  });
});

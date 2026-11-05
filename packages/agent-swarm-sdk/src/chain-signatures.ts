/**
 * Chain Signatures tooling.
 *
 * - `deriveTweak` / `deriveChildPublicKey` reproduce the MPC network's key derivation
 *   (`sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" + predecessor + "," + path)`,
 *   child = root + tweak·G), so the EVM address controlled by `aegis-core` for a path can be
 *   computed off-chain from the MPC root key (`v1.signer-prod.testnet` → `public_key`).
 * - `recoverEvmAddress` turns an MPC `SignatureResponse` into the signer's EVM address, which is
 *   exactly what an EVM contract's `ecrecover` would see for the EIP-191 settlement digest.
 * - `SimulatedMpcSigner` mounts at the MPC account inside AegisSim and answers `sign` with a
 *   real secp256k1 signature from a locally held root key. It is labeled as a simulation in
 *   every UI and log line; on testnet the same contract call goes to the real MPC network.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";

import { fromHex, fromUtf8, keccak256Bytes, sha256Bytes, sha3_256Bytes, toHex, utf8 } from "./encoding.ts";
import type { ExternalCallContext, ExternalContract } from "./sandbox/near-vm.ts";
import type { MpcSignatureT } from "./types.ts";

export const MPC_TWEAK_PREFIX = "near-mpc-recovery v0.1.0 epsilon derivation:";
export const TESTNET_MPC_CONTRACT = "v1.signer-prod.testnet";
export const MAINNET_MPC_CONTRACT = "v1.signer";

const N = secp256k1.Point.Fn.ORDER;

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(`0x${toHex(bytes)}`);
}

function bigIntTo32(v: bigint): Uint8Array {
  return fromHex(v.toString(16).padStart(64, "0"));
}

export function deriveTweak(predecessorId: string, path: string): bigint {
  return bytesToBigInt(sha3_256Bytes(`${MPC_TWEAK_PREFIX}${predecessorId},${path}`)) % N;
}

/** Uncompressed (65-byte) child public key controlled by `predecessorId` at `path`. */
export function deriveChildPublicKey(rootPublicKey: Uint8Array, predecessorId: string, path: string): Uint8Array {
  const root = secp256k1.Point.fromBytes(rootPublicKey);
  return root.add(secp256k1.Point.BASE.multiply(deriveTweak(predecessorId, path))).toBytes(false);
}

/** EIP-55 checksummed address of an uncompressed secp256k1 public key. */
export function evmAddressFromPublicKey(uncompressed: Uint8Array): string {
  const point = uncompressed.length === 65 ? uncompressed : secp256k1.Point.fromBytes(uncompressed).toBytes(false);
  const addr = toHex(keccak256Bytes(point.slice(1)).slice(12));
  const hash = toHex(keccak256Bytes(utf8(addr)));
  let out = "0x";
  for (let i = 0; i < addr.length; i++) {
    const c = addr.charAt(i);
    out += parseInt(hash.charAt(i), 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/** Recovers the EVM address that produced an MPC signature over a 32-byte payload. */
export function recoverEvmAddress(payload: Uint8Array, signature: MpcSignatureT): string {
  const r = fromHex(signature.big_r).slice(1);
  const s = fromHex(signature.s);
  const recovered = new Uint8Array(65);
  recovered[0] = signature.recovery_id & 1;
  recovered.set(r, 1);
  recovered.set(s, 33);
  const pub = secp256k1.recoverPublicKey(recovered, payload, { prehash: false });
  return evmAddressFromPublicKey(secp256k1.Point.fromBytes(pub).toBytes(false));
}

/** `{ r, s, v }` in the form EVM contracts expect (`v = recovery_id + 27`). */
export function toEvmSignature(signature: MpcSignatureT): { r: string; s: string; v: number } {
  return { r: `0x${signature.big_r.slice(2)}`, s: `0x${signature.s}`, v: (signature.recovery_id & 1) + 27 };
}

interface SignArgs {
  request?: { path?: string; payload_v2?: { Ecdsa?: string }; payload?: number[]; domain_id?: number; key_version?: number };
}

export interface MpcSignLogEntry {
  predecessorId: string;
  path: string;
  payload: string;
  signature: MpcSignatureT;
  address: string;
}

export class SimulatedMpcSigner implements ExternalContract {
  readonly rootPublicKey: Uint8Array;
  readonly log: MpcSignLogEntry[] = [];
  private readonly rootSecret: bigint;

  constructor(seed = "aegis-sim-mpc-root-key") {
    this.rootSecret = (bytesToBigInt(sha256Bytes(seed)) % (N - 1n)) + 1n;
    this.rootPublicKey = secp256k1.getPublicKey(bigIntTo32(this.rootSecret), false);
  }

  /** EVM address the MPC network would derive for `predecessorId` + `path`. */
  addressFor(predecessorId: string, path: string): string {
    return evmAddressFromPublicKey(deriveChildPublicKey(this.rootPublicKey, predecessorId, path));
  }

  call(ctx: ExternalCallContext): { value: Uint8Array; logs: string[] } {
    if (ctx.methodName !== "sign") throw new Error(`MPC: method ${ctx.methodName} not supported`);
    if (ctx.deposit < 1n) throw new Error("MPC: sign requires an attached deposit of 1 yoctoNEAR");
    const args = JSON.parse(fromUtf8(ctx.args)) as SignArgs;
    const request = args.request;
    if (!request?.path) throw new Error("MPC: missing request.path");
    const domain = request.domain_id ?? request.key_version ?? 0;
    if (domain !== 0) throw new Error(`MPC: domain ${domain} is not a secp256k1 domain in this simulation`);
    const payloadHex = request.payload_v2?.Ecdsa ?? (request.payload ? toHex(Uint8Array.from(request.payload)) : undefined);
    if (!payloadHex || payloadHex.length !== 64) throw new Error("MPC: Ecdsa payload must be 32 bytes");
    const payload = fromHex(payloadHex);

    const childSecret = (this.rootSecret + deriveTweak(ctx.predecessorId, request.path)) % N;
    const sig = secp256k1.sign(payload, bigIntTo32(childSecret), { prehash: false, format: "recovered" });
    const recovery = sig[0] ?? 0;
    const bigR = new Uint8Array(33);
    bigR[0] = 0x02 | (recovery & 1);
    bigR.set(sig.slice(1, 33), 1);
    const signature: MpcSignatureT = { big_r: toHex(bigR), s: toHex(sig.slice(33, 65)), recovery_id: recovery };
    const address = this.addressFor(ctx.predecessorId, request.path);
    this.log.push({ predecessorId: ctx.predecessorId, path: request.path, payload: payloadHex, signature, address });

    const response = {
      scheme: "Secp256k1",
      big_r: { affine_point: signature.big_r },
      s: { scalar: signature.s },
      recovery_id: signature.recovery_id,
    };
    return {
      value: utf8(JSON.stringify(response)),
      logs: [`sign: predecessor=${ctx.predecessorId} path=${request.path} (AegisSim simulated MPC responder)`],
    };
  }
}

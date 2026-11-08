/**
 * Byte-level primitives shared by every module. Each function mirrors a Rust helper in
 * `contracts/phalanx-core/src/codec.rs` (or a borsh layout used by the contract) and is covered
 * by parity tests against the compiled WASM.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256, sha3_256 } from "@noble/hashes/sha3.js";
import { base58, base64, hex } from "@scure/base";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const ONE_NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function toHex(bytes: Uint8Array): string {
  return hex.encode(bytes);
}

export function fromHex(s: string): Uint8Array {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return hex.decode(body.toLowerCase());
}

export function toBase58(bytes: Uint8Array): string {
  return base58.encode(bytes);
}

export function fromBase58(s: string): Uint8Array {
  return base58.decode(s);
}

export function toBase64(bytes: Uint8Array): string {
  return base64.encode(bytes);
}

export function fromBase64(s: string): Uint8Array {
  return base64.decode(s);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function sha256Bytes(data: Uint8Array | string): Uint8Array {
  return sha256(typeof data === "string" ? utf8(data) : data);
}

export function sha256Hex(data: Uint8Array | string): string {
  return toHex(sha256Bytes(data));
}

export function keccak256Bytes(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

export function sha3_256Bytes(data: Uint8Array | string): Uint8Array {
  return sha3_256(typeof data === "string" ? utf8(data) : data);
}

/** Little-endian borsh writer for the primitive types the protocol uses. */
export class BorshWriter {
  private readonly parts: Uint8Array[] = [];

  u8(v: number): this {
    this.parts.push(Uint8Array.of(v & 0xff));
    return this;
  }

  u32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.parts.push(b);
    return this;
  }

  u64(v: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, v), true);
    this.parts.push(b);
    return this;
  }

  u128(v: bigint): this {
    const b = new Uint8Array(16);
    const view = new DataView(b.buffer);
    view.setBigUint64(0, BigInt.asUintN(64, v), true);
    view.setBigUint64(8, BigInt.asUintN(64, v >> 64n), true);
    this.parts.push(b);
    return this;
  }

  /** Raw bytes without a length prefix (fixed-size arrays). */
  raw(bytes: Uint8Array): this {
    this.parts.push(bytes);
    return this;
  }

  /** `u32` length prefix followed by UTF-8 bytes. */
  string(s: string): this {
    const b = utf8(s);
    this.u32(b.length);
    this.parts.push(b);
    return this;
  }

  toBytes(): Uint8Array {
    return concatBytes(...this.parts);
  }
}

export function readU128LE(bytes: Uint8Array): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
  return view.getBigUint64(0, true) | (view.getBigUint64(8, true) << 64n);
}

export function u128ToLE(v: bigint): Uint8Array {
  return new BorshWriter().u128(v).toBytes();
}

/** `Date.prototype.toISOString()` for a nanosecond timestamp (identical to `format_iso8601_millis`). */
export function isoMillis(ns: bigint): string {
  return new Date(Number(ns / 1_000_000n)).toISOString();
}

/**
 * Sorted-key JSON without whitespace. For the ASCII-safe strings the contract accepts, the
 * output is byte-identical to serde_json serializing a struct with alphabetically ordered fields.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") throw new TypeError("canonicalJson: encode bigint values as strings");
    if (value === undefined) throw new TypeError("canonicalJson: undefined is not JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export interface Ed25519KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  /** `ed25519:<base58 32 bytes>` */
  publicKeyString: string;
  /** NEAR secret-key string: `ed25519:<base58(secret || public)>` */
  secretKeyString: string;
}

export function keyPairFromSecret(secretKey: Uint8Array): Ed25519KeyPair {
  const publicKey = ed25519.getPublicKey(secretKey);
  return {
    secretKey,
    publicKey,
    publicKeyString: `ed25519:${toBase58(publicKey)}`,
    secretKeyString: `ed25519:${toBase58(concatBytes(secretKey, publicKey))}`,
  };
}

/** Deterministic key pair: the secret is `sha256(seed)`. */
export function keyPairFromSeed(seed: string): Ed25519KeyPair {
  return keyPairFromSecret(sha256Bytes(seed));
}

export function keyPairFromSecretString(s: string): Ed25519KeyPair {
  const raw = fromBase58(s.replace(/^ed25519:/, ""));
  return keyPairFromSecret(raw.slice(0, 32));
}

export function randomKeyPair(): Ed25519KeyPair {
  return keyPairFromSecret(ed25519.utils.randomSecretKey());
}

/** `ed25519:<base58 64-byte signature>` */
export function signEd25519(keyPair: Ed25519KeyPair, message: Uint8Array): string {
  return `ed25519:${toBase58(ed25519.sign(message, keyPair.secretKey))}`;
}

export function parsePublicKey(pk: string): Uint8Array {
  if (!pk.startsWith("ed25519:")) throw new Error(`unsupported key type: ${pk}`);
  const raw = fromBase58(pk.slice("ed25519:".length));
  if (raw.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  return raw;
}

export function verifyEd25519(signature: string, message: Uint8Array, publicKey: string): boolean {
  try {
    const sig = fromBase58(signature.replace(/^ed25519:/, ""));
    return sig.length === 64 && ed25519.verify(sig, message, parsePublicKey(publicKey));
  } catch {
    return false;
  }
}

/** Borsh `PublicKey`: one curve-type byte (0 = ed25519) followed by the key. */
export function publicKeyToBorsh(pk: string): Uint8Array {
  return concatBytes(Uint8Array.of(0), parsePublicKey(pk));
}

export function publicKeyFromBorsh(bytes: Uint8Array): string {
  if (bytes[0] !== 0 || bytes.length !== 33) throw new Error("only ed25519 public keys are supported");
  return `ed25519:${toBase58(bytes.slice(1))}`;
}

/** Exact decimal NEAR string → yoctoNEAR. */
export function parseNear(amount: string | number): bigint {
  const s = typeof amount === "number" ? amount.toString() : amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid NEAR amount: ${s}`);
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > 24) throw new Error("more than 24 decimals");
  return BigInt(whole) * ONE_NEAR + BigInt(frac.padEnd(24, "0") || "0");
}

/** yoctoNEAR → decimal NEAR string with `decimals` digits (truncated). */
export function formatNear(yocto: bigint | string, decimals = 4): string {
  const v = typeof yocto === "string" ? BigInt(yocto) : yocto;
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / ONE_NEAR;
  const frac = (abs % ONE_NEAR).toString().padStart(24, "0").slice(0, decimals);
  const body = decimals > 0 ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/** Deterministic 32-byte value from a label (nonces, salts, seeds). */
export function deterministicBytes(label: string): Uint8Array {
  return sha256Bytes(`phalanx-deterministic:${label}`);
}

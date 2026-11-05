/**
 * EVM side of Chain Signatures spending (mirrors `contracts/aegis-core/src/evm.rs`).
 *
 * - `buildEvmTx` reproduces the exact EIP-1559 transaction the contract builds for an
 *   `EvmTransferRequest`, so its `signing_hash` can be checked against the contract's preview.
 * - `assembleSignedTx` / `recoverTxSender` turn an MPC `SignatureResponse` into the raw signed
 *   transaction and the sender address (the treasury's derived Chain Signatures address).
 * - `EvmRpc` is a minimal JSON-RPC client for nonce / fee lookup, broadcasting and receipts.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";

import { evmAddressFromPublicKey } from "./chain-signatures.ts";
import { concatBytes, fromHex, keccak256Bytes, toHex } from "./encoding.ts";
import type { EvmChainPolicyT, EvmTransferRequestT, MpcSignatureT } from "./types.ts";

export const NATIVE_ASSET = "native";
const ERC20_TRANSFER_SELECTOR = "a9059cbb";

function beBytes(v: bigint): Uint8Array {
  if (v < 0n) throw new Error("RLP integers are unsigned");
  if (v === 0n) return new Uint8Array(0);
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return fromHex(hex);
}

function lengthPrefix(len: number, offset: number): Uint8Array {
  if (len < 56) return Uint8Array.of(offset + len);
  const lb = beBytes(BigInt(len));
  return concatBytes(Uint8Array.of(offset + 55 + lb.length), lb);
}

export function rlpBytes(data: Uint8Array): Uint8Array {
  if (data.length === 1 && data[0]! < 0x80) return data;
  return concatBytes(lengthPrefix(data.length, 0x80), data);
}

export function rlpUint(v: bigint | number | string): Uint8Array {
  return rlpBytes(beBytes(BigInt(v)));
}

/** Strips leading zero bytes (r and s are integers in RLP). */
export function rlpUintBytes(be: Uint8Array): Uint8Array {
  let i = 0;
  while (i < be.length && be[i] === 0) i++;
  return rlpBytes(be.slice(i));
}

export function rlpList(payload: Uint8Array): Uint8Array {
  return concatBytes(lengthPrefix(payload.length, 0xc0), payload);
}

export type RlpItem = Uint8Array<ArrayBufferLike> | RlpItem[];

/** Minimal RLP decoder (used by tests and the relayer's sanity checks). */
export function rlpDecode(input: Uint8Array): RlpItem {
  const [item, rest] = decodeOne(input);
  if (rest.length) throw new Error("RLP: trailing bytes");
  return item;
}

function decodeOne(b: Uint8Array<ArrayBufferLike>): [RlpItem, Uint8Array<ArrayBufferLike>] {
  const p = b[0];
  if (p === undefined) throw new Error("RLP: empty input");
  const readLen = (n: number) => Number(BigInt(`0x${toHex(b.slice(1, 1 + n)) || "0"}`));
  if (p < 0x80) return [b.slice(0, 1), b.slice(1)];
  if (p < 0xb8) return [b.slice(1, 1 + p - 0x80), b.slice(1 + p - 0x80)];
  if (p < 0xc0) {
    const n = p - 0xb7;
    const len = readLen(n);
    return [b.slice(1 + n, 1 + n + len), b.slice(1 + n + len)];
  }
  let start: number;
  let len: number;
  if (p < 0xf8) {
    start = 1;
    len = p - 0xc0;
  } else {
    const n = p - 0xf7;
    start = 1 + n;
    len = readLen(n);
  }
  let body: Uint8Array<ArrayBufferLike> = b.slice(start, start + len);
  const items: RlpItem[] = [];
  while (body.length) {
    const [item, rest] = decodeOne(body);
    items.push(item);
    body = rest;
  }
  return [items, b.slice(start + len)];
}

export interface Eip1559Fields {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string;
  value: bigint;
  data: Uint8Array;
}

/** RLP payload of `[chain_id, nonce, tip, max_fee, gas, to, value, data, []]` (no list header). */
export function eip1559Payload(f: Eip1559Fields): Uint8Array {
  return concatBytes(
    rlpUint(f.chainId),
    rlpUint(f.nonce),
    rlpUint(f.maxPriorityFeePerGas),
    rlpUint(f.maxFeePerGas),
    rlpUint(f.gasLimit),
    rlpBytes(fromHex(f.to)),
    rlpUint(f.value),
    rlpBytes(f.data),
    Uint8Array.of(0xc0),
  );
}

export function typedTx(payload: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(0x02), rlpList(payload));
}

export function signedTypedTx(payload: Uint8Array, yParity: number, r: Uint8Array, s: Uint8Array): Uint8Array {
  return typedTx(concatBytes(payload, rlpUint(yParity), rlpUintBytes(r), rlpUintBytes(s)));
}

/** ERC-20 `transfer(address,uint256)` calldata. */
export function erc20TransferData(to: string, amount: bigint): Uint8Array {
  return fromHex(`${ERC20_TRANSFER_SELECTOR}${"0".repeat(24)}${to.replace(/^0x/, "").toLowerCase()}${amount.toString(16).padStart(64, "0")}`);
}

export interface BuiltEvmTx {
  fields: Eip1559Fields;
  payload: Uint8Array;
  unsignedTx: Uint8Array;
  signingHash: Uint8Array;
  txTo: string;
  txValue: bigint;
  data: Uint8Array;
}

/** The transaction `aegis-core` signs for `request` under `chain` (byte-identical to the contract). */
export function buildEvmTx(chain: Pick<EvmChainPolicyT, "chain_id">, request: EvmTransferRequestT): BuiltEvmTx {
  const native = request.asset === NATIVE_ASSET;
  const txTo = native ? request.to.toLowerCase() : request.asset;
  const txValue = native ? BigInt(request.amount) : 0n;
  const data = native ? new Uint8Array(0) : erc20TransferData(request.to, BigInt(request.amount));
  const fields: Eip1559Fields = {
    chainId: BigInt(chain.chain_id),
    nonce: BigInt(request.nonce),
    maxPriorityFeePerGas: BigInt(request.max_priority_fee_per_gas),
    maxFeePerGas: BigInt(request.max_fee_per_gas),
    gasLimit: BigInt(request.gas_limit),
    to: txTo,
    value: txValue,
    data,
  };
  const payload = eip1559Payload(fields);
  const unsignedTx = typedTx(payload);
  return { fields, payload, unsignedTx, signingHash: keccak256Bytes(unsignedTx), txTo, txValue, data };
}

/** Raw signed transaction and its hash from an MPC `SignatureResponse`. */
export function assembleSignedTx(built: Pick<BuiltEvmTx, "payload">, signature: MpcSignatureT): { rawTx: string; txHash: string } {
  const r = fromHex(signature.big_r).slice(1, 33);
  const s = fromHex(signature.s);
  const raw = signedTypedTx(built.payload, signature.recovery_id & 1, r, s);
  return { rawTx: `0x${toHex(raw)}`, txHash: `0x${toHex(keccak256Bytes(raw))}` };
}

/** Sender of a signed EIP-1559 transaction: who `eth_sendRawTransaction` will charge. */
export function recoverTxSender(signingHash: Uint8Array, signature: MpcSignatureT): string {
  const recovered = new Uint8Array(65);
  recovered[0] = signature.recovery_id & 1;
  recovered.set(fromHex(signature.big_r).slice(1, 33), 1);
  recovered.set(fromHex(signature.s), 33);
  const pub = secp256k1.recoverPublicKey(recovered, signingHash, { prehash: false });
  return evmAddressFromPublicKey(secp256k1.Point.fromBytes(pub).toBytes(false));
}

/** Well-known chains the treasury policy and relayer support out of the box. */
export const EVM_CHAINS: Record<string, { chainId: number; rpc: string; explorer: string; label: string }> = {
  basesepolia: { chainId: 84_532, rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org", label: "Base Sepolia" },
  base: { chainId: 8_453, rpc: "https://mainnet.base.org", explorer: "https://basescan.org", label: "Base" },
  arbsepolia: { chainId: 421_614, rpc: "https://sepolia-rollup.arbitrum.io/rpc", explorer: "https://sepolia.arbiscan.io", label: "Arbitrum Sepolia" },
  arb: { chainId: 42_161, rpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io", label: "Arbitrum One" },
};

export interface EvmReceipt {
  status: string;
  blockNumber: string;
  transactionHash: string;
  from: string;
  to: string | null;
  gasUsed: string;
}

/** Minimal Ethereum JSON-RPC client. */
export class EvmRpc {
  constructor(
    readonly url: string,
    private readonly fetchImpl: typeof fetch = (...a: Parameters<typeof fetch>) => fetch(...a),
  ) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
        const body = (await res.json()) as { result?: T; error?: { message?: string } };
        if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
        return body.result as T;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  async chainId(): Promise<bigint> {
    return BigInt(await this.call<string>("eth_chainId", []));
  }
  async nonce(address: string): Promise<bigint> {
    return BigInt(await this.call<string>("eth_getTransactionCount", [address, "pending"]));
  }
  async balance(address: string): Promise<bigint> {
    return BigInt(await this.call<string>("eth_getBalance", [address, "latest"]));
  }
  /** `max_fee = 2 * base_fee + tip` with the node's suggested tip (floored at 1 gwei / 1000). */
  async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const block = await this.call<{ baseFeePerGas?: string }>("eth_getBlockByNumber", ["latest", false]);
    const base = BigInt(block.baseFeePerGas ?? "0x0");
    let tip = 1_000_000n;
    try {
      tip = BigInt(await this.call<string>("eth_maxPriorityFeePerGas", []));
    } catch {
      /* ignore */
    }
    if (tip < 1_000_000n) tip = 1_000_000n;
    return { maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip };
  }
  sendRawTransaction(rawTx: string): Promise<string> {
    return this.call<string>("eth_sendRawTransaction", [rawTx]);
  }
  receipt(txHash: string): Promise<EvmReceipt | null> {
    return this.call<EvmReceipt | null>("eth_getTransactionReceipt", [txHash]);
  }
  async waitForReceipt(txHash: string, timeoutMs = 120_000, pollMs = 3_000): Promise<EvmReceipt> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.receipt(txHash);
      if (r) return r;
      if (Date.now() > deadline) throw new Error(`no receipt for ${txHash} after ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

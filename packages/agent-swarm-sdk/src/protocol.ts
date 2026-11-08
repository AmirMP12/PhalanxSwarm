/**
 * Off-chain mirrors of every digest and message the contract computes. A signature produced
 * with these helpers verifies on-chain only if the bytes match exactly; parity tests compare
 * them against the compiled WASM (`compute_*` / `evaluate_intent` views) and the Rust golden
 * vector in `contracts/phalanx-core/src/tests.rs`.
 */
import { BorshWriter, canonicalJson, concatBytes, fromHex, isoMillis, keccak256Bytes, sha256Bytes, toHex, utf8 } from "./encoding.ts";
import type { CrossChainIntentRequestT, ExecutionReceiptT, IntentRecordT } from "./types.ts";

/** NEP-413 prefix tag, 2^31 + 413. */
export const NEP413_TAG = 2_147_484_061;
export const RECEIPT_DOMAIN = "PHALANX_TEE_RECEIPT_V1";
export const SETTLEMENT_DOMAIN = "PHALANX_SETTLEMENT_V1";
export const EIP191_PREFIX_32 = "\x19Ethereum Signed Message:\n32";
export const MAX_LATENCY_SEC = 86_400;

export type UnsignedIntentRequest = Omit<CrossChainIntentRequestT, "signature" | "attestation"> & {
  signature?: string;
  attestation?: CrossChainIntentRequestT["attestation"];
};

/** Canonical NEAR Intents message (`token_diff` + `phalanx` envelope) an agent signs. */
export function buildIntentMessage(signerId: string, req: UnsignedIntentRequest): string {
  const diff: Record<string, string> = {
    [req.origin_asset]: `-${req.amount}`,
    [req.destination_asset]: req.min_amount_out,
  };
  return canonicalJson({
    phalanx: {
      chain: req.destination_chain,
      contract: req.execution_contract,
      invoice: req.invoice_ref ?? "",
      kind: req.kind,
      memo: req.memo ?? "",
      quote_hash: req.quote?.quote_hash ?? "",
      recipient: req.recipient,
    },
    deadline: isoMillis(BigInt(req.deadline_ns)),
    intents: [{ diff, intent: "token_diff" }],
    signer_id: signerId,
  });
}

/** NEP-413 payload bytes: `u32(tag) || borsh({ message, nonce, recipient, callback_url: None })`. */
export function nep413PayloadBytes(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  if (nonce.length !== 32) throw new Error("NEP-413 nonce must be 32 bytes");
  return new BorshWriter().u32(NEP413_TAG).string(message).raw(nonce).string(recipient).u8(0).toBytes();
}

export function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  return sha256Bytes(nep413PayloadBytes(message, nonce, recipient));
}

/** Borsh-compatible signing bytes of an execution receipt (see `attestation.rs`). */
export function receiptSigningBytes(r: ExecutionReceiptT): Uint8Array {
  return new BorshWriter()
    .string(RECEIPT_DOMAIN)
    .string(r.subject_kind)
    .u64(BigInt(r.subject_id))
    .string(r.agent_id)
    .string(r.enclave_id)
    .string(r.measurement)
    .string(r.model_id)
    .string(r.input_hash)
    .string(r.output_hash)
    .string(r.schema_hash)
    .string(r.verdict)
    .u32(r.confidence_bps)
    .u64(BigInt(r.issued_at_ns))
    .string(r.nonce)
    .toBytes();
}

export function receiptDigest(r: ExecutionReceiptT): Uint8Array {
  return sha256Bytes(receiptSigningBytes(r));
}

/** Sealed-bid commitment: hex sha256 of `borsh(task_id, agent_id, price, latency, salt)`. */
export function bidCommitment(taskId: bigint | string, agentId: string, price: bigint | string, estLatencySec: number, salt: string): string {
  const bytes = new BorshWriter().u64(BigInt(taskId)).string(agentId).u128(BigInt(price)).u32(estLatencySec).string(salt).toBytes();
  return toHex(sha256Bytes(bytes));
}

export const NEARAI_BIND_PREFIX = "PHALANX-BIND:v1";

/** The marker a NEAR AI request must contain to count as a proof (see `attestation.rs`). */
export function nearAiBindingMarker(
  subjectKind: "task" | "intent" | "evm",
  subjectId: bigint | string,
  agentId: string,
  inputHash: string,
  nonce: string,
  issuedAtNs: bigint | string,
): string {
  return `${NEARAI_BIND_PREFIX}:${subjectKind}:${BigInt(subjectId)}:${agentId}:${inputHash}:${nonce}:${BigInt(issuedAtNs)}`;
}

/** What NEAR AI signs for a completion: `<sha256(request body)>:<sha256(response body)>`. */
export function nearAiSignedText(requestBody: string, responseBody: string): string {
  return `${toHex(sha256Bytes(requestBody))}:${toHex(sha256Bytes(responseBody))}`;
}

/** Settlement commitment the MPC network is asked to authorize (see `intents.rs`). */
export function settlementCommitment(
  record: Pick<IntentRecordT, "intent_id" | "nep413_hash" | "quote" | "destination_chain" | "recipient" | "amount" | "min_amount_out">,
): Uint8Array {
  const quoteHash = record.quote ? fromHex(record.quote.quote_hash) : new Uint8Array(32);
  const bytes = new BorshWriter()
    .raw(utf8(SETTLEMENT_DOMAIN))
    .u64(BigInt(record.intent_id))
    .raw(fromHex(record.nep413_hash))
    .raw(quoteHash)
    .string(record.destination_chain)
    .string(record.recipient)
    .u128(BigInt(record.amount))
    .u128(BigInt(record.min_amount_out))
    .toBytes();
  return sha256Bytes(bytes);
}

/** EIP-191 digest of a 32-byte commitment: what `ecrecover` checks on any EVM chain. */
export function mpcPayload(commitment: Uint8Array): Uint8Array {
  return keccak256Bytes(concatBytes(utf8(EIP191_PREFIX_32), commitment));
}

/** Weighted sealed-bid score in basis points (price 50%, latency 20%, reputation 30%). */
export function scoreBid(ceiling: bigint, price: bigint, estLatencySec: number, reputationBps: number): number {
  if (price <= 0n || price > ceiling) throw new Error("price must be in (0, ceiling]");
  const priceScore = Number(((ceiling - price) * 10_000n) / ceiling);
  const latency = Math.min(estLatencySec, MAX_LATENCY_SEC);
  const latencyScore = 10_000 - Math.floor((latency * 10_000) / MAX_LATENCY_SEC);
  const total = priceScore * 50 + latencyScore * 20 + Math.min(reputationBps, 10_000) * 30;
  return Math.floor(total / 100);
}

/** Linear reverse-Dutch price (see `swarm_market::dutch_price`). */
export function dutchPrice(start: bigint, ceiling: bigint, createdNs: bigint, deadlineNs: bigint, nowNs: bigint): bigint {
  if (nowNs <= createdNs) return start;
  if (nowNs >= deadlineNs || deadlineNs <= createdNs) return ceiling;
  return start + ((ceiling - start) * (nowNs - createdNs)) / (deadlineNs - createdNs);
}

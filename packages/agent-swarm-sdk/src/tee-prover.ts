/**
 * Deterministic TEE attestation and private-execution receipt generator.
 *
 * A `SimulatedEnclave` stands in for a confidential VM (NEAR AI Cloud runs models inside
 * Intel TDX CVMs with NVIDIA confidential GPUs). It has:
 * - a code measurement: `sha256("phalanx-enclave-image:" + imageLabel)`, playing the role of the
 *   TDX MRTD / RTMR digest that an attestation report binds;
 * - an ed25519 signing key that never leaves the object, playing the role of the key bound to
 *   that measurement by the attestation report.
 *
 * Jobs run inside `run()`; only `sha256` digests of inputs and outputs leave the enclave in the
 * signed `ExecutionReceipt`. The receipt format and the on-chain verification
 * (`attestation.rs`: registry lookup, measurement match, `env::ed25519_verify`, freshness and
 * replay checks) are real; the hardware isolation is simulated because this environment has no
 * TDX hardware. Swapping in a real enclave only requires registering its measurement and key.
 */
import { canonicalJson, keyPairFromSeed, sha256Hex, signEd25519, toHex, verifyEd25519, type Ed25519KeyPair } from "./encoding.ts";
import { receiptDigest } from "./protocol.ts";
import type { ExecutionReceiptT, SignedReceiptT } from "./types.ts";

export interface EnclaveIdentity {
  enclaveId: string;
  measurement: string;
  modelId: string;
  vendor: string;
  teeType: string;
  publicKey: string;
}

export interface EnclaveJobResult<O> {
  output: O;
  verdict: string;
  confidenceBps: number;
}

export interface EnclaveRunOptions {
  subjectKind: "task" | "intent";
  subjectId: bigint | string;
  agentId: string;
  /** Hex sha256 the receipt must bind as input (task spec hash or NEP-413 hash). */
  inputHash: string;
  schemaHash: string;
  issuedAtNs: bigint;
  nonce: string;
}

export interface EnclaveRun<O> {
  output: O;
  outputHash: string;
  signed: SignedReceiptT;
  receiptHash: string;
}

export function measurementFor(imageLabel: string): string {
  return sha256Hex(`phalanx-enclave-image:${imageLabel}`);
}

export function schemaHashFor(schemaId: string): string {
  return sha256Hex(schemaId);
}

export class SimulatedEnclave {
  readonly identity: EnclaveIdentity;
  private readonly keyPair: Ed25519KeyPair;

  constructor(opts: { enclaveId: string; imageLabel: string; modelId: string; vendor?: string; teeType?: string; seed?: string; measurement?: string }) {
    this.keyPair = keyPairFromSeed(opts.seed ?? `phalanx-enclave-key:${opts.enclaveId}`);
    this.identity = {
      enclaveId: opts.enclaveId,
      measurement: (opts.measurement ?? measurementFor(opts.imageLabel)).toLowerCase(),
      modelId: opts.modelId,
      vendor: opts.vendor ?? "Simulated NEAR AI Cloud CVM (Intel TDX + NVIDIA CC)",
      teeType: opts.teeType ?? "intel-tdx+nvidia-cc",
      publicKey: this.keyPair.publicKeyString,
    };
  }

  /**
   * Replaces the code measurement with one obtained elsewhere (e.g. a real, DCAP-verified
   * NEAR AI Cloud `mr_td`). The receipt-signing key is unchanged: in a self-hosted CVM the
   * attestation's report_data would commit to this key; here the operator asserts that binding.
   */
  setMeasurement(measurement: string, vendor?: string): void {
    this.identity.measurement = measurement.toLowerCase();
    if (vendor) this.identity.vendor = vendor;
  }

  /** Executes `job` "inside" the enclave and signs a receipt over the input/output digests. */
  run<O>(job: () => EnclaveJobResult<O>, opts: EnclaveRunOptions): EnclaveRun<O> {
    const result = job();
    const outputHash = sha256Hex(canonicalJson(result.output));
    const signed = this.attest({
      subject_kind: opts.subjectKind,
      subject_id: BigInt(opts.subjectId).toString(),
      agent_id: opts.agentId,
      enclave_id: this.identity.enclaveId,
      measurement: this.identity.measurement,
      model_id: this.identity.modelId,
      input_hash: opts.inputHash,
      output_hash: outputHash,
      schema_hash: opts.schemaHash,
      verdict: result.verdict,
      confidence_bps: result.confidenceBps,
      issued_at_ns: opts.issuedAtNs.toString(),
      nonce: opts.nonce,
    });
    return { output: result.output, outputHash, signed, receiptHash: toHex(receiptDigest(signed.receipt)) };
  }

  /** Signs an arbitrary receipt with the enclave key. */
  attest(receipt: ExecutionReceiptT): SignedReceiptT {
    return { receipt, signature: signEd25519(this.keyPair, receiptDigest(receipt)) };
  }

  /** Local check, identical to the cryptographic part of the on-chain verification. */
  verify(signed: SignedReceiptT): boolean {
    return signed.receipt.measurement === this.identity.measurement && verifyEnclaveSignature(signed, this.identity.publicKey);
  }
}

export function verifyEnclaveSignature(signed: SignedReceiptT, enclavePublicKey: string): boolean {
  return verifyEd25519(signed.signature, receiptDigest(signed.receipt), enclavePublicKey);
}

/** Arguments for `register_enclave`, built from an enclave identity. */
export function enclaveRegistrationArgs(identity: EnclaveIdentity): Record<string, string> {
  return {
    enclave_id: identity.enclaveId,
    measurement: identity.measurement,
    signer_public_key: identity.publicKey,
    vendor: identity.vendor,
    model_id: identity.modelId,
    tee_type: identity.teeType,
  };
}

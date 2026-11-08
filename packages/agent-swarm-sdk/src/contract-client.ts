/**
 * Typed client for `phalanx-core`. Views and call results are validated with the strict Zod
 * schemas in `types.ts`; every NEP-297 event in a call's logs is parsed as well.
 *
 * Two transports implement the same interface:
 * - `VmTransport`: the in-process PhalanxSim VM (local sandbox, CI, browser judge mode);
 * - `RpcTransport`: NEAR JSON-RPC `call_function` for views on testnet. Writes on testnet go
 *   through the user's wallet (see `apps/web/src/lib/wallet.ts`).
 */
import type { z } from "zod";

import { fromBase64, fromUtf8, toBase64, utf8 } from "./encoding.ts";
import { decodeJson, VmError, type NearVm, type TxOutcome } from "./sandbox/near-vm.ts";
import {
  AgentRecord,
  AttestationCheck,
  AuditFacts,
  BlockedRecipient,
  Dashboard,
  EvmNonceState,
  EvmTxPreview,
  EvmTxRecord,
  GlobalPolicy,
  IntentAssessment,
  IntentRecord,
  parsePhalanxEvents,
  RecipientCheck,
  SecurityEvent,
  TaskView,
  TreasuryReport,
  type PhalanxEventT,
  type CrossChainIntentRequestT,
  type EvmTransferRequestT,
  type ExecutionProofT,
  type ExecutionReceiptT,
} from "./types.ts";

export interface Signer {
  accountId: string;
  publicKey: string;
}

export interface CallOptions {
  deposit?: bigint;
  gas?: bigint;
}

export interface CallResult<T> {
  ok: boolean;
  value: T | null;
  /** Contract panic, failed receipt, or protocol-level rejection (e.g. access-key scope). */
  error: string | null;
  /** `null` when the transaction was rejected before execution. */
  outcome: TxOutcome | null;
  events: PhalanxEventT[];
  failedReceipts: Array<{ receiverId: string; error: string }>;
}

export interface PhalanxTransport {
  readonly contractId: string;
  view(method: string, args: Record<string, unknown>): Promise<unknown>;
}

export class VmTransport implements PhalanxTransport {
  constructor(
    readonly vm: NearVm,
    readonly contractId: string,
  ) {}

  async view(method: string, args: Record<string, unknown>): Promise<unknown> {
    const { value } = await this.vm.view(this.contractId, method, args);
    return decodeJson(value);
  }
}

export class RpcTransport implements PhalanxTransport {
  constructor(
    readonly rpcUrl: string,
    readonly contractId: string,
    private readonly fetchImpl: typeof fetch = (...a: Parameters<typeof fetch>) => fetch(...a),
  ) {}

  async view(method: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "phalanx",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "optimistic",
          account_id: this.contractId,
          method_name: method,
          args_base64: toBase64(utf8(JSON.stringify(args))),
        },
      }),
    });
    const body = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { message?: string; data?: unknown } };
    if (body.error) throw new Error(`RPC error: ${body.error.message ?? JSON.stringify(body.error)}`);
    if (body.result?.error) throw new Error(`view ${method} failed: ${body.result.error}`);
    const bytes = Uint8Array.from(body.result?.result ?? []);
    return decodeJson(bytes);
  }
}

/** Read-only API shared by both transports. */
export class PhalanxViews {
  constructor(readonly transport: PhalanxTransport) {}

  get contractId(): string {
    return this.transport.contractId;
  }

  async parse<T>(method: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    return schema.parse(await this.transport.view(method, args));
  }

  dashboard() {
    return this.parse("get_dashboard", {}, Dashboard);
  }
  treasury() {
    return this.parse("get_treasury", {}, TreasuryReport);
  }
  policy() {
    return this.parse("get_global_policy", {}, GlobalPolicy);
  }
  agent(agentId: string) {
    return this.parse("get_agent", { agent_id: agentId }, AgentRecord.nullable());
  }
  task(taskId: bigint | string) {
    return this.parse("get_task", { task_id: taskId.toString() }, TaskView.nullable());
  }
  intent(intentId: bigint | string) {
    return this.parse("get_intent", { intent_id: intentId.toString() }, IntentRecord.nullable());
  }
  securityEvents(limit = 30) {
    return this.parse("get_security_events", { limit }, SecurityEvent.array());
  }
  evaluateIntent(agentId: string, request: CrossChainIntentRequestT) {
    return this.parse("evaluate_intent", { agent_id: agentId, request }, IntentAssessment);
  }
  /** The facts a NEAR AI audit of this settlement must carry as its user message (built by the contract). */
  intentAuditFacts(agentId: string, request: CrossChainIntentRequestT) {
    return this.parse("get_intent_audit_facts", { agent_id: agentId, request }, AuditFacts);
  }
  /** The facts a NEAR AI audit of this EVM transfer must carry as its user message (built by the contract). */
  evmAuditFacts(agentId: string, request: EvmTransferRequestT) {
    return this.parse("get_evm_audit_facts", { agent_id: agentId, request }, AuditFacts);
  }
  /** The next nonce the treasury address signs on `chain`, and the transfer holding it. */
  evmNonce(chain: string) {
    return this.parse("get_evm_nonce", { chain }, EvmNonceState);
  }
  async policyVersion(): Promise<string> {
    return String(await this.transport.view("get_policy_version", {}));
  }
  /** Recent settlements and EVM transfers (newest first), for prior-interaction checks. */
  recentIntents(limit = 50) {
    return this.parse("list_intents", { limit }, IntentRecord.array());
  }
  recentEvmTxs(limit = 50) {
    return this.parse("list_evm_txs", { limit }, EvmTxRecord.array());
  }
  /** `promptHash`: the pinned system prompt a NEAR AI proof must use (see `promptHash(role)`). */
  verifyAttestation(proof: ExecutionProofT, promptHash: string | null = null) {
    return this.parse("verify_attestation", { proof, prompt_hash: promptHash }, AttestationCheck);
  }
  evmTx(txId: bigint | string) {
    return this.parse("get_evm_tx", { tx_id: txId.toString() }, EvmTxRecord.nullable());
  }
  previewEvmTransfer(request: EvmTransferRequestT) {
    return this.parse("preview_evm_transfer", { request }, EvmTxPreview);
  }
  async isRecipientAllowed(chain: string, recipient: string): Promise<boolean> {
    return Boolean(await this.transport.view("is_recipient_allowed", { chain, recipient }));
  }
  /** Allow, warn or block, with reasons: what an agent should know before it signs a payment. */
  checkRecipient(chain: string, recipient: string) {
    return this.parse("check_recipient", { chain, recipient }, RecipientCheck);
  }
  blockedRecipients(limit = 50) {
    return this.parse("list_blocked_recipients", { from_index: 0, limit }, BlockedRecipient.array());
  }
  async computeReceiptDigest(receipt: ExecutionReceiptT): Promise<string> {
    return String(await this.transport.view("compute_receipt_digest", { receipt }));
  }
  async computeBindingMarker(args: {
    subject_kind: string;
    subject_id: string;
    agent_id: string;
    input_hash: string;
    nonce: string;
    issued_at_ns: string;
  }): Promise<string> {
    return String(await this.transport.view("compute_binding_marker", args));
  }
  async computeBidCommitment(args: { task_id: string; agent_id: string; price: string; est_latency_sec: number; salt: string }): Promise<string> {
    return String(await this.transport.view("compute_bid_commitment", args));
  }
  async dutchPrice(taskId: bigint | string): Promise<bigint> {
    return BigInt(String(await this.transport.view("get_dutch_price", { task_id: taskId.toString() })));
  }
}

/** Full client over the PhalanxSim VM: views plus signed calls. */
export class PhalanxContract extends PhalanxViews {
  constructor(
    readonly vm: NearVm,
    contractId: string,
  ) {
    super(new VmTransport(vm, contractId));
  }

  async call<T>(signer: Signer, method: string, args: Record<string, unknown>, schema: z.ZodType<T> | null, opts: CallOptions = {}): Promise<CallResult<T>> {
    let outcome: TxOutcome;
    try {
      outcome = await this.vm.functionCall(signer, this.contractId, method, args, opts);
    } catch (err) {
      if (err instanceof VmError) {
        return { ok: false, value: null, error: err.message, outcome: null, events: [], failedReceipts: [] };
      }
      throw err;
    }
    const events = parsePhalanxEvents(outcome.logs);
    const failedReceipts = outcome.receipts.flatMap((r) => (r.status.type === "Failure" ? [{ receiverId: r.receiverId, error: r.status.error }] : []));
    if (outcome.status.type === "Failure") {
      return { ok: false, value: null, error: outcome.status.error, outcome, events, failedReceipts };
    }
    const raw = decodeJson(outcome.status.value);
    const value = schema ? schema.parse(raw) : (raw as T);
    return { ok: true, value, error: null, outcome, events, failedReceipts };
  }
}

/** Decodes a base64 JSON-RPC `args_base64` payload (used by the testnet transaction builder). */
export function decodeArgsBase64(b64: string): unknown {
  return JSON.parse(fromUtf8(fromBase64(b64)));
}

/**
 * PhalanxSim: a deterministic, in-process NEAR runtime that executes the *compiled* contract WASM
 * (`artifacts/phalanx_core.wasm`) in Node or the browser.
 *
 * What it models (the subset of nearcore semantics the contract depends on):
 * - the `env` host-function ABI (registers, storage, context, economics, sha256/keccak256,
 *   ed25519_verify, logs, panics, promises and batch actions);
 * - transactions signed by access keys, with FunctionCall permission enforcement
 *   (receiver, method names, zero deposit, gas allowance) and FullAccess keys;
 * - receipts executed in causal order, callbacks receiving `promise_result`s, per-receipt
 *   atomic rollback with deposit refunds, and the storage-staking balance check;
 * - a block clock (1 block per second) and epochs, advanced explicitly;
 * - gas: every host call is charged from `HOST_CALL_GAS` and the receipt's prepaid gas is enforced
 *   as a hard ceiling, so a method that outruns its budget fails with `ExceededGasLimit` instead of
 *   succeeding. Views report theirs through `lastViewGas()`.
 *
 * What it does not model: nearcore's per-WASM-instruction gas (a JS host cannot see instructions,
 * so gas is charged per host call and is therefore a lower bound, not a consensus-accurate figure),
 * validators, sharding and finality. Cross-contract calls to accounts without WASM can be served by
 * registered `ExternalContract` handlers (used for the simulated MPC signer).
 */
import {
  bytesEqual,
  concatBytes,
  fromUtf8,
  keccak256Bytes,
  publicKeyFromBorsh,
  publicKeyToBorsh,
  readU128LE,
  sha256Bytes,
  toBase58,
  toHex,
  u128ToLE,
  utf8,
  verifyEd25519,
} from "../encoding.ts";

const U64_MAX = 0xffff_ffff_ffff_ffffn;
const STORAGE_BYTE_COST = 10_000_000_000_000_000_000n; // 10^19 yocto per byte
const GAS_PRICE = 100_000_000n; // yocto per gas unit (0.0001 NEAR per Tgas)
const RECEIPT_GAS_ESTIMATE = 5_000_000_000_000n; // 5 Tgas burnt per executed receipt (estimate)
/** Per-host-call gas, in gas units. Approximates nearcore's `wasmer` host costs. */
const HOST_CALL_GAS: Record<string, bigint> = {
  sha256: 3_000_000_000n,
  keccak256: 6_000_000_000n,
  ed25519_verify: 15_000_000_000n,
  read_register: 200_000_000n,
  write_register: 300_000_000n,
  register_len: 100_000_000n,
  storage_read: 2_000_000_000n,
  storage_write: 3_000_000_000n,
  storage_remove: 1_000_000_000n,
  storage_has_key: 500_000_000n,
};
const DEFAULT_HOST_CALL_GAS = 100_000_000n;
const MAX_RECEIPTS_PER_TX = 256;

export type Bytes = Uint8Array;

export interface FunctionCallPermission {
  receiverId: string;
  methodNames: string[];
  /** `null` = unlimited */
  allowance: bigint | null;
}

export type AccessKeyPermission = { kind: "full_access" } | ({ kind: "function_call" } & FunctionCallPermission);

export interface AccessKey {
  publicKey: string;
  nonce: bigint;
  permission: AccessKeyPermission;
}

export interface VmAccount {
  accountId: string;
  balance: bigint;
  locked: bigint;
  codeHash: string | null;
  storage: Map<string, Bytes>;
  keys: Map<string, AccessKey>;
}

export type Action =
  | { type: "CreateAccount" }
  | { type: "DeployContract"; code: Bytes }
  | { type: "FunctionCall"; methodName: string; args: Bytes; deposit: bigint; gas: bigint }
  | { type: "Transfer"; deposit: bigint }
  | { type: "AddKey"; publicKey: string; permission: AccessKeyPermission }
  | { type: "DeleteKey"; publicKey: string }
  | { type: "DeleteAccount"; beneficiaryId: string };

export type ActionSummary =
  | { type: "CreateAccount" }
  | { type: "DeployContract"; codeHash: string; size: number }
  | { type: "FunctionCall"; methodName: string; args: string; deposit: string; gas: string }
  | { type: "Transfer"; deposit: string }
  | { type: "AddKey"; publicKey: string; permission: AccessKeyPermission }
  | { type: "DeleteKey"; publicKey: string }
  | { type: "DeleteAccount"; beneficiaryId: string };

export type ExecutionStatus = { type: "SuccessValue"; value: Bytes } | { type: "SuccessReceiptId"; receiptId: string } | { type: "Failure"; error: string };

export interface ReceiptOutcome {
  receiptId: string;
  predecessorId: string;
  receiverId: string;
  actions: ActionSummary[];
  status: ExecutionStatus;
  logs: string[];
  gasBurnt: bigint;
  blockHeight: bigint;
}

export interface TxOutcome {
  transactionHash: string;
  signerId: string;
  receiverId: string;
  /** Final status: the first receipt's result, following `promise_return` chains. */
  status: { type: "SuccessValue"; value: Bytes } | { type: "Failure"; error: string };
  receipts: ReceiptOutcome[];
  logs: string[];
  blockHeight: bigint;
}

export interface ExternalCallContext {
  vm: NearVm;
  receiverId: string;
  predecessorId: string;
  signerId: string;
  methodName: string;
  args: Bytes;
  deposit: bigint;
}

/** Native (JS) contract mounted at an account id, e.g. the simulated MPC signer. */
export interface ExternalContract {
  call(ctx: ExternalCallContext): { value: Bytes; logs?: string[] };
}

export class VmError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(`${kind}: ${message}`);
    this.name = "VmError";
  }
}

class ContractPanic extends Error {
  constructor(message: string) {
    super(`Smart contract panicked: ${message}`);
    this.name = "ContractPanic";
  }
}

class HostError extends Error {
  constructor(message: string) {
    super(`HostError: ${message}`);
    this.name = "HostError";
  }
}

type PromiseResult = { ok: true; data: Bytes } | { ok: false };

interface PendingReceipt {
  id: string;
  predecessorId: string;
  receiverId: string;
  signerId: string;
  signerPublicKey: string;
  actions: Action[];
  dependsOn: string[];
}

type ReceiptResult = { kind: "value"; value: Bytes } | { kind: "failure"; error: string } | { kind: "deferred"; to: string };

/** Promise created during one function call. */
type LocalPromise = { kind: "receipt"; receipt: PendingReceipt } | { kind: "joint"; receiptIds: string[] };

interface ExecContext {
  accountId: string;
  account: VmAccount;
  storage: Map<string, Bytes>;
  predecessorId: string;
  signerId: string;
  signerPublicKey: string;
  input: Bytes;
  deposit: bigint;
  isView: boolean;
  promiseResults: PromiseResult[];
  logs: string[];
  returnData: Bytes | null;
  returnPromise: number | null;
  promises: LocalPromise[];
  registers: Map<bigint, Bytes>;
  codeSize: number;
  /** Gas granted to this receipt, and how much the metered host calls have consumed. */
  prepaidGas: bigint;
  usedGas: bigint;
}

export interface VmOptions {
  /** Block timestamp of the first block, in ns since the Unix epoch. Defaults to the current wall-clock time. */
  genesisTimestampNs?: bigint;
  genesisHeight?: bigint;
  epochHeight?: bigint;
  epochLengthBlocks?: bigint;
}

export class NearVm {
  readonly accounts = new Map<string, VmAccount>();
  private readonly codes = new Map<string, { bytes: Bytes; module: WebAssembly.Module }>();
  private readonly externals = new Map<string, ExternalContract>();
  private receiptSeq = 0;
  private txSeq = 0;
  /** Serializes transactions and views: one block producer, no interleaved receipts. */
  private queue: Promise<unknown> = Promise.resolve();
  blockHeight: bigint;
  timestampNs: bigint;
  epochHeight: bigint;
  readonly epochLengthBlocks: bigint;

  constructor(opts: VmOptions = {}) {
    this.timestampNs = opts.genesisTimestampNs ?? BigInt(Date.now()) * 1_000_000n;
    this.blockHeight = opts.genesisHeight ?? 1_000n;
    this.epochHeight = opts.epochHeight ?? 10n;
    this.epochLengthBlocks = opts.epochLengthBlocks ?? 43_200n;
  }

  createAccount(accountId: string, balance: bigint, fullAccessKey?: string): VmAccount {
    if (this.accounts.has(accountId)) throw new VmError("AccountAlreadyExists", accountId);
    const account: VmAccount = { accountId, balance, locked: 0n, codeHash: null, storage: new Map(), keys: new Map() };
    if (fullAccessKey) account.keys.set(fullAccessKey, { publicKey: fullAccessKey, nonce: 0n, permission: { kind: "full_access" } });
    this.accounts.set(accountId, account);
    return account;
  }

  async deploy(accountId: string, wasm: Bytes): Promise<string> {
    const account = this.mustAccount(accountId);
    const codeHash = await this.registerCode(wasm);
    account.codeHash = codeHash;
    return codeHash;
  }

  private async registerCode(wasm: Bytes): Promise<string> {
    const codeHash = toHex(sha256Bytes(wasm));
    if (!this.codes.has(codeHash)) {
      const module = await WebAssembly.compile(wasm as BufferSource);
      this.codes.set(codeHash, { bytes: wasm, module });
    }
    return codeHash;
  }

  mountExternal(accountId: string, handler: ExternalContract, balance = 0n): void {
    if (!this.accounts.has(accountId)) this.createAccount(accountId, balance);
    this.externals.set(accountId, handler);
  }

  getAccount(accountId: string): VmAccount | undefined {
    return this.accounts.get(accountId);
  }

  accessKeys(accountId: string): AccessKey[] {
    return [...(this.accounts.get(accountId)?.keys.values() ?? [])];
  }

  balanceOf(accountId: string): bigint {
    return this.accounts.get(accountId)?.balance ?? 0n;
  }

  storageUsage(accountId: string): bigint {
    const account = this.mustAccount(accountId);
    return this.computeStorageUsage(account, account.storage, this.codeSizeOf(account));
  }

  /** Moves the clock forward (1 block per second; epochs roll every `epochLengthBlocks`). */
  advance(seconds: number): void {
    if (seconds <= 0) return;
    const blocks = BigInt(Math.ceil(seconds));
    this.timestampNs += BigInt(Math.round(seconds * 1e9));
    const before = this.blockHeight / this.epochLengthBlocks;
    this.blockHeight += blocks;
    this.epochHeight += this.blockHeight / this.epochLengthBlocks - before;
  }

  private nextBlock(): void {
    this.blockHeight += 1n;
    this.timestampNs += 1_000_000_000n;
    if (this.blockHeight % this.epochLengthBlocks === 0n) this.epochHeight += 1n;
  }

  private mustAccount(accountId: string): VmAccount {
    const a = this.accounts.get(accountId);
    if (!a) throw new VmError("AccountDoesNotExist", accountId);
    return a;
  }

  private codeSizeOf(account: VmAccount): number {
    return account.codeHash ? (this.codes.get(account.codeHash)?.bytes.length ?? 0) : 0;
  }

  private computeStorageUsage(account: VmAccount, storage: Map<string, Bytes>, codeSize: number): bigint {
    let usage = 100n + BigInt(codeSize);
    for (const key of account.keys.values()) {
      let accessKeyLen = 8 + 1; // nonce + permission tag
      if (key.permission.kind === "function_call") {
        accessKeyLen += (key.permission.allowance === null ? 1 : 17) + 4 + key.permission.receiverId.length + 4;
        accessKeyLen += key.permission.methodNames.reduce((n, m) => n + 4 + m.length, 0);
      }
      usage += BigInt(33 + accessKeyLen + 40);
    }
    for (const [k, v] of storage) usage += BigInt(k.length / 2 + v.length + 40);
    return usage;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Signs (with `publicKey`, which must be an access key of `signerId`) and executes a transaction. */
  signAndSendTransaction(tx: { signerId: string; publicKey: string; receiverId: string; actions: Action[] }): Promise<TxOutcome> {
    return this.exclusive(() => this.executeTransaction(tx));
  }

  private async executeTransaction(tx: { signerId: string; publicKey: string; receiverId: string; actions: Action[] }): Promise<TxOutcome> {
    const signer = this.mustAccount(tx.signerId);
    const key = signer.keys.get(tx.publicKey);
    if (!key) throw new VmError("InvalidAccessKeyError", `access key ${tx.publicKey} not found on ${tx.signerId}`);
    const prepaid = tx.actions.reduce((g, a) => g + (a.type === "FunctionCall" ? a.gas : 0n), 0n);

    if (key.permission.kind === "function_call") {
      const perm = key.permission;
      const only = tx.actions.length === 1 ? tx.actions[0] : undefined;
      if (!only || only.type !== "FunctionCall") {
        throw new VmError("InvalidAccessKeyError", "RequiresFullAccess: function-call keys can only sign a single FunctionCall");
      }
      if (tx.receiverId !== perm.receiverId) {
        throw new VmError("InvalidAccessKeyError", `ReceiverMismatch: key is scoped to ${perm.receiverId}, tx targets ${tx.receiverId}`);
      }
      if (perm.methodNames.length > 0 && !perm.methodNames.includes(only.methodName)) {
        throw new VmError("InvalidAccessKeyError", `MethodNameMismatch: ${only.methodName} is not in [${perm.methodNames.join(", ")}]`);
      }
      if (only.deposit !== 0n) throw new VmError("InvalidAccessKeyError", "DepositWithFunctionCall: function-call keys cannot attach deposits");
      const cost = prepaid * GAS_PRICE;
      if (perm.allowance !== null && perm.allowance < cost) {
        throw new VmError("InvalidAccessKeyError", `NotEnoughAllowance: ${perm.allowance} < ${cost}`);
      }
    }

    const deposits = tx.actions.reduce((d, a) => d + (a.type === "Transfer" || a.type === "FunctionCall" ? a.deposit : 0n), 0n);
    const upfront = deposits + prepaid * GAS_PRICE;
    if (signer.balance < upfront) throw new VmError("NotEnoughBalance", `${tx.signerId} has ${signer.balance}, needs ${upfront}`);

    key.nonce += 1n;
    signer.balance -= deposits;
    this.txSeq += 1;
    const transactionHash = toBase58(sha256Bytes(utf8(`phalanx-sim-tx:${this.txSeq}:${tx.signerId}:${tx.publicKey}:${key.nonce}:${tx.receiverId}`)));

    const first: PendingReceipt = {
      id: this.newReceiptId(),
      predecessorId: tx.signerId,
      receiverId: tx.receiverId,
      signerId: tx.signerId,
      signerPublicKey: tx.publicKey,
      actions: tx.actions,
      dependsOn: [],
    };
    const { outcomes, results } = await this.processReceipts([first]);

    const burnt = outcomes.reduce((g, o) => g + o.gasBurnt, 0n);
    const fee = burnt * GAS_PRICE;
    signer.balance -= fee < signer.balance ? fee : signer.balance;
    if (key.permission.kind === "function_call" && key.permission.allowance !== null) {
      key.permission.allowance -= fee < key.permission.allowance ? fee : key.permission.allowance;
    }

    const final = this.resolve(first.id, results);
    const status: TxOutcome["status"] =
      final.kind === "value" ? { type: "SuccessValue", value: final.value } : { type: "Failure", error: final.kind === "failure" ? final.error : "unresolved" };
    return {
      transactionHash,
      signerId: tx.signerId,
      receiverId: tx.receiverId,
      status,
      receipts: outcomes,
      logs: outcomes.flatMap((o) => o.logs),
      blockHeight: this.blockHeight,
    };
  }

  /** Convenience wrapper for a single FunctionCall transaction. */
  async functionCall(
    signer: { accountId: string; publicKey: string },
    receiverId: string,
    methodName: string,
    args: unknown,
    opts: { deposit?: bigint; gas?: bigint } = {},
  ): Promise<TxOutcome> {
    const argBytes = args instanceof Uint8Array ? args : utf8(JSON.stringify(args ?? {}));
    return this.signAndSendTransaction({
      signerId: signer.accountId,
      publicKey: signer.publicKey,
      receiverId,
      actions: [{ type: "FunctionCall", methodName, args: argBytes, deposit: opts.deposit ?? 0n, gas: opts.gas ?? 300n * 10n ** 12n }],
    });
  }

  /** Read-only call. State writes and promises are prohibited, exactly like an RPC `call_function`. */
  view(accountId: string, methodName: string, args: unknown = {}): Promise<{ value: Bytes; logs: string[] }> {
    return this.exclusive(() => this.executeView(accountId, methodName, args));
  }

  /** Gas a view burned on its last call. Views have no receipt, so this is how a caller reads it. */
  lastViewGas(): bigint {
    return this.viewGas;
  }

  private async executeView(accountId: string, methodName: string, args: unknown): Promise<{ value: Bytes; logs: string[] }> {
    const account = this.mustAccount(accountId);
    if (!account.codeHash) throw new VmError("CodeDoesNotExist", accountId);
    const ctx = this.newContext(account, {
      predecessorId: accountId,
      signerId: accountId,
      signerPublicKey: "",
      input: args instanceof Uint8Array ? args : utf8(JSON.stringify(args ?? {})),
      deposit: 0n,
      isView: true,
      promiseResults: [],
    });
    await this.runWasm(account.codeHash, methodName, ctx);
    this.viewGas = ctx.usedGas;
    return { value: ctx.returnData ?? new Uint8Array(), logs: ctx.logs };
  }

  private viewGas = 0n;

  private newReceiptId(): string {
    this.receiptSeq += 1;
    return toBase58(sha256Bytes(utf8(`phalanx-sim-receipt:${this.receiptSeq}`)));
  }

  private resolve(id: string, results: Map<string, ReceiptResult>): ReceiptResult {
    let current = results.get(id);
    let guard = 0;
    while (current && current.kind === "deferred" && guard++ < MAX_RECEIPTS_PER_TX) current = results.get(current.to);
    return current ?? { kind: "failure", error: "receipt did not execute" };
  }

  private isResolved(id: string, results: Map<string, ReceiptResult>): boolean {
    let current = results.get(id);
    let guard = 0;
    while (current && current.kind === "deferred" && guard++ < MAX_RECEIPTS_PER_TX) current = results.get(current.to);
    return current !== undefined && current.kind !== "deferred";
  }

  private async processReceipts(initial: PendingReceipt[]): Promise<{ outcomes: ReceiptOutcome[]; results: Map<string, ReceiptResult> }> {
    const queue = [...initial];
    const outcomes: ReceiptOutcome[] = [];
    const results = new Map<string, ReceiptResult>();
    while (queue.length > 0) {
      if (outcomes.length >= MAX_RECEIPTS_PER_TX) throw new VmError("ReceiptLimit", "too many receipts in one transaction");
      const index = queue.findIndex((r) => r.dependsOn.every((d) => this.isResolved(d, results)));
      if (index < 0) throw new VmError("Deadlock", "receipts wait on results that never resolve");
      const [receipt] = queue.splice(index, 1);
      if (!receipt) break;
      this.nextBlock();
      const promiseResults: PromiseResult[] = receipt.dependsOn.map((d) => {
        const r = this.resolve(d, results);
        return r.kind === "value" ? { ok: true, data: r.value } : { ok: false };
      });
      const { outcome, result, spawned } = await this.applyReceipt(receipt, promiseResults);
      results.set(receipt.id, result);
      outcomes.push(outcome);
      queue.push(...spawned);
    }
    return { outcomes, results };
  }

  private async applyReceipt(
    receipt: PendingReceipt,
    promiseResults: PromiseResult[],
  ): Promise<{ outcome: ReceiptOutcome; result: ReceiptResult; spawned: PendingReceipt[] }> {
    const logs: string[] = [];
    const existing = this.accounts.get(receipt.receiverId);
    const snapshot = existing ? cloneAccount(existing) : null;
    let createdHere = false;
    let spawned: PendingReceipt[] = [];
    let result: ReceiptResult = { kind: "value", value: new Uint8Array() };
    /** Gas the executed WASM actually consumed (0 for receipts with no contract call). */
    let gasBurnt = 0n;
    const refundable = receipt.actions.reduce((d, a) => d + (a.type === "Transfer" || a.type === "FunctionCall" ? a.deposit : 0n), 0n);

    try {
      for (const action of receipt.actions) {
        let account = this.accounts.get(receipt.receiverId);
        const isOwnAccount = receipt.predecessorId === receipt.receiverId || createdHere;
        switch (action.type) {
          case "CreateAccount": {
            if (account) throw new VmError("AccountAlreadyExists", receipt.receiverId);
            if (!receipt.receiverId.endsWith(`.${receipt.predecessorId}`)) {
              throw new VmError("CreateAccountNotAllowed", `${receipt.predecessorId} cannot create ${receipt.receiverId}`);
            }
            this.createAccount(receipt.receiverId, 0n);
            createdHere = true;
            break;
          }
          case "Transfer": {
            if (!account) throw new VmError("AccountDoesNotExist", receipt.receiverId);
            account.balance += action.deposit;
            break;
          }
          case "AddKey": {
            if (!account) throw new VmError("AccountDoesNotExist", receipt.receiverId);
            if (!isOwnAccount) throw new VmError("ActorNoPermission", `${receipt.predecessorId} cannot add keys to ${receipt.receiverId}`);
            if (account.keys.has(action.publicKey)) throw new VmError("AddKeyAlreadyExists", action.publicKey);
            account.keys.set(action.publicKey, { publicKey: action.publicKey, nonce: this.blockHeight * 1_000_000n, permission: action.permission });
            break;
          }
          case "DeleteKey": {
            if (!account) throw new VmError("AccountDoesNotExist", receipt.receiverId);
            if (!isOwnAccount) throw new VmError("ActorNoPermission", `${receipt.predecessorId} cannot delete keys of ${receipt.receiverId}`);
            if (!account.keys.delete(action.publicKey)) throw new VmError("DeleteKeyDoesNotExist", action.publicKey);
            break;
          }
          case "DeployContract": {
            if (!account) throw new VmError("AccountDoesNotExist", receipt.receiverId);
            if (!isOwnAccount) throw new VmError("ActorNoPermission", "deploy requires the account itself");
            account.codeHash = await this.registerCode(action.code);
            break;
          }
          case "DeleteAccount": {
            if (!account) throw new VmError("AccountDoesNotExist", receipt.receiverId);
            if (!isOwnAccount) throw new VmError("ActorNoPermission", "delete requires the account itself");
            const beneficiary = this.accounts.get(action.beneficiaryId);
            if (beneficiary) beneficiary.balance += account.balance;
            this.accounts.delete(receipt.receiverId);
            break;
          }
          case "FunctionCall": {
            if (!account) throw new VmError("AccountDoesNotExist", receipt.receiverId);
            account.balance += action.deposit;
            const external = this.externals.get(receipt.receiverId);
            if (external) {
              const out = external.call({
                vm: this,
                receiverId: receipt.receiverId,
                predecessorId: receipt.predecessorId,
                signerId: receipt.signerId,
                methodName: action.methodName,
                args: action.args,
                deposit: action.deposit,
              });
              logs.push(...(out.logs ?? []));
              result = { kind: "value", value: out.value };
              break;
            }
            if (!account.codeHash) throw new VmError("CodeDoesNotExist", receipt.receiverId);
            const ctx = this.newContext(account, {
              predecessorId: receipt.predecessorId,
              signerId: receipt.signerId,
              signerPublicKey: receipt.signerPublicKey,
              input: action.args,
              deposit: action.deposit,
              isView: false,
              promiseResults,
            });
            try {
              await this.runWasm(account.codeHash, action.methodName, ctx);
            } finally {
              logs.push(...ctx.logs);
            }
            account.storage = ctx.storage;
            gasBurnt = ctx.usedGas;
            const created = ctx.promises.flatMap((p) => (p.kind === "receipt" ? [p.receipt] : []));
            spawned = spawned.concat(created);
            if (ctx.returnPromise !== null) {
              const target = ctx.promises[ctx.returnPromise];
              if (!target || target.kind !== "receipt") throw new VmError("ReturnedInvalidPromise", "promise_return of a joint promise");
              result = { kind: "deferred", to: target.receipt.id };
            } else {
              result = { kind: "value", value: ctx.returnData ?? new Uint8Array() };
            }
            break;
          }
        }
        account = this.accounts.get(receipt.receiverId);
      }

      const account = this.accounts.get(receipt.receiverId);
      if (account) {
        const usage = this.computeStorageUsage(account, account.storage, this.codeSizeOf(account));
        if (usage * STORAGE_BYTE_COST > account.balance + account.locked) {
          throw new VmError("LackBalanceForState", `${receipt.receiverId} needs ${usage * STORAGE_BYTE_COST} yocto for ${usage} bytes`);
        }
      }
    } catch (err) {
      // Atomic rollback of the receiver, refund of attached deposits to the predecessor.
      if (snapshot) this.accounts.set(receipt.receiverId, snapshot);
      else this.accounts.delete(receipt.receiverId);
      if (refundable > 0n) {
        const refundTo = this.accounts.get(receipt.predecessorId);
        if (refundTo) refundTo.balance += refundable;
      }
      spawned = [];
      result = { kind: "failure", error: errorMessage(err) };
    }

    const outcome: ReceiptOutcome = {
      receiptId: receipt.id,
      predecessorId: receipt.predecessorId,
      receiverId: receipt.receiverId,
      actions: receipt.actions.map(summarizeAction),
      status:
        result.kind === "value"
          ? { type: "SuccessValue", value: result.value }
          : result.kind === "deferred"
            ? { type: "SuccessReceiptId", receiptId: result.to }
            : { type: "Failure", error: result.error },
      logs,
      gasBurnt: gasBurnt > 0n ? gasBurnt : RECEIPT_GAS_ESTIMATE,
      blockHeight: this.blockHeight,
    };
    return { outcome, result, spawned };
  }

  private newContext(
    account: VmAccount,
    c: Pick<ExecContext, "predecessorId" | "signerId" | "signerPublicKey" | "input" | "deposit" | "isView" | "promiseResults"> & {
      prepaidGas?: bigint;
    },
  ): ExecContext {
    return {
      ...c,
      accountId: account.accountId,
      account,
      storage: new Map(account.storage),
      logs: [],
      returnData: null,
      returnPromise: null,
      promises: [],
      registers: new Map(),
      codeSize: this.codeSizeOf(account),
      prepaidGas: c.prepaidGas ?? RECEIPT_GAS_ESTIMATE,
      usedGas: 0n,
    };
  }

  private async runWasm(codeHash: string, methodName: string, ctx: ExecContext): Promise<void> {
    const code = this.codes.get(codeHash);
    if (!code) throw new VmError("CodeDoesNotExist", codeHash);
    const memory: { current: WebAssembly.Memory | null } = { current: null };
    const env = this.hostFunctions(ctx, memory);
    const imports: Record<string, WebAssembly.ImportValue> = {};
    for (const imp of WebAssembly.Module.imports(code.module)) {
      if (imp.module !== "env") continue;
      imports[imp.name] =
        env[imp.name] ??
        (() => {
          throw new HostError(`host function ${imp.name} is not supported by the PhalanxSim VM`);
        });
    }
    // Gas metering. nearcore charges per WASM instruction and per host call; PhalanxSim cannot see
    // instructions, so it charges a fixed cost per host call (the dominant term for this contract,
    // whose work is hashing, storage I/O and signature checks) and enforces the receipt's prepaid
    // gas as a hard ceiling. A method that would outrun its gas now fails here with
    // `ExceededGasLimit` instead of silently succeeding.
    const metered: Record<string, WebAssembly.ImportValue> = {};
    for (const [name, fn] of Object.entries(imports)) {
      metered[name] = (...args: bigint[]) => {
        ctx.usedGas += HOST_CALL_GAS[name] ?? DEFAULT_HOST_CALL_GAS;
        if (ctx.usedGas > ctx.prepaidGas) throw new HostError("ExceededGasLimit: the receipt ran out of gas");
        return (fn as (...a: bigint[]) => unknown)(...args);
      };
    }
    const instance = await WebAssembly.instantiate(code.module, { env: metered });
    memory.current = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports[methodName];
    if (typeof fn !== "function") throw new VmError("MethodNotFound", `${ctx.accountId}.${methodName}`);
    try {
      (fn as () => void)();
    } catch (err) {
      if (err instanceof WebAssembly.RuntimeError) throw new VmError("WasmTrap", err.message);
      throw err;
    }
  }

  private hostFunctions(ctx: ExecContext, memory: { current: WebAssembly.Memory | null }): Record<string, (...args: bigint[]) => unknown> {
    const mem = () => {
      if (!memory.current) throw new HostError("memory not initialised");
      return new Uint8Array(memory.current.buffer);
    };
    const read = (ptr: bigint, len: bigint): Bytes => {
      const start = Number(ptr);
      const end = start + Number(len);
      const m = mem();
      if (end > m.length || start < 0) throw new HostError("MemoryAccessViolation");
      return m.slice(start, end);
    };
    const write = (ptr: bigint, data: Bytes) => {
      const m = mem();
      if (Number(ptr) + data.length > m.length) throw new HostError("MemoryAccessViolation");
      m.set(data, Number(ptr));
    };
    const readString = (len: bigint, ptr: bigint): string => {
      if (len === U64_MAX) {
        const m = mem();
        let end = Number(ptr);
        while (end < m.length && m[end] !== 0) end++;
        return fromUtf8(m.slice(Number(ptr), end));
      }
      try {
        return fromUtf8(read(ptr, len));
      } catch (e) {
        if (e instanceof HostError) throw e;
        throw new HostError("BadUTF8");
      }
    };
    const setRegister = (id: bigint, data: Bytes) => ctx.registers.set(id, data);
    const prohibitedInView = (name: string) => {
      if (ctx.isView) throw new HostError(`ProhibitedInView: ${name}`);
    };
    const promise = (index: bigint): LocalPromise => {
      const p = ctx.promises[Number(index)];
      if (!p) throw new HostError(`InvalidPromiseIndex ${index}`);
      return p;
    };
    const batch = (index: bigint): PendingReceipt => {
      const p = promise(index);
      if (p.kind !== "receipt") throw new HostError("CannotAppendActionToJointPromise");
      return p.receipt;
    };
    const receiptIdsOf = (index: bigint): string[] => {
      const p = promise(index);
      return p.kind === "receipt" ? [p.receipt.id] : p.receiptIds;
    };
    const newReceipt = (receiverId: string, dependsOn: string[]): bigint => {
      prohibitedInView("promise");
      const receipt: PendingReceipt = {
        id: this.newReceiptId(),
        predecessorId: ctx.accountId,
        receiverId,
        signerId: ctx.signerId,
        signerPublicKey: ctx.signerPublicKey,
        actions: [],
        dependsOn,
      };
      ctx.promises.push({ kind: "receipt", receipt });
      return BigInt(ctx.promises.length - 1);
    };
    const charge = (amount: bigint) => {
      if (amount === 0n) return;
      if (ctx.account.balance < amount) throw new HostError(`BalanceExceeded: ${ctx.account.balance} < ${amount}`);
      ctx.account.balance -= amount;
    };
    const functionCallAction = (index: bigint, nameLen: bigint, namePtr: bigint, argsLen: bigint, argsPtr: bigint, amountPtr: bigint, gas: bigint) => {
      const amount = readU128LE(read(amountPtr, 16n));
      charge(amount);
      batch(index).actions.push({
        type: "FunctionCall",
        methodName: readString(nameLen, namePtr),
        args: read(argsPtr, argsLen),
        deposit: amount,
        gas,
      });
    };
    const unsupported = (name: string) => () => {
      throw new HostError(`${name} is not supported by the PhalanxSim VM`);
    };

    return {
      read_register: (id, ptr) => {
        const data = ctx.registers.get(id);
        if (!data) throw new HostError(`InvalidRegisterId ${id}`);
        write(ptr, data);
      },
      register_len: (id) => {
        const data = ctx.registers.get(id);
        return data ? BigInt(data.length) : U64_MAX;
      },
      write_register: (id, len, ptr) => setRegister(id, read(ptr, len)),
      current_account_id: (id) => setRegister(id, utf8(ctx.accountId)),
      signer_account_id: (id) => {
        prohibitedInView("signer_account_id");
        setRegister(id, utf8(ctx.signerId));
      },
      signer_account_pk: (id) => {
        prohibitedInView("signer_account_pk");
        setRegister(id, publicKeyToBorsh(ctx.signerPublicKey));
      },
      predecessor_account_id: (id) => {
        prohibitedInView("predecessor_account_id");
        setRegister(id, utf8(ctx.predecessorId));
      },
      input: (id) => setRegister(id, ctx.input),
      block_index: () => this.blockHeight,
      block_timestamp: () => this.timestampNs,
      epoch_height: () => this.epochHeight,
      storage_usage: () => this.computeStorageUsage(ctx.account, ctx.storage, ctx.codeSize),
      account_balance: (ptr) => write(ptr, u128ToLE(ctx.account.balance)),
      account_locked_balance: (ptr) => write(ptr, u128ToLE(ctx.account.locked)),
      attached_deposit: (ptr) => {
        prohibitedInView("attached_deposit");
        write(ptr, u128ToLE(ctx.deposit));
      },
      prepaid_gas: () => {
        prohibitedInView("prepaid_gas");
        return ctx.prepaidGas;
      },
      used_gas: () => {
        prohibitedInView("used_gas");
        return ctx.usedGas;
      },
      random_seed: (id) => setRegister(id, sha256Bytes(utf8(`phalanx-sim-seed:${this.blockHeight}`))),
      sha256: (len, ptr, id) => setRegister(id, sha256Bytes(read(ptr, len))),
      keccak256: (len, ptr, id) => setRegister(id, keccak256Bytes(read(ptr, len))),
      ed25519_verify: (sigLen, sigPtr, msgLen, msgPtr, pkLen, pkPtr) => {
        if (sigLen !== 64n) throw new HostError("Ed25519VerifyInvalidInput: signature must be 64 bytes");
        if (pkLen !== 32n) throw new HostError("Ed25519VerifyInvalidInput: public key must be 32 bytes");
        const sig = read(sigPtr, sigLen);
        const pk = read(pkPtr, pkLen);
        const msg = read(msgPtr, msgLen);
        return verifyEd25519(`ed25519:${toBase58(sig)}`, msg, `ed25519:${toBase58(pk)}`) ? 1n : 0n;
      },
      value_return: (len, ptr) => {
        ctx.returnData = read(ptr, len);
      },
      panic: () => {
        throw new ContractPanic("explicit guest panic");
      },
      panic_utf8: (len, ptr) => {
        throw new ContractPanic(readString(len, ptr));
      },
      log_utf8: (len, ptr) => {
        ctx.logs.push(readString(len, ptr));
      },
      abort: () => {
        throw new ContractPanic("abort");
      },
      promise_create: (accLen, accPtr, nameLen, namePtr, argsLen, argsPtr, amountPtr, gas) => {
        const idx = newReceipt(readString(accLen, accPtr), []);
        functionCallAction(idx, nameLen, namePtr, argsLen, argsPtr, amountPtr, gas);
        return idx;
      },
      promise_then: (prev, accLen, accPtr, nameLen, namePtr, argsLen, argsPtr, amountPtr, gas) => {
        const idx = newReceipt(readString(accLen, accPtr), receiptIdsOf(prev));
        functionCallAction(idx, nameLen, namePtr, argsLen, argsPtr, amountPtr, gas);
        return idx;
      },
      promise_and: (ptr, count) => {
        prohibitedInView("promise_and");
        const raw = read(ptr, count * 8n);
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const ids: string[] = [];
        for (let i = 0; i < Number(count); i++) ids.push(...receiptIdsOf(view.getBigUint64(i * 8, true)));
        ctx.promises.push({ kind: "joint", receiptIds: ids });
        return BigInt(ctx.promises.length - 1);
      },
      promise_batch_create: (accLen, accPtr) => newReceipt(readString(accLen, accPtr), []),
      promise_batch_then: (prev, accLen, accPtr) => newReceipt(readString(accLen, accPtr), receiptIdsOf(prev)),
      promise_batch_action_create_account: (index) => {
        batch(index).actions.push({ type: "CreateAccount" });
      },
      promise_batch_action_deploy_contract: (index, len, ptr) => {
        batch(index).actions.push({ type: "DeployContract", code: read(ptr, len) });
      },
      promise_batch_action_function_call: (index, nameLen, namePtr, argsLen, argsPtr, amountPtr, gas) =>
        functionCallAction(index, nameLen, namePtr, argsLen, argsPtr, amountPtr, gas),
      promise_batch_action_function_call_weight: (index, nameLen, namePtr, argsLen, argsPtr, amountPtr, gas) =>
        functionCallAction(index, nameLen, namePtr, argsLen, argsPtr, amountPtr, gas),
      promise_batch_action_transfer: (index, amountPtr) => {
        const amount = readU128LE(read(amountPtr, 16n));
        charge(amount);
        batch(index).actions.push({ type: "Transfer", deposit: amount });
      },
      promise_batch_action_add_key_with_full_access: (index, pkLen, pkPtr) => {
        batch(index).actions.push({ type: "AddKey", publicKey: publicKeyFromBorsh(read(pkPtr, pkLen)), permission: { kind: "full_access" } });
      },
      promise_batch_action_add_key_with_function_call: (index, pkLen, pkPtr, _nonce, allowancePtr, recvLen, recvPtr, namesLen, namesPtr) => {
        const allowance = readU128LE(read(allowancePtr, 16n));
        const names = readString(namesLen, namesPtr);
        batch(index).actions.push({
          type: "AddKey",
          publicKey: publicKeyFromBorsh(read(pkPtr, pkLen)),
          permission: {
            kind: "function_call",
            receiverId: readString(recvLen, recvPtr),
            methodNames: names.length > 0 ? names.split(",") : [],
            allowance: allowance === 0n ? null : allowance,
          },
        });
      },
      promise_batch_action_delete_key: (index, pkLen, pkPtr) => {
        batch(index).actions.push({ type: "DeleteKey", publicKey: publicKeyFromBorsh(read(pkPtr, pkLen)) });
      },
      promise_batch_action_delete_account: (index, len, ptr) => {
        batch(index).actions.push({ type: "DeleteAccount", beneficiaryId: readString(len, ptr) });
      },
      promise_batch_action_stake: unsupported("promise_batch_action_stake"),
      promise_batch_action_deploy_global_contract: unsupported("promise_batch_action_deploy_global_contract"),
      promise_batch_action_deploy_global_contract_by_account_id: unsupported("promise_batch_action_deploy_global_contract_by_account_id"),
      promise_batch_action_use_global_contract: unsupported("promise_batch_action_use_global_contract"),
      promise_batch_action_use_global_contract_by_account_id: unsupported("promise_batch_action_use_global_contract_by_account_id"),
      promise_batch_action_universal_state_init: unsupported("promise_batch_action_universal_state_init"),
      promise_batch_action_transfer_to_gas_key: unsupported("promise_batch_action_transfer_to_gas_key"),
      promise_batch_action_add_gas_key_with_full_access: unsupported("promise_batch_action_add_gas_key_with_full_access"),
      promise_batch_action_add_gas_key_with_function_call: unsupported("promise_batch_action_add_gas_key_with_function_call"),
      promise_results_count: () => BigInt(ctx.promiseResults.length),
      promise_result: (index, id) => {
        const r = ctx.promiseResults[Number(index)];
        if (!r) throw new HostError(`InvalidPromiseResultIndex ${index}`);
        if (!r.ok) return 2n;
        setRegister(id, r.data);
        return 1n;
      },
      promise_return: (index) => {
        prohibitedInView("promise_return");
        promise(index);
        ctx.returnPromise = Number(index);
      },
      storage_write: (keyLen, keyPtr, valueLen, valuePtr, id) => {
        prohibitedInView("storage_write");
        const key = toHex(read(keyPtr, keyLen));
        const old = ctx.storage.get(key);
        ctx.storage.set(key, read(valuePtr, valueLen));
        if (old) {
          setRegister(id, old);
          return 1n;
        }
        return 0n;
      },
      storage_read: (keyLen, keyPtr, id) => {
        const value = ctx.storage.get(toHex(read(keyPtr, keyLen)));
        if (!value) return 0n;
        setRegister(id, value);
        return 1n;
      },
      storage_remove: (keyLen, keyPtr, id) => {
        prohibitedInView("storage_remove");
        const key = toHex(read(keyPtr, keyLen));
        const old = ctx.storage.get(key);
        if (!old) return 0n;
        ctx.storage.delete(key);
        setRegister(id, old);
        return 1n;
      },
      storage_has_key: (keyLen, keyPtr) => (ctx.storage.has(toHex(read(keyPtr, keyLen))) ? 1n : 0n),
    };
  }
}

function cloneAccount(a: VmAccount): VmAccount {
  const keys = new Map<string, AccessKey>();
  for (const [k, v] of a.keys) {
    keys.set(k, { ...v, permission: v.permission.kind === "function_call" ? { ...v.permission, methodNames: [...v.permission.methodNames] } : v.permission });
  }
  return { ...a, storage: new Map(a.storage), keys };
}

function summarizeAction(a: Action): ActionSummary {
  switch (a.type) {
    case "CreateAccount":
      return { type: "CreateAccount" };
    case "DeployContract":
      return { type: "DeployContract", codeHash: toHex(sha256Bytes(a.code)), size: a.code.length };
    case "FunctionCall": {
      let args: string;
      try {
        args = fromUtf8(a.args);
      } catch {
        args = `0x${toHex(a.args)}`;
      }
      return { type: "FunctionCall", methodName: a.methodName, args, deposit: a.deposit.toString(), gas: a.gas.toString() };
    }
    case "Transfer":
      return { type: "Transfer", deposit: a.deposit.toString() };
    case "AddKey":
      return { type: "AddKey", publicKey: a.publicKey, permission: a.permission };
    case "DeleteKey":
      return { type: "DeleteKey", publicKey: a.publicKey };
    case "DeleteAccount":
      return { type: "DeleteAccount", beneficiaryId: a.beneficiaryId };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Decodes a JSON return value from an execution status. */
export function decodeJson<T = unknown>(value: Bytes): T {
  const text = fromUtf8(value);
  return (text.length === 0 ? null : JSON.parse(text)) as T;
}

/** Collects every access key and its permission on an account (for the UI and assertions). */
export function describeKeys(vm: NearVm, accountId: string): Array<{ publicKey: string; permission: AccessKeyPermission }> {
  return vm.accessKeys(accountId).map((k) => ({ publicKey: k.publicKey, permission: k.permission }));
}

export { bytesEqual, concatBytes };

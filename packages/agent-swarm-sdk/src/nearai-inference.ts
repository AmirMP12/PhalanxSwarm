/**
 * NEAR AI Cloud private inference with on-chain-verifiable signatures.
 *
 * NEAR AI Cloud runs open-weight models inside Intel TDX CVMs with NVIDIA confidential GPUs.
 * After a chat completion, `GET /v1/signature/{chat_id}?model=…&signing_algo=ed25519` returns
 * `text = "<sha256(request body)>:<sha256(response body)>"` signed by the model TEE's ed25519
 * key. That key is bound to the hardware by the model attestation (`nearai.ts`).
 *
 * `NearAiBackend` keeps the exact request and response bytes so `phalanx-core` can re-hash them,
 * verify the signature with `env::ed25519_verify` and read the model's verdict. Every request an
 * agent wants to use as a proof embeds the binding marker (`nearAiBindingMarker`), so a proof
 * cannot be replayed for another task, agent or input.
 *
 * `StandInBackend` is the offline substitute for CI and keyless judge runs: deterministic outputs
 * in the same byte format, signed by a local key that is registered on-chain as an
 * "offline stand-in (no TEE)". It proves the verification pipeline, not hardware isolation.
 */
import { ed25519 } from "@noble/curves/ed25519.js";

import { fromHex, keyPairFromSecret, keyPairFromSeed, sha256Bytes, toBase58, toHex, utf8 } from "./encoding.ts";
import { NEARAI_CLOUD_BASE } from "./nearai.ts";
import { nearAiBindingMarker, nearAiSignedText } from "./protocol.ts";
import type { ExecutionProofT, SubjectKindT } from "./types.ts";

/** TEE-hosted (owned_by "nearai") model with JSON mode; override with NEARAI_MODEL. */
export const DEFAULT_NEARAI_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";
export const STANDIN_MODEL = "phalanx-standin/deterministic-v1";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SignedCompletion {
  source: "nearai" | "standin" | "generic_llm";
  model: string;
  chatId: string;
  /** Exact request body sent to `/v1/chat/completions`. */
  requestBody: string;
  /** Exact response body received. */
  responseBody: string;
  /** `choices[0].message.content`. */
  content: string;
  signedText: string;
  /** ed25519 signature, hex. */
  signature: string;
  /** ed25519 public key that signed, hex (NEAR AI `signing_address`). */
  signingAddress: string;
}

/** What produced the messages: lets a server route rebuild the exact prompt instead of trusting raw messages. */
export interface CompletionMeta {
  role: string;
  context: unknown;
  marker: string | null;
  /** Live deliberation phase when agents run draft → critique → finalize. */
  phase?: "draft" | "finalize";
}

export interface CompletionBackend {
  readonly source: "nearai" | "standin" | "generic_llm";
  readonly model: string;
  /** `false` when the backend can only send the role's single-turn prompt (a server route). */
  readonly deliberates?: boolean;
  /** `standIn` produces the deterministic answer; real backends ignore it. */
  complete(messages: ChatMessage[], standIn: () => Record<string, unknown>, meta?: CompletionMeta): Promise<SignedCompletion>;
}

/**
 * Token budget for one completion. The contract accepts any `max_tokens`, so it is not pinned.
 * With hidden reasoning on, the default Qwen3.6 model used 900 to 4,096 tokens before answering
 * (900 returned `content: null`, `finish_reason: "length"`), so requests also turn reasoning off.
 */
export const MAX_COMPLETION_TOKENS = 2_048;

/**
 * `chat_template_kwargs` that turns the hidden reasoning of NEAR AI's TEE-hosted open-weight
 * models off: about 1.5 s per answer instead of 15-30 s, and no token budget spent before the
 * JSON. It adds no instructions, and it is the only extra request field the contract accepts.
 */
export const NO_THINKING = { enable_thinking: false } as const;

/**
 * Request body (JSON mode, deterministic sampling). NEAR AI and the stand-in send `NO_THINKING`;
 * generic OpenAI-compatible APIs may reject unknown fields, so they get `{ noThinking: false }`.
 */
export function chatRequestBody(model: string, messages: ChatMessage[], opts: { noThinking?: boolean } = {}): string {
  return JSON.stringify({
    model,
    messages,
    temperature: 0,
    max_tokens: MAX_COMPLETION_TOKENS,
    response_format: { type: "json_object" },
    ...(opts.noThinking === false ? {} : { chat_template_kwargs: NO_THINKING }),
  });
}

interface ChatCompletionBody {
  id?: string;
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null; reasoning_content?: string | null } }>;
  usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } | null };
}

/** The answer of a completion, or an error that says why there is none (e.g. reasoning used up the budget). */
export function completionContent(parsed: ChatCompletionBody, provider: string): string {
  const choice = parsed.choices?.[0];
  const content = choice?.message?.content;
  const reasoningContent = choice?.message?.reasoning_content;
  
  // Try regular content first
  if (typeof content === "string" && content.length > 0) return content;
  
  // Fall back to reasoning_content if available (some models return only this)
  if (typeof reasoningContent === "string" && reasoningContent.length > 0) return reasoningContent;
  
  const reasoning = parsed.usage?.completion_tokens_details?.reasoning_tokens;
  if (choice?.finish_reason === "length") {
    throw new Error(
      `${provider} model used the whole ${MAX_COMPLETION_TOKENS}-token budget${reasoning ? ` (${reasoning} reasoning tokens)` : ""} before answering`,
    );
  }
  throw new Error(`${provider} completion has no content (finish_reason ${choice?.finish_reason ?? "unknown"})`);
}

/** Local verification identical to the contract's: body hashes, then ed25519 over the text (or its sha256). */
export function verifySignedCompletion(c: Pick<SignedCompletion, "requestBody" | "responseBody" | "signedText" | "signature" | "signingAddress">): boolean {
  const parts = c.signedText.split(":");
  const [req, resp] = parts.length === 3 ? [parts[1], parts[2]] : parts.length === 2 ? [parts[0], parts[1]] : [undefined, undefined];
  if (req !== toHex(sha256Bytes(c.requestBody)) || resp !== toHex(sha256Bytes(c.responseBody))) return false;
  try {
    const sig = fromHex(c.signature);
    const pk = fromHex(c.signingAddress);
    return ed25519.verify(sig, utf8(c.signedText), pk) || ed25519.verify(sig, sha256Bytes(c.signedText), pk);
  } catch {
    return false;
  }
}

/** The ed25519 key as a NEAR `PublicKey` string (for `register_enclave`). */
export function nearPublicKeyFromHex(hexKey: string): string {
  return `ed25519:${toBase58(fromHex(hexKey))}`;
}

/** Enclave id under which a model signing key is registered. */
export function enclaveIdForKey(signingAddress: string): string {
  return `nearai-${signingAddress.slice(0, 24)}`;
}

export class StandInBackend implements CompletionBackend {
  readonly source = "standin" as const;
  readonly model = STANDIN_MODEL;
  private readonly secret: Uint8Array;
  readonly signingAddress: string;

  constructor(seed = "phalanx-standin-model-key") {
    const kp = keyPairFromSeed(seed);
    this.secret = kp.secretKey;
    this.signingAddress = toHex(kp.publicKey);
  }

  async complete(messages: ChatMessage[], standIn: () => Record<string, unknown>): Promise<SignedCompletion> {
    const requestBody = chatRequestBody(this.model, messages);
    const chatId = `chatcmpl-standin-${toHex(sha256Bytes(requestBody)).slice(0, 24)}`;
    const content = JSON.stringify(standIn());
    const responseBody = JSON.stringify({
      id: chatId,
      object: "chat.completion",
      created: 0,
      model: this.model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    });
    const signedText = nearAiSignedText(requestBody, responseBody);
    const signature = toHex(ed25519.sign(utf8(signedText), this.secret));
    return { source: "standin", model: this.model, chatId, requestBody, responseBody, content, signedText, signature, signingAddress: this.signingAddress };
  }
}

// ---------------------------------------------------------------------------
// Generic LLM backend: any OpenAI-compatible API (Gemini, OpenAI, Groq,
// Ollama, etc.) for real AI reasoning without TEE signatures.
// ---------------------------------------------------------------------------

export interface GenericLlmOptions {
  /** API key (sent as `Authorization: Bearer <key>`). */
  apiKey: string;
  /** OpenAI-compatible base URL (e.g. `https://generativelanguage.googleapis.com/v1beta/openai`). */
  baseUrl: string;
  /** Model id (e.g. `gemini-2.5-flash`, `gpt-4.1-mini`, `llama-3.3-70b-versatile`). */
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Calls any OpenAI-compatible chat endpoint for real AI reasoning. The response
 * is locally signed with a throw-away ed25519 key so the swarm's on-chain
 * verifier runs the same code path — but the signature is **not** backed by a
 * TEE. This is clearly labeled as `generic_llm` everywhere.
 *
 * The key is random for every instance. Keep one instance per process so its
 * completions share one registered key.
 *
 * Use this when no NEAR AI Cloud key is available but the operator still wants
 * live model intelligence (judges, demos, local development).
 */
export class GenericLlmBackend implements CompletionBackend {
  readonly source = "generic_llm" as const;
  readonly model: string;
  private readonly opts: GenericLlmOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly secret: Uint8Array;
  readonly signingAddress: string;

  constructor(opts: GenericLlmOptions) {
    if (!opts.apiKey) throw new Error("GenericLlmBackend requires an API key");
    if (!opts.baseUrl) throw new Error("GenericLlmBackend requires a base URL");
    this.opts = opts;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    // Local signing key, not TEE-backed and labeled accordingly everywhere. It is random: a key
    // derived from a published seed would let anyone sign completions a registry trusting it accepts.
    const kp = keyPairFromSecret(crypto.getRandomValues(new Uint8Array(32)));
    this.secret = kp.secretKey;
    this.signingAddress = toHex(kp.publicKey);
  }

  async complete(messages: ChatMessage[], _standIn?: () => Record<string, unknown>): Promise<SignedCompletion> {
    // The exact bytes sent are the bytes the local signature covers.
    const requestBody = chatRequestBody(this.model, messages, { noThinking: false });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 60_000);
    let responseBody: string;
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: requestBody,
        signal: controller.signal,
      });
      responseBody = await res.text();
      if (!res.ok) {
        throw new Error(`LLM API HTTP ${res.status}: ${responseBody.slice(0, 300)}`);
      }
    } finally {
      clearTimeout(timeout);
    }

    const parsed = JSON.parse(responseBody) as ChatCompletionBody;
    const chatId = parsed.id ?? `chatcmpl-llm-${toHex(sha256Bytes(responseBody)).slice(0, 24)}`;
    const content = completionContent(parsed, "LLM API");

    // Re-serialize the response in the same format the verifier expects
    const normalizedResponse = JSON.stringify({
      id: chatId,
      object: "chat.completion",
      created: 0,
      model: this.model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    });

    // Sign with the local key (not TEE-backed)
    const signedText = nearAiSignedText(requestBody, normalizedResponse);
    const signature = toHex(ed25519.sign(utf8(signedText), this.secret));

    return {
      source: "generic_llm",
      model: this.model,
      chatId,
      requestBody,
      responseBody: normalizedResponse,
      content,
      signedText,
      signature,
      signingAddress: this.signingAddress,
    };
  }
}

export interface NearAiBackendOptions {
  /** NEAR AI Cloud API key (server / CLI only). */
  apiKey?: string;
  /** Server route that performs the completion and signature fetch (browser). */
  endpoint?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Extra JSON sent to `endpoint` (e.g. the role the server should prompt for). */
  endpointContext?: Record<string, unknown>;
}

interface SignatureResponse {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo?: string;
}

export class NearAiBackend implements CompletionBackend {
  readonly source = "nearai" as const;
  readonly model: string;
  /** The server route rebuilds only the single-turn prompt, so there is no draft → critique turn. */
  readonly deliberates: boolean;
  private readonly opts: NearAiBackendOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: NearAiBackendOptions) {
    if (!opts.apiKey && !opts.endpoint) throw new Error("NearAiBackend needs NEARAI_API_KEY or a server endpoint");
    this.opts = opts;
    this.deliberates = !opts.endpoint;
    this.model = opts.model ?? DEFAULT_NEARAI_MODEL;
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  private async withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), this.opts.timeoutMs ?? 90_000);
    try {
      return await run(c.signal);
    } finally {
      clearTimeout(t);
    }
  }

  async complete(messages: ChatMessage[], _standIn?: () => Record<string, unknown>, meta?: CompletionMeta): Promise<SignedCompletion> {
    if (this.opts.endpoint) {
      if (!meta) throw new Error("the inference endpoint needs the role, context and marker to rebuild the prompt");
      const res = await this.withTimeout((signal) =>
        this.fetchImpl(this.opts.endpoint!, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: this.model, role: meta.role, context: meta.context, marker: meta.marker, ...this.opts.endpointContext }),
          signal,
        }),
      );
      if (!res.ok) throw new Error(`inference endpoint HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const c = (await res.json()) as SignedCompletion;
      if (c.requestBody !== chatRequestBody(c.model, messages)) throw new Error("inference endpoint sent a different prompt than this agent built");
      if (!verifySignedCompletion(c)) throw new Error("inference endpoint returned a completion whose signature does not verify");
      return c;
    }
    const base = this.opts.baseUrl ?? NEARAI_CLOUD_BASE;
    const requestBody = chatRequestBody(this.model, messages);
    const auth = { Authorization: `Bearer ${this.opts.apiKey}` };
    const responseBody = await retryTransient(() =>
      this.withTimeout(async (signal) => {
        const res = await this.fetchImpl(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...auth },
          body: requestBody,
          signal,
        });
        const text = await res.text();
        if (!res.ok) throw new HttpError(`NEAR AI chat completion HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
        return text;
      }),
    );
    const parsed = JSON.parse(responseBody) as ChatCompletionBody;
    const chatId = parsed.id;
    if (!chatId) throw new Error("NEAR AI completion has no id");
    const content = completionContent(parsed, "NEAR AI");

    let sig: SignatureResponse | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6 && !sig; attempt++) {
      try {
        const url = new URL(`${base}/v1/signature/${encodeURIComponent(chatId)}`);
        url.searchParams.set("model", this.model);
        url.searchParams.set("signing_algo", "ed25519");
        const res = await this.withTimeout((signal) => this.fetchImpl(url.toString(), { headers: auth, signal }));
        if (!res.ok) throw new Error(`NEAR AI signature HTTP ${res.status}`);
        sig = (await res.json()) as SignatureResponse;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
      }
    }
    if (!sig) throw new Error(`NEAR AI signature unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    const completion: SignedCompletion = {
      source: "nearai",
      model: this.model,
      chatId,
      requestBody,
      responseBody,
      content,
      signedText: sig.text,
      signature: sig.signature.replace(/^0x/, "").toLowerCase(),
      signingAddress: sig.signing_address.replace(/^0x/, "").toLowerCase(),
    };
    if (!verifySignedCompletion(completion)) {
      throw new Error("NEAR AI signature does not cover the exact request/response bytes received (gateway rewrite or wrong key)");
    }
    return completion;
  }
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Retries network errors, 429 and 5xx up to 3 attempts. The request is deterministic, so a retry
 * asks the same question; timeouts and other HTTP errors are not retried.
 */
async function retryTransient<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const transient = err instanceof HttpError ? err.status === 429 || err.status >= 500 : !(err instanceof Error && err.name === "AbortError");
      if (!transient || attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1_500 * attempt));
    }
  }
}

/**
 * Uses a live backend and falls back to the stand-in when a call fails, so a demo keeps working
 * when the live service is down, slow or out of credit. Every fallback is reported to
 * `onFallback`, and a fallback completion keeps `source: "standin"`, so the UI shows which model
 * answered and the contract registers the stand-in key under its "no TEE" label.
 */
export class FallbackBackend implements CompletionBackend {
  readonly source: CompletionBackend["source"];
  readonly model: string;
  readonly deliberates?: boolean;

  constructor(
    private readonly primary: CompletionBackend,
    private readonly fallback: CompletionBackend,
    private readonly onFallback: (reason: string, meta?: CompletionMeta) => void,
  ) {
    this.source = primary.source;
    this.model = primary.model;
    this.deliberates = primary.deliberates;
  }

  async complete(messages: ChatMessage[], standIn: () => Record<string, unknown>, meta?: CompletionMeta): Promise<SignedCompletion> {
    try {
      return await this.primary.complete(messages, standIn, meta);
    } catch (err) {
      this.onFallback(err instanceof Error ? err.message : String(err), meta);
      return this.fallback.complete(messages, standIn, meta);
    }
  }
}

/** What a proof must be bound to (see `attestation.rs`). */
export interface ProofBinding {
  subjectKind: SubjectKindT;
  subjectId: bigint | string;
  agentId: string;
  inputHash: string;
  schemaHash: string;
  nonce: string;
  issuedAtNs: bigint;
}

export function bindingMarkerFor(b: ProofBinding): string {
  return nearAiBindingMarker(b.subjectKind, b.subjectId, b.agentId, b.inputHash, b.nonce, b.issuedAtNs);
}

/** Converts a signed completion into the `ExecutionProof` the contract verifies. */
export function toNearAiProof(c: SignedCompletion, b: ProofBinding, enclaveId: string): ExecutionProofT {
  return {
    kind: "near_ai",
    enclave_id: enclaveId,
    chat_id: c.chatId,
    subject_kind: b.subjectKind,
    subject_id: BigInt(b.subjectId).toString(),
    agent_id: b.agentId,
    input_hash: b.inputHash,
    schema_hash: b.schemaHash,
    nonce: b.nonce,
    issued_at_ns: b.issuedAtNs.toString(),
    request_body: c.requestBody,
    response_body: c.responseBody,
    signed_text: c.signedText,
    signature: c.signature,
  };
}

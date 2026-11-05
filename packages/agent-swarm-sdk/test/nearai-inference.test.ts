/** NEAR AI signed completions: client against a mocked NEAR AI server, stand-in, local verification. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

import {
  chatRequestBody,
  GenericLlmBackend,
  keyPairFromSeed,
  NearAiBackend,
  nearAiSignedText,
  StandInBackend,
  toHex,
  utf8,
  verifySignedCompletion,
  type ChatMessage,
} from "../src/index.ts";

const MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";
const modelKey = keyPairFromSeed("mock-nearai-model-key");
const messages: ChatMessage[] = [
  { role: "system", content: "Answer with JSON." },
  { role: "user", content: "ping" },
];

/** A fake NEAR AI Cloud: chat completions plus `/v1/signature/{id}` signed by `modelKey`. */
function mockNearAi(opts: { tamper?: boolean } = {}) {
  const seen: { request?: string; auth?: string | null } = {};
  let responseBody = "";
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/v1/chat/completions") {
      seen.request = String(init?.body);
      seen.auth = new Headers(init?.headers).get("authorization");
      responseBody = JSON.stringify({
        id: "chatcmpl-mock-1",
        object: "chat.completion",
        model: MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: '{"verdict":"approve","confidence_bps":9500,"findings":[]}' }, finish_reason: "stop" }],
      });
      return new Response(responseBody, { status: 200 });
    }
    if (url.pathname === "/v1/signature/chatcmpl-mock-1") {
      expect(url.searchParams.get("signing_algo")).toBe("ed25519");
      const text = nearAiSignedText(opts.tamper ? `${seen.request} ` : seen.request!, responseBody);
      return Response.json({
        text,
        signature: toHex(ed25519.sign(utf8(text), modelKey.secretKey)),
        signing_address: toHex(modelKey.publicKey),
        signing_algo: "ed25519",
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe("NEAR AI Cloud backend", () => {
  it("keeps the exact bytes, fetches the ed25519 signature and verifies it locally", async () => {
    const { fetchImpl, seen } = mockNearAi();
    const backend = new NearAiBackend({ apiKey: "sk-test", baseUrl: "https://nearai.mock", model: MODEL, fetchImpl });
    const c = await backend.complete(messages);
    expect(seen.auth).toBe("Bearer sk-test");
    expect(c.requestBody).toBe(chatRequestBody(MODEL, messages));
    expect(seen.request).toBe(c.requestBody);
    expect(c.signingAddress).toBe(toHex(modelKey.publicKey));
    expect(JSON.parse(c.content).verdict).toBe("approve");
    expect(verifySignedCompletion(c)).toBe(true);
  });

  it("refuses a signature that does not cover the bytes it received", async () => {
    const { fetchImpl } = mockNearAi({ tamper: true });
    const backend = new NearAiBackend({ apiKey: "sk-test", baseUrl: "https://nearai.mock", model: MODEL, fetchImpl });
    await expect(backend.complete(messages)).rejects.toThrow(/does not cover the exact request/);
  });

  it("needs a key or a server endpoint", () => {
    expect(() => new NearAiBackend({})).toThrow(/NEARAI_API_KEY/);
  });
});

describe("offline stand-in", () => {
  it("produces NEAR AI's signed format deterministically", async () => {
    const a = await new StandInBackend().complete(messages, () => ({ verdict: "completed", confidence_bps: 9000 }));
    const b = await new StandInBackend().complete(messages, () => ({ verdict: "completed", confidence_bps: 9000 }));
    expect(a).toEqual(b);
    expect(a.source).toBe("standin");
    expect(verifySignedCompletion(a)).toBe(true);
    expect(verifySignedCompletion({ ...a, responseBody: a.responseBody.replace("9000", "9001") })).toBe(false);
  });
});

describe("generic LLM backend", () => {
  it("requires apiKey and baseUrl", () => {
    expect(() => new GenericLlmBackend({ apiKey: "", baseUrl: "http://test", model: "m" })).toThrow(/API key/);
    expect(() => new GenericLlmBackend({ apiKey: "key", baseUrl: "", model: "m" })).toThrow(/base URL/);
  });

  it("calls OpenAI/Gemini-compatible endpoint, signs completion, and verifies", async () => {
    const seen: { auth?: string | null; body?: string } = {};
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.auth = new Headers(init?.headers).get("authorization");
      seen.body = String(init?.body);
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test-1",
          choices: [{ message: { content: '{"verdict":"approve","confidence_bps":9800}' } }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const backend = new GenericLlmBackend({
      apiKey: "ai-key-123",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-2.5-flash",
      fetchImpl,
    });

    const completion = await backend.complete(messages, () => ({}));
    expect(seen.auth).toBe("Bearer ai-key-123");
    expect(seen.body).toContain('"model":"gemini-2.5-flash"');
    expect(completion.source).toBe("generic_llm");
    expect(completion.model).toBe("gemini-2.5-flash");
    expect(completion.content).toBe('{"verdict":"approve","confidence_bps":9800}');
    expect(verifySignedCompletion(completion)).toBe(true);
  });

  it("handles upstream API errors", async () => {
    const fetchImpl = (async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;

    const backend = new GenericLlmBackend({
      apiKey: "bad-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      fetchImpl,
    });

    await expect(backend.complete(messages, () => ({}))).rejects.toThrow(/HTTP 401/);
  });
});

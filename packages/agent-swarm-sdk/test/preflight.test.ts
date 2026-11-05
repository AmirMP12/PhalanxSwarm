/** Agent-side pre-flight and the live-model fallback. */
import { describe, expect, it } from "vitest";

import {
  completionContent,
  decidePreflight,
  FallbackBackend,
  MAX_COMPLETION_TOKENS,
  StandInBackend,
  verifySignedCompletion,
  type CompletionBackend,
  type RecipientCheckT,
} from "../src/index.ts";

const check = (over: Partial<RecipientCheckT>): RecipientCheckT => ({
  chain: "arb",
  recipient: "0x7a3f00000000000000000000000000000000beef",
  verdict: "warn",
  reasons: ["not on the DAO allow-list"],
  allow_listed: false,
  registered_agent: false,
  blocked: null,
  unknown_recipient: "quarantine",
  ...over,
});

describe("pre-flight", () => {
  it("signs for allow-listed recipients and refuses blocked ones", () => {
    expect(decidePreflight(check({ verdict: "allow", allow_listed: true })).action).toBe("sign");
    expect(decidePreflight(check({ verdict: "block" })).action).toBe("refuse");
  });

  it("never pays a new recipient on its own: DAO approval under hold, allow-listing under quarantine", () => {
    expect(decidePreflight(check({ unknown_recipient: "hold" })).action).toBe("submit_for_dao_approval");
    expect(decidePreflight(check({ unknown_recipient: "quarantine" })).action).toBe("ask_dao_to_allow_list");
  });
});

describe("live model answers", () => {
  it("explains a completion whose reasoning used the whole token budget", () => {
    const exhausted = {
      id: "chatcmpl-1",
      choices: [{ finish_reason: "length", message: { content: null } }],
      usage: { completion_tokens: MAX_COMPLETION_TOKENS, completion_tokens_details: { reasoning_tokens: MAX_COMPLETION_TOKENS } },
    };
    expect(() => completionContent(exhausted, "NEAR AI")).toThrow(new RegExp(`whole ${MAX_COMPLETION_TOKENS}-token budget .*reasoning tokens`));
    expect(completionContent({ choices: [{ finish_reason: "stop", message: { content: '{"verdict":"approve"}' } }] }, "NEAR AI")).toBe('{"verdict":"approve"}');
  });

  it("falls back to the labeled stand-in when the live backend fails, and reports it", async () => {
    const failing: CompletionBackend = {
      source: "nearai",
      model: "Qwen/Qwen3.6-35B-A3B-FP8",
      complete: () => Promise.reject(new Error("NEAR AI chat completion HTTP 503")),
    };
    const reasons: string[] = [];
    const backend = new FallbackBackend(failing, new StandInBackend(), (reason, meta) => reasons.push(`${meta?.role}: ${reason}`));
    expect(backend.source).toBe("nearai");
    const c = await backend.complete([{ role: "user", content: "audit" }], () => ({ verdict: "approve" }), {
      role: "auditor",
      context: {},
      marker: null,
    });
    expect(c.source).toBe("standin");
    expect(JSON.parse(c.content)).toEqual({ verdict: "approve" });
    expect(verifySignedCompletion(c)).toBe(true);
    expect(reasons).toEqual(["auditor: NEAR AI chat completion HTTP 503"]);
  });
});

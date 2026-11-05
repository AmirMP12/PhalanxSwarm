/** Agent prompts, output validation and the invoice-fraud stand-in. */
import { describe, expect, it } from "vitest";

import { ATTACKER_EVM, extractJson, messagesFor, naiveInvoiceReading, poisonedInvoice, StandInBackend, think, VENDOR_EVM } from "../src/index.ts";

describe("agent brains", () => {
  it("puts the proof binding marker into the system prompt only", () => {
    const m = messagesFor("auditor", { a: 1 }, "AEGIS-BIND:v1:intent:0:x:y:z:1");
    expect(m[0]!.content).toContain("AEGIS-BIND:v1:intent:0:x:y:z:1");
    expect(m[1]!.content).toBe('{"a":1}');
  });

  it("extracts the JSON object from fenced or chatty answers", () => {
    expect(extractJson('Sure!\n```json\n{"verdict":"approve","confidence_bps":9000,"findings":[]}\n```')).toEqual({
      verdict: "approve",
      confidence_bps: 9000,
      findings: [],
    });
    expect(() => extractJson("no json here")).toThrow(/no complete JSON object/);
    expect(() => extractJson('{"verdict":"approve","findings":["cut off')).toThrow(/no complete JSON object \(\d+ chars/);
  });

  it("rejects answers that do not match the role's schema", async () => {
    await expect(think(new StandInBackend(), "auditor", {}, null, () => ({ verdict: "maybe" }) as never)).rejects.toThrow();
  });

  it("a naive accounts-payable reading of the poisoned invoice pays the attacker", () => {
    const invoice = poisonedInvoice({
      invoiceId: "INV-1",
      vendor: "GPU Vendor A",
      legitAddress: VENDOR_EVM,
      attackerAddress: ATTACKER_EVM,
      amountUsd: 18.92,
      nearUsd: 4.73,
    });
    const instruction = naiveInvoiceReading(invoice, "INV-1");
    expect(instruction.recipient).toBe(ATTACKER_EVM);
    expect(instruction.amount_near).toBe(4);
    expect(instruction.chain).toBe("arb");
  });
});

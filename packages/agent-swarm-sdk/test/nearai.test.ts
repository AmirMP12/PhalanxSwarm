import { describe, expect, it } from "vitest";

import { checkBinding, offlineAttestation } from "../src/index.ts";
import { verifyNearAiAttestationNode } from "../src/node.ts";

describe("NEAR AI Cloud attestation", () => {
  it("offline fixture is deterministic and never claims to be verified", () => {
    const a = offlineAttestation("cipher-procurement-planner:v1");
    expect(a.verified).toBe(false);
    expect(a.source).toBe("binding-only");
    expect(a.measurement).toHaveLength(64);
    expect(offlineAttestation("cipher-procurement-planner:v1").measurement).toBe(a.measurement);
  });

  it("binding check rejects a report whose report_data does not commit to the nonce", () => {
    const a = offlineAttestation("x");
    expect(checkBinding(a.report, "ff".repeat(32))).toBe(false);
  });

  // Gated: hits the live NEAR AI Cloud endpoint and verifies the Intel TDX quote via dcap-qvl.
  it.runIf(process.env.PHALANX_LIVE_TEE === "1" && Boolean(process.env.NEARAI_API_KEY))(
    "fetches and DCAP-verifies a real NEAR AI Cloud Intel TDX attestation",
    async () => {
      const r = await verifyNearAiAttestationNode({ timeoutMs: 25_000 });
      expect(r.source).toBe("live");
      expect(r.bindingOk).toBe(true);
      expect(r.measurementMatch).toBe(true);
      expect(["UpToDate", "SWHardeningNeeded", "ConfigurationAndSWHardeningNeeded"]).toContain(r.status);
      expect(r.verified).toBe(true);
      expect(r.measurement).toMatch(/^[0-9a-f]{96}$/);
      expect(r.signingAddress).toMatch(/^[0-9a-f]{64}$/);
    },
    40_000,
  );
});

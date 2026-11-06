#!/usr/bin/env node
/**
 * Fetches and DCAP-verifies fresh NEAR AI Cloud attestations (`pnpm verify:tee`). No API key is
 * needed: the attestation endpoint is public (a key is sent when NEARAI_API_KEY is set).
 *
 *  - Gateway: Intel TDX quote, report_data = signing key ‖ our fresh nonce, mr_td match.
 *  - Model (NEARAI_MODEL or the default): every server's response-signing key, each bound to the
 *    same fresh nonce by its own DCAP-verified quote. These are the keys the contract accepts
 *    NEAR AI proofs from once the owner registers them.
 *
 * Writes artifacts/nearai-attestation.json (public measurements, keys, verdicts; no secrets).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_NEARAI_MODEL } from "../packages/agent-swarm-sdk/src/index.ts";
import { loadRootEnv, verifyNearAiAttestationNode, verifyNearAiModelKeysNode } from "../packages/agent-swarm-sdk/src/node.ts";

loadRootEnv();

async function main() {
  const result = await verifyNearAiAttestationNode({ timeoutMs: 25_000 });
  if (!result.verified || !result.bindingOk || !result.measurementMatch || result.source !== "live") {
    throw new Error(
      `NEAR AI gateway attestation failed: ${JSON.stringify({ source: result.source, status: result.status, binding: result.bindingOk, measurement: result.measurementMatch })}`,
    );
  }
  const model = process.env.NEARAI_MODEL || DEFAULT_NEARAI_MODEL;
  const keys = await verifyNearAiModelKeysNode({ model, timeoutMs: 25_000 });
  if (keys.length === 0 || !keys.every((k) => k.verified)) {
    throw new Error(
      `NEAR AI model attestation failed for ${model}: ${JSON.stringify(keys.map((k) => ({ key: k.signingAddress, status: k.status, binding: k.bindingOk })))}`,
    );
  }
  const evidence = {
    provider: "NEAR AI Cloud",
    tee: "Intel TDX",
    verifier: "@phala/dcap-qvl",
    source: result.source,
    status: result.status,
    verified: result.verified,
    nonce_bound: result.bindingOk,
    measurement_match: result.measurementMatch,
    measurement_mr_td: result.measurement,
    gateway_signing_address: result.signingAddress,
    nonce: result.nonce,
    advisory_ids: result.advisoryIds,
    endpoint: "https://cloud-api.near.ai/v1/attestation/report",
    model_attestation: {
      model,
      nonce: keys[0]!.nonce,
      keys: keys.map((k) => ({
        signing_address: k.signingAddress,
        near_public_key: k.publicKey,
        status: k.status,
        nonce_bound: k.bindingOk,
        measurement_mr_td: k.measurement,
        report_sha256: k.reportHash,
      })),
    },
    timestamp: new Date().toISOString(),
  };
  writeFileSync(resolve("artifacts/nearai-attestation.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log("REAL NEAR AI TDX ATTESTATION: PASS");
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((err) => {
  console.error("REAL NEAR AI TDX ATTESTATION: FAIL", err);
  process.exitCode = 1;
});

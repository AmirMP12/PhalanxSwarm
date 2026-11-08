#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatNear, randomKeyPair } from "../packages/agent-swarm-sdk/src/index.ts";
import { accountBalance, accountExists, networkConfig, REPO_ROOT, saveCredential } from "./lib/near.ts";

async function main() {
  const cfg = networkConfig("testnet");
  const suffix = randomBytes(3).toString("hex");
  const accountId = process.argv[2] ?? `phalanx-deploy-${suffix}.testnet`;

  console.log(`Generating key pair for ${accountId}...`);
  const keyPair = randomKeyPair();
  console.log(`Account ID:  ${accountId}`);
  console.log(`Public Key:  ${keyPair.publicKeyString}`);

  console.log(`Requesting account creation and funding from NEAR Testnet Helper Faucet...`);
  const helperUrl = "https://helper.testnet.near.org/account";

  try {
    const res = await fetch(helperUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        newAccountId: accountId,
        newAccountPublicKey: keyPair.publicKeyString,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.ok) {
      console.log(`Account ${accountId} successfully created and funded via NEAR testnet helper faucet!`);
    } else {
      const text = await res.text();
      console.warn(`Faucet helper returned status ${res.status}: ${text}`);
    }
  } catch (err) {
    console.warn(`Failed to reach faucet helper: ${err}`);
  }

  const credPath = saveCredential(cfg, accountId, keyPair);
  console.log(`Saved credential to: ${credPath}`);

  try {
    const exists = await accountExists(cfg.rpc, accountId);
    if (exists) {
      const balance = await accountBalance(cfg.rpc, accountId);
      console.log(`On-chain balance: ${formatNear(balance, 4)} NEAR`);
    } else {
      console.log(`Note: Account ${accountId} is not yet detected on-chain.`);
      console.log(`If the automated faucet failed or is rate-limited, you can fund it via:`);
      console.log(`  - Faucet: https://near-faucet.io (enter ${accountId})`);
    }
  } catch (err) {
    console.log(`Could not query balance on testnet: ${err}`);
  }

  const envPath = resolve(REPO_ROOT, ".env");
  const envExamplePath = resolve(REPO_ROOT, ".env.example");
  let envContent = existsSync(envPath) ? readFileSync(envPath, "utf8") : existsSync(envExamplePath) ? readFileSync(envExamplePath, "utf8") : "";

  const normalizedPath = credPath.replace(/\\/g, "/");

  if (/^PHALANX_TESTNET_CREDENTIAL=.*$/m.test(envContent)) {
    envContent = envContent.replace(/^PHALANX_TESTNET_CREDENTIAL=.*$/m, `PHALANX_TESTNET_CREDENTIAL=${normalizedPath}`);
  } else {
    envContent += `\nPHALANX_TESTNET_CREDENTIAL=${normalizedPath}\n`;
  }

  writeFileSync(envPath, envContent, "utf8");
  console.log(`Updated .env with PHALANX_TESTNET_CREDENTIAL=${normalizedPath}`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Real NEAR Connect wallet smoke test in Chromium.
 *
 * Injects a disposable self-custodial test wallet through NEAR Connect's documented
 * `near-wallet-injected` event, signs owner actions with near-api-js, broadcasts them to real
 * NEAR testnet, and verifies the command-center UI observes pause + resume over RPC.
 *
 * Requires a running web app (default http://localhost:3100) and
 * PHALANX_TESTNET_CREDENTIAL=/absolute/path/to/disposable-testnet-key.json (outside this repo).
 * Writes artifacts/wallet-smoke.json with public evidence only. The private key never enters the
 * browser, page storage, logs, or repository: a Node-side exposed function is the wallet boundary.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Account, actions, KeyPairSigner } from "near-api-js";
import { chromium } from "playwright-core";

const credentialPath = process.env.PHALANX_TESTNET_CREDENTIAL;
if (!credentialPath) throw new Error("set PHALANX_TESTNET_CREDENTIAL to a disposable testnet credential JSON outside the repo");
const cred = JSON.parse(readFileSync(credentialPath, "utf8"));
if (!cred.account_id?.endsWith(".testnet")) throw new Error("wallet smoke accepts .testnet credentials only");
const APP = process.env.PHALANX_WEB_URL ?? "http://localhost:3100";
const RPC = "https://rpc.testnet.near.org";
const browserPaths = [
  process.env.CHROME_BIN,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const executablePath = browserPaths.find((p) => existsSync(p));
if (!executablePath) throw new Error("set CHROME_BIN to Chrome/Chromium/Edge");
const signer = KeyPairSigner.fromSecretKey(cred.private_key);
const sent = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pausedOnChain() {
  const args = Buffer.from("{}").toString("base64");
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "query",
          params: { request_type: "call_function", finality: "final", account_id: cred.account_id, method_name: "is_paused", args_base64: args },
        }),
      });
      const body = await res.json();
      if (!body.result?.result) throw new Error(JSON.stringify(body.error));
      return JSON.parse(Buffer.from(body.result.result).toString());
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", (e) => browserErrors.push(e.message));
  await page.exposeFunction("__phalanxRealWalletSign", async (params) => {
    const converted = params.actions.map((a) => {
      if (a.type === "FunctionCall") return actions.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit));
      throw new Error(`wallet smoke does not permit action ${a.type}`);
    });
    const method = params.actions[0]?.params?.methodName;
    let result;
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const account = new Account(cred.account_id, RPC, signer);
        result = await account.signAndSendTransaction({ receiverId: params.receiverId, actions: converted, waitUntil: "FINAL", throwOnFailure: true });
        break;
      } catch (error) {
        lastError = error;
        console.error(`wallet ${method} attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (attempt < 3) await sleep(1000 * 2 ** attempt);
      }
    }
    if (!result) throw lastError ?? new Error(`wallet ${method} failed`);
    const hash = String(result.transaction?.hash ?? "unknown");
    sent.push({ method, receiver_id: params.receiverId, hash, explorer: `https://testnet.nearblocks.io/txns/${hash}` });
    console.log(`wallet ${method} final: ${hash}`);
    return { transaction: { hash, signer_id: cred.account_id, receiver_id: params.receiverId }, status: { SuccessValue: "" } };
  });

  await page.goto(APP, { waitUntil: "networkidle", timeout: 120_000 });
  await page.waitForFunction(() => document.body.innerText.includes("WASM running locally"), null, { timeout: 120_000 });

  await page.evaluate(
    ({ accountId, publicKey }) => {
      let signedIn = false;
      const wallet = {
        manifest: {
          id: "phalanx-disposable-real-testnet",
          platform: ["web"],
          name: "Phalanx Disposable Testnet Wallet",
          icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%2307090e'/%3E%3Cpath d='M12 20h40v28H12zM20 20v-6h30v6' fill='none' stroke='%2300ec97' stroke-width='4'/%3E%3C/svg%3E",
          description: "Disposable self-custodial wallet used by the PhalanxSwarm real-testnet smoke test",
          website: "https://near.org",
          version: "1.0.0",
          executor: "injected",
          type: "injected",
          permissions: {},
          features: {
            signMessage: false,
            signTransaction: true,
            signAndSendTransaction: true,
            signAndSendTransactions: true,
            signInWithoutAddKey: true,
            signInAndSignMessage: false,
            signInWithFunctionCallKey: false,
            signDelegateActions: false,
            mainnet: false,
            testnet: true,
          },
        },
        signIn: async () => {
          signedIn = true;
          return [{ accountId, publicKey }];
        },
        signOut: async () => {
          signedIn = false;
        },
        getAccounts: async () => (signedIn ? [{ accountId, publicKey }] : []),
        signAndSendTransaction: (params) => window.__phalanxRealWalletSign(params),
        signAndSendTransactions: async ({ transactions, ...rest }) => Promise.all(transactions.map((tx) => window.__phalanxRealWalletSign({ ...rest, ...tx }))),
        signMessage: async () => {
          throw new Error("not supported by this disposable smoke wallet");
        },
        signInAndSignMessage: async () => {
          throw new Error("not supported by this disposable smoke wallet");
        },
        signDelegateActions: async () => {
          throw new Error("not supported by this disposable smoke wallet");
        },
      };
      window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: wallet }));
    },
    { accountId: cred.account_id, publicKey: cred.public_key },
  );

  await page.getByRole("button", { name: /Connect NEAR wallet/i }).click();
  await page.locator('.connect-item[data-type="phalanx-disposable-real-testnet"]').click({ timeout: 30_000 });
  await page.getByRole("button", { name: "Disconnect wallet" }).waitFor({ timeout: 30_000 });
  console.log(`NEAR Connect login: ${cred.account_id}`);

  const input = page.getByLabel("Testnet contract account");
  await input.fill(cred.account_id);
  await page.getByRole("button", { name: "Load on-chain state" }).click();
  await page.getByRole("button", { name: "Pause (wallet)" }).waitFor({ timeout: 90_000 });
  console.log("RPC dashboard: loaded");

  const bridgeText = async () =>
    page
      .locator("text=Testnet bridge")
      .locator("..")
      .innerText()
      .catch(() => "bridge unavailable");
  const awaitState = async (expected, buttonName, priorTxCount) => {
    for (let i = 0; i < 75; i++) {
      if (sent.length > priorTxCount) {
        const paused = await pausedOnChain().catch(() => null);
        if (paused === expected) {
          await page
            .getByRole("button", { name: "Load on-chain state" })
            .click()
            .catch(() => undefined);
          await page.getByRole("button", { name: buttonName }).waitFor({ timeout: 30_000 });
          return;
        }
      }
      await sleep(1000);
    }
    throw new Error(`wallet state ${String(expected)} not observed; sent=${JSON.stringify(sent)}; bridge=${await bridgeText()}`);
  };

  let prior = sent.length;
  await page.getByRole("button", { name: "Pause (wallet)" }).click();
  await awaitState(true, "Resume (wallet)", prior);
  console.log("wallet tx: pause observed on-chain");
  prior = sent.length;
  await page.getByRole("button", { name: "Resume (wallet)" }).click();
  await awaitState(false, "Pause (wallet)", prior);
  console.log("wallet tx: resume observed on-chain");

  if (sent.length < 2 || sent.some((x) => x.receiver_id !== cred.account_id)) throw new Error(`unexpected wallet transactions: ${JSON.stringify(sent)}`);
  if (browserErrors.length) throw new Error(`browser errors: ${browserErrors.join("; ")}`);
  const evidence = {
    network: "testnet",
    wallet_connector: "@hot-labs/near-connect",
    wallet_type: "injected disposable self-custodial test wallet",
    account_id: cred.account_id,
    contract_id: cred.account_id,
    login_observed: true,
    rpc_dashboard_loaded: true,
    pause_observed: true,
    resume_observed: true,
    transactions: sent,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(resolve("artifacts/wallet-smoke.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log("REAL NEAR CONNECT WALLET SMOKE: PASS");
} finally {
  await browser.close();
}

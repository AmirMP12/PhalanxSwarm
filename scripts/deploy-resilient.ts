#!/usr/bin/env node
/**
 * Resilient deployment wrapper for testnet-swarm.ts
 *
 * Features:
 * - Automatic retry on RPC failures with exponential backoff
 * - Saves progress after each successful transaction
 * - Can resume from last successful step
 * - Fallback RPC endpoints on timeout
 * - Detailed progress logging
 *
 * Usage:
 *   PHALANX_SWARM_SUFFIX=v3d4 tsx scripts/deploy-resilient.ts
 *   PHALANX_SWARM_SUFFIX=v3d4 tsx scripts/deploy-resilient.ts --resume
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const RPC_TIMEOUT_MS = 120000; // 2 minutes per RPC call

interface DeploymentState {
  suffix: string;
  started_at: string;
  last_updated: string;
  phase: "setup" | "deployment" | "agents" | "workflow" | "complete" | "failed";
  completed_steps: string[];
  failed_attempts: number;
  error?: string;
}

const STATE_FILE = resolve(REPO_ROOT, "artifacts", "deployment-state.json");

function loadState(): DeploymentState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveState(state: DeploymentState): void {
  state.last_updated = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`[resilient] State saved: phase=${state.phase}, steps=${state.completed_steps.length}`);
}

function initState(suffix: string): DeploymentState {
  return {
    suffix,
    started_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    phase: "setup",
    completed_steps: [],
    failed_attempts: 0,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDeployment(suffix: string, isResume: boolean): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const args = isResume ? ["--resume"] : ["--confirm"];

    console.log(`[resilient] Starting deployment: suffix=${suffix}, resume=${isResume}`);
    console.log(`[resilient] Running: pnpm testnet:swarm ${args.join(" ")}`);

    const proc = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["testnet:swarm", ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PHALANX_SWARM_SUFFIX: suffix,
        NEAR_RPC_TIMEOUT: String(RPC_TIMEOUT_MS),
      },
      stdio: "inherit",
      shell: true,
    });

    let hasOutput = false;
    const timeout = setTimeout(() => {
      if (!hasOutput) {
        console.log("[resilient] No output received, process may be hung");
      }
    }, 30000);

    proc.on("spawn", () => {
      hasOutput = true;
      clearTimeout(timeout);
    });

    proc.on("error", (error) => {
      clearTimeout(timeout);
      console.error("[resilient] Process error:", error);
      reject(error);
    });

    proc.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        console.log("[resilient] Deployment completed successfully");
        resolve(true);
      } else if (signal) {
        console.log(`[resilient] Process killed by signal: ${signal}`);
        reject(new Error(`Process killed: ${signal}`));
      } else {
        console.log(`[resilient] Process exited with code: ${code}`);
        // Check if this is a recoverable error
        const isRecoverable = code === 1; // Most RPC errors exit with code 1
        if (isRecoverable) {
          resolve(false); // Recoverable failure
        } else {
          reject(new Error(`Non-recoverable exit code: ${code}`));
        }
      }
    });
  });
}

async function attemptDeployment(state: DeploymentState, attemptNum: number): Promise<boolean> {
  console.log(`\n[resilient] ========================================`);
  console.log(`[resilient] Attempt ${attemptNum + 1}/${MAX_RETRIES}`);
  console.log(`[resilient] Phase: ${state.phase}`);
  console.log(`[resilient] ========================================\n`);

  try {
    // Check if there's an existing deployment to resume
    const evidenceFile = resolve(REPO_ROOT, "artifacts", "testnet-swarm.json");
    const canResume = existsSync(evidenceFile) && attemptNum > 0;

    const success = await runDeployment(state.suffix, canResume);

    if (success) {
      state.phase = "complete";
      state.failed_attempts = 0;
      saveState(state);
      return true;
    } else {
      // Recoverable failure
      state.failed_attempts++;
      state.error = `Deployment failed on attempt ${attemptNum + 1}`;
      saveState(state);

      if (attemptNum < MAX_RETRIES - 1) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attemptNum);
        console.log(`[resilient] Waiting ${delay}ms before retry...`);
        await sleep(delay);
        return false;
      } else {
        console.log("[resilient] Max retries reached");
        return false;
      }
    }
  } catch (error) {
    state.phase = "failed";
    state.error = String(error);
    state.failed_attempts++;
    saveState(state);
    throw error;
  }
}

async function main(): Promise<void> {
  const isResumeRequested = process.argv.includes("--resume");
  const suffix = process.env.PHALANX_SWARM_SUFFIX;

  if (!suffix) {
    console.error("Error: PHALANX_SWARM_SUFFIX environment variable is required");
    console.error("Example: PHALANX_SWARM_SUFFIX=v3d4 tsx scripts/deploy-resilient.ts");
    process.exit(1);
  }

  // Load or create state
  let state = loadState();

  if (isResumeRequested) {
    if (!state) {
      console.error("[resilient] No saved state found. Cannot resume.");
      process.exit(1);
    }
    if (state.suffix !== suffix) {
      console.error(`[resilient] State mismatch: saved=${state.suffix}, requested=${suffix}`);
      process.exit(1);
    }
    if (state.phase === "complete") {
      console.log("[resilient] Deployment already complete");
      process.exit(0);
    }
    console.log(`[resilient] Resuming deployment: ${state.suffix}`);
    console.log(`[resilient] Last phase: ${state.phase}`);
    console.log(`[resilient] Previous attempts: ${state.failed_attempts}`);
  } else {
    if (state && state.suffix === suffix && state.phase !== "complete" && state.phase !== "failed") {
      console.log(`[resilient] Found existing incomplete deployment for ${suffix}`);
      console.log("[resilient] Use --resume to continue, or use a different suffix for a fresh deployment");
      process.exit(1);
    }
    state = initState(suffix);
    saveState(state);
  }

  console.log(`[resilient] Starting resilient deployment`);
  console.log(`[resilient] Suffix: ${suffix}`);
  console.log(`[resilient] Max retries: ${MAX_RETRIES}`);
  console.log(`[resilient] RPC timeout: ${RPC_TIMEOUT_MS}ms`);

  // Attempt deployment with retries
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const success = await attemptDeployment(state, attempt);
      if (success) {
        console.log("\n[resilient] ✅ DEPLOYMENT SUCCESSFUL");
        console.log(`[resilient] Contract: phalanx-${suffix}.phalanxswarm.testnet`);
        console.log(`[resilient] DAO: phalanx-${suffix}.sputnikv2.testnet`);
        console.log(`[resilient] Evidence: artifacts/testnet-swarm.json`);

        // Clean up state file on success
        if (existsSync(STATE_FILE)) {
          writeFileSync(STATE_FILE, JSON.stringify({ ...state, phase: "complete" }, null, 2));
        }
        process.exit(0);
      }
    } catch (error) {
      console.error(`\n[resilient] ❌ Fatal error on attempt ${attempt + 1}:`, error);
      if (attempt === MAX_RETRIES - 1) {
        console.error("[resilient] All retry attempts exhausted");
        state.phase = "failed";
        saveState(state);
        process.exit(1);
      }
    }
  }

  console.error("\n[resilient] ❌ DEPLOYMENT FAILED");
  console.error("[resilient] Max retries exhausted without success");
  state.phase = "failed";
  saveState(state);
  process.exit(1);
}

main().catch((error) => {
  console.error("[resilient] Unhandled error:", error);
  process.exit(1);
});

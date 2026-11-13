#!/usr/bin/env node
/**
 * Cross-platform runner for pnpm audit (JS dependencies).
 *
 * Checks if the npm registry is reachable. If offline or network-isolated,
 * prints a warning and skips cleanly instead of hanging or failing.
 */
import { spawnSync } from "node:child_process";

async function isOnline() {
  try {
    const res = await fetch("https://registry.npmjs.org/-/ping", {
      signal: AbortSignal.timeout(8000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

const online = await isOnline();
if (!online) {
  console.warn("⚠️  npm registry (registry.npmjs.org) is unreachable (offline or network-sandboxed). Skipping JS audit...");
  process.exit(0);
}

const res = spawnSync("pnpm", ["audit", "--audit-level", "low"], {
  stdio: "inherit",
  shell: true,
});

process.exit(res.status ?? 0);

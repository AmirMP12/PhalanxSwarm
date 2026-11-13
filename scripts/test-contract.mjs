#!/usr/bin/env node
/**
 * Cross-platform runner for contracts/phalanx-core unit tests.
 *
 * Runs `cargo test -p phalanx-core --locked`. On Linux/macOS it runs inside a login shell so the
 * user's cargo environment is sourced; on Windows it invokes cargo directly to avoid WSL/MSYS
 * bash.exe permission traps.
 */
import { spawnSync } from "node:child_process";
import { platform } from "node:os";

const isWin = platform() === "win32";

if (!isWin) {
  const res = spawnSync("bash", ["-lc", "cargo test -p phalanx-core --locked"], { stdio: "inherit" });
  process.exit(res.status ?? 1);
}

// On Windows, invoke cargo directly
const res = spawnSync("cargo", ["test", "-p", "phalanx-core", "--locked"], { stdio: "inherit", shell: true });
if (res.status === 0) {
  process.exit(0);
}

console.error("\n[phalanx-swarm] Notice: Native Rust tests ('cargo test') on Windows require the MSVC C++ Linker (link.exe from Visual Studio Build Tools).");
console.error("[phalanx-swarm] To run the full hermetic test suite on Windows without MSVC or WSL, use:");
console.error("  pnpm test            (77 TypeScript SDK & WebAssembly VM tests)");
console.error("  pnpm judge:offline   (11-step complete scenario against artifacts/phalanx_core.wasm)");
console.error("  pnpm judge:attack    (invoice fraud circuit breaker verification)\n");
process.exit(res.status ?? 1);

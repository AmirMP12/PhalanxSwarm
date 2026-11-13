#!/usr/bin/env node
/**
 * Cross-platform runner for Cargo audit (Rust dependencies).
 *
 * Runs `cargo audit`. On Linux/macOS, invokes `cargo audit` (using a login shell if bash is available
 * so the cargo environment is sourced). On Windows, invokes `cargo audit` directly to avoid
 * WSL/MSYS bash.exe permission traps.
 *
 * If `cargo-audit` is not installed, prints a helpful explanation and skips gracefully with exit code 0
 * (or instructions to install via `cargo install cargo-audit --locked`), consistent with lint-shell and
 * test-contract.
 */
import { spawnSync } from "node:child_process";
import { platform } from "node:os";

const isWin = platform() === "win32";

// Check if cargo is installed
const cargoCheck = spawnSync("cargo", ["--version"], { stdio: "pipe", shell: isWin });
if (cargoCheck.status !== 0) {
  console.warn("⚠️  Cargo is not available. Skipping Rust audit...");
  process.exit(0);
}

// Check if cargo-audit subcommand is available
const auditCheck = spawnSync("cargo", ["audit", "--version"], { stdio: "pipe", shell: isWin });
if (auditCheck.status !== 0) {
  console.warn("⚠️  cargo-audit is not installed on this machine.");
  console.warn("   To install cargo-audit: cargo install cargo-audit --locked");
  console.warn("   (Note: native Rust audit is verified in CI and configured in .cargo/audit.toml)\n");
  process.exit(0);
}

// Run cargo audit
const res = isWin ? spawnSync("cargo", ["audit"], { stdio: "inherit", shell: true }) : spawnSync("bash", ["-lc", "cargo audit"], { stdio: "inherit" });

process.exit(res.status ?? 0);

#!/usr/bin/env bash
# Single-command verification for judges (Claude Code / Codex / humans).
#
#   bash scripts/verify-all.sh
#
# Runs, in order: Rust lint, contract unit tests, WASM build, TypeScript typecheck, ESLint +
# formatting + source-integrity checks, SDK tests, the 11-step judge scenario against the compiled
# WASM (offline, no network), the Next.js production build, and (when the host can run nearcore
# 2.14) the near-workspaces sandbox suite. The Rust toolchain is pinned by rust-toolchain.toml.
#
# artifacts/phalanx_core.wasm is the canonical reproducible build deployed on testnet. A local build
# has different bytes (toolchain paths are embedded), so the stages below test the local build and
# the committed canonical artifact is restored when the script exits.
#
# Env:
#   PHALANX_SANDBOX=auto|1|docker|0   sandbox suite: auto-detect (default), force native, run in Docker, skip
#   PHALANX_INTENTS_MODE=offline|auto  judge quote mode (default offline: no network needed)
#   PHALANX_AUDIT=1                      also run dependency audits (pnpm audit + cargo-audit). Off by
#                                      default: advisory databases change daily, so an audit result
#                                      says nothing about whether this submission works.
#   PHALANX_LIVE=1                       append the no-secret real-network proof suite
set -euo pipefail

# Non-interactive WSL shells do not source Rust automatically. When this script is launched by
# Windows pnpm, keep JavaScript commands on Windows so pnpm does not replace a Windows
# node_modules tree with Linux binaries.
if [ -s "${HOME:-}/.cargo/env" ]; then
  # shellcheck source=/dev/null
  . "$HOME/.cargo/env"
fi
HOST_JS=false
if grep -qi microsoft /proc/version 2>/dev/null && command -v cmd.exe >/dev/null 2>&1; then
  HOST_JS=true
fi
if [ "$HOST_JS" = false ] && ! command -v node >/dev/null 2>&1 && [ -s "${HOME:-}/.nvm/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$HOME/.nvm/nvm.sh"
fi

run_pnpm() {
  if [ "$HOST_JS" = true ]; then
    cmd.exe /d /s /c "pnpm $*"
  else
    pnpm "$@"
  fi
}
run_node() {
  if [ "$HOST_JS" = true ]; then
    cmd.exe /d /s /c "node $*"
  else
    node "$@"
  fi
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SANDBOX="${PHALANX_SANDBOX:-auto}"
MODE="${PHALANX_INTENTS_MODE:-offline}"
LIVE="${PHALANX_LIVE:-0}"
AUDIT="${PHALANX_AUDIT:-0}"
PASSED=()
SKIPPED=()
TOTAL=9
if [ "$AUDIT" = "1" ]; then TOTAL=$((TOTAL + 1)); fi
if [ "$LIVE" = "1" ]; then TOTAL=$((TOTAL + 1)); fi
STEP=0

step() {
  STEP=$((STEP + 1))
  printf '\n\033[1;36m==> %d/%d %s\033[0m\n' "$STEP" "$TOTAL" "$1"
}
ok() { PASSED+=("$1"); printf '\033[32m✔ %s\033[0m\n' "$1"; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1 ($2)"; exit 1; }; }
need cargo "https://rustup.rs"
if [ "$AUDIT" = "1" ]; then need cargo-audit "cargo install cargo-audit --locked"; fi
if [ "$HOST_JS" = true ]; then
  cmd.exe /d /s /c "node --version >nul && pnpm --version >nul" || { echo "missing required Windows Node.js/pnpm toolchain"; exit 1; }
else
  need node "Node.js >= 20.19"
  need pnpm "npm i -g pnpm@10"
fi

CANONICAL="$(mktemp -d)"
if [ -f artifacts/phalanx_core.wasm ]; then cp artifacts/phalanx_core.wasm artifacts/phalanx_core.wasm.sha256 "$CANONICAL/"; fi
restore_canonical() {
  if [ -f "$CANONICAL/phalanx_core.wasm" ]; then
    cp "$CANONICAL/phalanx_core.wasm" "$CANONICAL/phalanx_core.wasm.sha256" artifacts/
    if [ -d apps/web/public ]; then cp "$CANONICAL/phalanx_core.wasm" apps/web/public/phalanx_core.wasm; fi
  fi
  rm -rf "$CANONICAL"
}
trap restore_canonical EXIT

step "Rust: clippy (deny warnings) on the workspace"
cargo clippy --workspace --all-targets --locked -- -D warnings
ok "clippy clean"

if [ "$AUDIT" = "1" ]; then
  step "Dependency audits (pnpm advisory service + RustSec)"
  run_pnpm audit:js
  cargo audit
  ok "dependency audits"
else
  SKIPPED+=("dependency audits (opt-in: PHALANX_AUDIT=1)")
fi

step "Rust: unit tests (near-sdk test blockchain)"
cargo test -p phalanx-core --locked
ok "contract unit tests"

step "Build phalanx_core.wasm from source (RUSTFLAGS='-C link-arg=-s --cfg near')"
bash scripts/build-contract.sh
ok "wasm build"

step "pnpm install + TypeScript typecheck (SDK, web, scripts)"
run_pnpm install --frozen-lockfile
run_node apps/web/scripts/copy-wasm.mjs
run_pnpm typecheck
ok "typecheck"

step "ESLint, Prettier, rustfmt and runtime-source integrity checks"
run_pnpm lint
run_pnpm format:check
run_pnpm check:source
ok "lint + format + source integrity"

step "SDK tests: VM semantics, Rust<->TS parity, 1Click client, TEE, Chain Signatures, E2E scenario"
run_pnpm --filter @phalanx/agent-swarm-sdk test
ok "sdk tests"

step "Judge scenario against the compiled WASM (1Click mode: $MODE)"
if [ "$HOST_JS" = true ]; then
  cmd.exe /d /s /c "set PHALANX_INTENTS_MODE=$MODE&& pnpm --filter @phalanx/agent-swarm-sdk judge"
else
  PHALANX_INTENTS_MODE="$MODE" pnpm --filter @phalanx/agent-swarm-sdk judge
fi
ok "judge scenario"

step "Next.js production build (apps/web)"
run_pnpm --filter @phalanx/web build
ok "web build"

step "near-workspaces sandbox suite (real nearcore 2.14 node)"
glibc_ok() {
  local v
  v="$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+$' || echo 0)"
  awk -v v="$v" 'BEGIN { split(v, a, "."); exit !((a[1] > 2) || (a[1] == 2 && a[2] >= 39)) }'
}
run_native() { cargo test -p phalanx-sandbox-tests --locked -- --test-threads=2; ok "sandbox suite (native)"; }
case "$SANDBOX" in
  0) SKIPPED+=("sandbox suite (PHALANX_SANDBOX=0)") ;;
  1) run_native ;;
  docker) bash scripts/sandbox-docker.sh && ok "sandbox suite (docker)" ;;
  *)
    if [ "$(uname -s)" = "Darwin" ] || { [ "$(uname -s)" = "Linux" ] && glibc_ok; }; then
      run_native
    elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      bash scripts/sandbox-docker.sh && ok "sandbox suite (docker)"
    else
      SKIPPED+=("sandbox suite: needs macOS, Linux with glibc >= 2.39, or Docker (set PHALANX_SANDBOX=docker)")
    fi
    ;;
esac

# The live stage checks the committed canonical artifact, so put it back first.
restore_canonical

# The real-network proof script is opt-in: it requires internet but no secret. It re-checks
# deployed bytes, MPC/wallet transactions, preserved DCAP evidence and a live dry quote.
if [ "$LIVE" = "1" ]; then
  step "Public live-network verification (no secrets)"
  run_pnpm verify:live
  ok "live public evidence"
fi

printf '\n\033[1;32mVERIFICATION PASSED\033[0m (%d stages)\n' "${#PASSED[@]}"
for p in "${PASSED[@]}"; do echo "  ✔ $p"; done
for s in "${SKIPPED[@]+"${SKIPPED[@]}"}"; do echo "  – skipped: $s"; done

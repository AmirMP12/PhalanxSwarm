#!/usr/bin/env bash
# Builds contracts/phalanx-core into artifacts/phalanx_core.wasm.
#
# Uses the same flags as `cargo near build non-reproducible-wasm`:
#   RUSTFLAGS="-C link-arg=-s --cfg near"  (`--cfg near` selects near-sdk's on-chain host functions)
# plus the size-optimised [profile.release] from the workspace Cargo.toml.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
cd "$ROOT"

if ! rustup target list --installed 2>/dev/null | grep -q '^wasm32-unknown-unknown$'; then
  rustup target add wasm32-unknown-unknown
fi

LOCKED=""
if [ -f "$ROOT/Cargo.lock" ]; then LOCKED="--locked"; fi

RUSTFLAGS="-C link-arg=-s --cfg near" \
  cargo build -p phalanx-core --target wasm32-unknown-unknown --release $LOCKED

mkdir -p "$ROOT/artifacts"
cp "$TARGET_DIR/wasm32-unknown-unknown/release/phalanx_core.wasm" "$ROOT/artifacts/phalanx_core.wasm"

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    "$ROOT/artifacts/phalanx_core.wasm" -o "$ROOT/artifacts/phalanx_core.wasm"
fi

if command -v sha256sum >/dev/null 2>&1; then
  HASH="$(sha256sum "$ROOT/artifacts/phalanx_core.wasm" | cut -d' ' -f1)"
else
  HASH="$(shasum -a 256 "$ROOT/artifacts/phalanx_core.wasm" | cut -d' ' -f1)"
fi
echo "$HASH  phalanx_core.wasm" > "$ROOT/artifacts/phalanx_core.wasm.sha256"
SIZE="$(wc -c < "$ROOT/artifacts/phalanx_core.wasm" | tr -d ' ')"
echo "artifacts/phalanx_core.wasm  ${SIZE} bytes  sha256=${HASH}"

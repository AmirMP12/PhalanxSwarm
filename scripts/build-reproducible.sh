#!/usr/bin/env bash
# Canonical, byte-for-byte reproducible build of phalanx_core.wasm.
#
# The immutable image digest pins rustc, LLVM, linker, libc and OS. Cargo.lock pins crates;
# --platform pins architecture; the source path and target path are fixed inside the container.
# `--verify` performs two clean builds and fails if their hashes differ.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="rust@sha256:09027f873d45b8ecd1dc86f1fa13b7a62b875c961f017a0e331267b350430137"
MODE="${1:-build}"
# Extra `docker run` flags, for hosts whose Docker DNS is broken: PHALANX_DOCKER_RUN_FLAGS="--dns 8.8.8.8".
# They change how the container reaches the network, never the bytes it builds.
read -r -a EXTRA_FLAGS <<< "${PHALANX_DOCKER_RUN_FLAGS:-}"
command -v docker >/dev/null 2>&1 || { echo "Docker is required for the reproducible build"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker engine is not running"; exit 1; }
mkdir -p "$ROOT/artifacts"

build_once() {
  local slot="$1"
  docker run --rm --platform linux/amd64 ${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"} \
    -v "$ROOT:/src:ro" \
    -v "$ROOT/artifacts:/out" \
    -v phalanx-repro-cargo-registry:/usr/local/cargo/registry \
    "$IMAGE" bash -ceu '
      rustup target add wasm32-unknown-unknown >/dev/null
      export CARGO_TARGET_DIR=/tmp/target-'"$slot"'
      export CARGO_INCREMENTAL=0 SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C
      cd /src
      RUSTFLAGS="-C link-arg=-s --cfg near" cargo build -p phalanx-core --target wasm32-unknown-unknown --release --locked
      cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/phalanx_core.wasm" /out/phalanx_core.'"$slot"'.wasm
    '
}

build_once 1
if [ "$MODE" = "--verify" ]; then
  build_once 2
  H1="$(sha256sum "$ROOT/artifacts/phalanx_core.1.wasm" | cut -d' ' -f1)"
  H2="$(sha256sum "$ROOT/artifacts/phalanx_core.2.wasm" | cut -d' ' -f1)"
  echo "build 1: $H1"
  echo "build 2: $H2"
  [ "$H1" = "$H2" ] || { echo "ERROR: reproducible hashes differ"; exit 1; }
  rm -f "$ROOT/artifacts/phalanx_core.2.wasm"
else
  H1="$(sha256sum "$ROOT/artifacts/phalanx_core.1.wasm" | cut -d' ' -f1)"
fi
mv -f "$ROOT/artifacts/phalanx_core.1.wasm" "$ROOT/artifacts/phalanx_core.wasm"
printf '%s  phalanx_core.wasm\n' "$H1" > "$ROOT/artifacts/phalanx_core.wasm.sha256"
SIZE="$(wc -c < "$ROOT/artifacts/phalanx_core.wasm" | tr -d ' ')"
cat > "$ROOT/artifacts/reproducible-build.json" <<JSON
{
  "image": "$IMAGE",
  "platform": "linux/amd64",
  "rustc": "1.99.1",
  "source_path": "/src",
  "target_path": "/tmp/target",
  "rustflags": "-C link-arg=-s --cfg near",
  "cargo_locked": true,
  "wasm_sha256": "$H1",
  "size_bytes": $SIZE,
  "two_clean_builds_byte_identical": $([ "$MODE" = "--verify" ] && echo true || echo false)
}
JSON
echo "artifacts/phalanx_core.wasm  $SIZE bytes  sha256=$H1"
if [ "$MODE" = "--verify" ]; then
  echo "REPRODUCIBLE: PASS (two clean builds are byte-identical)"
fi

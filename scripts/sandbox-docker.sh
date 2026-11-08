#!/usr/bin/env bash
# Runs the near-workspaces sandbox suite inside a Debian trixie container.
# near-sandbox 2.14.0 needs glibc >= 2.39 (Ubuntu 24.04 / Debian 13); use this on older hosts.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
docker run --rm \
  -v "$ROOT:/work" -w /work \
  -v phalanx-cargo-registry:/usr/local/cargo/registry \
  -v phalanx-cargo-target:/target -e CARGO_TARGET_DIR=/target \
  rust:1-trixie \
  bash -c "cargo test -p phalanx-sandbox-tests --locked -- --nocapture --test-threads=2"

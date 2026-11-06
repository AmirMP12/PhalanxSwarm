#!/usr/bin/env bash
# Lints every repository shell script with ShellCheck. A local binary is preferred; the pinned
# official container keeps the command reproducible on machines that already use Docker here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILES=("$ROOT"/scripts/*.sh)

if command -v shellcheck >/dev/null 2>&1; then
  exec shellcheck "${FILES[@]}"
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  CONTAINER_FILES=()
  for file in "${FILES[@]}"; do CONTAINER_FILES+=("/mnt/scripts/$(basename "$file")"); done
  exec docker run --rm -v "$ROOT:/mnt:ro" \
    koalaman/shellcheck@sha256:bb596a0d169b85ddd81d8b6d3a2ff6d5baf5fca10b97f575ebc647c3dff62b3d \
    "${CONTAINER_FILES[@]}"
fi

echo "ShellCheck is required: install shellcheck or start Docker" >&2
exit 1

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v go >/dev/null 2>&1; then
  echo "go not found on PATH; install Go 1.22+ first" >&2
  exit 1
fi

npm run build

if [[ ! -f dist/index.html ]]; then
  echo "dist/index.html is missing; npm run build did not produce a dist" >&2
  exit 1
fi

rm -rf internal/web/dist
mkdir -p internal/web/dist
cp -R dist/. internal/web/dist/
touch internal/web/dist/.gitkeep

go build -o agent-machi ./cmd/agent-machi
echo "built ./agent-machi"

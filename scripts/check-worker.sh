#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER="$ROOT/workers/ai-gateway"

[[ -f "$WORKER/package-lock.json" ]] || {
  echo "Missing Worker package-lock.json." >&2
  exit 2
}

outdir="$(mktemp -d)"
trap 'rm -rf "$outdir"' EXIT

cd "$WORKER"
npm ci
npx wrangler deploy --dry-run --outdir "$outdir"

test -n "$(find "$outdir" -type f -maxdepth 2 -print -quit)" || {
  echo "Wrangler dry-run produced no bundle output." >&2
  exit 3
}

echo "AI gateway dependency install and Wrangler dry-run bundle passed."

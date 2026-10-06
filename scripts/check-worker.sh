#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AI="$ROOT/workers/ai-gateway"
EVENT="$ROOT/workers/event-relay"

[[ -f "$AI/package-lock.json" ]] || {
  echo "Missing AI gateway package-lock.json." >&2
  exit 2
}

ai_out="$(mktemp -d)"
event_out="$(mktemp -d)"
trap 'rm -rf "$ai_out" "$event_out"' EXIT

cd "$AI"
npm ci
./node_modules/.bin/wrangler deploy --dry-run --outdir "$ai_out"

test -n "$(find "$ai_out" -maxdepth 2 -type f -print -quit)" || {
  echo "AI gateway Wrangler dry-run produced no bundle output." >&2
  exit 3
}

cd "$EVENT"
"$AI/node_modules/.bin/wrangler" deploy --dry-run --config wrangler.toml --outdir "$event_out"

test -n "$(find "$event_out" -maxdepth 2 -type f -print -quit)" || {
  echo "Event relay Wrangler dry-run produced no bundle output." >&2
  exit 4
}

echo "AI gateway and event relay Wrangler dry-run bundles passed."

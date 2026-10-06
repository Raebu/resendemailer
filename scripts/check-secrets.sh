#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

targets=(src native workers .github capacitor.config.ts package.json)
patterns=(
  're_[A-Za-z0-9]{24,}'
  'sk-(proj-)?[A-Za-z0-9_-]{20,}'
)

found=0
for pattern in "${patterns[@]}"; do
  if git grep -nE "$pattern" -- "${targets[@]}" 2>/dev/null; then
    found=1
  fi
done

if (( found )); then
  echo >&2
  echo "Potential committed API credential detected. Review the matches above." >&2
  exit 1
fi

echo "Secret scan passed: no Resend/OpenAI key-shaped values found in tracked application source."

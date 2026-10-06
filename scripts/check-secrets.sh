#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

targets=(src native workers .github capacitor.config.ts package.json .env.example README.md docs)
patterns=(
  're_[A-Za-z0-9]{24,}'
  'sk-(proj-)?[A-Za-z0-9_-]{20,}'
)

scan_ref() {
  local ref="$1"
  local label="$2"
  local found=0
  for pattern in "${patterns[@]}"; do
    if [[ "$ref" == "WORKTREE" ]]; then
      if git grep -nE "$pattern" -- "${targets[@]}" 2>/dev/null; then
        found=1
      fi
    else
      if git grep -nE "$pattern" "$ref" -- "${targets[@]}" 2>/dev/null; then
        echo "Potential credential found in historical ref $label ($ref)." >&2
        found=1
      fi
    fi
  done
  return "$found"
}

failed=0
if ! scan_ref WORKTREE current; then
  failed=1
fi

if [[ "${CHECK_GIT_HISTORY:-0}" == "1" ]]; then
  while IFS= read -r commit; do
    if ! scan_ref "$commit" "$commit"; then
      failed=1
    fi
  done < <(git rev-list --all)
fi

if (( failed )); then
  echo >&2
  echo "Potential committed API credential detected. Review the matches above and rotate/scrub any real secret." >&2
  exit 1
fi

scope="current tracked source"
if [[ "${CHECK_GIT_HISTORY:-0}" == "1" ]]; then
  scope="current tracked source and reachable Git history"
fi
echo "Secret scan passed: no Resend/OpenAI key-shaped values found in $scope."

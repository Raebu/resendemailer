#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null 2>&1 || { echo "Node.js is required." >&2; exit 2; }
command -v npm >/dev/null 2>&1 || { echo "npm is required." >&2; exit 2; }

node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
(( node_major >= 22 )) || {
  echo "Node.js 22+ is required. Found $(node --version)." >&2
  exit 2
}

echo "== Deterministic dependency install =="
npm ci

echo
echo "== GIBP Mail application checks =="
npm run check
npm run security:scan

echo
echo "== Android project =="
if [[ -d android/app ]]; then
  npm run android:sync
else
  npm run android:add
fi

chmod +x android/gradlew
(
  cd android
  ./gradlew clean assembleDebug --stacktrace
)

APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
[[ -f "$APK" ]] || { echo "Expected APK was not produced: $APK" >&2; exit 4; }

HASH="$(sha256sum "$APK" | awk '{print $1}')"
SIZE="$(stat -c '%s' "$APK")"

printf '%s  %s\n' "$HASH" "$(basename "$APK")" > "$APK.sha256"

echo
echo "Preflight passed."
echo "APK: $APK"
echo "Bytes: $SIZE"
echo "SHA-256: $HASH"

if [[ "${INSTALL_TO_PHONE:-0}" == "1" ]]; then
  echo
  bash "$ROOT/scripts/install-phone.sh" "$APK"
else
  echo
  echo "To install on a connected phone:"
  echo "  npm run android:install"
  echo "or rerun with:"
  echo "  INSTALL_TO_PHONE=1 npm run preflight"
fi

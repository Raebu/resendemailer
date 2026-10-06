#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK="${1:-$ROOT/android/app/build/outputs/apk/debug/app-debug.apk}"
PACKAGE="global.gibp.mail"

command -v adb >/dev/null 2>&1 || {
  echo "adb is not installed or is not on PATH." >&2
  exit 2
}

if [[ ! -f "$APK" ]]; then
  echo "APK not found; running deterministic preflight build first."
  (
    cd "$ROOT"
    INSTALL_TO_PHONE=0 npm run preflight
  )
fi

[[ -f "$APK" ]] || {
  echo "APK was not produced: $APK" >&2
  exit 2
}

adb start-server >/dev/null

if [[ -n "${ANDROID_SERIAL:-}" ]]; then
  serial="$ANDROID_SERIAL"
  state="$(adb -s "$serial" get-state 2>/dev/null || true)"
  [[ "$state" == "device" ]] || {
    echo "ANDROID_SERIAL=$serial is not an authorised connected device." >&2
    adb devices -l >&2
    exit 3
  }
else
  mapfile -t devices < <(adb devices | awk 'NR>1 && $2=="device"{print $1}')
  if (( ${#devices[@]} == 0 )); then
    echo "No authorised Android device detected." >&2
    echo "Connect the phone, enable USB debugging, and accept the RSA prompt." >&2
    adb devices -l >&2
    exit 3
  fi
  if (( ${#devices[@]} > 1 )); then
    echo "Multiple authorised Android devices detected. Set ANDROID_SERIAL to choose one." >&2
    adb devices -l >&2
    exit 3
  fi
  serial="${devices[0]}"
fi

echo "Installing $(basename "$APK") on $serial..."
adb -s "$serial" install -r "$APK"

echo "Launching $PACKAGE..."
adb -s "$serial" shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 3

pid="$(adb -s "$serial" shell pidof "$PACKAGE" 2>/dev/null | tr -d '\r' || true)"
if [[ -z "$pid" ]]; then
  echo "The package installed, but no running process was found after launch." >&2
  exit 4
fi

echo "App process is running with PID $pid."

logs="$(adb -s "$serial" logcat -d --pid="$pid" -t 250 2>/dev/null || true)"
if grep -Eiq 'FATAL EXCEPTION|AndroidRuntime:.*FATAL|Process: global\.gibp\.mail.*has died' <<<"$logs"; then
  echo "A fatal Android exception was detected after launch:" >&2
  grep -Ei 'FATAL EXCEPTION|AndroidRuntime|Process: global\.gibp\.mail' <<<"$logs" | tail -80 >&2
  exit 5
fi

echo "ADB smoke test passed: installed, launched, and no immediate fatal exception was detected."

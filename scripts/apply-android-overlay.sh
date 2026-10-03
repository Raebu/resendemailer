#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID="$ROOT/android"
SRC="$ANDROID/app/src/main/java/global/gibp/mail"

if [[ ! -d "$ANDROID/app" ]]; then
  echo "android/ does not exist. Run: npx cap add android" >&2
  exit 1
fi

mkdir -p "$SRC"
cp "$ROOT"/native/android/java/*.java "$SRC"/

GRADLE="$ANDROID/app/build.gradle"
if [[ ! -f "$GRADLE" ]]; then
  echo "Expected $GRADLE" >&2
  exit 1
fi
if ! grep -q 'androidx.work:work-runtime:2.12.0' "$GRADLE"; then
  sed -i '/^dependencies[[:space:]]*{/a\    implementation "androidx.work:work-runtime:2.12.0"' "$GRADLE"
fi

MANIFEST="$ANDROID/app/src/main/AndroidManifest.xml"
if ! grep -q 'android.permission.POST_NOTIFICATIONS' "$MANIFEST"; then
  sed -i '/<manifest/a\    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />' "$MANIFEST"
fi

echo "Applied GIBP Mail Android native background overlay."

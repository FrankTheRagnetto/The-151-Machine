#!/usr/bin/env bash
# bump-version.sh — bump the Android app version BEFORE building a new APK.
#
# Android refuses to install an APK over an existing one unless versionCode is
# strictly higher, so every new build needs a bump. Run this, THEN build, THEN
# hand the owner the APK link (since 2026-10-12 there is no in-app update and no
# publish-apk.sh). Keeping the bump separate from the build is deliberate: the
# gradle build is a long step phone-side, so we don't wrap it here.
#
# Usage:
#   tools/bump-version.sh                 # versionCode +1, keep versionName
#   tools/bump-version.sh 1.6.0           # versionCode +1, set versionName 1.6.0
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GRADLE="$REPO/app/android/app/build.gradle"
[ -f "$GRADLE" ] || { echo "[FAIL] build.gradle not found at $GRADLE"; exit 1; }

CUR_CODE=$(grep -oP 'versionCode\s+\K[0-9]+' "$GRADLE" | head -1)
CUR_NAME=$(grep -oP 'versionName\s+"\K[^"]+' "$GRADLE" | head -1)
[ -n "$CUR_CODE" ] || { echo "[FAIL] could not read versionCode"; exit 1; }

NEW_CODE=$((CUR_CODE + 1))
NEW_NAME="${1:-$CUR_NAME}"

# In-place edit, scoped to the exact defaultConfig lines.
sed -i -E "s/(versionCode\s+)[0-9]+/\1${NEW_CODE}/" "$GRADLE"
sed -i -E "s/(versionName\s+\")[^\"]+(\")/\1${NEW_NAME}\2/" "$GRADLE"

echo "[OK] version bumped: code ${CUR_CODE} -> ${NEW_CODE}, name ${CUR_NAME} -> ${NEW_NAME}"
echo "     Next: build the APK, then give the owner the link (~/Backups/apps/151-machine-apk/)"

#!/usr/bin/env bash
# Builds a signed universal macOS release and writes latest.json, ready to upload
# to a GitHub Release. Usage: scripts/release.sh "What changed in this version"
set -euo pipefail

cd "$(dirname "$0")/.."
KEY_FILE="${TAURI_KEY_FILE:-$HOME/.tauri/gooey-agents.key}"
REPO_URL="https://github.com/computationalmama/gooey-agents-desktop"
NOTES="${1:-}"

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

npm run tauri build -- --target universal-apple-darwin

BUNDLE=src-tauri/target/universal-apple-darwin/release/bundle
OUT=release/v$VERSION
rm -rf "$OUT" && mkdir -p "$OUT"
# GitHub swaps spaces in asset names for dots, so use space-free names up front.
cp "$BUNDLE/dmg/Gooey Agents_${VERSION}_universal.dmg" "$OUT/Gooey-Agents_${VERSION}_universal.dmg"
cp "$BUNDLE/macos/Gooey Agents.app.tar.gz" "$OUT/Gooey-Agents_${VERSION}_universal.app.tar.gz"
SIG=$(cat "$BUNDLE/macos/Gooey Agents.app.tar.gz.sig")
URL="$REPO_URL/releases/download/v$VERSION/Gooey-Agents_${VERSION}_universal.app.tar.gz"

node -e '
const [version, notes, sig, url] = process.argv.slice(1);
const platform = { signature: sig, url };
console.log(JSON.stringify({
  version, notes, pub_date: new Date().toISOString(),
  platforms: { "darwin-aarch64": platform, "darwin-x86_64": platform },
}, null, 2));
' "$VERSION" "$NOTES" "$SIG" "$URL" > "$OUT/latest.json"

echo
echo "Release files in $OUT:"
ls -1 "$OUT"
echo
echo "Upload all three to a GitHub Release tagged v$VERSION and publish it."

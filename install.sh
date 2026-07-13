#!/usr/bin/env bash
#
# Build (optionally) and install Jotter.app into /Applications.
#
#   ./install.sh              build a fresh release bundle, then install
#   ./install.sh --no-build   install the already-built bundle (faster)
#
set -euo pipefail
cd "$(dirname "$0")"

APP="src-tauri/target/release/bundle/macos/Jotter.app"
DEST="/Applications/Jotter.app"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "▶ Building Jotter.app (release)…"
  # Local personal builds don't distribute update artifacts, so disable them —
  # otherwise the build demands the CI-only TAURI_SIGNING_PRIVATE_KEY. The
  # installed app still auto-updates (it verifies downloaded releases against
  # the embedded public key).
  pnpm tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
fi

if [[ ! -d "$APP" ]]; then
  echo "✗ $APP not found. Run without --no-build to build it first." >&2
  exit 1
fi

echo "▶ Installing to $DEST …"
rm -rf "$DEST"
cp -R "$APP" "$DEST"

# Nudge macOS to refresh the (aggressively cached) icon.
touch "$DEST"
killall Dock 2>/dev/null || true

echo "✓ Jotter installed. Search \"Jotter\" in Spotlight (⌘Space)."

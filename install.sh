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
  pnpm tauri build --bundles app
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

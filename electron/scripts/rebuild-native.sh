#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────────
# rebuild-native.sh — Rebuild native modules against the Electron ABI.
#
# Usage:
#   ./scripts/rebuild-native.sh              # rebuild all native deps
#   ./scripts/rebuild-native.sh --force      # force rebuild even if cached
#
# Must be run from the electron/ directory (or set ELECTRON_PROJECT_DIR).
# Rebuilds: better-sqlite3, onnxruntime-node, node-pty
# ────────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${ELECTRON_PROJECT_DIR:-$(dirname "$SCRIPT_DIR")}"

cd "$PROJECT_DIR"

FORCE_FLAG=""
if [[ "${1:-}" == "--force" ]]; then
  FORCE_FLAG="--force"
fi

ELECTRON_VERSION=$(node -e "console.log(require('electron/package.json').version)")

echo "==> Rebuilding native modules for Electron ABI..."
echo "    Project: $PROJECT_DIR"
echo "    Electron: $ELECTRON_VERSION"
echo "    Modules: better-sqlite3, onnxruntime-node, node-pty"

npx @electron/rebuild \
  --version "$ELECTRON_VERSION" \
  --module-dir . \
  $FORCE_FLAG

echo "==> Native module rebuild complete."

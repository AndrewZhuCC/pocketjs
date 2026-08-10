#!/usr/bin/env bash
# Sync this repo from Mac mini → Air for Kindle cross-build / deploy.
# Usage: ./scripts/sync-to-air.sh [air-host]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AIR_HOST="${1:-air}"
AIR_PATH="${AIR_PATH:-/Users/zhuanzhi/Documents/projects/pocketjs}"

# Prefer SSH config Host "air"; override with AIR_RSH if needed.
RSH="${AIR_RSH:-ssh}"

echo "→ rsync $ROOT/  →  ${AIR_HOST}:${AIR_PATH}/"
rsync -az --delete \
  --exclude '.git/objects' \
  --exclude '**/target/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude '.pocket/' \
  --exclude '.DS_Store' \
  -e "$RSH" \
  "$ROOT/" \
  "${AIR_HOST}:${AIR_PATH}/"

# Always push git tip so Air can also git pull if preferred
if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BRANCH="$(git -C "$ROOT" branch --show-current)"
  echo "→ git push myfork $BRANCH (best-effort)"
  git -C "$ROOT" push myfork "HEAD:refs/heads/$BRANCH" 2>/dev/null || \
    echo "  (git push skipped or failed; rsync already copied tree)"
fi

echo "✓ synced to ${AIR_HOST}:${AIR_PATH}"

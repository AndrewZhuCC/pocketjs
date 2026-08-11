#!/usr/bin/env bash
# Sync this repo from Mac mini → Air for Kindle cross-build / deploy.
# Prefer git push + pull so Air's .git stays healthy; rsync is a tree fallback.
# Usage: ./scripts/sync-to-air.sh [air-host]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AIR_HOST="${1:-air}"
AIR_PATH="${AIR_PATH:-/Users/zhuanzhi/Documents/projects/pocketjs}"
RSH="${AIR_RSH:-ssh}"
BRANCH="$(git -C "$ROOT" branch --show-current)"

echo "→ git push myfork $BRANCH"
git -C "$ROOT" push myfork "HEAD:refs/heads/$BRANCH"

echo "→ air: git fetch + reset --hard origin tip"
$RSH "$AIR_HOST" "set -e
  mkdir -p '$AIR_PATH'
  if [ ! -d '$AIR_PATH/.git' ]; then
    git clone --branch '$BRANCH' git@github.com:AndrewZhuCC/pocketjs.git '$AIR_PATH' || \
      git clone git@github.com:AndrewZhuCC/pocketjs.git '$AIR_PATH'
  fi
  cd '$AIR_PATH'
  git remote remove myfork 2>/dev/null || true
  git remote add myfork git@github.com:AndrewZhuCC/pocketjs.git 2>/dev/null || \
    git remote set-url myfork git@github.com:AndrewZhuCC/pocketjs.git
  git fetch myfork
  git checkout -B '$BRANCH' "myfork/$BRANCH"
  git reset --hard "myfork/$BRANCH"
  git clean -fd -e 'hosts/kindle/target' -e 'dist' -e 'node_modules' -e 'engine/**/target' || true
  git log -1 --oneline
  echo SYNC_OK
"

# Also rsync working tree extras that may not be committed (scripts WIP etc.)
# NEVER exclude .git/objects — that corrupts Air's repo.
echo "→ rsync working tree (keep .git intact, skip heavy build dirs)"
rsync -az \
  --exclude '.git/' \
  --exclude '**/target/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude '.pocket/' \
  --exclude '.DS_Store' \
  -e "$RSH" \
  "$ROOT/" \
  "${AIR_HOST}:${AIR_PATH}/"

echo "✓ synced to ${AIR_HOST}:${AIR_PATH} ($BRANCH)"

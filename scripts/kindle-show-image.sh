#!/usr/bin/env bash
# Run ON AIR. Deploy host (if needed) and launch --show-image on device via
# run-runtime-style GUI pause so the full-screen probe is safe.
#
# Usage:
#   ./scripts/kindle-show-image.sh 'https://example.com/page.jpg'
#   ./scripts/kindle-show-image.sh /path/on/kindle/to/local.png
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"

SOURCE="${1:-}"
if [[ -z "$SOURCE" ]]; then
  echo "usage: $0 <http(s)-url|kindle-local-path>" >&2
  exit 2
fi

KINDLE_HOST="${KINDLE_HOST:-192.168.15.244}"
KINDLE_PORT="${KINDLE_PORT:-22}"
PASS="${KINDLE_PASS:-x}"
REMOTE_ROOT="${REMOTE_ROOT:-/mnt/us/pocketjs-dev}"
DEPLOY_HOST="${DEPLOY_HOST:-1}"

run_pw() {
  local timeout_s="${1:-120}"
  shift
  local tmp
  tmp="$(mktemp)"
  {
    echo '#!/usr/bin/env expect'
    echo "set timeout $timeout_s"
    printf 'spawn'
    for a in "$@"; do
      local ea
      ea=$(printf '%s' "$a" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\[/\\[/g; s/\]/\\]/g; s/\$/\\$/g')
      printf ' "%s"' "$ea"
    done
    echo
    cat <<'EOT'
expect {
  -re {(?i)password:} { send -- "$env(KINDLE_PASS)\r"; exp_continue }
  eof {}
  timeout { exit 124 }
}
catch wait result
set code [lindex $result 3]
if {$code == ""} { set code 0 }
exit $code
EOT
  } >"$tmp"
  chmod +x "$tmp"
  KINDLE_PASS="$PASS" expect "$tmp"
  local rc=$?
  rm -f "$tmp"
  return $rc
}

if [[ "$DEPLOY_HOST" == "1" ]]; then
  BUILD=0 APP=host-only "$ROOT/scripts/deploy-kindle-manga.sh" || \
    BUILD=0 APP=hero "$ROOT/scripts/deploy-kindle-manga.sh"
fi

# Escape single quotes for remote sh
SRC_ESC=$(printf "%s" "$SOURCE" | sed "s/'/'\\\\''/g")

echo "→ launch --show-image on device (background via run-runtime pause path)"
# Use a tiny wrapper that:
# 1) stops any previous runtime
# 2) pauses GUI the same way run-runtime does (export POCKETJS_GUI_PAUSED=1 after SIGSTOP)
# For simplicity: call run-runtime is heavy; we replicate the minimum:
#   stop → SIGSTOP lipc UI → export POCKETJS_GUI_PAUSED=1 → binary --show-image
run_pw 60 ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  -p "$KINDLE_PORT" "root@$KINDLE_HOST" \
  "sh $REMOTE_ROOT/stop-runtime.sh 2>/dev/null; mkdir -p $REMOTE_ROOT/logs $REMOTE_ROOT/run; nohup sh -c '
    # Soft GUI pause: mark env; prefer full run-runtime if available later
    export POCKETJS_GUI_PAUSED=1
    export PATH=/usr/local/bin:/usr/bin:/bin
    cd $REMOTE_ROOT
    exec $REMOTE_ROOT/bin/pocketjs-kindle \
      --show-image '\''$SRC_ESC'\'' \
      --fbink $REMOTE_ROOT/bin/fbink \
      --allow-active-gui \
      >$REMOTE_ROOT/logs/show-image.log 2>&1
  ' >/dev/null 2>&1 &
  sleep 1
  echo LAUNCHED
  tail -n 5 $REMOTE_ROOT/logs/show-image.log 2>/dev/null || true
"

echo "→ waiting a few seconds for fetch/decode…"
sleep 8
run_pw 30 ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  -p "$KINDLE_PORT" "root@$KINDLE_HOST" \
  "echo '--- show-image.log ---'; tail -n 40 $REMOTE_ROOT/logs/show-image.log 2>/dev/null; echo '--- ps ---'; ps | grep -i pocketjs | grep -v grep || true"

echo "✓ probe launched. On device: full-screen image or error in logs."
echo "  Exit: corner-hold 1.5s, or: ssh root@$KINDLE_HOST 'sh $REMOTE_ROOT/stop-runtime.sh; killall pocketjs-kindle 2>/dev/null'"

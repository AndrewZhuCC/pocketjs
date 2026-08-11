#!/usr/bin/env bash
# Inject a logical-space tap into the running PocketJS host (bypasses exclusive grab).
# Usage:
#   ./scripts/kindle-tap.sh 154 200          # logical x y (0..308, 0..411)
#   ./scripts/kindle-tap.sh shelf             # named target
#   ./scripts/kindle-tap.sh exit
set -euo pipefail

KINDLE_HOST="${KINDLE_HOST:-192.168.15.244}"
KINDLE_PORT="${KINDLE_PORT:-22}"
PASS="${KINDLE_PASS:-x}"
REMOTE_ROOT="${REMOTE_ROOT:-/mnt/us/pocketjs-dev}"
CMD_FILE="$REMOTE_ROOT/run/cmd"

X=""
Y=""
case "${1:-}" in
  ""|-h|--help)
    echo "usage: $0 <logical-x> <logical-y> | shelf|settings|exit|cat-prev|cat-next|retry"
    exit 2
    ;;
  shelf)     X=50;  Y=390 ;;   # bottom col 0
  settings)  X=154; Y=390 ;;
  exit)      X=260; Y=390 ;;
  cat-prev)  X=80;  Y=60 ;;
  cat-next)  X=230; Y=60 ;;
  retry)     X=154; Y=150 ;;
  *)
    X="$1"
    Y="${2:?need y}"
    ;;
esac

run_pw() {
  local timeout_s="${1:-30}"
  shift
  local tmp; tmp="$(mktemp)"
  {
    echo '#!/usr/bin/env expect'
    echo "set timeout $timeout_s"
    printf 'spawn'
    for a in "$@"; do
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
  set +e
  KINDLE_PASS="$PASS" expect "$tmp"
  local rc=$?
  set -e
  rm -f "$tmp"
  return $rc
}

echo "→ inject tap-logical $X $Y"
run_pw 20 ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  -p "$KINDLE_PORT" "root@$KINDLE_HOST" \
  "mkdir -p $REMOTE_ROOT/run; printf 'tap-logical %s %s\n' '$X' '$Y' > $CMD_FILE; echo OK"
echo "✓ queued (host consumes within ~1 logic frame)"

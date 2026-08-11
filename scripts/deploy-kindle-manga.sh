#!/usr/bin/env bash
# Run ON AIR after sync. Cross-builds (optional) and scp hero/manga artifacts to Kindle.
# Requires: USBNetwork up, en5 = 192.168.15.201, Kindle = 192.168.15.244:22
#
# Usage:
#   BUILD=0 APP=manga ./scripts/deploy-kindle-manga.sh
#   BUILD=1 APP=manga ./scripts/deploy-kindle-manga.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"

KINDLE_HOST="${KINDLE_HOST:-192.168.15.244}"
KINDLE_PORT="${KINDLE_PORT:-22}"
PASS="${KINDLE_PASS:-x}"
REMOTE_ROOT="${REMOTE_ROOT:-/mnt/us/pocketjs-dev}"

BUILD="${BUILD:-1}"
APP="${APP:-hero}" # hero | manga | host-only

# Parse simple flags: --app manga --BUILD 0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --BUILD|--build) BUILD="$2"; shift 2 ;;
    *) shift ;;
  esac
done

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
  set +e
  KINDLE_PASS="$PASS" expect "$tmp"
  local rc=$?
  set -e
  rm -f "$tmp"
  return $rc
}

if [[ "$BUILD" == "1" && "$APP" != "host-only" ]]; then
  if [[ "$APP" == "manga" ]]; then
    MANIFEST=apps/manga/pocket.kindle.json
  else
    MANIFEST=apps/hero/pocket.kindle.json
  fi
  echo "→ build $APP ($MANIFEST)"
  bun pocket build --target kindle-pw5 --manifest "$MANIFEST" --project-root .
elif [[ "$BUILD" == "1" && "$APP" == "host-only" ]]; then
  echo "→ cargo zigbuild host only"
  (cd hosts/kindle && cargo zigbuild --release --target armv7-unknown-linux-musleabihf)
fi

BIN=hosts/kindle/target/armv7-unknown-linux-musleabihf/release/pocketjs-kindle
[[ -f "$BIN" ]] || { echo "missing $BIN — build host first"; exit 1; }

if [[ "$APP" == "manga" ]]; then
  JS=dist/manga-kindle-main.js
  PAK=dist/manga-kindle-main.pak
elif [[ "$APP" == "hero" ]]; then
  JS=dist/hero-kindle-main.js
  PAK=dist/hero-kindle-main.pak
else
  JS=""
  PAK=""
fi

if [[ -n "$JS" ]]; then
  [[ -f "$JS" && -f "$PAK" ]] || { echo "missing $JS / $PAK"; exit 1; }
fi

echo "→ stop runtime (best-effort)"
run_pw 30 ssh -o StrictHostKeyChecking=accept-new \
  -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  -p "$KINDLE_PORT" "root@$KINDLE_HOST" \
  "sh $REMOTE_ROOT/stop-runtime.sh 2>/dev/null; killall -9 pocketjs-kindle 2>/dev/null; rm -f $REMOTE_ROOT/bin/pocketjs-kindle; echo STOP_OK" || true

echo "→ scp host binary (via /tmp to avoid ETXTBSY)"
run_pw 180 scp -P "$KINDLE_PORT" -o StrictHostKeyChecking=accept-new \
  -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  "$BIN" "root@${KINDLE_HOST}:/tmp/pocketjs-kindle.new"

if [[ -n "$JS" ]]; then
  echo "→ scp app js/pak"
  run_pw 180 scp -P "$KINDLE_PORT" -o StrictHostKeyChecking=accept-new \
    -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    "$JS" "root@${KINDLE_HOST}:${REMOTE_ROOT}/$(basename "$JS")"
  run_pw 180 scp -P "$KINDLE_PORT" -o StrictHostKeyChecking=accept-new \
    -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    "$PAK" "root@${KINDLE_HOST}:${REMOTE_ROOT}/$(basename "$PAK")"
  BASENAME_JS="$(basename "$JS")"
  BASENAME_PAK="$(basename "$PAK")"
  run_pw 60 ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    -p "$KINDLE_PORT" "root@$KINDLE_HOST" \
    "cp -f /tmp/pocketjs-kindle.new $REMOTE_ROOT/bin/pocketjs-kindle; chmod +x $REMOTE_ROOT/bin/pocketjs-kindle; mkdir -p $REMOTE_ROOT/current; cp -f $REMOTE_ROOT/$BASENAME_JS $REMOTE_ROOT/current/app.js; cp -f $REMOTE_ROOT/$BASENAME_PAK $REMOTE_ROOT/current/app.pak; if ! $REMOTE_ROOT/bin/fbink -v >/dev/null 2>&1; then cp -f /mnt/us/usbnet/bin/fbink $REMOTE_ROOT/bin/fbink; chmod +x $REMOTE_ROOT/bin/fbink; fi; ls -la $REMOTE_ROOT/bin/pocketjs-kindle $REMOTE_ROOT/current/; echo DEPLOY_OK"
else
  run_pw 60 ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    -p "$KINDLE_PORT" "root@$KINDLE_HOST" \
    "cp -f /tmp/pocketjs-kindle.new $REMOTE_ROOT/bin/pocketjs-kindle; chmod +x $REMOTE_ROOT/bin/pocketjs-kindle; echo DEPLOY_HOST_OK"
fi

# Runtime CJK: full Noto (~8MB) OOMs Kindle after login. Host ensureChars is
# stubbed until a subset font is shipped. Keep device fonts/ clear of full OTF.
echo "→ clear full runtime CJK fonts on device (OOM guard)"
if ssh -o BatchMode=yes -o ConnectTimeout=5 -p "$KINDLE_PORT" "root@$KINDLE_HOST" "true" 2>/dev/null; then
  ssh -p "$KINDLE_PORT" "root@$KINDLE_HOST" \
    "rm -f $REMOTE_ROOT/fonts/NotoSansSC-*.otf $REMOTE_ROOT/fonts/NotoSansSC-*.ttf 2>/dev/null; mkdir -p $REMOTE_ROOT/fonts; echo FONTS_CLEARED"
else
  run_pw 60 ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    -p "$KINDLE_PORT" "root@$KINDLE_HOST" \
    "rm -f $REMOTE_ROOT/fonts/NotoSansSC-*.otf $REMOTE_ROOT/fonts/NotoSansSC-*.ttf 2>/dev/null; mkdir -p $REMOTE_ROOT/fonts; echo FONTS_CLEARED" || true
fi

echo "✓ deployed $APP"

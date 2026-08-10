#!/usr/bin/env bash
# Run ON AIR after sync. Cross-builds (optional) and scp hero/manga artifacts to Kindle.
# Requires: USBNetwork up, en5 = 192.168.15.201, Kindle = 192.168.15.244:22
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"

KINDLE_HOST="${KINDLE_HOST:-192.168.15.244}"
KINDLE_PORT="${KINDLE_PORT:-22}"
PASS="${KINDLE_PASS:-x}"
REMOTE_ROOT="${REMOTE_ROOT:-/mnt/us/pocketjs-dev}"

BUILD="${BUILD:-1}"
APP="${APP:-hero}" # hero | manga

ssh_pw() {
  expect <<EOF
set timeout 120
spawn ssh -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password -o PubkeyAuthentication=no -p $KINDLE_PORT root@$KINDLE_HOST {*}$argv
expect {
  -re {(?i)password:} { send "$PASS\r"; exp_continue }
  eof {}
  timeout { exit 124 }
}
expect eof
EOF
}

scp_pw() {
  expect <<EOF
set timeout 180
spawn scp -P $KINDLE_PORT -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password -o PubkeyAuthentication=no {*}[lrange \$argv 0 end]
expect {
  -re {(?i)password:} { send "$PASS\r"; exp_continue }
  eof {}
  timeout { exit 124 }
}
catch wait r
exit [lindex \$r 3]
EOF
}

if [[ "$BUILD" == "1" ]]; then
  if [[ "$APP" == "manga" ]]; then
    MANIFEST=apps/manga/pocket.kindle.json
  else
    MANIFEST=apps/hero/pocket.kindle.json
  fi
  echo "→ build $APP ($MANIFEST)"
  bun pocket build --target kindle-pw5 --manifest "$MANIFEST" --project-root .
fi

BIN=hosts/kindle/target/armv7-unknown-linux-musleabihf/release/pocketjs-kindle
if [[ "$APP" == "manga" ]]; then
  JS=dist/manga-kindle-main.js
  PAK=dist/manga-kindle-main.pak
else
  JS=dist/hero-kindle-main.js
  PAK=dist/hero-kindle-main.pak
fi

[[ -f "$BIN" ]] || { echo "missing $BIN — build host first"; exit 1; }
[[ -f "$JS" && -f "$PAK" ]] || { echo "missing $JS / $PAK"; exit 1; }

echo "→ stop runtime (best-effort)"
expect <<EOF
set timeout 30
spawn ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no -p $KINDLE_PORT root@$KINDLE_HOST {sh $REMOTE_ROOT/stop-runtime.sh 2>/dev/null; rm -f $REMOTE_ROOT/bin/pocketjs-kindle; echo ok}
expect {
  -re {(?i)password:} { send "$PASS\r"; exp_continue }
  eof {}
}
expect eof
EOF

echo "→ scp artifacts"
expect <<EOF
set timeout 180
spawn scp -P $KINDLE_PORT -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password -o PubkeyAuthentication=no $JS $PAK root@$KINDLE_HOST:$REMOTE_ROOT/
expect {
  -re {(?i)password:} { send "$PASS\r"; exp_continue }
  eof {}
}
catch wait r1
spawn scp -P $KINDLE_PORT -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password -o PubkeyAuthentication=no $BIN root@$KINDLE_HOST:$REMOTE_ROOT/bin/pocketjs-kindle
expect {
  -re {(?i)password:} { send "$PASS\r"; exp_continue }
  eof {}
}
catch wait r2
exit 0
EOF

echo "→ install current/ + fbink fallback + kual launcher"
expect <<EOF
set timeout 60
spawn ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no -p $KINDLE_PORT root@$KINDLE_HOST {chmod +x $REMOTE_ROOT/bin/pocketjs-kindle; mkdir -p $REMOTE_ROOT/current; cp -f $REMOTE_ROOT/\$(basename $JS) $REMOTE_ROOT/current/app.js; cp -f $REMOTE_ROOT/\$(basename $PAK) $REMOTE_ROOT/current/app.pak; if ! $REMOTE_ROOT/bin/fbink -v >/dev/null 2>&1; then cp -f /mnt/us/usbnet/bin/fbink $REMOTE_ROOT/bin/fbink; chmod +x $REMOTE_ROOT/bin/fbink; fi; ls -la $REMOTE_ROOT/bin/pocketjs-kindle $REMOTE_ROOT/current/; echo DEPLOY_OK}
expect {
  -re {(?i)password:} { send "$PASS\r"; exp_continue }
  eof {}
}
expect eof
EOF

echo "✓ deployed $APP — use KUAL → PocketJS Dev → Run Runtime"

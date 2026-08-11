#!/usr/bin/env bash
# Capture Kindle e-ink framebuffer to a PNG on Air for agent iteration.
# Prefer fbink dump; fall back to raw /dev/fb0 → PNG via Python.
#
# Usage (on Air, USBNetwork up):
#   ./scripts/kindle-screenshot.sh
# Output: ./screenshot-kindle.png (cwd = repo root)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
KINDLE_HOST="${KINDLE_HOST:-192.168.15.244}"
KINDLE_PORT="${KINDLE_PORT:-22}"
PASS="${KINDLE_PASS:-x}"
REMOTE_ROOT="${REMOTE_ROOT:-/mnt/us/pocketjs-dev}"
OUT="${1:-$ROOT/screenshot-kindle.png}"

run_pw() {
  local timeout_s="${1:-60}"
  shift
  local tmp
  tmp="$(mktemp)"
  {
    echo '#!/usr/bin/env expect'
    echo "set timeout $timeout_s"
    printf 'spawn'
    for a in "$@"; do
      local ea
      ea=$(printf '%s' "$a" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\[/\\[/g; s/\]/\\[/g; s/\$/\\$/g' | sed 's/\]/\\]/g')
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

echo "→ capture on device"
# fbink -s writes a PNG if supported; also dump raw gray for fallback
run_pw 40 ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  -p "$KINDLE_PORT" "root@$KINDLE_HOST" \
  "FBINK=$REMOTE_ROOT/bin/fbink; [ -x \"\$FBINK\" ] || FBINK=/mnt/us/usbnet/bin/fbink; \
   rm -f $REMOTE_ROOT/screenshot.png $REMOTE_ROOT/fb.raw; \
   if \$FBINK -s $REMOTE_ROOT/screenshot.png 2>/dev/null; then echo FBINK_OK; \
   elif \$FBINK --screenshot $REMOTE_ROOT/screenshot.png 2>/dev/null; then echo FBINK_OK2; \
   else dd if=/dev/fb0 of=$REMOTE_ROOT/fb.raw bs=1024 count=2048 2>/dev/null; echo RAW_OK; fi; \
   ls -la $REMOTE_ROOT/screenshot.png $REMOTE_ROOT/fb.raw 2>/dev/null; echo CAPTURE_DONE"

echo "→ scp back"
rm -f /tmp/kindle-shot.png /tmp/kindle-fb.raw
run_pw 60 scp -P "$KINDLE_PORT" -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  "root@${KINDLE_HOST}:${REMOTE_ROOT}/screenshot.png" /tmp/kindle-shot.png 2>/dev/null || true
run_pw 60 scp -P "$KINDLE_PORT" -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  "root@${KINDLE_HOST}:${REMOTE_ROOT}/fb.raw" /tmp/kindle-fb.raw 2>/dev/null || true

if [[ -f /tmp/kindle-shot.png ]] && [[ -s /tmp/kindle-shot.png ]]; then
  cp /tmp/kindle-shot.png "$OUT"
  echo "✓ PNG via fbink → $OUT ($(wc -c < "$OUT") bytes)"
  exit 0
fi

if [[ -f /tmp/kindle-fb.raw ]] && [[ -s /tmp/kindle-fb.raw ]]; then
  python3 - <<PY
from pathlib import Path
raw = Path("/tmp/kindle-fb.raw").read_bytes()
# PW5 visible 1236x1648 Gray8, stride often 1248
w, h, stride = 1236, 1648, 1248
need = stride * h
if len(raw) < need:
    # try tight packing
    stride = w
    need = stride * h
data = raw[:need]
rows = []
for y in range(h):
    rows.append(data[y*stride:y*stride+w])
img = b"".join(rows)
# write PGM then let sips convert, or raw PNG via pure python
try:
    import struct, zlib
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag+data) & 0xffffffff)
    # grayscale PNG
    raw_img = b""
    for y in range(h):
        raw_img += b"\x00" + rows[y]
    comp = zlib.compress(raw_img, 9)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
    png += chunk(b"IDAT", comp)
    png += chunk(b"IEND", b"")
    Path("$OUT").write_bytes(png)
    print("✓ raw fb0 → PNG", w, h, len(png))
except Exception as e:
    Path("$OUT.pgm").write_bytes(f"P5\n{w} {h}\n255\n".encode()+img)
    print("pgm fallback", e)
PY
  if [[ -f "$OUT" ]]; then
    echo "✓ $OUT"
    exit 0
  fi
fi

echo "✗ capture failed — is runtime drawing to fb0? try while app is on screen"
exit 1

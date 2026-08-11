#!/usr/bin/env bash
# Ask running PocketJS host to dump its gray buffer, then scp + convert to PNG.
# Better than raw /dev/fb0: captures exactly what the app drew.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KINDLE_HOST="${KINDLE_HOST:-192.168.15.244}"
KINDLE_PORT="${KINDLE_PORT:-22}"
PASS="${KINDLE_PASS:-x}"
REMOTE_ROOT="${REMOTE_ROOT:-/mnt/us/pocketjs-dev}"
OUT="${1:-$ROOT/screenshot-kindle.png}"

run_pw() {
  local timeout_s="${1:-30}"; shift
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

echo "→ request shot"
run_pw 20 ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  -p "$KINDLE_PORT" "root@$KINDLE_HOST" \
  "mkdir -p $REMOTE_ROOT/run; echo shot > $REMOTE_ROOT/run/cmd; echo Q"
sleep 1
echo "→ scp PGM"
rm -f /tmp/kindle-shot.pgm
run_pw 40 scp -P "$KINDLE_PORT" -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  "root@${KINDLE_HOST}:${REMOTE_ROOT}/run/shot.pgm" /tmp/kindle-shot.pgm

python3 - <<'PY'
from pathlib import Path
import struct, zlib
p = Path("/tmp/kindle-shot.pgm")
raw = p.read_bytes()
# P5\nW H\n255\n<data>
assert raw.startswith(b"P5")
parts = raw.split(b"\n", 3)
# handle comment lines
idx = 1
while parts[idx].startswith(b"#"):
    rest = b"\n".join(parts[idx+1:])
    parts = parts[:1] + rest.split(b"\n", 3)
wh = parts[1].split()
w, h = int(wh[0]), int(wh[1])
# parts[2] is maxval, parts[3] is data — but split only 3 times so:
body = raw.split(b"\n", 3)[-1]
# if maxval line separate:
if b"\n" in body[:10]:
    # already consumed
    pass
# Re-parse properly
lines = []
i = 0
# skip magic
assert raw[0:2] == b"P5"
i = 2
while raw[i] in b" \t\r\n":
    i += 1
def read_token():
    global i
    while i < len(raw) and raw[i] in b" \t\r\n":
        i += 1
    if raw[i:i+1] == b"#":
        while i < len(raw) and raw[i] not in b"\n":
            i += 1
        return read_token()
    j = i
    while j < len(raw) and raw[j] not in b" \t\r\n":
        j += 1
    tok = raw[i:j]
    i = j
    return tok
w = int(read_token())
h = int(read_token())
maxv = int(read_token())
while i < len(raw) and raw[i] in b" \t\r":
    i += 1
if raw[i:i+1] == b"\n":
    i += 1
pixels = raw[i:i+w*h]
assert len(pixels) >= w*h, (len(pixels), w*h)
pixels = pixels[:w*h]

def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag+data) & 0xffffffff)
raw_img = b""
for y in range(h):
    raw_img += b"\x00" + pixels[y*w:(y+1)*w]
comp = zlib.compress(raw_img, 9)
png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
png += chunk(b"IDAT", comp)
png += chunk(b"IEND", b"")
out = Path("'''"$OUT"'''")
out.write_bytes(png)
print(f"✓ {out} {w}x{h} {len(png)} bytes")
PY

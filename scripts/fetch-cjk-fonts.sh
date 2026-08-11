#!/usr/bin/env bash
# Fetch Noto Sans SC (OFL) static OTFs used when a PocketJS app harvests CJK
# codepoints. Large (~8MB each) — gitignored; bake-time only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FONT_DIR="$ROOT/assets/fonts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

URL="${NOTO_SANS_SC_URL:-https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/18_NotoSansSC.zip}"

mkdir -p "$FONT_DIR"
echo "→ downloading $URL"
curl -L --fail -o "$TMP/NotoSansSC.zip" "$URL"
unzip -qo "$TMP/NotoSansSC.zip" -d "$TMP/out"
cp "$TMP/out/NotoSansSC-Regular.otf" "$TMP/out/NotoSansSC-Bold.otf" "$FONT_DIR/"
cp "$TMP/out/LICENSE" "$FONT_DIR/NotoSansSC-OFL.txt"
ls -lh "$FONT_DIR"/NotoSansSC-*.otf
echo "✓ Noto Sans SC ready under assets/fonts (OFL — see NotoSansSC-OFL.txt)"

#!/usr/bin/env bash
# Rebuild all icon variants from build/icon.svg.
# Run from `catalyst-app/`:
#     bash build/generate-icons.sh
#
# Output:
#   build/icon.png          1024×1024 master PNG (used by electron-builder
#                           when targeting non-Mac platforms that just want
#                           a raster).
#   build/icon-1024.png     same content, kept around so old config + sanity
#                           checkers still work.
#   build/icon.icns         macOS multi-res bundle (16, 32, 64, 128, 256,
#                           512, 1024 + @2x variants).
#   build/icon.ico          Windows multi-res icon (16, 24, 32, 48, 64,
#                           128, 256).
#
# Requires (all but png-to-ico are macOS built-ins):
#   qlmanage    SVG → PNG via QuickLook
#   sips        PNG resize
#   iconutil    .iconset → .icns
#   npx png-to-ico   PNG list → .ico (will auto-fetch on first run)

set -euo pipefail

cd "$(dirname "$0")"

SVG="icon.svg"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ ! -f "$SVG" ]; then
  echo "icon.svg not found in $(pwd)" >&2
  exit 1
fi

echo "→ rasterising $SVG to 1024×1024…"
# QuickLook generates a thumbnail at the requested square size. -s sets the
# longest edge; output filename is "<input>.png" in the -o directory.
qlmanage -t -s 1024 -o "$TMP" "$SVG" >/dev/null 2>&1
cp "$TMP/$SVG.png" icon.png
cp icon.png icon-1024.png

echo "→ building .iconset for iconutil…"
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"

# macOS .icns expects this exact filename matrix (size + @1x/@2x variants).
declare -a SIZES=(
  "16    icon_16x16.png"
  "32    icon_16x16@2x.png"
  "32    icon_32x32.png"
  "64    icon_32x32@2x.png"
  "128   icon_128x128.png"
  "256   icon_128x128@2x.png"
  "256   icon_256x256.png"
  "512   icon_256x256@2x.png"
  "512   icon_512x512.png"
  "1024  icon_512x512@2x.png"
)

for entry in "${SIZES[@]}"; do
  size=$(echo "$entry" | awk '{print $1}')
  name=$(echo "$entry" | awk '{print $2}')
  sips -z "$size" "$size" icon.png --out "$ICONSET/$name" >/dev/null
done

iconutil -c icns "$ICONSET" -o icon.icns
echo "  wrote icon.icns ($(wc -c < icon.icns) bytes)"

echo "→ building .ico for Windows…"
ICO_SIZES=(16 24 32 48 64 128 256)
ICO_INPUTS=()
for s in "${ICO_SIZES[@]}"; do
  out="$TMP/ico-$s.png"
  sips -z "$s" "$s" icon.png --out "$out" >/dev/null
  ICO_INPUTS+=("$out")
done

# png-to-ico is a small pure-JS package; npx will fetch it once and cache.
npx --yes png-to-ico "${ICO_INPUTS[@]}" > icon.ico
echo "  wrote icon.ico ($(wc -c < icon.ico) bytes)"

echo
echo "✓ done. Regenerated icons in $(pwd):"
ls -la icon.png icon-1024.png icon.icns icon.ico

#!/usr/bin/env python3
"""Rasterize the brand mark into icon.png / icon.icns / icon.ico.

Single source of truth is icon.svg in this directory; this script draws the
same shapes with PIL so we can render crisp icons without an SVG toolchain.
If you edit icon.svg, keep the polygon coordinates here in sync.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

BG = (10, 10, 11, 255)
ORANGE = (224, 104, 60, 255)
BLUE = (84, 131, 164, 255)

# Coordinates expressed in the 1024x1024 design grid; the renderer scales to
# whatever final size is requested using high-quality LANCZOS downsampling
# after drawing at 4x for clean diagonals.
ORANGE_POLY = [(262, 822), (372, 822), (432, 202), (322, 202)]
BLUE_POLY = [(472, 822), (800, 822), (800, 420), (472, 202)]

BRAND_DIR = Path(__file__).resolve().parent
BUILD_DIR = BRAND_DIR.parent


def render(size: int) -> Image.Image:
    scale = 4
    super_size = size * scale
    img = Image.new("RGBA", (super_size, super_size), BG)
    draw = ImageDraw.Draw(img)

    def scaled(poly):
        factor = super_size / 1024
        return [(x * factor, y * factor) for x, y in poly]

    draw.polygon(scaled(ORANGE_POLY), fill=ORANGE)
    draw.polygon(scaled(BLUE_POLY), fill=BLUE)
    return img.resize((size, size), Image.LANCZOS)


def write_png() -> Path:
    path = BUILD_DIR / "icon.png"
    render(1024).save(path)
    return path


def write_ico() -> Path:
    path = BUILD_DIR / "icon.ico"
    base = render(256)
    base.save(
        path,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    return path


def write_icns() -> Path | None:
    if sys.platform != "darwin" or not shutil.which("iconutil"):
        return None
    iconset = BUILD_DIR / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    spec = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }
    for name, sz in spec.items():
        render(sz).save(iconset / name)
    icns_path = BUILD_DIR / "icon.icns"
    subprocess.check_call(
        ["iconutil", "-c", "icns", str(iconset), "-o", str(icns_path)]
    )
    shutil.rmtree(iconset)
    return icns_path


def main() -> None:
    written = [write_png(), write_ico()]
    icns = write_icns()
    if icns:
        written.append(icns)
    for p in written:
        print(f"wrote {p.relative_to(BUILD_DIR.parent)} ({os.path.getsize(p):,} bytes)")


if __name__ == "__main__":
    main()

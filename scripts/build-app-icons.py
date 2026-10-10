#!/usr/bin/env python3
"""Generate the Natalia application icon set from the portrait master.

The art is a 3:4 portrait illustration (cat-ear, headphone character); an icon
must be square, so the design decision is an 800x800 head crop, baked into the
committed master `assets/source/natalia-icon-master.png`. Re-crop by pointing
`--source` at the full art and overriding `--crop`. The crop keeps the whole
face (eyes through chin) intact — the tilted head leaves the hair mass on the
left and the headphones framing both sides; trimming further to center the
face would cut the chin.

Two tracks, because one image cannot serve every size:

  * illustration track (128-1024): the portrait crop, lightly cleaned. Keeps
    the line art where there are pixels to spend.
  * flat track (48-64): the crop with strand detail blurred away and
    contrast/saturation pushed up. Below ~48px the raw crop degenerates into
    noise; this track keeps the ear/headphone/teal-eye silhouette readable.
  * micro track (16-32): the flat track pushed further (heavier blur, then
    posterized to four bits per channel) so the shapes survive as shapes
    instead of moire. Readable as "dark head, two teal eyes" at 16px.

Outputs (all RGBA, 22% rounded corners, matching the previous lettermark set):

  assets/icons/icon-{16,24,32}.png              micro track
  assets/icons/icon-{48,64}.png                 flat track
  assets/icons/icon-{128,256,512,1024}.png      illustration track
  assets/icons/icon.png                         copy of icon-256.png (AppImage)
  assets/icons/icon.ico                         16..256, 32-bit PNG entries
  apps/cef-desktop/src/app_icon_png.h           icon-128.png as a byte array, so
                                                the RUNNING window shows the icon
                                                with no file to locate at runtime

Requires Pillow (`python3 -m pip install Pillow`). The `.ico` container is
written here directly so no external tool (icotool/ImageMagick) is needed.

Usage:
  python3 scripts/build-app-icons.py                 # from the committed master
  python3 scripts/build-app-icons.py --source art.png --crop 183,30,903,750
  python3 scripts/build-app-icons.py --out /tmp/icons # preview without touching assets
"""
from __future__ import annotations

import argparse
import shutil
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MASTER = ROOT / "assets" / "source" / "natalia-icon-master.png"
ICON_HEADER = ROOT / "apps" / "cef-desktop" / "src" / "app_icon_png.h"
EMBED_SIZE = 128  # the PNG embedded in the desktop app for its window icon
# The crop box on the full 1086x1448 art (left, top, right, bottom): ears at
# the top with margin, the complete face (eyes through chin) as the focal
# point, headphone cups framed on both sides.
DEFAULT_CROP = (180, 30, 980, 830)

FLAT_SIZES = [48, 64]
MICRO_SIZES = [16, 24, 32]
ILLUS_SIZES = [128, 256, 512, 1024]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]  # <=64 from the flat/micro tracks, 128+ illustration
CORNER_FRACTION = 0.22  # matches the previous icon set


def simplify(img: Image.Image, blur: float, contrast: float, color: float, brightness: float) -> Image.Image:
    """Blur micro-detail away, then push the shapes that remain."""
    x = img.filter(ImageFilter.GaussianBlur(blur))
    x = ImageEnhance.Contrast(x).enhance(contrast)
    x = ImageEnhance.Color(x).enhance(color)
    x = ImageEnhance.Brightness(x).enhance(brightness)
    return x


def downscale(img: Image.Image, size: int) -> Image.Image:
    """Progressive box halving, then one Lanczos pass.

    A single Lanczos resample from 720px to 16px aliases the hair into moire;
    halving with a box filter first averages honestly at each step.
    """
    while img.width > size * 2:
        img = img.reduce(2)
    return img.resize((size, size), Image.LANCZOS)


def rounded_corners(img: Image.Image, fraction: float = CORNER_FRACTION) -> Image.Image:
    """Apply antialiased rounded corners via a supersampled alpha mask."""
    n = 4
    w, h = img.size
    mask = Image.new("L", (w * n, h * n), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, w * n - 1, h * n - 1], radius=int(w * n * fraction), fill=255
    )
    mask = mask.resize((w, h), Image.LANCZOS)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def render_track(master: Image.Image, size: int, track: str) -> Image.Image:
    if track == "flat":
        x = simplify(master, blur=5.0, contrast=1.55, color=1.50, brightness=1.03)
        x = downscale(x, size)
        x = x.filter(ImageFilter.UnsharpMask(radius=0.8, percent=45, threshold=2))
    elif track == "micro":
        x = simplify(master, blur=7.0, contrast=1.70, color=1.60, brightness=1.03)
        x = ImageOps.posterize(x, 4)  # flatten moire into solid shapes
        x = downscale(x, size)
        x = x.filter(ImageFilter.UnsharpMask(radius=0.8, percent=45, threshold=2))
    else:
        x = simplify(master, blur=1.5, contrast=1.06, color=1.12, brightness=1.02)
        x = downscale(x, size)
        x = x.filter(ImageFilter.UnsharpMask(radius=1.0, percent=65, threshold=2))
    return rounded_corners(x)


def write_ico(path: Path, entries: list[tuple[int, Path]]) -> None:
    """Write a Windows .ico whose entries are the given PNGs, 32-bit each.

    ICO directory entry: width/height in bytes (0 means 256), colors 0,
    planes 1, bitcount 32, then byte length and file offset of the PNG blob.
    """
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    body = b""
    dir_entries = b""
    for size, png in entries:
        data = png.read_bytes()
        dim = 0 if size >= 256 else size
        dir_entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        body += data
        offset += len(data)
    path.write_bytes(header + dir_entries + body)


def write_icon_header(path: Path, png: bytes, size: int) -> None:
    """Emit the embedded window icon as a C++ byte array.

    The running desktop app sets its window/taskbar icon from these bytes
    (simple_app.cc), because where the icon FILE lives differs between a
    checkout and an installed copy, while the binary always has itself.
    """
    out = [
        "// GENERATED by scripts/build-app-icons.py — do not edit by hand.",
        "//",
        f"// assets/icons/icon-{size}.png as a byte array, embedded so the running",
        "// window shows the app icon with no file to find at runtime. Regenerate",
        "// with: python3 scripts/build-app-icons.py",
        "#pragma once",
        "",
        "namespace natalia {",
        "",
        f"inline constexpr unsigned char kAppIconPng[] = {{",
    ]
    for i in range(0, len(png), 20):
        out.append("    " + ",".join(str(b) for b in png[i:i + 20]) + ",")
    out += [
        "};",
        "",
        f"inline constexpr unsigned kAppIconPngSize = {len(png)};",
        "",
        "}  // namespace natalia",
        "",
    ]
    path.write_text("\n".join(out), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--source", type=Path, default=DEFAULT_MASTER,
                    help="master crop (default: assets/source/natalia-icon-master.png)")
    ap.add_argument("--crop", default=None,
                    help="crop box L,T,R,B applied when --source is the full art")
    ap.add_argument("--out", type=Path, default=ROOT / "assets" / "icons",
                    help="output directory (default: assets/icons)")
    args = ap.parse_args()

    src = args.source.resolve()
    if not src.is_file():
        print(f"error: source not found: {src}", file=sys.stderr)
        return 1

    art = Image.open(src).convert("RGB")
    if art.size != (800, 800):
        box = DEFAULT_CROP
        if args.crop:
            box = tuple(int(v) for v in args.crop.split(","))
        l, t, r, b = box
        print(f"cropping {src.name} {art.size} -> {r-l}x{b-t} box={box}")
        art = art.crop(box)
    master = art

    args.out.mkdir(parents=True, exist_ok=True)
    made: dict[int, Path] = {}
    for size in MICRO_SIZES:
        p = args.out / f"icon-{size}.png"
        render_track(master, size, track="micro").save(p)
        made[size] = p
        print(f"  micro        {p.name}")
    for size in FLAT_SIZES:
        p = args.out / f"icon-{size}.png"
        render_track(master, size, track="flat").save(p)
        made[size] = p
        print(f"  flat         {p.name}")
    for size in ILLUS_SIZES:
        p = args.out / f"icon-{size}.png"
        render_track(master, size, track="illustration").save(p)
        made[size] = p
        print(f"  illustration {p.name}")

    shutil.copyfile(made[256], args.out / "icon.png")
    print("  copy        icon.png (= icon-256.png)")

    ico = args.out / "icon.ico"
    write_ico(ico, [(s, made[s]) for s in ICO_SIZES])
    print(f"  container   icon.ico ({len(ICO_SIZES)} entries: {', '.join(map(str, ICO_SIZES))})")

    # The running app's window icon: the same illustration track at EMBED_SIZE,
    # as bytes. Written next to the sources the desktop target compiles.
    write_icon_header(ICON_HEADER, made[EMBED_SIZE].read_bytes(), EMBED_SIZE)
    print(f"  embed       {ICON_HEADER.relative_to(ROOT)} (icon-{EMBED_SIZE}.png, {made[EMBED_SIZE].stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

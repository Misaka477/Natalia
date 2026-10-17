#!/usr/bin/env bun
/**
 * Generate the Natalia application icon set from the SVG master.
 *
 * The master is `assets/source/natalia-icon.svg`, a 1086x1086 vector
 * tracing of the portrait illustration. Because it is vector, every size
 * below is rendered natively at that size: there is no downscaling step
 * to alias the hair into moire, so the micro/flat/illustration track
 * system the previous raster pipeline needed is gone.
 *
 * Two framings, selected with --variant, because one square cannot show
 * the whole illustration and a readable face at 16px at the same time:
 *
 *   head  viewBox 150 0 850 850 on the 1086 canvas: ears with a small
 *         margin at the top, the face as the focal point, both headphone
 *         cups framed.
 *   full  the whole 1086 canvas, jacket and choker included.
 *
 * Both carry the 22% rounded corners the icon set has always had, baked
 * in as a clipPath, so the PNGs, the .ico and the web favicon all
 * inherit the same shape from one source.
 *
 * Outputs (identical paths to the previous pipeline, so every consumer
 * stays untouched: the PE resource, the Inno installer, the AppImage,
 * the mac bundle, and the embedded window icon):
 *
 *   assets/icons/icon-{16,24,32,48,64,128,256,512,1024}.png
 *   assets/icons/icon.png                    copy of icon-256.png
 *   assets/icons/icon.ico                    16..256, 32-bit PNG entries
 *   apps/cef-desktop/src/app_icon_png.h      icon-128.png as a byte array
 *   apps/web/favicon.svg                     the active variant, minimized
 *
 * Usage:
 *   bun scripts/build-app-icons.ts                     # head into assets/
 *   bun scripts/build-app-icons.ts --variant full
 *   bun scripts/build-app-icons.ts --out /tmp/preview  # PNGs only
 */
import { optimize } from "svgo";
import { Resvg } from "@resvg/resvg-js";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SOURCE_SVG = join(ROOT, "assets", "source", "natalia-icon.svg");
const ICONS_DIR = join(ROOT, "assets", "icons");
const ICON_HEADER = join(ROOT, "apps", "cef-desktop", "src", "app_icon_png.h");
const FAVICON = join(ROOT, "apps", "web", "favicon.svg");
/**
 * The web shell's own copy of the mark, at the size the top bar draws it.
 *
 * Vite copies `public/` into the build output verbatim, so this file lands at
 * `<web root>/brand.png` and the static server already serves `.png`. The web
 * UI is a PLUGIN bundle served by the runtime from a different origin than the
 * shell, so it cannot reference a hashed asset name or a bundle-relative path —
 * a stable, root-relative `/brand.png` is the only form that resolves. The top
 * bar used to draw a blue rounded square with the letter N in it, which is a
 * placeholder, not the app's icon.
 */
const WEB_BRAND = join(ROOT, "apps", "web", "public", "brand.png");

/** Matches the corner radius the icon set has always carried. */
const CORNER_FRACTION = 0.22;
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** The PNG embedded in the desktop app for its window icon. */
const EMBED_SIZE = 128;
/** The size the web top bar draws. */
const WEB_BRAND_SIZE = 64;

const VARIANTS = {
  head: { viewBox: "150 0 850 850" },
  full: { viewBox: null },
} as const;

type Variant = keyof typeof VARIANTS;

function parseArgs(argv: string[]): { variant: Variant; out: string | null } {
  let variant: Variant = "head";
  let out: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--variant") {
      const value = argv[i + 1];
      if (value !== "head" && value !== "full") {
        throw new Error(`--variant expects head|full, got ${String(value)}`);
      }
      variant = value;
      i += 1;
    } else if (arg === "--out") {
      const value = argv[i + 1];
      if (!value) throw new Error("--out expects a directory");
      out = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { variant, out };
}

/**
 * Inject the variant's viewBox and the rounded-corner clip into the
 * source. The clip rect is written in the source's own user units, so
 * the head variant's rect sits at the viewBox origin rather than at 0,0.
 */
function buildSvg(source: string, variant: Variant): string {
  const open = /<svg[^>]*>/u.exec(source);
  const close = /<\/svg>/u.exec(source);
  if (!open || !close) throw new Error("source svg has no root element");
  const canvas = Number(/width="(\d+)"/u.exec(open[0])?.[1]);
  if (!Number.isFinite(canvas)) throw new Error("source svg declares no width");
  const viewBox = VARIANTS[variant].viewBox;
  const [x, y, side] = (
    viewBox ? viewBox.split(" ") : ["0", "0", String(canvas)]
  ).map(Number) as [number, number, number];
  if (![x, y, side].every((n) => Number.isFinite(n))) {
    throw new Error(`variant ${variant} has a malformed viewBox`);
  }
  const rx = Math.round(side * CORNER_FRACTION);
  let openTag = open[0];
  if (viewBox) {
    openTag = /viewBox=/u.test(openTag)
      ? openTag.replace(/viewBox="[^"]*"/u, `viewBox="${viewBox}"`)
      : openTag.replace(/<svg/u, `<svg viewBox="${viewBox}"`);
  }
  const clip =
    '<defs><clipPath id="natalia-icon-corners">' +
    `<rect x="${x}" y="${y}" width="${side}" height="${side}" rx="${rx}"/>` +
    "</clipPath></defs>" +
    '<g clip-path="url(#natalia-icon-corners)">';
  return (
    source.slice(0, open.index) +
    openTag +
    clip +
    source.slice(open.index + open[0].length, close.index) +
    "</g>" +
    source.slice(close.index)
  );
}

function renderPng(svg: string, size: number): Uint8Array {
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  return resvg.render().asPng();
}

/**
 * Write a Windows .ico whose entries are the given PNGs, 32-bit each.
 * Directory entry: width and height in bytes (0 means 256), colors 0,
 * reserved 0, planes 1, bitcount 32, byte length, then file offset.
 */
function writeIco(path: string, entries: [number, Uint8Array][]): void {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  const body: Buffer[] = [];
  let offset = 6 + 16 * entries.length;
  entries.forEach(([size, data], index) => {
    const dim = size >= 256 ? 0 : size;
    const entry = dir.subarray(index * 16);
    entry.writeUInt8(dim, 0);
    entry.writeUInt8(dim, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.byteLength, 8);
    entry.writeUInt32LE(offset, 12);
    const buf = Buffer.from(data);
    body.push(buf);
    offset += buf.byteLength;
  });
  writeFileSync(path, Buffer.concat([header, dir, ...body]));
}

/** Emit the embedded window icon as a C++ byte array. */
function writeIconHeader(path: string, png: Uint8Array, size: number): void {
  const lines = [
    "// GENERATED by scripts/build-app-icons.ts — do not edit by hand.",
    "//",
    `// assets/icons/icon-${size}.png as a byte array, embedded so the running`,
    "// window shows the app icon with no file to find at runtime. Regenerate",
    "// with: bun scripts/build-app-icons.ts",
    "#pragma once",
    "",
    "namespace natalia {",
    "",
    "inline constexpr unsigned char kAppIconPng[] = {",
  ];
  for (let i = 0; i < png.byteLength; i += 20) {
    lines.push(`    ${Array.from(png.subarray(i, i + 20)).join(",")},`);
  }
  lines.push(
    "};",
    "",
    `inline constexpr unsigned kAppIconPngSize = ${png.byteLength};`,
    "",
    "}  // namespace natalia",
    "",
  );
  writeFileSync(path, lines.join("\n"));
}

async function writeFavicon(svg: string): Promise<void> {
  const result = optimize(svg, { floatPrecision: 1, multipass: true });
  if (typeof result.data !== "string" || result.data.length === 0) {
    throw new Error("svgo produced no output for the favicon");
  }
  await writeFile(FAVICON, result.data);
}

async function main(): Promise<number> {
  const { variant, out } = parseArgs(process.argv.slice(2));
  const source = await readFile(SOURCE_SVG, "utf8");
  const svg = buildSvg(source, variant);
  const outDir = out ?? ICONS_DIR;
  await mkdir(outDir, { recursive: true });

  const rendered = new Map<number, Uint8Array>();
  for (const size of PNG_SIZES) {
    const png = renderPng(svg, size);
    rendered.set(size, png);
    const target = join(outDir, `icon-${size}.png`);
    await writeFile(target, png);
    console.log(
      `  ${String(size).padStart(4)}px  ${target.slice(ROOT.length + 1)}`,
    );
  }
  await cp(join(outDir, "icon-256.png"), join(outDir, "icon.png"));
  console.log("  copy    icon.png (= icon-256.png)");

  const icoPath = join(outDir, "icon.ico");
  writeIco(
    icoPath,
    ICO_SIZES.map(
      (size) => [size, rendered.get(size)!] as [number, Uint8Array],
    ),
  );
  console.log(
    `  ico     ${icoPath.slice(ROOT.length + 1)} (${ICO_SIZES.length} entries)`,
  );

  if (out) {
    console.log(`preview only (--out): ${outDir}`);
    return 0;
  }

  const embed = rendered.get(EMBED_SIZE)!;
  writeIconHeader(ICON_HEADER, embed, EMBED_SIZE);
  console.log(
    `  embed   apps/cef-desktop/src/app_icon_png.h (icon-${EMBED_SIZE}.png, ${embed.byteLength} bytes)`,
  );
  await writeFavicon(svg);
  console.log(`  favicon apps/web/favicon.svg (variant: ${variant})`);
  // The web shell's own copy of the mark at the size the top bar draws it.
  // Vite copies `public/` into the build output verbatim, so this lands at
  // `<web root>/brand.png` and the static server already serves `.png` — the
  // one form the UI can reference (a plugin bundle is served by the runtime
  // from a different origin, so a hashed asset name or a bundle-relative path
  // would not resolve).
  const brand = rendered.get(WEB_BRAND_SIZE)!;
  await mkdir(dirname(WEB_BRAND), { recursive: true });
  await writeFile(WEB_BRAND, brand);
  console.log(
    `  brand   apps/web/public/brand.png (icon-${WEB_BRAND_SIZE}.png, ${brand.byteLength} bytes)`,
  );
  return 0;
}

process.exit(await main());

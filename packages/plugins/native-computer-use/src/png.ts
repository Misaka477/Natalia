/**
 * PNG encoding for captured frames.
 *
 * A screenshot the model can look at has to be a file the provider accepts,
 * and the Windows capture path hands back raw BGRA pixels. Writing the PNG
 * here — rather than pulling in an image library — keeps the plugin's
 * dependency list at the two workspace packages it already needs, and the
 * format is small enough to be owned: a signature, one IHDR, one IDAT of
 * deflated scanlines, one IEND.
 *
 * Everything is verified by a round trip: the test inflates the IDAT back
 * and demands the exact scanlines it encoded, which is the only proof that
 * the bytes on disk are the pixels that were captured.
 */
import { deflateSync } from "node:zlib";

const SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Color type 2: truecolor RGB, eight bits per channel. */
const COLOR_TYPE_RGB = 2;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type+data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Encode truecolor pixels as a PNG.
 *
 * `rgb` is width*height*3 bytes, row-major, top-down — the shape a BGRA
 * capture becomes after the channel swap in the win32 layer.
 */
export function encodePng(
  width: number,
  height: number,
  rgb: Uint8Array,
): Uint8Array {
  if (width <= 0 || height <= 0)
    throw new Error(`png: impossible dimensions ${width}x${height}`);
  const expected = width * height * 3;
  if (rgb.length !== expected)
    throw new Error(
      `png: expected ${expected} bytes for ${width}x${height}, got ${rgb.length}`,
    );
  // Each scanline is prefixed with its filter type; filter 0 (none) is the
  // honest choice for a screen capture, where the neighbours are noise.
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    const at = row * (1 + width * 3);
    raw[at] = 0;
    raw.set(rgb.subarray(row * width * 3, (row + 1) * width * 3), at + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = COLOR_TYPE_RGB;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return new Uint8Array([
    ...SIGNATURE,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", deflateSync(raw)),
    ...chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Swap a 32-bit BGRA buffer into truecolor RGB, dropping the alpha. */
export function bgraToRgb(bgra: Uint8Array, pixels: number): Uint8Array {
  const rgb = new Uint8Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    rgb[i * 3] = bgra[i * 4 + 2]!;
    rgb[i * 3 + 1] = bgra[i * 4 + 1]!;
    rgb[i * 3 + 2] = bgra[i * 4]!;
  }
  return rgb;
}

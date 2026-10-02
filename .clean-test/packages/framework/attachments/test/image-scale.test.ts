import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ATTACHMENT_LIMITS,
  DEFAULT_MAX_IMAGE_LONG_EDGE,
  attachmentDataURL,
  scaleImage,
  storeLocalAttachmentBytes,
  storeLocalAttachments,
} from "../src";

/** A real PNG, so the codec has something decodable to work on. */
async function makePng(width: number, height: number): Promise<Uint8Array> {
  const { encode } = await import("@jsquash/png");
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = index % 256;
    data[index * 4 + 1] = (index * 3) % 256;
    data[index * 4 + 2] = (index * 7) % 256;
    data[index * 4 + 3] = 255;
  }
  return new Uint8Array(await encode(new ImageData(data, width, height)));
}

test("scaleImage shrinks an oversized PNG down to the long-edge limit", async () => {
  // A small limit so the test does not have to build a multi-megapixel image;
  // the geometry under test is the same one the 1568px default applies.
  const png = await makePng(320, 200);
  const result = await scaleImage({
    bytes: png,
    mediaType: "image/png",
    maxLongEdge: 160,
  });

  expect(result).toBeDefined();
  expect(Math.max(result!.width, result!.height)).toBe(160);
  // Aspect ratio preserved: 320x200 scaled by 160/320 keeps the 8:5 ratio.
  expect(result!.height).toBe(100);
  expect(result!.width).toBe(160);
  expect(result!.mediaType).toBe("image/png");
  // The whole point: the replacement bytes are smaller than what came in.
  expect(result!.bytes.byteLength).toBeLessThan(png.byteLength);
});

test("scaleImage leaves an image that already fits untouched", async () => {
  const png = await makePng(40, 30);
  const result = await scaleImage({
    bytes: png,
    mediaType: "image/png",
    maxLongEdge: DEFAULT_MAX_IMAGE_LONG_EDGE,
  });

  expect(result).toBeUndefined();
});

test("scaleImage never touches a GIF, which would need per-frame work", async () => {
  // A minimal GIF header; the codec is never reached for this media type.
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const result = await scaleImage({
    bytes: gif,
    mediaType: "image/gif",
    maxLongEdge: 8,
  });

  expect(result).toBeUndefined();
});

test("scaleImage is deterministic: the same bytes scale to the same output", async () => {
  const png = await makePng(300, 150);
  const options = { mediaType: "image/png", maxLongEdge: 100 } as const;

  const first = await scaleImage({ bytes: png, ...options });
  const second = await scaleImage({ bytes: png, ...options });

  expect(first).toBeDefined();
  expect(second).toBeDefined();
  expect(Array.from(second!.bytes)).toEqual(Array.from(first!.bytes));
  expect(second!.width).toBe(first!.width);
  expect(second!.height).toBe(first!.height);
});

test("scaleImage falls back to the original bytes when the codec fails", async () => {
  // Valid PNG header claiming 10x10 but no pixel data: decoding throws.
  const broken = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48,
    0x44, 0x52, 0, 0, 0, 0x0a, 0, 0, 0, 0x0a,
  ]);
  const result = await scaleImage({
    bytes: broken,
    mediaType: "image/png",
    maxLongEdge: 4,
  });

  expect(result).toBeUndefined();
});

test("storing an oversized image persists the scaled bytes and dimensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-attachment-scale-"));
  const png = await makePng(320, 200);

  const stored = await storeLocalAttachmentBytes({
    workspaceRoot: root,
    name: "big.png",
    mediaType: "image/png",
    data: png,
    limits: { maxImageLongEdge: 160 },
  });

  expect(Math.max(stored.width!, stored.height!)).toBe(160);
  expect(stored.height).toBe(100);
  // The stored file, its recorded byteLength and its sha256 all describe the
  // same representation — that agreement is what makes the data URL stable.
  const onDisk = new Uint8Array(await readFile(join(root, stored.path)));
  expect(onDisk.byteLength).toBe(stored.byteLength);
  expect(Bun.file(join(root, stored.path)).size).toBe(stored.byteLength);
  expect(onDisk.byteLength).toBeLessThan(png.byteLength);

  const dataURL = await attachmentDataURL(root, stored);
  const again = await attachmentDataURL(root, stored);
  // Prefix stability: the same attachment must resolve to the same bytes every
  // time, or every request after the first one misses the provider's cache.
  expect(again).toBe(dataURL);
});

test("storing from a path scales too, and records the scaled dimensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-attachment-path-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root, "shot.png"), await makePng(400, 300));

  const [stored] = await storeLocalAttachments({
    workspaceRoot: root,
    paths: ["shot.png"],
    limits: { maxImageLongEdge: 160 },
  });

  expect(stored).toBeDefined();
  // 400x300 at a 160 long edge: factor 160/400, so height floors to 120.
  expect(Math.max(stored.width!, stored.height!)).toBe(160);
  expect(stored.height).toBe(120);
});

test("the long-edge limit is configurable", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-attachment-limit-"));
  const png = await makePng(200, 100);

  const stored = await storeLocalAttachmentBytes({
    workspaceRoot: root,
    name: "big.png",
    mediaType: "image/png",
    data: png,
    limits: { maxImageLongEdge: 64 },
  });

  expect(Math.max(stored.width!, stored.height!)).toBe(64);
  expect(DEFAULT_ATTACHMENT_LIMITS.maxImageLongEdge).toBe(
    DEFAULT_MAX_IMAGE_LONG_EDGE,
  );
});

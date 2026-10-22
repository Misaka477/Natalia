/**
 * The pure half of the computer-use plugin.
 *
 * Everything here runs without a display: the PNG bytes a capture becomes,
 * the arithmetic a click depends on, the key specs the keyboard layer
 * replays, and the verdict that decides whether a click did anything. The
 * native layer (win32/*) is what these are tested FOR — the rules it
 * implements are the rules checked here.
 */
import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { bgraToRgb, encodePng } from "../src/png";
import { clipToBounds, rectContains, regionAround } from "../src/coords";
import { parseKeySpec } from "../src/keys";
import { clickVerdict, diffRegion } from "../src/verify";

/* ------------------------------- png.ts ------------------------------- */

test("an encoded PNG carries the pixels it was given", () => {
  // 2x2, four distinct colors, so a swapped channel or a lost row is
  // visible in the round trip rather than in a renderer.
  const width = 2;
  const height = 2;
  const rgb = Uint8Array.from([
    255,
    0,
    0, // red
    0,
    255,
    0, // green
    0,
    0,
    255, // blue
    255,
    255,
    0, // yellow
  ]);
  const png = encodePng(width, height, rgb);
  expect([...png.slice(0, 8)]).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect(view.getUint32(8)).toBe(13); // IHDR length
  expect(String.fromCharCode(...png.slice(12, 16))).toBe("IHDR");
  expect(view.getUint32(16)).toBe(width);
  expect(view.getUint32(20)).toBe(height);
  expect(png[24]).toBe(8); // bit depth
  expect(png[25]).toBe(2); // truecolor RGB
  // The IDAT inflates back to the exact scanlines: filter byte 0, then the
  // row, for each row. This is the proof the file on disk is the frame.
  // Layout: signature(8) + IHDR chunk(4+4+13+4=25) + IDAT chunk header(8).
  const idatLengthAt = 8 + 25;
  const idatTypeAt = idatLengthAt + 4;
  const idatDataAt = idatTypeAt + 4;
  expect(String.fromCharCode(...png.slice(idatTypeAt, idatDataAt))).toBe(
    "IDAT",
  );
  const inflated = inflateSync(
    png.slice(idatDataAt, idatDataAt + view.getUint32(idatLengthAt)),
  );
  expect([...inflated]).toEqual([
    0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 0,
  ]);
  expect(String.fromCharCode(...png.slice(-8, -4))).toBe("IEND");
});

test("a PNG refuses a pixel buffer that does not match its dimensions", () => {
  expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow(
    /expected 12 bytes/u,
  );
  expect(() => encodePng(0, 2, new Uint8Array(0))).toThrow(
    /impossible dimensions/u,
  );
});

test("a BGRA capture becomes truecolor RGB with the channels in place", () => {
  // Windows hands back BGRA; a red pixel is B=0,G=0,R=255,A=255.
  const bgra = Uint8Array.from([0, 0, 255, 255]);
  expect([...bgraToRgb(bgra, 1)]).toEqual([255, 0, 0]);
});

/* ------------------------------ coords.ts ------------------------------ */

test("regionAround clips to the screen and reports nothing off-screen", () => {
  const bounds = { x: 0, y: 0, w: 1000, h: 800 };
  expect(regionAround(500, 400, 48, bounds)).toEqual({
    x: 452,
    y: 352,
    w: 97,
    h: 97,
  });
  // A point at the corner keeps the region inside the screen.
  expect(regionAround(0, 0, 48, bounds)).toEqual({ x: 0, y: 0, w: 49, h: 49 });
  // Off-screen is a refusal, not a zero-width region.
  expect(regionAround(2000, 400, 48, bounds)).toBeUndefined();
});

test("clipToBounds keeps the part of a region that exists", () => {
  const bounds = { x: 0, y: 0, w: 1000, h: 800 };
  // A window dragged half off the right edge.
  expect(clipToBounds({ x: 900, y: 100, w: 400, h: 300 }, bounds)).toEqual({
    x: 900,
    y: 100,
    w: 100,
    h: 300,
  });
  // Entirely off-screen is nothing to capture, which is the honest answer.
  expect(
    clipToBounds({ x: -50, y: 100, w: 40, h: 300 }, bounds),
  ).toBeUndefined();
  expect(
    clipToBounds({ x: 5000, y: 100, w: 40, h: 300 }, bounds),
  ).toBeUndefined();
});

/* ------------------------------- keys.ts ------------------------------- */

test("a chord presses modifiers first and releases them last", () => {
  const steps = parseKeySpec("ctrl+v");
  expect(steps).toEqual([
    { vk: 0x11, up: false },
    { vk: 0x56, up: false },
    { vk: 0x56, up: true },
    { vk: 0x11, up: true },
  ]);
});

test("several modifiers keep their order, reversed on release", () => {
  const steps = parseKeySpec("ctrl+shift+esc");
  expect(steps).toEqual([
    { vk: 0x11, up: false },
    { vk: 0x10, up: false },
    { vk: 0x1b, up: false },
    { vk: 0x1b, up: true },
    { vk: 0x10, up: true },
    { vk: 0x11, up: true },
  ]);
});

test("named keys, function keys and characters resolve", () => {
  expect(parseKeySpec("enter")).toEqual([
    { vk: 0x0d, up: false },
    { vk: 0x0d, up: true },
  ]);
  expect(parseKeySpec("F5")).toEqual([
    { vk: 0x74, up: false },
    { vk: 0x74, up: true },
  ]);
  expect(parseKeySpec("a")).toEqual([
    { vk: 0x41, up: false },
    { vk: 0x41, up: true },
  ]);
  expect(parseKeySpec("alt+tab")[0]).toEqual({ vk: 0x12, up: false });
});

test("an unusable key spec is refused with what is known", () => {
  expect(() => parseKeySpec("ctrl+hyper")).toThrow(/unknown key "hyper"/u);
  expect(() => parseKeySpec("ctrl")).toThrow(/names only modifiers/u);
  expect(() => parseKeySpec("")).toThrow(/empty key spec/u);
  // One spec is one chord; a caller that wants a sequence calls per key.
  expect(() => parseKeySpec("ctrl+v+c")).toThrow(/several keys at once/u);
  expect(() => parseKeySpec("f99")).toThrow(/unknown key/u);
});

/* ------------------------------ verify.ts ------------------------------ */

/** A solid-color frame of the given size. */
function frame(width: number, height: number, color: [number, number, number]) {
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 3] = color[0];
    pixels[i * 3 + 1] = color[1];
    pixels[i * 3 + 2] = color[2];
  }
  return pixels;
}

test("the diff counts changed pixels and boxes where they are", () => {
  const before = frame(10, 10, [0, 0, 0]);
  const after = frame(10, 10, [0, 0, 0]);
  // A 2x2 block at (4,4) turns white.
  for (let y = 4; y < 6; y += 1)
    for (let x = 4; x < 6; x += 1) {
      const at = (y * 10 + x) * 3;
      after[at] = 255;
      after[at + 1] = 255;
      after[at + 2] = 255;
    }
  const diff = diffRegion(before, after, 10, 10);
  expect(diff.total).toBe(100);
  expect(diff.changedPixels).toBe(4);
  expect(diff.changedRatio).toBeCloseTo(0.04, 5);
  expect(diff.box).toEqual({ x: 4, y: 4, w: 2, h: 2 });
});

test("a click that changed the screen is verified with the change's size", () => {
  const before = frame(20, 20, [10, 10, 10]);
  const after = frame(20, 20, [10, 10, 10]);
  // A menu opened over a third of the sampled region.
  for (let i = 0; i < 20 * 20 * 0.4; i += 1) {
    after[i * 3] = 200;
    after[i * 3 + 1] = 200;
    after[i * 3 + 2] = 200;
  }
  const verdict = clickVerdict(diffRegion(before, after, 20, 20), {
    x: 5,
    y: 5,
  });
  expect(verdict.verified).toBe(true);
  expect(verdict.note).toContain("160 of 400");
});

test("a click that changed nothing names what to check, never a retry", () => {
  const still = frame(20, 20, [10, 10, 10]);
  const verdict = clickVerdict(diffRegion(still, still, 20, 20), {
    x: 640,
    y: 480,
  });
  expect(verdict.verified).toBe(false);
  // The coordinate transform comes first: it is the failure that reads as
  // "the click did nothing".
  expect(verdict.note).toContain("coordinate");
  expect(verdict.note).toContain("client origin");
  // And it must not send the model back to the same pixel.
  expect(verdict.note).toContain("Do not click the same pixel again");
  expect(verdict.note).toContain("(640,480)");
});

test("a click whose change is noise is not a response", () => {
  const before = frame(20, 20, [10, 10, 10]);
  const after = frame(20, 20, [10, 10, 10]);
  // One pixel in 400 turned white: a caret blink, not the page answering.
  after[0] = 255;
  after[1] = 255;
  after[2] = 255;
  const diff = diffRegion(before, after, 20, 20);
  expect(diff.changedPixels).toBe(1);
  const verdict = clickVerdict(diff, { x: 1, y: 1 });
  expect(verdict.verified).toBe(false);
  expect(verdict.note).toContain("noise");
});

test("a point off the screen is reported as unsampleable", () => {
  const verdict = clickVerdict(
    { changedRatio: 0, changedPixels: 0, total: 0 },
    { x: -5, y: -5 },
  );
  expect(verdict.verified).toBe(false);
  expect(verdict.note).toContain("outside the screen");
});

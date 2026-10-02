import { beforeAll, expect, test } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { rustCas } from "../src";

/**
 * Slice 4a — the zero-dependency compression core, with node's `zlib`
 * as the standing oracle in BOTH directions: our inflate decodes its
 * `deflateSync` at every level (covering stored, fixed and dynamic
 * blocks — plus a hand-built fixed-Huffman fixture so block type 01 is
 * covered by construction, not by hope), and its `inflateSync` decodes
 * our stored-block output. Error faces: a truncated stream and a
 * rotted adler are refused with codes, never panics — the FFI carries
 * catch_unwind because a Rust panic across extern "C" aborts the host.
 */

beforeAll(async () => {
  await rustCas.ensureBuilt();
});

const boundarySizes = [
  0, 1, 55, 63, 64, 120, 1000, 65_535, 65_536, 70_000, 300_000,
];

const corpus = (size: number): Buffer<ArrayBuffer> => {
  // Two exact halves concatenated to the exact length: NO subarray (a
  // view types as shared-capable and toEqual wants a non-shared Buffer
  // — and the halves already sum to `size` exactly).
  const headLen = Math.floor(size / 2);
  const head = Buffer.from(
    "0123456789abcdef".repeat(headLen / 16 + 1).slice(0, headLen),
  );
  return Buffer.concat([head, randomBytes(size - headLen)]);
};

test("our inflate decodes node's deflateSync at every level and boundary size", () => {
  for (const level of [0, 1, 6, 9]) {
    for (const size of boundarySizes) {
      const source = corpus(size);
      expect(rustCas.inflate(deflateSync(source, { level }), size)).toEqual(
        source,
      );
    }
  }
  const repetitive = Buffer.from("0123456789abcdef".repeat(64 * 1024)); // 1 MiB
  for (const level of [1, 6, 9]) {
    expect(
      rustCas.inflate(deflateSync(repetitive, { level }), repetitive.length),
    ).toEqual(repetitive);
  }
});

test("our stored-block deflate round-trips through node's inflateSync", () => {
  for (const size of boundarySizes) {
    const source = corpus(size);
    expect(inflateSync(rustCas.deflate(source))).toEqual(source);
  }
  const repetitive = Buffer.from("0123456789abcdef".repeat(64 * 1024));
  expect(inflateSync(rustCas.deflate(repetitive))).toEqual(repetitive);
});

test("a hand-built multi-block stored stream (node-validated) decodes identically", () => {
  const payload = Buffer.from(
    "stored-block cross validation payload ".repeat(100),
  );
  const storedBlock = (chunk: Buffer, last: boolean): Buffer => {
    const len = chunk.length;
    const head = Buffer.alloc(5);
    head[0] = last ? 1 : 0;
    head.writeUInt16LE(len, 1);
    head.writeUInt16LE(~len & 0xffff, 3);
    return Buffer.concat([head, chunk]);
  };
  let a = 1;
  let b = 0;
  for (const byte of payload) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(((b << 16) | a) >>> 0, 0);
  const half = payload.length - 3;
  const stream = Buffer.concat([
    Buffer.from([0x78, 0x01]),
    storedBlock(payload.subarray(0, half), false),
    storedBlock(payload.subarray(half), true),
    trailer,
  ]);
  // node validates the fixture first — if either side disagrees, the
  // disagreement is ours, not the RFC's
  expect(inflateSync(stream)).toEqual(payload);
  expect(rustCas.inflate(stream, payload.length)).toEqual(payload);
});

test("a crafted FIXED-HUFFMAN block (RFC1951 §3.2.6) decodes on both sides", () => {
  // Fixed tables: literals0-143 = an8-bit code 0x30..0xbf (written
  // MSB-first per §3.2.6, so the byte arrives bit-reversed into our
  // LSB-first stream); end-of-block256 = a7-bit code0000000.
  const payload = Buffer.from("fixed-huffman block");
  const bits: number[] = []; // bit order as written (LSB-first stream)
  const put = (value: number, count: number) => {
    for (let i = 0; i < count; i += 1) bits.push((value >> i) & 1);
  };
  put(1, 1); // BFINAL
  put(1, 2); // BTYPE = fixed
  for (const byte of payload) {
    // the 8-bit code for a literal <144 is (0x30 + byte), emitted
    // most-significant-bit first (§3.2.6) -> put reversed
    const code = 0x30 + byte;
    for (let i = 7; i >= 0; i -= 1) bits.push((code >> i) & 1);
  }
  // end-of-block256: a7-bit code (0000000)
  for (let i = 0; i < 7; i += 1) bits.push(0);
  const bytes: number[] = [];
  let acc = 0;
  let n = 0;
  for (const bit of bits) {
    acc |= bit << n;
    n += 1;
    if (n === 8) {
      bytes.push(acc);
      acc = 0;
      n = 0;
    }
  }
  if (n > 0) bytes.push(acc);
  let a = 1;
  let b = 0;
  for (const byte of payload) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(((b << 16) | a) >>> 0, 0);
  const stream = Buffer.concat([
    Buffer.from([0x78, 0x01]),
    Buffer.from(bytes),
    trailer,
  ]);
  // node first: the fixture is valid RFC, or this test says so
  expect(inflateSync(stream)).toEqual(payload);
  expect(rustCas.inflate(stream, payload.length)).toEqual(payload);
});

test("refusals are codes, not crashes: truncation and adler rot", () => {
  const good = deflateSync(Buffer.from("hello world, a real payload"));
  expect(() => rustCas.inflate(good.subarray(0, good.length - 6), 26)).toThrow(
    /inflate refused/u,
  );
  const rotted = Buffer.from(good);
  rotted[rotted.length - 1] ^= 0xff;
  expect(() => rustCas.inflate(rotted, 26)).toThrow(/inflate refused/u);
});

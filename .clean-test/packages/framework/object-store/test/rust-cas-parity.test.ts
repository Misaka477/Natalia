import { beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStore, objectStoreBackendStatus, rustCas } from "../src";

/**
 * T2 Phase A slice 1 — the Rust CAS proves itself against the TS
 * store in BOTH directions plus the hash oracle: NIST vectors, a live
 * diff against node:crypto across the padding boundaries (64-byte
 * block / 56-rem edge — where hand-written SHA-256 lives or dies), a
 * TS-writes/Rust-reads and Rust-writes/TS-reads round trip through the
 * SAME store dir, and the corrupt-object contract identical on both
 * sides (verify-on-read: the address IS the integrity check).
 */

const sha256 = (content: Buffer | string) =>
  createHash("sha256").update(content).digest("hex");

const PADDING_BOUNDARY_LENGTHS = [
  0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 1000, 4096,
];

beforeAll(async () => {
  await rustCas.ensureBuilt();
});

test("the Rust SHA-256 matches the NIST vectors", () => {
  expect(rustCas.sha256Hex("")).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  expect(rustCas.sha256Hex("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(
    rustCas.sha256Hex(
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    ),
  ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  // the 80-byte input whose padding crosses into a second block
  expect(rustCas.sha256Hex("a".repeat(80))).toBe(sha256("a".repeat(80)));
});

test("the Rust hash live-diffs against node:crypto across padding boundaries", () => {
  let seed = 0x9e3779b9;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (const length of PADDING_BOUNDARY_LENGTHS) {
    const bytes = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) bytes[i] = next() & 0xff;
    expect(rustCas.sha256Hex(bytes)).toBe(sha256(bytes));
  }
  // plus pseudo-random sizes to cover unaligned multi-block tails
  for (let round = 0; round < 40; round += 1) {
    const bytes = Buffer.from(
      Array.from({ length: 1 + (next() % 3000) }, () => next() & 0xff),
    );
    expect(rustCas.sha256Hex(bytes)).toBe(sha256(bytes));
  }
});

test("TS writes, Rust reads: identical bytes through one store dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-rust-parity-"));
  const storeRoot = join(root, "objects");
  const objects = new ObjectStore(storeRoot);
  const id = await objects.put("written by the TS implementation");
  expect(rustCas.has(storeRoot, id)).toBe(true);
  expect(rustCas.get(storeRoot, id).toString("utf8")).toBe(
    "written by the TS implementation",
  );
  // the shard path both implementations share
  expect(id).toBe(sha256("written by the TS implementation"));
});

test("Rust writes, TS reads: the TS verify-on-read accepts Rust's bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-rust-write-"));
  const storeRoot = join(root, "objects");
  const objects = new ObjectStore(storeRoot);
  const id = rustCas.put(storeRoot, "written by the Rust implementation");
  expect(id).toBe(sha256("written by the Rust implementation"));
  // TS get() runs verify(): a mismatch would throw — this is the parity
  expect((await objects.get(id)).toString("utf8")).toBe(
    "written by the Rust implementation",
  );
  // dedup: a second put is a no-op returning the same id
  expect(rustCas.put(storeRoot, "written by the Rust implementation")).toBe(id);
  // the shard dir honors the same modes the TS store creates
  const shard = await stat(join(storeRoot, id.slice(0, 2)));
  expect(shard.mode & 0o777).toBe(0o700);
});

test("a corrupt object fails identically on both sides (verify-on-read)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-rust-corrupt-"));
  const storeRoot = join(root, "objects");
  const objects = new ObjectStore(storeRoot);
  const id = await objects.put("honest bytes");
  // rot the content under the address
  await writeFile(join(storeRoot, id.slice(0, 2), id), "rotted bytes!");
  expect(() => objects.get(id)).toThrow(/is corrupt/u);
  expect(() => rustCas.get(storeRoot, id)).toThrow(/is corrupt/u);
  // has() is existence (both sides answer true — put dedups on it too)
  expect(rustCas.has(storeRoot, id)).toBe(true);
});

test("the fallback face: an explicit rust demand with an unusable library degrades to TypeScript honestly", async () => {
  const previousBackend = process.env.NATALIA_OBJECT_STORE_BACKEND;
  const previousLib = process.env.NATALIA_OBJECT_STORE_RUST_LIB;
  process.env.NATALIA_OBJECT_STORE_BACKEND = "rust";
  process.env.NATALIA_OBJECT_STORE_RUST_LIB = join(
    tmpdir(),
    "natalia-no-such-rust-lib.so",
  );
  try {
    // The demand cannot be met -> the STATUS says so (no silent pass,
    // no thrown panic: availability degrades, the answer stays honest).
    expect(objectStoreBackendStatus()).toBe("rust-fallback-typescript");
    // and the store built under that status keeps working, on the TS path
    const root = await mkdtemp(join(tmpdir(), "natalia-fallback-"));
    const storeRoot = join(root, "objects");
    const objects = new ObjectStore(storeRoot);
    const id = await objects.put("written while degraded");
    expect(id).toBe(sha256("written while degraded"));
    expect((await objects.get(id)).toString("utf8")).toBe(
      "written while degraded",
    );
  } finally {
    if (previousBackend === undefined)
      delete process.env.NATALIA_OBJECT_STORE_BACKEND;
    else process.env.NATALIA_OBJECT_STORE_BACKEND = previousBackend;
    if (previousLib === undefined)
      delete process.env.NATALIA_OBJECT_STORE_RUST_LIB;
    else process.env.NATALIA_OBJECT_STORE_RUST_LIB = previousLib;
  }
});

test("the honest default: with no demand the backend is plain TypeScript", () => {
  // The test states the DEFAULT, so it must withdraw the demand for its
  // own observation — asserting "typescript" inside a rust-mode run
  // would test the environment, not the code (the runner's own red).
  const previous = process.env.NATALIA_OBJECT_STORE_BACKEND;
  delete process.env.NATALIA_OBJECT_STORE_BACKEND;
  try {
    expect(objectStoreBackendStatus()).toBe("typescript");
  } finally {
    if (previous !== undefined)
      process.env.NATALIA_OBJECT_STORE_BACKEND = previous;
  }
});

test("slice 3: a chunked big blob lands IDENTICALLY in a TS store and a Rust-mode store", async () => {
  // The same fixture the suite's own chunk test uses (the1 MiB repeating
  // pattern with proven multi-chunk boundaries): under the CDC parity
  // the split must produce the same chunk ids, hence the same manifest,
  // hence the same manifestId — boundary parity proven through the
  // PUBLIC API, no private access.
  const text = "0123456789abcdef".repeat(64 * 1024); // 1 MiB
  const previous = process.env.NATALIA_OBJECT_STORE_BACKEND;
  delete process.env.NATALIA_OBJECT_STORE_BACKEND;
  const tsRoot = await mkdtemp(join(tmpdir(), "natalia-chunk-ts-"));
  const tsStore = new ObjectStore(join(tsRoot, "objects"));
  try {
    const tsId = await tsStore.put(text);
    const tsMeta = await tsStore.getMeta<{
      manifestId: string;
      chunks: string[];
    }>(`chunked:${tsId}`);
    expect(tsMeta).toBeDefined(); // >1 chunk by construction (the suite's own fixture)

    process.env.NATALIA_OBJECT_STORE_BACKEND = "rust";
    const rustRoot = await mkdtemp(join(tmpdir(), "natalia-chunk-rs-"));
    const rustStore = new ObjectStore(join(rustRoot, "objects"));
    expect(objectStoreBackendStatus()).toBe("rust");
    const rustId = await rustStore.put(text);
    const rustMeta = await rustStore.getMeta<{
      manifestId: string;
      chunks: string[];
    }>(`chunked:${rustId}`);

    // byte-for-byte identity of the chunk map (the CDC boundary rule
    // ported bit-exactly): same id, same manifest id, same chunk list
    expect(rustId).toBe(tsId);
    expect(rustMeta).toEqual(tsMeta!);
    // and the Rust-mode store round-trips and streams the content whole
    expect((await rustStore.get(rustId)).toString("utf8")).toBe(text);
    let streamed = 0;
    for await (const chunk of rustStore.getStream(rustId))
      streamed += chunk.byteLength;
    expect(streamed).toBe(text.length);
  } finally {
    if (previous === undefined) delete process.env.NATALIA_OBJECT_STORE_BACKEND;
    else process.env.NATALIA_OBJECT_STORE_BACKEND = previous;
  }
});

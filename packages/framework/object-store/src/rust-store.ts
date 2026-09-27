import { dlopen, FFIType, ptr as ffiPtr } from "bun:ffi";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * T2 Phase A (object-store-rust plan) — the bun:ffi face of the Rust
 * CAS core. `root` is the ObjectStore's own root (shards = first two
 * hex chars), so both implementations address identical paths.
 *
 * The crate is deliberately ZERO-DEPENDENCY: this sandbox's cargo home
 * is fresh per invocation, so a registry dependency would re-download
 * every build. The loader self-heals — it builds the cdylib when it is
 * missing OR older than any crate source (the ast-pack SKIP rule's
 * freshness shape), so tests and the chain never depend on a manual
 * step.
 */

// src -> object-store -> hosts -> packages (the crate sits at native/)
/**
 * The backend a store should use (the object-store-rust plan's "TS
 * keeps its implementation as the fallback"):
 *  - default: TypeScript (nothing to decide, nothing to break);
 *  - `NATALIA_OBJECT_STORE_BACKEND=rust`: an EXPLICIT demand — used by
 *    the mode runner, which treats an unavailable backend as a FAILURE
 *    (a requested mode that silently didn't engage would make its
 *    acceptance run a lie). In ordinary code the demand degrades to
 *    TypeScript by the same rule: availability never beats honesty.
 * `NATALIA_OBJECT_STORE_RUST_LIB` overrides the library path (tests
 * force the fallback with a broken path).
 */
let configuredImpl: "typescript" | "rust" | undefined;

/**
 * The composition row's selection (decision17): the DATA picks the
 * factory; the wire applies it at boot and on every profile reload.
 * `undefined` unsets (a test restoring its own demand). Precedence,
 * highest first: the env seam (the mode runner's explicit demand and
 * the ops escape hatch) -> this configured selection -> TypeScript.
 */
export function configureObjectStoreBackend(
  impl: "typescript" | "rust" | undefined,
): void {
  configuredImpl = impl;
}

export function objectStoreBackendStatus():
  | "typescript"
  | "rust"
  | "rust-fallback-typescript" {
  const demand =
    process.env.NATALIA_OBJECT_STORE_BACKEND === "rust"
      ? "rust"
      : (configuredImpl ?? "typescript");
  if (demand !== "rust") return "typescript";
  const previous = LIB_PATH;
  const override = process.env.NATALIA_OBJECT_STORE_RUST_LIB;
  if (override) LIB_PATH = override;
  try {
    load();
    return "rust";
  } catch {
    return "rust-fallback-typescript";
  } finally {
    LIB_PATH = previous;
  }
}

// The native CAS core lives beside its sibling (native-index) under the
// package that owns it — the confinement precedent. It used to sit at
// packages/object-store-rust, a root directory that conformed to no
// layer; the architecture assigns the store to the engine, and a native
// module belongs to its owning package.
const CRATE_DIR = resolve(import.meta.dir, "..", "native");
let LIB_PATH = join(
  CRATE_DIR,
  "target",
  "release",
  "libnatalia_object_store.so",
);

type RustCasLib = {
  symbols: {
    cas_sha256_hex: (data: unknown, dataLen: number, out: unknown) => number;
    cas_put: (
      root: unknown,
      rootLen: number,
      data: unknown,
      dataLen: number,
      out: unknown,
    ) => number;
    cas_has: (
      root: unknown,
      rootLen: number,
      id: unknown,
      idLen: number,
    ) => number;
    cas_get_size: (
      root: unknown,
      rootLen: number,
      id: unknown,
      idLen: number,
    ) => number;
    zlib_inflate: (
      z: unknown,
      zLen: number,
      out: unknown,
      outCap: number,
    ) => number;
    zlib_deflate: (
      data: unknown,
      dataLen: number,
      out: unknown,
      outCap: number,
    ) => number;
    zlib_deflate_bound: (dataLen: number) => number;
    zlib_inflate_max: (zLen: number) => number;
    pack_frame: (
      input: unknown,
      inputLen: number,
      out: unknown,
      outCap: number,
    ) => number;
    pack_frame_bound: (inputLen: number) => number;
    cas_put_chunked: (
      root: unknown,
      rootLen: number,
      data: unknown,
      dataLen: number,
      out: unknown,
    ) => number;
    cas_get: (
      root: unknown,
      rootLen: number,
      id: unknown,
      idLen: number,
      out: unknown,
      outCap: number,
    ) => number;
  };
};

let lib: RustCasLib | undefined;
// Memo KEYED BY PATH: a store/test that probes an overridden library
// path (the fallback face) must get THAT answer, not a handle loaded
// from another path — and a throwing probe never memoizes failure.
let loadedPath: string | undefined;

async function newestSourceTime(): Promise<number> {
  let newest = 0;
  for (const name of await readdir(join(CRATE_DIR, "src"))) {
    const time = statSync(join(CRATE_DIR, "src", name)).mtimeMs;
    if (time > newest) newest = time;
  }
  const cargoTime = statSync(join(CRATE_DIR, "Cargo.toml")).mtimeMs;
  return Math.max(newest, cargoTime);
}

async function buildIfStale(): Promise<void> {
  const built = existsSync(LIB_PATH) ? statSync(LIB_PATH).mtimeMs : 0;
  if (built && built > (await newestSourceTime())) return;
  const result = spawnSync("cargo", ["build", "--release"], {
    cwd: CRATE_DIR,
    env: {
      ...process.env,
      // ~/.cargo is read-only here (the same family as ~/.npm): a /tmp
      // cargo home keeps the build writable, and a std-only crate means
      // nothing is ever fetched into it.
      CARGO_HOME: process.env.CARGO_HOME ?? "/tmp/natalia-cargo",
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error)
    throw new Error(
      `object-store-rust build could not start (cargo): ${result.error.message} (cwd ${CRATE_DIR})`,
    );
  if (result.status !== 0)
    throw new Error(
      `object-store-rust build failed (cargo exit ${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
}

function load(): RustCasLib {
  if (lib && loadedPath === LIB_PATH) return lib;
  const loaded = dlopen(LIB_PATH, {
    cas_sha256_hex: {
      args: [FFIType.pointer, FFIType.u64, FFIType.pointer],
      returns: FFIType.int,
    },
    cas_put: {
      args: [
        FFIType.pointer,
        FFIType.u64,
        FFIType.pointer,
        FFIType.u64,
        FFIType.pointer,
      ],
      returns: FFIType.int,
    },
    cas_has: {
      args: [FFIType.pointer, FFIType.u64, FFIType.pointer, FFIType.u64],
      returns: FFIType.int,
    },
    cas_get_size: {
      args: [FFIType.pointer, FFIType.u64, FFIType.pointer, FFIType.u64],
      returns: FFIType.i64,
    },
    zlib_inflate: {
      args: [FFIType.pointer, FFIType.u64, FFIType.pointer, FFIType.u64],
      returns: FFIType.i64,
    },
    zlib_deflate: {
      args: [FFIType.pointer, FFIType.u64, FFIType.pointer, FFIType.u64],
      returns: FFIType.i64,
    },
    zlib_deflate_bound: { args: [FFIType.u64], returns: FFIType.i64 },
    zlib_inflate_max: { args: [FFIType.u64], returns: FFIType.i64 },
    pack_frame: {
      args: [FFIType.pointer, FFIType.u64, FFIType.pointer, FFIType.u64],
      returns: FFIType.i64,
    },
    pack_frame_bound: { args: [FFIType.u64], returns: FFIType.i64 },
    cas_put_chunked: {
      args: [
        FFIType.pointer,
        FFIType.u64,
        FFIType.pointer,
        FFIType.u64,
        FFIType.pointer,
      ],
      returns: FFIType.i64,
    },
    cas_get: {
      args: [
        FFIType.pointer,
        FFIType.u64,
        FFIType.pointer,
        FFIType.u64,
        FFIType.pointer,
        FFIType.u64,
      ],
      returns: FFIType.i64,
    },
  }) as unknown as RustCasLib;
  lib = loaded;
  loadedPath = LIB_PATH;
  return loaded;
}

const enc = (text: string) => Buffer.from(text, "utf8");
// An empty Buffer has no address ffiPtr can take: the Rust side treats
// null+0 as an empty slice (the NIST empty-string vector travels here).
const bptr = (bytes: Buffer | Uint8Array): unknown =>
  bytes.byteLength === 0 ? null : ffiPtr(bytes);
const hex = (out: Buffer) => out.toString("utf8");

export const rustCas = {
  async ensureBuilt(): Promise<void> {
    await buildIfStale();
  },
  available(): boolean {
    return existsSync(LIB_PATH);
  },
  sha256Hex(data: Buffer | string): string {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const out = Buffer.alloc(64);
    const code = load().symbols.cas_sha256_hex(
      bptr(bytes),
      bytes.byteLength,
      bptr(out),
    );
    if (code !== 0) throw new Error(`cas_sha256_hex failed: ${code}`);
    return hex(out);
  },
  /**
   * Slice 3: the content-defined split + chunk/manifest writes in one
   * call (the manifest id arrives via the fixed 64-byte out buffer;
   * the RETURN is the chunk count — 0 = single chunk, nothing was
   * written and the caller falls through to the plain put).
   */
  putChunked(
    root: string,
    data: Buffer | string,
  ): {
    chunkCount: number;
    manifestId?: string;
  } {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const rootBuf = enc(root);
    const out = Buffer.alloc(64);
    const count = Number(
      load().symbols.cas_put_chunked(
        ffiPtr(rootBuf),
        rootBuf.byteLength,
        bptr(bytes),
        bytes.byteLength,
        bptr(out),
      ),
    );
    if (count < 0) throw new Error(`cas_put_chunked failed: ${count}`);
    return count > 0
      ? { chunkCount: count, manifestId: out.toString("utf8") }
      : { chunkCount: 0 };
  },

  put(root: string, data: Buffer | string): string {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const rootBuf = enc(root);
    const out = Buffer.alloc(64);
    const code = load().symbols.cas_put(
      ffiPtr(rootBuf),
      rootBuf.byteLength,
      bptr(bytes),
      bytes.byteLength,
      bptr(out),
    );
    if (code !== 0) throw new Error(`cas_put failed: ${code}`);
    return hex(out);
  },
  /**
   * Slice 4a: RFC1950 inflate (all three block types), adler-verified
   * — a rotted record is an error, never silently wrong bytes.
   * `expectedLength` is what a `.idx` record already knows (origLen),
   * so nothing ever decodes twice.
   */
  inflate(stream: Uint8Array, expectedLength: number): Buffer {
    const out = Buffer.alloc(expectedLength);
    const written = Number(
      load().symbols.zlib_inflate(
        bptr(stream),
        stream.byteLength,
        bptr(out),
        out.byteLength,
      ),
    );
    if (written < 0)
      throw new Error(
        `inflate refused (${written}) — malformed stream or adler mismatch`,
      );
    if (written !== expectedLength)
      throw new Error(`inflate wrote ${written}, expected ${expectedLength}`);
    return out;
  },

  /**
   * Slice 4a: a zlib-wrapped STORED-block stream any reader accepts
   * (node's inflateSync is the standing oracle). A dynamic-Huffman
   * encoder is a later optimization the format needs no signature for
   * — and the delta record choice is what carries most of a pack's
   * size win anyway.
   */
  deflate(data: Uint8Array): Buffer {
    const bound = Number(load().symbols.zlib_deflate_bound(data.byteLength));
    const out = Buffer.alloc(bound);
    const written = Number(
      load().symbols.zlib_deflate(
        bptr(data),
        data.byteLength,
        bptr(out),
        out.byteLength,
      ),
    );
    if (written < 0) throw new Error(`deflate refused (${written})`);
    return out.subarray(0, written);
  },

  /**
   * Slice 4b-α: the pack + NDX1 index BYTES for an ordered entry list
   * (the TS side owns fs and order — listLoose's readdir order passes
   * through). One call, closed-form capacity (the slice-4a sizing
   * lesson): {packLen, pack, idxLen, idx} concatenated out.
   */
  compactFrame(entries: ReadonlyArray<{ id: string; data: Buffer }>): {
    pack: Buffer;
    idx: Buffer;
  } {
    const chunks: Buffer[] = [Buffer.alloc(4)];
    chunks[0]!.writeUInt32LE(entries.length, 0);
    for (const entry of entries) {
      const idBuf = Buffer.from(entry.id, "utf8");
      const idLen = Buffer.alloc(4);
      idLen.writeUInt32LE(idBuf.byteLength, 0);
      const dataLen = Buffer.alloc(4);
      dataLen.writeUInt32LE(entry.data.byteLength, 0);
      chunks.push(idLen, idBuf, dataLen, entry.data);
    }
    const input = Buffer.concat(chunks);
    const bound = Number(load().symbols.pack_frame_bound(input.byteLength));
    const out = Buffer.alloc(bound);
    const written = Number(
      load().symbols.pack_frame(
        bptr(input),
        input.byteLength,
        bptr(out),
        out.byteLength,
      ),
    );
    if (written < 0) throw new Error(`pack_frame refused (${written})`);
    const view = out.subarray(0, written);
    const packLen = view.readUInt32LE(0);
    const pack = view.subarray(4, 4 + packLen);
    const idxLen = view.readUInt32LE(4 + packLen);
    const idx = view.subarray(8 + packLen, 8 + packLen + idxLen);
    return { pack: Buffer.from(pack), idx: Buffer.from(idx) };
  },

  has(root: string, id: string): boolean {
    const rootBuf = enc(root);
    const idBuf = enc(id);
    return (
      load().symbols.cas_has(
        ffiPtr(rootBuf),
        rootBuf.byteLength,
        ffiPtr(idBuf),
        idBuf.byteLength,
      ) === 1
    );
  },
  getSize(root: string, id: string): number {
    const rootBuf = enc(root);
    const idBuf = enc(id);
    // bun:ffi returns i64 as BigInt by design; the sizes a store
    // object can carry fit a Number exactly (the chunk ceiling is 1 MiB).
    return Number(
      load().symbols.cas_get_size(
        ffiPtr(rootBuf),
        rootBuf.byteLength,
        ffiPtr(idBuf),
        idBuf.byteLength,
      ),
    );
  },
  get(root: string, id: string): Buffer {
    const rootBuf = enc(root);
    const idBuf = enc(id);
    const size = rustCas.getSize(root, id);
    if (size < 0) throw new Error(`object ${id} not found`);
    const out = Buffer.alloc(size);
    const written = Number(
      load().symbols.cas_get(
        ffiPtr(rootBuf),
        rootBuf.byteLength,
        ffiPtr(idBuf),
        idBuf.byteLength,
        bptr(out),
        out.byteLength,
      ),
    );
    if (written === 1) throw new Error(`object ${id} is corrupt`);
    if (written === 3) throw new Error(`object ${id}: capacity ${size}`);
    if (written < 0) throw new Error(`object ${id} unreadable (${written})`);
    return out.subarray(0, written);
  },
};

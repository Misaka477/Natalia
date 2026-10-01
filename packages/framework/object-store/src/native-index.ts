import { dlopen, FFIType, ptr as ffiPtr } from "bun:ffi";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type NativeIndexEntry = {
  offset: number;
  dataOffset: number;
  origLen: number;
  compLen: number;
  kind: number;
  deltaLen: number;
  /** A delta entry's base id — a kind-1 entry cannot be read without it. */
  baseId?: string;
};

type NativeLib = {
  symbols: {
    // The cstring parameters take the ENCODED form: bun's FFI rejects a raw
    // JS string for a cstring argument at runtime ("To convert a string to
    // a pointer, encode it as a buffer"), even though its types say string.
    native_index_load: (path: Uint8Array) => unknown;
    native_index_find: (handle: unknown, id: Uint8Array, out: unknown) => number;
    native_index_free: (handle: unknown) => void;
    native_index_open_dir: (path: Uint8Array) => unknown;
    native_index_find_dir: (
      handle: unknown,
      id: Uint8Array,
      out: unknown,
    ) => number;
    native_index_table_count: (handle: unknown) => number;
    native_index_free_dir: (handle: unknown) => void;
  };
};

let lib: NativeLib | undefined;
let libAttempted = false;

function candidatePaths(): string[] {
  const dir = import.meta.dir;
  const base = "native-index/target/release";
  // MSVC cdylib naming (`natalia_index_native.dll`) has no `lib` prefix.
  const libName =
    process.platform === "win32"
      ? "natalia_index_native.dll"
      : "libnatalia_index_native.so";
  return [
    resolve(dir, "..", base, libName),
    resolve(dir, "..", "..", base, libName),
    resolve(
      process.cwd(),
      "packages",
      "hosts",
      "object-store",
      base,
      libName
    ),
  ];
}

function loadLib(): NativeLib | undefined {
  if (libAttempted) return lib;
  libAttempted = true;
  for (const path of candidatePaths()) {
    if (!existsSync(path)) continue;
    try {
      lib = dlopen(path, {
        native_index_load: {
          args: [FFIType.cstring],
          returns: FFIType.pointer,
        },
        native_index_find: {
          args: [FFIType.pointer, FFIType.cstring, FFIType.pointer],
          returns: FFIType.int,
        },
        native_index_free: {
          args: [FFIType.pointer],
          returns: FFIType.void,
        },
        native_index_open_dir: {
          args: [FFIType.cstring],
          returns: FFIType.pointer,
        },
        native_index_find_dir: {
          args: [FFIType.pointer, FFIType.cstring, FFIType.pointer],
          returns: FFIType.int,
        },
        native_index_table_count: {
          args: [FFIType.pointer],
          returns: FFIType.int,
        },
        native_index_free_dir: {
          args: [FFIType.pointer],
          returns: FFIType.void,
        },
      }) as unknown as NativeLib;
      return lib;
    } catch {
      lib = undefined;
    }
  }
  return undefined;
}

/**
 * A NUL-terminated utf8 buffer for a `cstring` FFI argument. bun's FFI takes
 * the encoded buffer for cstring args — a bare JS string is rejected with
 * "To convert a string to a pointer, encode it as a buffer".
 */
function cstr(value: string): Uint8Array {
  const bytes = Buffer.from(value, "utf8");
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes, 0);
  return out;
}

export class NativePackIndex {
  private handle: unknown;
  constructor(path: string) {
    const loaded = loadLib();
    if (!loaded) throw new Error("native index library unavailable");
    const handle = loaded.symbols.native_index_load(cstr(path));
    if (!handle) throw new Error("native index load failed");
    this.handle = handle;
  }

  find(id: string): NativeIndexEntry | undefined {
    const loaded = loadLib();
    if (!loaded) return undefined;
    const out = Buffer.alloc(24); // repr(C): 4*u32 + u8 + padding + u32
    const outPtr = ffiPtr(out);
    const found = loaded.symbols.native_index_find(
      this.handle,
      cstr(id),
      outPtr,
    );
    if (!found) return undefined;
    return {
      offset: out.readUInt32LE(0),
      dataOffset: out.readUInt32LE(4),
      origLen: out.readUInt32LE(8),
      compLen: out.readUInt32LE(12),
      kind: out[16],
      deltaLen: out.readUInt32LE(20),
    };
  }

  free(): void {
    const loaded = loadLib();
    if (!loaded) return;
    loaded.symbols.native_index_free(this.handle);
  }
}

export function nativePackIndexAvailable(): boolean {
  return loadLib() !== undefined;
}

/** A table hit: which pack answered, and its record fields. */
export type NativeTableHit = {
  pack: number;
} & NativeIndexEntry;

/**
 * The Phase B multi-pack table: one handle over every `.idx` in a
 * directory, a find running each pack's binary search. The daemon's
 * lookup faces many packs; this is the face. An indexless directory
 * opens with zero packs (find answers undefined, never throws), and a
 * missing directory refuses exactly like the single-index path.
 */
export class NativePackIndexSet {
  private handle: unknown;
  constructor(dir: string) {
    const loaded = loadLib();
    if (!loaded) throw new Error("native index library unavailable");
    const handle = loaded.symbols.native_index_open_dir(cstr(dir));
    if (!handle) throw new Error("native index table open failed");
    this.handle = handle;
  }

  /** How many pack indexes the table holds. */
  count(): number {
    const loaded = loadLib();
    return loaded ? loaded.symbols.native_index_table_count(this.handle) : 0;
  }

  find(id: string): NativeTableHit | undefined {
    const loaded = loadLib();
    if (!loaded) return undefined;
    // repr(C): u32 pack, then the entry (u32x6 + kind + delta_len), then
    // the delta base as a fixed 64-byte array plus its length (an id is
    // 64 hex characters). A kind-1 hit without its base is unreadable.
    const out = Buffer.alloc(28 + 64 + 4);
    const outPtr = ffiPtr(out);
    const found = loaded.symbols.native_index_find_dir(
      this.handle,
      cstr(id),
      outPtr,
    );
    if (!found) return undefined;
    const baseLen = out.readUInt32LE(92);
    const baseId =
      baseLen > 0 ? out.toString("utf8", 28, 28 + baseLen) : undefined;
    return {
      pack: out.readUInt32LE(0),
      offset: out.readUInt32LE(4),
      dataOffset: out.readUInt32LE(8),
      origLen: out.readUInt32LE(12),
      compLen: out.readUInt32LE(16),
      kind: out[20],
      deltaLen: out.readUInt32LE(24),
      ...(baseId ? { baseId } : {}),
    };
  }

  free(): void {
    const loaded = loadLib();
    if (loaded) loaded.symbols.native_index_free_dir(this.handle);
  }
}

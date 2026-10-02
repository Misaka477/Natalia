export type WasmDiffResult = {
  patch?: string;
  additions: number;
  deletions: number;
};

export type DiffLineType = "context" | "add" | "delete" | "hunk";

export type StructuredDiffWordRange = {
  start: number;
  end: number;
  kind: "added" | "deleted";
};

export type StructuredDiffLine = {
  type: DiffLineType;
  text: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  wordRanges?: StructuredDiffWordRange[];
  /** Optional worker-computed lightweight syntax tokens. */
  syntaxParts?: Array<{ text: string; cls: string }>;
};

export type StructuredDiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: StructuredDiffLine[];
};

export type StructuredDiffResult = {
  hunks: StructuredDiffHunk[];
  additions: number;
  deletions: number;
  patch?: string;
};

type WasmExports = {
  memory: WebAssembly.Memory;
  wasm_alloc(len: number): number;
  wasm_dealloc(ptr: number, len: number): void;
  wasm_diff(
    oldPtr: number,
    oldLen: number,
    newPtr: number,
    newLen: number,
    outLenPtr: number,
  ): number;
  wasm_diff_structured(
    oldPtr: number,
    oldLen: number,
    newPtr: number,
    newLen: number,
    ignoreWhitespace: number,
    outLenPtr: number,
  ): number;
};

let engine: WasmExports | undefined;
let enginePromise: Promise<WasmExports> | undefined;

function allocString(
  exports: WasmExports,
  text: string,
): { ptr: number; len: number } {
  const bytes = new TextEncoder().encode(text);
  const ptr = exports.wasm_alloc(bytes.length);
  if (!ptr) throw new Error("wasm alloc failed");
  new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
  return { ptr, len: bytes.length };
}

function freeInputs(
  exports: WasmExports,
  old: { ptr: number; len: number },
  new_: { ptr: number; len: number },
  outLenPtr: number,
) {
  exports.wasm_dealloc(old.ptr, old.len);
  exports.wasm_dealloc(new_.ptr, new_.len);
  exports.wasm_dealloc(outLenPtr, 8);
}

async function withWasm(
  oldText: string,
  newText: string,
  run: (
    exports: WasmExports,
    old: { ptr: number; len: number },
    new_: { ptr: number; len: number },
    outLenPtr: number,
  ) => void,
): Promise<void> {
  const exports = await loadWasmDiff();
  const old = allocString(exports, oldText);
  const new_ = allocString(exports, newText);
  const outLenPtr = exports.wasm_alloc(8);
  try {
    run(exports, old, new_, outLenPtr);
  } finally {
    freeInputs(exports, old, new_, outLenPtr);
  }
}

export async function loadWasmDiff(): Promise<WasmExports> {
  if (engine) return engine;
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const url = new URL("./natalia_diff_wasm.wasm", import.meta.url);
    try {
      const source = await fetch(url);
      const module = await WebAssembly.instantiateStreaming(source, {});
      return module.instance.exports as unknown as WasmExports;
    } catch {
      // Node/Bun fallback: read the wasm from disk directly.
      const { readFile } = await import("node:fs/promises");
      const { fileURLToPath } = await import("node:url");
      const bytes = await readFile(fileURLToPath(url));
      const module = await WebAssembly.instantiate(bytes, {});
      return module.instance.exports as unknown as WasmExports;
    }
  })();
  engine = await enginePromise;
  return engine;
}

export async function diffWasm(
  oldText: string,
  newText: string,
): Promise<WasmDiffResult> {
  let patch = "";
  let additions = 0;
  let deletions = 0;
  await withWasm(oldText, newText, (exports, old, new_, outLenPtr) => {
    const patchPtr = exports.wasm_diff(
      old.ptr,
      old.len,
      new_.ptr,
      new_.len,
      outLenPtr,
    );
    const outLen = new DataView(exports.memory.buffer, outLenPtr, 8).getUint32(
      0,
      true,
    );
    const length = Number(outLen);
    patch = new TextDecoder().decode(
      new Uint8Array(exports.memory.buffer, patchPtr, length),
    );
    if (patchPtr && length) exports.wasm_dealloc(patchPtr, length);
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
  });
  return { patch, additions, deletions };
}

const DIFF_BINARY_HEADER_SIZE = 48;
const DIFF_HUNK_RECORD_SIZE = 20;
const DIFF_LINE_RECORD_SIZE = 20;
const LINE_NONE = 0xffffffff;

/**
 * Decode the compact binary format produced by `wasm_diff_structured`.
 *
 * The binary contains the original old/new text blobs followed by hunk and
 * line records. Line text is reconstructed by line number from the decoded
 * full text, so no per-line string copies are necessary on the wire.
 */
export function parseDiffBinary(
  binary: ArrayBuffer | Uint8Array,
): StructuredDiffResult {
  const bytes = binary instanceof Uint8Array ? binary : new Uint8Array(binary);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = view.getUint32(0, true);
  if (magic !== 0x4e444946)
    throw new Error(`invalid diff binary magic: 0x${magic.toString(16)}`);
  const version = view.getUint32(4, true);
  if (version !== 1 && version !== 2)
    throw new Error(`unsupported diff binary version: ${version}`);

  const hunkCount = view.getUint32(8, true);
  const lineOpCount = view.getUint32(12, true);
  const additions = view.getUint32(16, true);
  const deletions = view.getUint32(20, true);
  const wordRangeCount = view.getUint32(24, true);
  const lineOpsOffset = view.getUint32(28, true);
  const textsOffset = view.getUint32(32, true);
  const textsLen = view.getUint32(36, true);
  const wordRangesOffset = view.getUint32(40, true);

  const textsBytes = bytes.subarray(textsOffset, textsOffset + textsLen);

  const hunkStart = 48;
  const hunks: StructuredDiffHunk[] = [];
  const lines: StructuredDiffLine[] = [];
  const WORD_RANGE_SIZE = 16;

  for (let i = 0; i < lineOpCount; i++) {
    const offset = lineOpsOffset + i * DIFF_LINE_RECORD_SIZE;
    const kind = view.getUint32(offset, true);
    const oldLineRaw = view.getUint32(offset + 4, true);
    const newLineRaw = view.getUint32(offset + 8, true);
    const oldLineNumber = oldLineRaw === LINE_NONE ? null : oldLineRaw;
    const newLineNumber = newLineRaw === LINE_NONE ? null : newLineRaw;
    const type: DiffLineType =
      kind === 1 ? "add" : kind === 2 ? "delete" : "context";
    const textOffset = view.getUint32(offset + 12, true);
    const textLen = view.getUint32(offset + 16, true);
    const text = new TextDecoder().decode(
      textsBytes.subarray(textOffset, textOffset + textLen),
    );
    lines.push({ type, text, oldLineNumber, newLineNumber });
  }

  for (let i = 0; i < wordRangeCount; i++) {
    const offset = wordRangesOffset + i * WORD_RANGE_SIZE;
    const lineIndex = view.getUint32(offset, true);
    const kind = view.getUint8(offset + 4);
    const start = view.getUint32(offset + 5, true);
    const end = view.getUint32(offset + 9, true);
    if (lineIndex < lineOpCount) {
      lines[lineIndex]!.wordRanges ??= [];
      lines[lineIndex]!.wordRanges!.push({
        start,
        end,
        kind: kind === 1 ? "added" : "deleted",
      });
    }
  }

  let cursor = 0;
  for (let i = 0; i < hunkCount; i++) {
    const offset = hunkStart + i * DIFF_HUNK_RECORD_SIZE;
    const lineCount = view.getUint32(offset + 16, true);
    hunks.push({
      oldStart: view.getUint32(offset, true),
      oldCount: view.getUint32(offset + 4, true),
      newStart: view.getUint32(offset + 8, true),
      newCount: view.getUint32(offset + 12, true),
      lines: lines.slice(cursor, cursor + lineCount),
    });
    cursor += lineCount;
  }

  return { hunks, additions, deletions };
}

/**
 * Returns the raw compact DiffBinary buffer produced by Rust/WASM.
 * This is the hot-path transport representation; callers may keep it as
 * ArrayBuffer or decode it with `parseDiffBinary`.
 */
export async function diffWasmBinary(
  oldText: string,
  newText: string,
  options?: { ignoreWhitespace?: boolean },
): Promise<Uint8Array> {
  let binary = new Uint8Array(0);
  await withWasm(oldText, newText, (exports, old, new_, outLenPtr) => {
    const diffPtr = exports.wasm_diff_structured(
      old.ptr,
      old.len,
      new_.ptr,
      new_.len,
      options?.ignoreWhitespace ? 1 : 0,
      outLenPtr,
    );
    const outLen = new DataView(exports.memory.buffer, outLenPtr, 8).getUint32(
      0,
      true,
    );
    const len = Number(outLen);
    if (!len) return;
    binary = new Uint8Array(
      exports.memory.buffer.slice(diffPtr, diffPtr + len),
    );
    if (diffPtr && len) exports.wasm_dealloc(diffPtr, len);
  });
  return binary;
}

export async function diffWasmStructured(
  oldText: string,
  newText: string,
  options?: { ignoreWhitespace?: boolean },
): Promise<StructuredDiffResult> {
  const binary = await diffWasmBinary(oldText, newText, options);
  return parseDiffBinary(binary);
}

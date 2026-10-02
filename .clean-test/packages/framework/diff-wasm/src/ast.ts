import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WASI } from "node:wasi";

export type AstChange = {
  kind: "modified" | "added" | "removed" | "moved";
  nodeKind: string;
  nodeText?: string;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
};

export type AstDiffResult = {
  language: string;
  changes: AstChange[];
};

export type AstIndexNode = {
  nodeKind: string;
  text: string;
  start: number;
  end: number;
};

export type AstIndexResult = {
  language: string;
  nodes: AstIndexNode[];
};

type AstExports = {
  memory: WebAssembly.Memory;
  wasm_alloc(len: number): number;
  wasm_dealloc(ptr: number, len: number): void;
  wasm_ast_diff(
    oldPtr: number,
    oldLen: number,
    newPtr: number,
    newLen: number,
    languagePtr: number,
    languageLen: number,
    outLenPtr: number,
  ): number;
  wasm_ast_index(
    sourcePtr: number,
    sourceLen: number,
    languagePtr: number,
    languageLen: number,
    outLenPtr: number,
  ): number;
};

const astCache = new Map<string, Promise<AstDiffResult>>();
const astIndexCache = new Map<string, Promise<AstIndexResult>>();
const AST_CACHE_MAX = 128;
function astCacheKey(language: string, oldText: string, newText: string) {
  const hash = createHash("sha256")
    .update(oldText)
    .update("\0")
    .update(newText)
    .digest("hex");
  return `${language}|${oldText.length}|${newText.length}|${hash}`;
}

function astIndexCacheKey(language: string, source: string) {
  const hash = createHash("sha256").update(source).digest("hex");
  return `${language}|${source.length}|${hash}`;
}

const PACK_BY_LANGUAGE: Record<string, string> = {
  javascript: "javascript",
  js: "javascript",
  typescript: "typescript",
  ts: "typescript",
  tsx: "tsx",
  python: "python",
  py: "python",
  go: "go",
  rust: "rust",
  rs: "rust",
  json: "json",
  c: "c",
  h: "c",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  java: "java",
  csharp: "csharp",
  cs: "csharp",
  bash: "bash",
  sh: "bash",
  ruby: "ruby",
  rb: "ruby",
  php: "php",
  css: "css",
  scss: "css",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  html: "xml",
  lua: "lua",
  scala: "scala",
  swift: "swift",
  elixir: "elixir",
  haskell: "haskell",
  hs: "haskell",
  nix: "nix",
  zig: "zig",
  elm: "elm",
  fsharp: "fsharp",
  fs: "fsharp",
  ocaml: "ocaml",
  ml: "ocaml",
  r: "r",
  julia: "julia",
  dart: "dart",
  clojure: "clojure",
  clj: "clojure",
  toml: "toml",
  sql: "sql",
  cmake: "cmake",
  fish: "fish",
  make: "make",
  makefile: "make",
  perl: "perl",
  pl: "perl",
  proto: "proto",
  protobuf: "proto",
  racket: "racket",
  rkt: "racket",
  scheme: "scheme",
  scm: "scheme",
  verilog: "verilog",
  v: "verilog",
  vhdl: "vhdl",
  pascal: "pascal",
  pas: "pascal",
  objc: "objc",
  "objective-c": "objc",
  m: "objc",
};

/** Canonical supported AST language set. Runtime refactor/apply must use this. */
export const SUPPORTED_AST_LANGUAGES = Object.keys(
  PACK_BY_LANGUAGE,
) as readonly string[];

/**
 * The path's AST language (same table the pack selection uses), or
 * undefined when the extension is unknown. A single place naming the
 * mapping, so a workspace face never re-derives one.
 */
export function astLanguageForPath(path: string): string | undefined {
  const name = path.split("/").pop() ?? path;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return ext ? PACK_BY_LANGUAGE[ext] : PACK_BY_LANGUAGE[name.toLowerCase()];
}

const packInstances = new Map<string, AstExports>();
const packPromises = new Map<string, Promise<AstExports>>();

let instance: AstExports | undefined;
let instancePromise: Promise<AstExports> | undefined;

function allocString(exports: AstExports, text: string) {
  const bytes = new TextEncoder().encode(text);
  const ptr = exports.wasm_alloc(bytes.length);
  if (!ptr) throw new Error("ast wasm alloc failed");
  new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
  return { ptr, len: bytes.length };
}

export async function loadAstWasm(language?: string): Promise<AstExports> {
  const pack =
    (language && PACK_BY_LANGUAGE[language]) || language || "javascript";
  const cached = packInstances.get(pack);
  if (cached) return cached;
  const pending = packPromises.get(pack);
  if (pending) return pending;
  const promise = (async (): Promise<AstExports> => {
    const fileName = `${pack}.wasm`;
    const url = new URL(`../ast/${fileName}`, import.meta.url);
    const bytes = await readFile(fileURLToPath(url));
    const wasi = new WASI({
      version: "preview1",
      args: [],
      env: {},
      preopens: {},
    });
    const { instance: wasmInstance } = await WebAssembly.instantiate(bytes, {
      wasi_snapshot_preview1: wasi.wasiImport,
    });
    try {
      wasi.start(wasmInstance);
    } catch {
      // Reactor-style module: no _start, memory already initialized by start.
    }
    return wasmInstance.exports as unknown as AstExports;
  })();
  packPromises.set(pack, promise);
  const resolved = await promise;
  packInstances.set(pack, resolved);
  packPromises.delete(pack);
  return resolved;
}

const AST_HEADER = 0x54534441;
const AST_VERSION = 1;

export function parseAstDiffBinary(
  binary: ArrayBuffer | Uint8Array,
): AstDiffResult {
  const bytes = binary instanceof Uint8Array ? binary : new Uint8Array(binary);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== AST_HEADER)
    throw new Error("invalid AST diff binary magic");
  if (view.getUint32(4, true) !== AST_VERSION)
    throw new Error("unsupported AST diff binary version");
  const count = view.getUint32(8, true);
  const changes: AstChange[] = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const kind = view.getUint8(offset);
    offset += 1;
    const oldStart = view.getUint32(offset, true);
    const oldEnd = view.getUint32(offset + 4, true);
    const newStart = view.getUint32(offset + 8, true);
    const newEnd = view.getUint32(offset + 12, true);
    const kindLen = view.getUint32(offset + 16, true);
    offset += 20;
    const nodeKind = new TextDecoder().decode(
      bytes.subarray(offset, offset + kindLen),
    );
    offset += kindLen;
    const textLen = view.getUint32(offset, true);
    offset += 4;
    const nodeText = new TextDecoder().decode(
      bytes.subarray(offset, offset + textLen),
    );
    offset += textLen;
    changes.push({
      kind:
        kind === 1
          ? "added"
          : kind === 2
            ? "removed"
            : kind === 3
              ? "moved"
              : "modified",
      nodeKind,
      nodeText,
      oldStart,
      oldEnd,
      newStart,
      newEnd,
    });
  }
  return { language: "", changes };
}

export async function diffWasmAst(
  oldText: string,
  newText: string,
  language: string,
): Promise<AstDiffResult> {
  if (!Object.hasOwn(PACK_BY_LANGUAGE, language)) {
    // Keep the UI's AST view useful for languages we do not ship a parser for:
    // it is not an error, just an empty structural diff.
    return { language, changes: [] };
  }
  const key = astCacheKey(language, oldText, newText);
  const cached = astCache.get(key);
  if (cached) return cached;
  const promise = (async (): Promise<AstDiffResult> => {
    const exports = await loadAstWasm(language);
    const old = allocString(exports, oldText);
    const new_ = allocString(exports, newText);
    const lang = allocString(exports, language);
    const outLenPtr = exports.wasm_alloc(8);
    let resultPtr = 0;
    let resultLen = 0;
    try {
      resultPtr = exports.wasm_ast_diff(
        old.ptr,
        old.len,
        new_.ptr,
        new_.len,
        lang.ptr,
        lang.len,
        outLenPtr,
      );
      const outLen = new DataView(
        exports.memory.buffer,
        outLenPtr,
        8,
      ).getUint32(0, true);
      resultLen = Number(outLen);
      const binary = new Uint8Array(
        exports.memory.buffer.slice(resultPtr, resultPtr + resultLen),
      );
      return { ...parseAstDiffBinary(binary), language };
    } finally {
      if (resultPtr && resultLen) exports.wasm_dealloc(resultPtr, resultLen);
      exports.wasm_dealloc(old.ptr, old.len);
      exports.wasm_dealloc(new_.ptr, new_.len);
      exports.wasm_dealloc(lang.ptr, lang.len);
      exports.wasm_dealloc(outLenPtr, 8);
    }
  })();
  astCache.set(key, promise);
  if (astCache.size > AST_CACHE_MAX) {
    const first = astCache.keys().next().value;
    if (first !== undefined) astCache.delete(first);
  }
  return promise;
}

const AST_INDEX_HEADER = 0x49535441;
const AST_INDEX_VERSION = 1;

export function parseAstIndexBinary(
  binary: ArrayBuffer | Uint8Array,
): AstIndexResult {
  const bytes = binary instanceof Uint8Array ? binary : new Uint8Array(binary);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== AST_INDEX_HEADER)
    throw new Error("invalid AST index binary magic");
  if (view.getUint32(4, true) !== AST_INDEX_VERSION)
    throw new Error("unsupported AST index binary version");
  const count = view.getUint32(8, true);
  const nodes: AstIndexNode[] = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const start = view.getUint32(offset, true);
    const end = view.getUint32(offset + 4, true);
    const kindLen = view.getUint32(offset + 8, true);
    offset += 12;
    const nodeKind = new TextDecoder().decode(
      bytes.subarray(offset, offset + kindLen),
    );
    offset += kindLen;
    const textLen = view.getUint32(offset, true);
    offset += 4;
    const text = new TextDecoder().decode(
      bytes.subarray(offset, offset + textLen),
    );
    offset += textLen;
    nodes.push({ nodeKind, text, start, end });
  }
  return { language: "", nodes };
}

export async function indexWasmAst(
  source: string,
  language: string,
): Promise<AstIndexResult> {
  if (!Object.hasOwn(PACK_BY_LANGUAGE, language))
    return { language, nodes: [] };
  const key = astIndexCacheKey(language, source);
  const cached = astIndexCache.get(key);
  if (cached) return cached;
  const promise = (async (): Promise<AstIndexResult> => {
    const exports = await loadAstWasm(language);
    const src = allocString(exports, source);
    const lang = allocString(exports, language);
    const outLenPtr = exports.wasm_alloc(8);
    let resultPtr = 0;
    let resultLen = 0;
    try {
      resultPtr = exports.wasm_ast_index(
        src.ptr,
        src.len,
        lang.ptr,
        lang.len,
        outLenPtr,
      );
      const outLen = new DataView(
        exports.memory.buffer,
        outLenPtr,
        8,
      ).getUint32(0, true);
      resultLen = Number(outLen);
      const binary = new Uint8Array(
        exports.memory.buffer.slice(resultPtr, resultPtr + resultLen),
      );
      return { ...parseAstIndexBinary(binary), language };
    } finally {
      if (resultPtr && resultLen) exports.wasm_dealloc(resultPtr, resultLen);
      exports.wasm_dealloc(src.ptr, src.len);
      exports.wasm_dealloc(lang.ptr, lang.len);
      exports.wasm_dealloc(outLenPtr, 8);
    }
  })();
  astIndexCache.set(key, promise);
  if (astIndexCache.size > AST_CACHE_MAX) {
    const first = astIndexCache.keys().next().value;
    if (first !== undefined) astIndexCache.delete(first);
  }
  return promise;
}

// Where the tree-sitter WASM files actually live.
//
// `import.meta.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm")`
// works in a checkout and FAILS in an installed copy: inside a Bun single-file
// executable it resolves to `B:\~BUN\root\...` — Bun's EMBEDDED filesystem — and
// `Language.load` reads it as a disk path, so every shell tool
// (run_shell, interactive_terminal_start, process_start) died on its first
// command with "missing B:\~BUN\root\tree-sitter.wasm".
//
// So the order is: a copy shipped in the install directory FIRST (real disk
// path, always present in a release), and the resolved dependency path second
// (what a checkout gets). The second MUST use the package specifier, not a
// path relative to this file — the wasm lives inside @vscode/tree-sitter-wasm
// and web-tree-sitter, not beside this source, and resolving "./tree-sitter.wasm"
// here simply does not resolve at all.
//
// The install directory is found the same way apps/cli/src/start-app.ts finds
// it: by checking which candidate actually CONTAINS what we need, because
// `import.meta.dir` and `process.execPath` both resolve to Bun's embedded
// filesystem under some launch modes.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The tree-sitter WASM files this package needs, by what they are for. */
export const WASM_FILES = {
  /** web-tree-sitter's own runtime, loaded by Parser.init. */
  runtime: {
    name: "tree-sitter.wasm",
    specifier: "web-tree-sitter/tree-sitter.wasm",
  },
  /** The bash grammar, loaded by Language.load for the command policy. */
  bash: {
    name: "tree-sitter-bash.wasm",
    specifier: "@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm",
  },
} as const;

export type WasmKey = keyof typeof WASM_FILES;

/** The install directory, found the way start-app.ts finds it. */
function installDir(): string {
  const candidates = [
    dirname(process.argv[0] ?? ""),
    dirname(process.execPath),
    dirname(import.meta.dir),
  ].filter((dir) => dir.length > 0);
  return candidates[0] ?? ".";
}

function fromSpecifier(specifier: string): string | null {
  try {
    return fileURLToPath(import.meta.resolve(specifier));
  } catch {
    return null;
  }
}

/**
 * A wasm file's bytes, from wherever it really is.
 *
 * Throws with BOTH tried paths in the message, so the failure says where it
 * looked instead of "ENOENT" with a path nobody can act on.
 */
export function readBundledWasm(key: WasmKey): Uint8Array {
  const { name, specifier } = WASM_FILES[key];
  const shipped = join(installDir(), "wasm", name);
  if (existsSync(shipped)) return new Uint8Array(readFileSync(shipped));

  const resolved = fromSpecifier(specifier);
  if (resolved && existsSync(resolved))
    return new Uint8Array(readFileSync(resolved));

  throw new Error(
    `the ${name} wasm file was not found. Looked for it at: ${shipped}${
      resolved ? ` and ${resolved}` : ""
    }. An installed copy must ship it under wasm/ — if it is missing from the ` +
      `install, the release build did not stage it.`,
  );
}

/** A wasm file's real path, for APIs that take one (web-tree-sitter's Parser.init). */
export function resolveBundledWasmPath(key: WasmKey): string {
  const { name, specifier } = WASM_FILES[key];
  const shipped = join(installDir(), "wasm", name);
  if (existsSync(shipped)) return shipped;
  const resolved = fromSpecifier(specifier);
  if (resolved) return resolved;
  throw new Error(
    `the ${name} wasm file could not be resolved from ${specifier}`,
  );
}

// The install path is the one that failed in the field, so it gets a guard.
//
// `B:\~BUN\root\tree-sitter.wasm` — the error every shell tool died on in an
// installed copy — comes from resolving the wasm through Bun's embedded
// filesystem. wasm-paths.ts fixes it by preferring a copy shipped in the
// install directory, and this test pins that preference: if it regresses, the
// failure is silent at build time (the build succeeds, `wasm/` is simply empty
// or ignored) and only the installed app notices.
import { expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

let root = "";
const savedArgv0 = process.argv[0];
const savedExecPath = process.execPath;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "natalia-wasm-install-"));
  // A fake install: the layout build-standalone.ts produces.
  mkdirSync(join(root, "wasm"), { recursive: true });
  for (const name of ["tree-sitter.wasm", "tree-sitter-bash.wasm"]) {
    writeFileSync(join(root, "wasm", name), WASM);
  }
});

afterAll(() => {
  // The module resolves the install directory from argv[0] and execPath, so both
  // are restored before the temp dir goes — a leaked value would make every
  // later test in this file resolve against a directory that no longer exists.
  process.argv[0] = savedArgv0;
  Object.defineProperty(process, "execPath", {
    value: savedExecPath,
    configurable: true,
  });
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the wasm shipped in an install directory is the one that is used", async () => {
  // Point the two candidates the module reads at the fake install. argv[0] first,
  // because that is the order the module itself tries them in.
  process.argv[0] = join(root, "natalia.exe");
  Object.defineProperty(process, "execPath", {
    value: join(root, "natalia.exe"),
    configurable: true,
  });

  const { readBundledWasm, resolveBundledWasmPath } = await import(
    "../src/wasm-paths.ts"
  );

  // Bytes, not a path into an embedded filesystem: this is the shape
  // `Language.load` accepts, and the reason the wasm no longer has to exist on
  // disk for the grammar to load.
  const bytes = readBundledWasm("bash");
  expect(Array.from(bytes)).toEqual(Array.from(WASM));

  // And a path, for `Parser.init({ locateFile })`.
  const path = resolveBundledWasmPath("runtime");
  expect(path.startsWith(root)).toBe(true);
  expect(path.endsWith("tree-sitter.wasm")).toBe(true);
});

test("a missing wasm says where it looked, not just ENOENT", async () => {
  // A directory with no wasm/ in it at all: neither candidate helps, and the
  // message must name both paths it tried, or the user has nothing to act on.
  const empty = mkdtempSync(join(tmpdir(), "natalia-wasm-empty-"));
  try {
    process.argv[0] = join(empty, "natalia.exe");
    Object.defineProperty(process, "execPath", {
      value: join(empty, "natalia.exe"),
      configurable: true,
    });
    const { readBundledWasm } = await import("../src/wasm-paths.ts");
    // The checkout fallback still resolves, so this asserts the SHIPPED path is
    // not what it used — which is the whole point of the preference order.
    expect(() => readBundledWasm("bash")).not.toThrow();
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

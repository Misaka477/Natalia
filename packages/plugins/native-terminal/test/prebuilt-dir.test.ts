// The bridge path is the one that failed in the field, so it gets a guard.
//
// A compiled binary's argv[0] is the string "bun", so the candidate that
// used to be tried first resolved to the CURRENT DIRECTORY — correct only
// when the cwd happens to be the install root. Under redirected stdio
// execPath points at Bun's embedded filesystem, which exists in no release
// tree, and the fallback named a directory inside the plugin store that is
// never staged there. The result was a terminal that failed with a
// confident path to a file that had never existed anywhere.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root = "";
const savedArgv0 = process.argv[0];
const savedExecPath = process.execPath;
const savedCwd = process.cwd();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "natalia-prebuilt-install-"));
  // The layout a release produces: the bridge beside the executable.
  mkdirSync(join(root, "prebuilt", "windows-x64"), { recursive: true });
  writeFileSync(
    join(root, "prebuilt", "windows-x64", "natalia-conpty-bridge.exe"),
    "bridge",
  );
});

afterAll(() => {
  process.argv[0] = savedArgv0;
  Object.defineProperty(process, "execPath", {
    value: savedExecPath,
    configurable: true,
  });
  process.chdir(savedCwd);
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the bridge beside the real executable is found, whatever argv[0] says", async () => {
  // The compiled-binary shape: argv[0] is "bun", so the old first candidate
  // was the current directory. execPath is the real executable, and it wins.
  process.argv[0] = "bun";
  Object.defineProperty(process, "execPath", {
    value: join(root, "natalia.exe"),
    configurable: true,
  });
  const { nativeTerminalPrebuiltDir } = await import(
    "../src/prebuilt-dir.ts"
  );
  expect(nativeTerminalPrebuiltDir("win32")).toBe(
    join(root, "prebuilt", "windows-x64"),
  );
});

test("a cwd that is the install root does not make the answer relative", async () => {
  // The regression this pins: with argv[0] tried first, a launch whose cwd IS
  // the install root (a shortcut, a Start Menu entry) resolves the bridge to
  // the RELATIVE path, which works only for as long as the cwd stays put —
  // the terminal breaks the moment the runtime is started from anywhere else.
  process.chdir(root);
  process.argv[0] = "bun";
  Object.defineProperty(process, "execPath", {
    value: join(root, "natalia.exe"),
    configurable: true,
  });
  const { nativeTerminalPrebuiltDir } = await import(
    "../src/prebuilt-dir.ts"
  );
  expect(nativeTerminalPrebuiltDir("win32")).toBe(
    join(root, "prebuilt", "windows-x64"),
  );
});

test("an embedded-filesystem execPath is not mistaken for an install", async () => {
  // Redirected stdio: execPath lives in Bun's embedded filesystem, which no
  // release tree contains. It must be filtered, not returned.
  process.argv[0] = "bun";
  Object.defineProperty(process, "execPath", {
    value: "B:\\~BUN\\root\\natalia.exe",
    configurable: true,
  });
  const { nativeTerminalPrebuiltDir } = await import(
    "../src/prebuilt-dir.ts"
  );
  const resolved = nativeTerminalPrebuiltDir("win32");
  expect(resolved.toLowerCase()).not.toContain("~bun");
  // Nothing on disk matched, so the answer is the plugin-relative fallback —
  // a path the caller reports verbatim, which is what makes the failure
  // diagnosable instead of silent.
  expect(resolved.endsWith(join("prebuilt", "windows-x64"))).toBe(true);
});

/**
 * The CI matrix must run every test this repository has.
 *
 * Measured defects this pins, all found by walking the workflow instead of
 * trusting it:
 *
 *  - `substrate-2` ran `./packages/hosts/object-store/test`, a path that stopped
 *    existing when the package moved to `packages/framework/object-store`. `bun
 *    test` exits 0 when a filter matches nothing **as long as another path
 *    matched** (measured: one real dir plus the stale one → "12 pass", exit 0),
 *    so ten test files had never run in CI and nothing said so.
 *  - `packages/core/shell/test`, `apps/web/test`, `apps/cef-desktop/test` and
 *    `packages/core/logging/test` were covered by no layer at all.
 *  - `packages/framework/client/test` is enumerated file by file, so a NEW file
 *    there silently escapes CI — every test added by recent work was absent.
 *
 * The gate is a walk, not a list: a new test directory, a moved package, or a
 * new file under the enumerated directory fails this test the day it lands.
 */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const WORKFLOW = join(repoRoot, ".github", "workflows", "verify.yml");
const workflow = readFileSync(WORKFLOW, "utf8");
const posix = (path: string) => path.split(sep).join("/");

/** Directories that hold test files directly, as repo-relative posix paths. */
function testDirs(): string[] {
  const found: string[] = [];
  const skip = /(?:^|\/)(?:node_modules|dist|devref|\.natalia|\.git)(?:\/|$)/u;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const here = posix(relative(repoRoot, dir));
    if (here !== "" && skip.test(here)) return;
    let holdsTests = false;
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".test.ts")) holdsTests = true;
      if (entry.isDirectory()) walk(join(dir, entry.name));
    }
    if (holdsTests && here !== "") found.push(here);
  };
  walk(repoRoot);
  return found.sort();
}

/**
 * Whether the workflow runs this directory's tests.
 *
 * The directory must be named as a DIRECTORY — followed by whitespace, which is
 * what a layer argument looks like (`./packages/core/shell/test`) or a shard
 * invocation (`./packages/framework/client/test 0 2`). A mention followed by a
 * file name does NOT count: that is an enumeration, and an enumeration is
 * exactly how thirty-two client test files came to run nowhere.
 *
 * An app workspace is run through its package script instead
 * (`npm --workspace @natalia/cli run test`), which names no path at all.
 */
function covered(dir: string): boolean {
  const asDirectory = new RegExp(
    `${dir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s`,
    "u",
  );
  if (asDirectory.test(workflow)) return true;
  // A workspace suite is run by its package script, which names no path:
  // `npm --workspace @natalia/cli run test` covers `apps/cli/test`.
  const parts = dir.split("/");
  const testAt = parts.lastIndexOf("test");
  const workspaceName = testAt > 0 ? parts[testAt - 1] : undefined;
  if (workspaceName && workflow.includes(`@natalia/${workspaceName}`))
    return true;
  return false;
}

test("every test directory is run by a CI layer", () => {
  const missing = testDirs().filter((dir) => !covered(dir));
  expect(
    missing,
    "a test directory runs nowhere in CI — add it to a layer in " +
      ".github/workflows/verify.yml (and keep the layer's platform in mind)",
  ).toEqual([]);
});

test("every path a layer names exists", () => {
  // The stale `./packages/hosts/object-store/test` is the case this catches:
  // a moved package leaves a path behind, and bun's exit code hides it.
  const named = new Set<string>();
  for (const match of workflow.matchAll(
    /(?:^|\s)\.?\/?((?:packages|apps|scripts)\/[A-Za-z0-9_./-]+)/gu,
  )) {
    const path = match[1]!.replace(/[.,;]+$/u, "");
    if (path.endsWith("/test")) named.add(path);
  }
  expect(named.size).toBeGreaterThan(20);
  const absent = [...named].filter((path) => !existsSync(join(repoRoot, path)));
  expect(absent, "a CI layer names a path that does not exist").toEqual([]);
});

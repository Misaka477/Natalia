/**
 * Test-workspace hygiene guard.
 *
 * Two checks, and the split is the lesson:
 *
 * 1. STATIC — every test file that creates an official-plugin workspace must
 *    call `useWorkspaceCleanup()`. This is the property, checked from the
 *    source text on any platform, so a forgotten call fails in CI without a
 *    test ever running and without depending on how long Windows holds a
 *    directory handle.
 * 2. RESIDUE — `dist/ts/client-test-workspaces` is swept and emptied, and how
 *    much was there is reported. This guard runs in a FRESH process, where the
 *    handles the test process held are gone; measured on Windows, teardown
 *    reliably empties a workspace and then cannot unlink the directory, so the
 *    residue it leaves is reclaimed here instead of failing a green suite.
 *
 * Either way the leak stays visible: a forgotten call is a red guard, and
 * anything this process cannot remove — a genuinely locked or permission-broken
 * workspace — is reported as red too, because that is a state a human must see.
 *
 * Run after `bun test` (the "test" script chains it), so a failing run is
 * already red — this guard exists for the quiet case where everything passes
 * and the disk still fills.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  workspaceCreatorFilesMissingCleanup,
  type SourceFile,
} from "../src/test-workspace-hygiene";

const root = process.cwd();
const residueRoot = resolve(root, "dist", "ts", "client-test-workspaces");
const SOURCE_ROOTS = ["packages", "apps", "scripts"];
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git", "devref"]);

function testFilesIn(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...testFilesIn(path));
    else if (/\.test\.tsx?$/u.test(entry.name)) found.push(path);
  }
  return found;
}

let failed = false;

const sources: SourceFile[] = [];
for (const directory of SOURCE_ROOTS) {
  const absolute = resolve(root, directory);
  if (!existsSync(absolute)) continue;
  for (const path of testFilesIn(absolute))
    sources.push({
      path: path
        .slice(root.length + 1)
        .split(/[\\/]/u)
        .join("/"),
      text: readFileSync(path, "utf8"),
    });
}

const missingCleanup = workspaceCreatorFilesMissingCleanup(sources);
console.log(
  `test-workspace hygiene guard: scanned ${sources.length} test files for the cleanup hook`,
);
if (missingCleanup.length > 0) {
  failed = true;
  console.error(
    `test files creating workspaces without useWorkspaceCleanup(): ${missingCleanup.length}`,
  );
  for (const path of missingCleanup.slice(0, 10)) console.error(`  ${path}`);
  if (missingCleanup.length > 10)
    console.error(`  … and ${missingCleanup.length - 10} more`);
  console.error(
    "add `useWorkspaceCleanup()` from plugin-test-helpers to the file (it registers the per-test remove and the per-file sweep)",
  );
} else console.log("every workspace creator registers its teardown");

if (existsSync(residueRoot)) {
  const entries = readdirSync(residueRoot);
  let reclaimed = 0;
  const stuck: string[] = [];
  for (const entry of entries) {
    const path = resolve(residueRoot, entry);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      rmSync(path, { recursive: true, force: true });
      if (!existsSync(path)) reclaimed += 1;
      else stuck.push(entry);
    } catch {
      stuck.push(entry);
    }
  }
  console.log(
    `residue: ${entries.length} entr(y/ies) under ${residueRoot}; ` +
      `reclaimed ${reclaimed} (teardown removed the files, the OS held the directory)`,
  );
  if (stuck.length > 0) {
    failed = true;
    console.error(`residue a fresh process could not remove: ${stuck.length}`);
    for (const entry of stuck.slice(0, 10))
      console.error(`  ${resolve(residueRoot, entry)}`);
    console.error(
      `a workspace that survives a fresh process is a real lock or permission problem, not handle lag: rm -rf ${residueRoot} once, then find what holds it`,
    );
  }
} else console.log("residue: no test workspaces present");

process.exit(failed ? 1 : 0);

/**
 * Test-focus guard.
 *
 * A committed `test.only` / `it.only` / `describe.only` makes the runner execute
 * only that test in the file and silently skip the rest — a green CI that ran a
 * fraction of the suite, the exact "half-finished" this audit exists to catch.
 * Unlike `.skip` (a visible choice) or `.skipIf` (a conditional), a focus
 * modifier hides the skipped tests, so nothing downstream notices.
 *
 * Scope is test files under packages/ and apps/. Comment lines are ignored; a
 * genuine exception goes in ALLOWED with a reason, and a stale entry (the focus
 * modifier is gone) fails the gate, matching the contract-producer guard.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const roots = ["packages", "apps"];
const skipDirs = new Set([
  "node_modules",
  "dist",
  ".turbo",
  "coverage",
  "build",
  "out",
]);
const focusRe = /\b(?:test|it|describe)\.only\s*\(/u;

/** Intentional focus modifiers, keyed `path:line`, each with a reason. */
const ALLOWED: Readonly<Record<string, string>> = {};

async function* testFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      yield* testFiles(join(dir, entry.name));
    } else if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

const isCommentLine = (line: string) => /^\s*(?:\/\/|\/\*|\*)/.test(line);

const failures: string[] = [];
const allowedPresent = new Set<string>();
let scanned = 0;

for (const base of roots) {
  for await (const file of testFiles(join(root, base))) {
    scanned++;
    const rel = relative(root, file).replaceAll("\\", "/");
    const lines = (await readFile(file, "utf8")).split("\n");
    for (const [index, line] of lines.entries()) {
      if (!focusRe.test(line) || isCommentLine(line)) continue;
      const key = `${rel}:${index + 1}`;
      if (ALLOWED[key] !== undefined) {
        allowedPresent.add(key);
        continue;
      }
      failures.push(
        `${rel}:${index + 1}: focused test (.only) is not allowed in committed tests`,
      );
    }
  }
}

for (const key of Object.keys(ALLOWED)) {
  if (!allowedPresent.has(key))
    failures.push(
      `${key}: ALLOWED entry is stale — the focus modifier is gone, remove it from the guard`,
    );
}

console.log(`test-focus guard: scanned ${scanned} test files`);
if (failures.length) {
  console.error(`focused tests in committed test files: ${failures.length}`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("no focused (.only) tests");

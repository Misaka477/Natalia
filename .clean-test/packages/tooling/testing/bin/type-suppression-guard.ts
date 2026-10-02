/**
 * Type-suppression guard.
 *
 * `@ts-ignore` and `@ts-nocheck` silently disable the type checker: the first
 * hides the next line's error with no self-check, the second disables checking
 * for a whole file. Both let a real type error — often the shadow of a logic
 * bug — disappear instead of being fixed. `@ts-expect-error` is deliberately
 * allowed: it asserts an error exists and FAILS when the error goes away, so it
 * cannot rot the way the silent forms do.
 *
 * This mechanizes the audit's "type escape hatches" screen so a silent
 * suppression cannot quietly re-enter production source. Scope is production
 * source only (the src trees of packages and apps); test files may suppress
 * freely. An intentional exception goes in ALLOWED with a reason, and a stale
 * entry (the suppression no longer present) fails the gate, matching the
 * contract-producer guard's discipline.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const sourceRoots = ["packages", "apps"];
const skipDirs = new Set([
  "node_modules",
  "dist",
  ".turbo",
  "coverage",
  "build",
  "out",
]);

/** Intentional silent suppressions, keyed `path:line`, each with a reason. */
const ALLOWED: Readonly<Record<string, string>> = {};

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      yield* sourceFiles(join(dir, entry.name));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

const isProductionSource = (file: string) =>
  /\/src\//.test(file.replaceAll("\\", "/")) &&
  !/\.(test|spec)\.(ts|tsx)$/.test(file) &&
  !/\/test\//.test(file.replaceAll("\\", "/"));

const suppressionRe =
  /\/\/\s*@ts-(ignore|nocheck)\b|\/\*\s*@ts-(ignore|nocheck)\b/;
const anySuppressionRe = /@ts-(ignore|nocheck|expect-error)\b/g;

const failures: string[] = [];
const allowedStillPresent = new Set<string>();
let scanned = 0;

for (const base of sourceRoots) {
  for await (const file of sourceFiles(join(root, base))) {
    if (!isProductionSource(file)) continue;
    scanned++;
    const rel = relative(root, file).replaceAll("\\", "/");
    const lines = (await readFile(file, "utf8")).split("\n");
    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;
      for (const match of line.matchAll(anySuppressionRe)) {
        const key = `${rel}:${lineNumber}`;
        if (ALLOWED[key] !== undefined) allowedStillPresent.add(key);
        if (match[1] === "expect-error") continue; // self-checking, allowed
        if (ALLOWED[key] !== undefined) continue; // intentional, reasoned
        failures.push(
          `${rel}:${lineNumber}: @ts-${match[1]} is not allowed in production source`,
        );
      }
    }
  }
}

for (const key of Object.keys(ALLOWED)) {
  if (!allowedStillPresent.has(key))
    failures.push(
      `${key}: ALLOWED entry is stale — the suppression is gone, remove it from the guard`,
    );
}

console.log(
  `type-suppression guard: scanned ${scanned} production source files`,
);
if (failures.length) {
  console.error(
    `silent type suppressions in production source: ${failures.length}`,
  );
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("no @ts-ignore / @ts-nocheck in production source");

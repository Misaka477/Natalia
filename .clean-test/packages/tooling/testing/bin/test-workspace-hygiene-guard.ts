/**
 * Test-workspace hygiene guard.
 *
 * Fails when `dist/ts/client-test-workspaces` still holds directories after a
 * test run. Every official-plugin test workspace is removed by the per-file
 * `useWorkspaceCleanup()` hook (see plugin-test-helpers.ts); residue means a
 * test file created workspaces without registering it, or a process was killed
 * hard mid-run. Either way the leak is bounded only by disk: 95,927 leftover
 * workspaces once exhausted btrfs metadata and turned every later verify red
 * with ENOSPC. This guard turns the silent leak into a loud failure.
 *
 * Run after `bun test` (the "test" script chains it), so a failing run is
 * already red — this guard exists for the quiet case where everything passes
 * and the disk still fills.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const residueRoot = resolve(root, "dist", "ts", "client-test-workspaces");

if (!existsSync(residueRoot)) {
  console.log("test-workspace hygiene guard: no test workspaces present");
  process.exit(0);
}

const entries = readdirSync(residueRoot);
const leftovers = entries.filter((entry) => {
  try {
    return statSync(resolve(residueRoot, entry)).isDirectory();
  } catch {
    return false;
  }
});

console.log(
  `test-workspace hygiene guard: scanned ${residueRoot} (${entries.length} entries)`,
);
if (leftovers.length > 0) {
  console.error(`leftover test workspaces: ${leftovers.length}`);
  for (const entry of leftovers.slice(0, 10))
    console.error(`  ${resolve(residueRoot, entry)}`);
  if (leftovers.length > 10)
    console.error(`  … and ${leftovers.length - 10} more`);
  console.error(
    "every test file creating workspaces must call useWorkspaceCleanup() from plugin-test-helpers;",
  );
  console.error(
    `hard-killed residue can be removed with: rm -rf ${residueRoot}`,
  );
  process.exit(1);
}
console.log("no leftover test workspaces");

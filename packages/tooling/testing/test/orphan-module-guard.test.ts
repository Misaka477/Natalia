import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The orphan-module guard catches what it exists to catch.
 *
 * A guard that cannot fail is decoration. The first version of this one reported
 * 412 findings on a healthy tree because it matched only `.ts`-suffixed spellings
 * while essentially every import in this repository is extension-less — so this
 * test drives the guard's real binary against a synthetic tree and demands both
 * directions.
 */

const guardPath = new URL("../bin/orphan-module-guard.ts", import.meta.url)
  .pathname;

async function runGuard(cwd: string) {
  const proc = Bun.spawnSync(["bun", guardPath], {
    cwd,
    env: { ...process.env, CI: "1", ORPHAN_GUARD_ROOT: cwd },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

/** A tree with one module that nothing references. */
async function treeWithOrphan(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orphan-guard-"));
  await mkdir(join(dir, "packages/demo/src"), { recursive: true });
  await mkdir(join(dir, "packages/demo/test"), { recursive: true });
  // The orphan: exported, and referenced by nothing.
  await writeFile(
    join(dir, "packages/demo/src/unreferenced.ts"),
    "export const x = 1;\n",
  );
  // Something that IS referenced, so the guard has a reason to pass on the rest.
  await writeFile(
    join(dir, "packages/demo/src/used.ts"),
    "export const y = 2;\n",
  );
  // The two ALLOWED orphans, or their entries read as stale in a tree without
  // them (correct behaviour, and noise for what this test is about).
  await mkdir(join(dir, "apps/cef-desktop/src"), { recursive: true });
  await writeFile(
    join(dir, "apps/cef-desktop/src/instance.ts"),
    "export {};\n",
  );
  await writeFile(
    join(dir, "apps/cef-desktop/src/window-policy.ts"),
    "export {};\n",
  );
  await mkdir(join(dir, "packages/tooling/testing/src"), { recursive: true });
  await writeFile(
    join(dir, "packages/tooling/testing/src/eval-adapter.ts"),
    "export {};\n",
  );
  await writeFile(
    join(dir, "packages/demo/src/index.ts"),
    'import { y } from "./used";\nexport { y };\n',
  );
  await writeFile(
    join(dir, "packages/demo/test/x.test.ts"),
    'import { x } from "../src/unreferenced";\nexport default x;\n',
  );
  return dir;
}

test("an unreferenced production module fails the guard", async () => {
  const dir = await treeWithOrphan();
  const result = await runGuard(dir);
  expect(result.code).not.toBe(0);
  expect(result.out).toContain("unreferenced.ts");
  expect(result.out).toContain("no product caller");
  await rm(dir, { recursive: true, force: true });
});

test("an extension-less import counts as a reference", async () => {
  // The first version's bug: `from "./used"` does not spell `used.ts`, and a guard
  // that only matched suffixes called this tree 412 orphans.
  const dir = await treeWithOrphan();
  await rm(join(dir, "packages/demo/src/unreferenced.ts"), { force: true });
  await rm(join(dir, "packages/demo/test"), {
    recursive: true,
    force: true,
  });
  const result = await runGuard(dir);
  expect(result.out).not.toContain("used.ts");
  expect(result.code).toBe(0);
  await rm(dir, { recursive: true, force: true });
});

test("a test file referencing a module does not make it reachable", async () => {
  // The failure mode itself: `unreferenced.ts` is imported by a TEST and nothing
  // else, which is exactly what a green checkmark hiding an unused module looks
  // like. The guard must still fail.
  const dir = await treeWithOrphan();
  const result = await runGuard(dir);
  expect(result.code).not.toBe(0);
  await rm(dir, { recursive: true, force: true });
});

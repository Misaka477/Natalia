import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findUndeclaredWorkspaceImports } from "../src/manifest-dep-rules";

/**
 * The census's fixture: an undeclared workspace import in src (value
 * OR type-only) is a violation; declared, self-named, relative and
 * external imports are not; files outside src are not scanned.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("undeclared workspace imports in src are named with their file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mdep-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(
    join(dir, "src", "a.ts"),
    [
      'import { x } from "@anthelia/kernel";', // declared -> ok
      'import type { T } from "@natalia/product";', // type-only, UNDECLARED -> flagged
      'import { y } from "./sibling";', // relative -> ignored
      'import { z } from "node:path";', // external -> ignored
      `import { self } from "${"@"}natalia/selfname";`, // self -> ignored
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "test", "t.ts"),
    'import { u } from "@natalia/product";', // outside src -> not scanned
  );
  const failures = await findUndeclaredWorkspaceImports({
    ownName: "@natalia/selfname",
    packageDir: dir,
    deps: { "@anthelia/kernel": "workspace:*" },
  });
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("a.ts");
  expect(failures[0]).toContain("@natalia/product");
});

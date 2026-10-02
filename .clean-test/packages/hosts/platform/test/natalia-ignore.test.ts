import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_NATALIA_IGNORE_PATTERNS,
  ensureNataliaIgnoreFile,
  isSnapshotIgnored,
  loadNataliaIgnore,
  NATALIA_IGNORE_FILE,
  parseSnapshotIgnore,
} from "../src";

test("ensureNataliaIgnoreFile creates the default file without overwriting", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ignore-default-"));
  const created = await ensureNataliaIgnoreFile(root);
  expect(created.created).toBe(true);
  const contents = await readFile(join(root, NATALIA_IGNORE_FILE), "utf8");
  for (const pattern of DEFAULT_NATALIA_IGNORE_PATTERNS)
    expect(contents).toContain(pattern);
  await writeFile(join(root, NATALIA_IGNORE_FILE), "custom/\n");
  const again = await ensureNataliaIgnoreFile(root);
  expect(again.created).toBe(false);
  expect(await readFile(join(root, NATALIA_IGNORE_FILE), "utf8")).toBe(
    "custom/\n",
  );
});

test("ensureNataliaIgnoreFile migrates checkpoint.ignore patterns once", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ignore-migrate-"));
  await ensureNataliaIgnoreFile(root, ["legacy-cache/", "*.bak"]);
  const loaded = await loadNataliaIgnore(root);
  expect(loaded.exists).toBe(true);
  expect(loaded.patterns).toContain("legacy-cache/");
  expect(loaded.patterns).toContain("*.bak");
  expect(loaded.patterns).toContain("node_modules/");
});

test("snapshot ignore rules are directory-aware and support negation", () => {
  const rules = parseSnapshotIgnore(
    `build/\n!build/keep/\n*.tmp\n/root-only\n`,
  );
  expect(isSnapshotIgnored("build/generated.js", false, rules)).toBe(true);
  expect(isSnapshotIgnored("build/keep/note.md", false, rules)).toBe(false);
  expect(isSnapshotIgnored("src/a.tmp", false, rules)).toBe(true);
  expect(isSnapshotIgnored("root-only", false, rules)).toBe(true);
  expect(isSnapshotIgnored("nested/root-only", false, rules)).toBe(false);
});

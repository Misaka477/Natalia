import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dependencyRootsFor,
  isDependencyLinkPath,
  linkDependencyRoots,
} from "../src/dependency-links";

test("a declared dependency root that exists is linked into the candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-deps-link-"));
  await mkdir(join(root, "host", "node_modules", "left-pad"), {
    recursive: true,
  });
  await writeFile(join(root, "host", "node_modules", "left-pad", "i.js"), "1");
  await mkdir(join(root, "candidate"), { recursive: true });

  const linked = await linkDependencyRoots({
    hostRoot: join(root, "host"),
    candidateRoot: join(root, "candidate"),
    roots: ["node_modules"],
  });

  expect(linked).toEqual(["node_modules"]);
  const info = await lstat(join(root, "candidate", "node_modules"));
  expect(info.isSymbolicLink()).toBe(true);
  // The link resolves to the host's own tree: a command inside the candidate
  // reads the installed dependencies instead of failing "module not found".
  expect(
    await lstat(join(root, "candidate", "node_modules", "left-pad", "i.js")),
  ).toBeDefined();
});

test("a root the host does not have is skipped, not invented", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-deps-absent-"));
  await mkdir(join(root, "host"), { recursive: true });
  await mkdir(join(root, "candidate"), { recursive: true });
  const linked = await linkDependencyRoots({
    hostRoot: join(root, "host"),
    candidateRoot: join(root, "candidate"),
    roots: ["node_modules"],
  });
  expect(linked).toEqual([]);
  await expect(
    lstat(join(root, "candidate", "node_modules")),
  ).rejects.toThrow();
});

test("a path the candidate already holds is never replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-deps-present-"));
  await mkdir(join(root, "host", "node_modules"), { recursive: true });
  await mkdir(join(root, "candidate", "node_modules"), { recursive: true });
  await writeFile(join(root, "candidate", "node_modules", "keep.txt"), "1");
  const linked = await linkDependencyRoots({
    hostRoot: join(root, "host"),
    candidateRoot: join(root, "candidate"),
    roots: ["node_modules"],
  });
  // A project that tracks its dependencies keeps its own copy.
  expect(linked).toEqual([]);
  expect(
    (await lstat(join(root, "candidate", "node_modules"))).isDirectory(),
  ).toBe(true);
});

test("a nested declared root links with its parents created", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-deps-nested-"));
  await mkdir(join(root, "host", "apps", "web", "node_modules"), {
    recursive: true,
  });
  await mkdir(join(root, "candidate"), { recursive: true });
  const linked = await linkDependencyRoots({
    hostRoot: join(root, "host"),
    candidateRoot: join(root, "candidate"),
    roots: ["apps/web/node_modules"],
  });
  expect(linked).toEqual(["apps/web/node_modules"]);
  expect(
    (
      await lstat(join(root, "candidate", "apps", "web", "node_modules"))
    ).isSymbolicLink(),
  ).toBe(true);
});

test("a declaration that escapes the workspace is refused, not linked", () => {
  const root = join(tmpdir(), "natalia-deps-escape-");
  expect(() => dependencyRootsFor(root, ["../../.."])).toThrow(
    /escapes the workspace/u,
  );
  expect(() => dependencyRootsFor(root, ["/etc"])).toThrow(
    /must be host-relative/u,
  );
  // Legal spellings survive, deduplicated, in order.
  expect(
    dependencyRootsFor(root, ["node_modules", "./node_modules", ".venv"]),
  ).toEqual(["node_modules", ".venv"]);
});

test("the link predicate matches the root and everything under it", () => {
  expect(isDependencyLinkPath("node_modules", ["node_modules"])).toBe(true);
  expect(
    isDependencyLinkPath("node_modules/left-pad/i.js", ["node_modules"]),
  ).toBe(true);
  expect(isDependencyLinkPath("./node_modules/x", ["node_modules"])).toBe(true);
  // A sibling that merely shares a prefix is not the root.
  expect(isDependencyLinkPath("node_modules-backup/x", ["node_modules"])).toBe(
    false,
  );
  expect(isDependencyLinkPath("src/index.ts", ["node_modules"])).toBe(false);
});

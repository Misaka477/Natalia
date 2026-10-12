import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pathWithinDomains,
  relativeToRoot,
} from "../src/runtime/sandbox-policy";

/**
 * The sandbox policy's path law — the containment judgement every write
 * path answers to. The escapes it must refuse are the ones a prefix match
 * waves through: `..` traversal, an absolute path outside the root, and a
 * symlink whose target sits outside while its spelling sits inside.
 */

test("a path inside the domain passes; one outside fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-domain-"));
  await mkdir(join(root, "allowed"), { recursive: true });
  await writeFile(join(root, "allowed", "a.txt"), "a");
  expect(
    pathWithinDomains({
      path: join(root, "allowed", "a.txt"),
      root,
      domains: ["allowed"],
    }),
  ).toBe(true);
  expect(
    pathWithinDomains({
      path: join(root, "elsewhere", "b.txt"),
      root,
      domains: ["allowed"],
    }),
  ).toBe(false);
});

test("a `..` traversal that lexically starts inside is refused", async () => {
  // THE escape the prefix match waved through: the spelling starts with
  // the domain, the kernel resolves it outside the root.
  const root = await mkdtemp(join(tmpdir(), "natalia-domain-"));
  await mkdir(join(root, "allowed"), { recursive: true });
  await mkdir(join(root, "outside"), { recursive: true });
  expect(
    pathWithinDomains({
      path: join(root, "allowed", "..", "..", "outside", "x.txt"),
      root,
      domains: ["allowed"],
    }),
  ).toBe(false);
});

test("a symlink inside the root pointing outside is refused", async () => {
  // The other half of canonicalize-then-contain: the spelling is inside,
  // the identity is not.
  const root = await mkdtemp(join(tmpdir(), "natalia-domain-"));
  const outside = await mkdtemp(join(tmpdir(), "natalia-outside-"));
  await mkdir(join(root, "allowed"), { recursive: true });
  await writeFile(join(outside, "secret.txt"), "s");
  await symlink(outside, join(root, "allowed", "link"), "dir");
  expect(
    pathWithinDomains({
      path: join(root, "allowed", "link", "secret.txt"),
      root,
      domains: ["allowed"],
    }),
  ).toBe(false);
});

test("a path whose tail does not exist yet is judged on its directory", async () => {
  // The write about to create the file: the deepest existing ancestor is
  // resolved, the answer about the directory is the truthful one.
  const root = await mkdtemp(join(tmpdir(), "natalia-domain-"));
  await mkdir(join(root, "allowed"), { recursive: true });
  expect(
    pathWithinDomains({
      path: join(root, "allowed", "new.txt"),
      root,
      domains: ["allowed"],
    }),
  ).toBe(true);
  expect(
    pathWithinDomains({
      path: join(root, "elsewhere", "new.txt"),
      root,
      domains: ["allowed"],
    }),
  ).toBe(false);
});

test("an absolute path outside the root never matches a relative domain", () => {
  expect(relativeToRoot("/etc/passwd", "/tmp/root")).toBe("/etc/passwd");
  expect(
    pathWithinDomains({
      path: "/etc/passwd",
      root: "/tmp/root",
      domains: ["etc"],
    }),
  ).toBe(false);
});

test("the root itself reads as position empty, and a bare domain never matches it", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-domain-"));
  // The root is inside at position "" — and "" is not a domain name, so a
  // domain list of ["."] does not silently come to mean "the whole root".
  expect(relativeToRoot(root, root)).toBe("");
  expect(pathWithinDomains({ path: root, root, domains: ["."] })).toBe(false);
});

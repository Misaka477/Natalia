/**
 * The media-preview route's boundary, pinned.
 *
 * Measured hole: with only the permission-rule check (`auto` allows reads), the
 * deployed route served `C:\Windows\win.ini` as base64 for a caller that claimed
 * `image/png`. The rule layer is a read POLICY, not a boundary; the workspace
 * root is the boundary, and this pins the predicate that enforces it.
 */
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapesDir } from "../src/runtime/attachment-paths";

test("a path inside the root does not escape, its sibling does", () => {
  const root = process.platform === "win32" ? "C:\\w\\app" : "/w/app";
  const sep = process.platform === "win32" ? "\\" : "/";
  expect(escapesDir(root, `${root}${sep}pic.png`)).toBe(false);
  expect(escapesDir(root, `${root}${sep}sub${sep}pic.png`)).toBe(false);
  expect(escapesDir(root, root)).toBe(false);
  // A sibling whose name merely STARTS with the root's name is outside it — the
  // prefix comparison without a separator is the classic way this check leaks.
  expect(escapesDir(root, `${root}2${sep}pic.png`)).toBe(true);
  expect(
    escapesDir(
      root,
      process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/passwd",
    ),
  ).toBe(true);
});

test("separators are normalized, so a mixed path cannot slip through", () => {
  const root = process.platform === "win32" ? "C:\\w\\app" : "/w/app";
  expect(
    escapesDir(
      root,
      process.platform === "win32" ? "C:/w/app/pic.png" : "/w/app/pic.png",
    ),
  ).toBe(false);
});

test("a symlink out of the workspace is refused once realpath'd", async () => {
  const outside = await mkdtemp(join(tmpdir(), "natalia-media-outside-"));
  const inside = await mkdtemp(join(tmpdir(), "natalia-media-inside-"));
  try {
    await writeFile(join(outside, "secret.png"), "not really a png");
    const link = join(inside, "sneaky.png");
    // A junction needs no privilege on Windows; POSIX takes a directory link, so
    // the case links the DIR and the candidate traverses it.
    if (process.platform === "win32") {
      await symlink(outside, link, "junction");
    } else {
      await symlink(outside, join(inside, "link"), "dir");
    }
    const root = await realpath(inside);
    const candidate =
      process.platform === "win32"
        ? join(root, "sneaky.png", "secret.png")
        : join(root, "link", "secret.png");
    // The containment check reads the RESOLVED path, which is what makes a link
    // a link rather than a name: realpath leaves the workspace.
    const resolved = await realpath(candidate);
    expect(escapesDir(root, resolved)).toBe(true);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(inside, { recursive: true, force: true });
  }
});

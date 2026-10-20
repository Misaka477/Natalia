/**
 * The browse directory picker: the fence, the bound, and the closed error
 * vocabulary.
 *
 * The shape follows the reference harness's `directory-picker-browse`. The
 * three properties worth pinning are the ones a browser client cannot check for
 * itself: a wire path means one directory on every host, a level with a
 * million children costs bounded memory, and a failure carries a code rather
 * than a sentence to match on.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_ENTRIES,
  DirectoryPickerError,
  boundedInsert,
  createChildDirectory,
  fullyQualified,
  listDirectoryLevel,
} from "../src/directory-browse";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "natalia-browse-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a listing carries the level, its ancestry, and its home", async () => {
  const child = join(root, "child");
  await mkdir(child);
  await writeFile(join(root, "plain.txt"), "not a directory\n", "utf8");

  const listing = await listDirectoryLevel(root);
  expect(listing.path).toBe(root);
  expect(listing.home.length).toBeGreaterThan(0);
  // The ancestry ends at the listed directory, and every crumb is a jump target.
  expect(listing.crumbs.at(-1)).toEqual({
    name: expect.any(String),
    path: root,
    hidden: false,
  });
  // A file is not a row: the browser shows what can be entered.
  expect(listing.entries.map((entry) => entry.name)).toEqual(["child"]);
  expect(listing.truncated).toBe(false);
});

test("a relative or drive-less path is refused, not rebased", async () => {
  // `resolve()` would silently rebase these under the host process cwd (or, on
  // Windows, its current drive), so the same wire value would name a different
  // directory on a different host.
  expect(fullyQualified("relative/path")).toBe(false);
  expect(fullyQualified("")).toBe(false);
  expect(fullyQualified("C:\\Users\\me", "win32")).toBe(true);
  expect(fullyQualified("\\\\server\\share\\dir", "win32")).toBe(true);
  // Rooted but drive-less: `isAbsolute` is true and the path still resolves
  // against the current drive, which is exactly the case the fence exists for.
  expect(fullyQualified("\\Users\\me", "win32")).toBe(false);
  expect(fullyQualified("/home/me", "linux")).toBe(true);

  await expect(listDirectoryLevel("relative/path")).rejects.toThrow(
    DirectoryPickerError,
  );
  await expect(listDirectoryLevel("relative/path")).rejects.toMatchObject({
    code: "directory-unreadable",
  });
});

test("a level beyond the bound is cut and says so", async () => {
  // 5 children against a bound of 2: the window keeps the name-sorted head and
  // the flag says the tail is missing.
  for (const name of ["e", "d", "c", "b", "a"]) await mkdir(join(root, name));

  const listing = await listDirectoryLevel(root, { maxEntries: 2 });
  expect(listing.entries.map((entry) => entry.name)).toEqual(["a", "b"]);
  expect(listing.truncated).toBe(true);
});

test("a level within the bound is complete", async () => {
  for (const name of ["b", "a"]) await mkdir(join(root, name));
  const listing = await listDirectoryLevel(root, { maxEntries: 10 });
  expect(listing.entries.map((entry) => entry.name)).toEqual(["a", "b"]);
  expect(listing.truncated).toBe(false);
});

test("the window keeps memory bounded and reports the cut", () => {
  // The bound is on the WINDOW, not on the level: an oversized level costs O(1)
  // per candidate past the head rather than a window scan.
  const window: Array<{
    name: string;
    isDirectory: boolean;
    isSymbolicLink: boolean;
  }> = [];
  let evicted = false;
  for (let index = 0; index < 5000; index += 1) {
    evicted =
      boundedInsert(
        window,
        {
          name: `d${String(index).padStart(5, "0")}`,
          isDirectory: true,
          isSymbolicLink: false,
        },
        3,
      ) || evicted;
  }
  expect(window.length).toBe(3);
  expect(window.map((entry) => entry.name)).toEqual([
    "d00000",
    "d00001",
    "d00002",
  ]);
  expect(evicted).toBe(true);
});

/**
 * Whether this host can create a symlink at all.
 *
 * Windows refuses `symlink` with EPERM unless the process is elevated or
 * Developer Mode is on, so a test that needs one is not a test this host can
 * run. The behaviour under test (a symlink to a directory is enterable, a
 * broken one is skipped) is the same on every platform; only the fixture is
 * platform-gated. Skipping is honest where a failure would be a lie about the
 * code.
 */
const canSymlink = await (async () => {
  const probe = await mkdtemp(join(tmpdir(), "natalia-symlink-probe-"));
  try {
    await symlink(join(probe, "nowhere"), join(probe, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
})();

test("a broken symlink is skipped rather than listed", async () => {
  if (!canSymlink) return;
  await mkdir(join(root, "real"));
  await symlink(join(root, "gone"), join(root, "dangling"), "dir");

  const listing = await listDirectoryLevel(root);
  expect(listing.entries.map((entry) => entry.name)).toEqual(["real"]);
});

test("a symlink to a directory is enterable", async () => {
  if (!canSymlink) return;
  const target = join(root, "target");
  await mkdir(target);
  await symlink(target, join(root, "link"), "dir");

  const listing = await listDirectoryLevel(root);
  expect(listing.entries.map((entry) => entry.name)).toEqual([
    "link",
    "target",
  ]);
});

test("createDirectory makes one child and refuses a second", async () => {
  const created = await createChildDirectory(root, "fresh");
  expect(created).toBe(join(root, "fresh"));

  await expect(createChildDirectory(root, "fresh")).rejects.toMatchObject({
    code: "directory-exists",
  });
});

test("createDirectory refuses anything that is not one path segment", async () => {
  for (const name of ["", " ", ".", "..", "a/b", "a\\b"])
    await expect(createChildDirectory(root, name)).rejects.toMatchObject({
      code: "directory-create-failed",
    });
});

test("createDirectory refuses a parent that is not fully qualified", async () => {
  await expect(createChildDirectory("relative", "child")).rejects.toMatchObject(
    { code: "directory-create-failed" },
  );
});

test("the default bound is the documented one", () => {
  expect(DEFAULT_MAX_ENTRIES).toBe(1000);
});

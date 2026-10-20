/**
 * The stale-write guard: a write whose file changed after the model read it is
 * refused, not applied.
 *
 * This is the failure this repository's own agent hit three times in one
 * session, losing uncommitted work each time. The reference harness refuses
 * with `FS_STALE_VERSION`; these tools refuse with the same sentence, and the
 * point of the tests is that the refusal happens BEFORE any write and BEFORE
 * the literal match, so a stale edit never reports "oldText not found" against
 * content the model never saw.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileVersion } from "@natalia/fs-shared";
import { writeFileTools } from "../src/fs-write-tools";

const tools = new Map(writeFileTools.map((tool) => [tool.name, tool]));

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "natalia-stale-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The context a tool's execute receives, with the workspace pointed at `root`. */
function context() {
  return { workspaceRoot: root } as unknown as Parameters<
    (typeof writeFileTools)[number]["execute"]
  >[1];
}

async function call(name: string, args: Record<string, unknown>) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return (await tool.execute(args, context())) as string;
}

test("a read carries a version, and a stale edit is refused", async () => {
  const path = join(root, "a.txt");
  await writeFile(path, "one\ntwo\nthree\n", "utf8");

  // The version read_file hands the model is the same token the write tools
  // are asked to match, so the read side is exercised through the same
  // function rather than through another package's tool.
  const version = await fileVersion(path);
  expect(typeof version).toBe("string");
  expect(version!.length).toBeGreaterThan(0);

  // The file changes underneath the model, exactly as a concurrent writer or a
  // second agent would.
  await writeFile(path, "one\nCHANGED\nthree\n", "utf8");

  let refused: string | undefined;
  try {
    await call("edit_file", {
      path: "a.txt",
      oldText: "two",
      newText: "TWO",
      expectedVersion: version,
    });
  } catch (error) {
    refused = (error as Error).message;
  }
  expect(refused).toContain("file changed since it was read");
  expect(refused).toContain("re-read the file, then retry");
  // Nothing was written: the refusal is before the write, not after it.
  expect(await readFile(path, "utf8")).toBe("one\nCHANGED\nthree\n");
});

test("a fresh version lets the edit through", async () => {
  const path = join(root, "b.txt");
  await writeFile(path, "alpha\nbeta\n", "utf8");
  const version = await fileVersion(path);

  await call("edit_file", {
    path: "b.txt",
    oldText: "beta",
    newText: "BETA",
    expectedVersion: version,
  });
  expect(await readFile(path, "utf8")).toBe("alpha\nBETA\n");
});

test("write_file refuses a stale version and applies a fresh one", async () => {
  const path = join(root, "c.txt");
  await writeFile(path, "first\n", "utf8");
  const stale = await fileVersion(path);

  await writeFile(path, "second\n", "utf8");
  await expect(
    call("write_file", {
      path: "c.txt",
      content: "third\n",
      expectedVersion: stale,
    }),
  ).rejects.toThrow("file changed since it was read");
  expect(await readFile(path, "utf8")).toBe("second\n");

  const fresh = await fileVersion(path);
  await call("write_file", {
    path: "c.txt",
    content: "third\n",
    expectedVersion: fresh,
  });
  expect(await readFile(path, "utf8")).toBe("third\n");
});

test("apply_edits refuses a stale entry and writes nothing", async () => {
  const path = join(root, "d.txt");
  await writeFile(path, "keep\nchange\n", "utf8");
  const stale = await fileVersion(path);

  await writeFile(path, "keep\nMOVED\n", "utf8");
  await expect(
    call("apply_edits", {
      edits: [
        {
          path: "d.txt",
          operation: "replace",
          oldText: "change",
          newText: "CHANGED",
          expectedVersion: stale,
        },
      ],
    }),
  ).rejects.toThrow("file changed since it was read");
  expect(await readFile(path, "utf8")).toBe("keep\nMOVED\n");
});

test("a write with no expected version is unconditional", async () => {
  // The model chose not to guard. The tool honours that rather than inventing
  // a requirement — the guard is opt-in, and this is the opt-out.
  const path = join(root, "e.txt");
  await writeFile(path, "x\n", "utf8");
  await call("edit_file", {
    path: "e.txt",
    oldText: "x",
    newText: "y",
  });
  expect(await readFile(path, "utf8")).toBe("y\n");
});

test("a missing file is never at any version", async () => {
  // A write that expects a version and finds nothing is writing to a file that
  // vanished — the same class of surprise as one that changed.
  await writeFile(join(root, "f.txt"), "gone\n", "utf8");
  const version = await fileVersion(join(root, "f.txt"));
  await rm(join(root, "f.txt"));
  await expect(
    call("edit_file", {
      path: "f.txt",
      oldText: "gone",
      newText: "here",
      expectedVersion: version,
    }),
  ).rejects.toThrow("file changed since it was read");
});

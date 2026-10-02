import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ObjectStore } from "@anthelia/object-store";
import { SnapshotSandboxManager } from "../src/snapshot-sandbox";
import { SnapshotStore } from "../src/snapshot-store";

test("SnapshotStore captures, diffs and promotes by content hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-snapshot-store-"));
  const store = new SnapshotStore(
    new ObjectStore(join(root, ".natalia", "objects")),
    join(root, ".natalia", "snapshots"),
  );
  const host = join(root, "host");
  await mkdir(host, { recursive: true });
  await writeFile(join(host, "a.txt"), "base content");
  const base = await store.capture(host);
  await store.saveIndex("s1", base);

  // A changed file and a new file are detected by hash; an unchanged one is not.
  const candidate = join(root, "candidate");
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, "a.txt"), "changed content");
  await writeFile(join(candidate, "b.txt"), "new");
  const changes = await store.diff(
    candidate,
    base,
    await store.capture(candidate),
  );
  expect(changes.map((change) => change.path).sort()).toEqual([
    "a.txt",
    "b.txt",
  ]);
  expect(changes.find((change) => change.path === "a.txt")?.kind).toBe(
    "modify",
  );
  expect(changes.find((change) => change.path === "b.txt")?.kind).toBe("add");

  // Promote applies to the host; rollback restores the last-known-good.
  await store.promote("s1", candidate, host, changes);
  expect(await readFile(join(host, "a.txt"), "utf8")).toBe("changed content");
  expect(await readFile(join(host, "b.txt"), "utf8")).toBe("new");
  await store.rollback(host, "s1");
  expect(await readFile(join(host, "a.txt"), "utf8")).toBe("base content");
  // `b.txt` did not exist before the promote, so rolling back removes it. This
  // assertion previously expected an empty string — which is what a
  // restore-only rollback leaves, and it pinned the leak as correct behaviour.
  await expect(readFile(join(host, "b.txt"))).rejects.toThrow();
});

test("SnapshotSandboxManager checks the base out into each candidate worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-snapshot-checkout-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "CONTRACT.md"), "shared contract\n");
  await writeFile(join(root, "src", "index.ts"), "export const base = true;\n");
  const manager = new SnapshotSandboxManager(root);
  await manager.initialize();

  const candidate = await manager.create("agent.1");

  expect(await readFile(join(candidate.root, "CONTRACT.md"), "utf8")).toBe(
    "shared contract\n",
  );
  expect(await readFile(join(candidate.root, "src", "index.ts"), "utf8")).toBe(
    "export const base = true;\n",
  );
  expect(await manager.previewMerge("agent.1")).toEqual([]);

  await writeFile(
    join(candidate.root, "src", "index.ts"),
    "export const base = false;\n",
  );
  expect(await manager.previewMerge("agent.1")).toEqual([
    expect.objectContaining({ kind: "modify", path: "src/index.ts" }),
  ]);
});

test("diff after a small change hashes only the changed file, not the whole tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-snapshot-perf-"));
  // A workspace with many files; only one will change.
  for (let index = 0; index < 40; index++)
    await writeFile(join(root, `file-${index}.txt`), `content ${index}`);
  await writeFile(join(root, "file.txt"), "base\n");

  let puts = 0;
  const store = new SnapshotStore(
    new (class extends ObjectStore {
      override async put(content: Buffer | string): Promise<string> {
        puts++;
        return await super.put(content);
      }
    })(join(root, ".natalia", "objects")),
    join(root, ".natalia", "snapshots"),
  );
  const countingManager = new SnapshotSandboxManager(root);
  await countingManager.initialize();
  // create hashes the whole tree once (the base capture).
  await countingManager.create("perf.1");
  // The agent changes one file.
  await writeFile(
    join(root, ".natalia", "sandboxes", "perf.1", "file.txt"),
    "edited\n",
  );
  // Re-index the candidate through the counting store: untouched files reuse
  // their objects by size/mtime; only the changed one is hashed.
  const candidateIndex = await store.capture(
    join(root, ".natalia", "sandboxes", "perf.1"),
    await store.loadCandidateIndex("perf.1"),
    (path) => path === ".natalia-manifest.json",
  );
  const before = puts;
  await store.diff(
    join(root, ".natalia", "sandboxes", "perf.1"),
    (await store.loadIndex("perf.1"))!,
    candidateIndex,
  );
  // At most a couple of files were hashed, not the whole 41-file tree.
  expect(puts - before).toBeLessThanOrEqual(2);
});

test("promoting a delete removes the file from the host", async () => {
  // A sub-agent that deletes a file produces a `delete` change in its PR. The
  // lead approves it. The host must end up without the file — otherwise the
  // deletion is silently dropped and the host keeps a file the PR said was gone.
  const root = await mkdtemp(join(tmpdir(), "natalia-sb-del-"));
  const host = join(root, "host");
  await mkdir(host, { recursive: true });
  await writeFile(join(host, "keep.txt"), "keep");
  await writeFile(join(host, "gone.txt"), "delete me");
  const store = new SnapshotStore(
    new ObjectStore(join(root, ".natalia", "objects")),
    join(root, ".natalia", "store"),
  );
  const base = await store.capture(host);
  const candidate = join(root, "candidate");
  await mkdir(candidate, { recursive: true });
  const candidateIndex = await store.materialize(candidate, base);
  await rm(join(candidate, "gone.txt"));
  // Re-capture after mutating the worktree: the index `materialize` returned
  // describes the checkout, not what the agent did to it.
  const afterDelete = await store.capture(candidate, candidateIndex);
  const changes = await store.diff(candidate, base, afterDelete);
  expect(changes.map((change) => change.kind)).toEqual(["delete"]);

  await store.promote("sb_del", candidate, host, changes);

  await expect(readFile(join(host, "gone.txt"))).rejects.toThrow();
  await expect(readFile(join(host, "keep.txt"), "utf8")).resolves.toBe("keep");
});

test("rollback removes a file the promote added, rather than leaving a 0-byte stub", async () => {
  // The backup for a file that did not exist on the host is empty, so writing
  // every backup back leaves a 0-byte file where the promote created a real one.
  const root = await mkdtemp(join(tmpdir(), "natalia-sb-add-"));
  const host = join(root, "host");
  await mkdir(host, { recursive: true });
  await writeFile(join(host, "keep.txt"), "keep");
  const store = new SnapshotStore(
    new ObjectStore(join(root, ".natalia", "objects")),
    join(root, ".natalia", "store"),
  );
  const base = await store.capture(host);
  const candidate = join(root, "candidate");
  await mkdir(candidate, { recursive: true });
  const candidateIndex = await store.materialize(candidate, base);
  await writeFile(join(candidate, "added.txt"), "brand new");
  const afterAdd = await store.capture(candidate, candidateIndex);
  const changes = await store.diff(candidate, base, afterAdd);
  expect(changes.map((change) => change.kind)).toEqual(["add"]);

  await store.promote("sb_add", candidate, host, changes);
  await expect(readFile(join(host, "added.txt"), "utf8")).resolves.toBe(
    "brand new",
  );

  expect(await store.rollback(host, "sb_add")).toBe(true);
  // Rolling back an addition must undo it, not leave an empty file behind.
  await expect(readFile(join(host, "added.txt"))).rejects.toThrow();
});

test("a second candidate from the same base cannot overwrite the first", async () => {
  // Two candidates taken from one snapshot and both editing one file: the first
  // promotion lands, and the second used to overwrite it silently, discarding
  // the first candidate's work with nothing reported.
  const root = await mkdtemp(join(tmpdir(), "natalia-sb-conflict-"));
  const host = join(root, "host");
  await mkdir(host, { recursive: true });
  await writeFile(join(host, "shared.ts"), "BASE\n");
  const store = new SnapshotStore(
    new ObjectStore(join(root, ".natalia", "objects")),
    join(root, ".natalia", "store"),
  );
  const base = await store.capture(host);
  const candidateFor = async (name: string, body: string) => {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    const index = await store.materialize(dir, base);
    await writeFile(join(dir, "shared.ts"), body);
    const captured = await store.capture(dir, index);
    return { dir, changes: await store.diff(dir, base, captured) };
  };
  const a = await candidateFor("candA", "A's version\n");
  const b = await candidateFor("candB", "B's version\n");

  await store.promote("sb_a", a.dir, host, a.changes, undefined, base);
  await expect(
    store.promote("sb_b", b.dir, host, b.changes, undefined, base),
  ).rejects.toThrow(/conflicts with changes already on the host/);

  // The refusal is the point: the first candidate's work survives.
  expect(await readFile(join(host, "shared.ts"), "utf8")).toBe("A's version\n");
});

test("a candidate whose base still matches promotes without complaint", async () => {
  // The check must not fire on the ordinary case, or every promotion after the
  // first would be refused.
  const root = await mkdtemp(join(tmpdir(), "natalia-sb-noconflict-"));
  const host = join(root, "host");
  await mkdir(host, { recursive: true });
  await writeFile(join(host, "a.ts"), "one\n");
  await writeFile(join(host, "b.ts"), "two\n");
  const store = new SnapshotStore(
    new ObjectStore(join(root, ".natalia", "objects")),
    join(root, ".natalia", "store"),
  );
  const base = await store.capture(host);
  const dir = join(root, "cand");
  await mkdir(dir, { recursive: true });
  const index = await store.materialize(dir, base);
  await writeFile(join(dir, "a.ts"), "one changed\n");
  const changes = await store.diff(dir, base, await store.capture(dir, index));

  await store.promote("sb_ok", dir, host, changes, undefined, base);

  expect(await readFile(join(host, "a.ts"), "utf8")).toBe("one changed\n");
  expect(await readFile(join(host, "b.ts"), "utf8")).toBe("two\n");
});

test("an add whose path appeared on the host meanwhile is a conflict", async () => {
  // The candidate created a file; if the host created one at the same path after
  // the snapshot, promoting would destroy whichever came second.
  const root = await mkdtemp(join(tmpdir(), "natalia-sb-addconflict-"));
  const host = join(root, "host");
  await mkdir(host, { recursive: true });
  await writeFile(join(host, "seed.txt"), "seed\n");
  const store = new SnapshotStore(
    new ObjectStore(join(root, ".natalia", "objects")),
    join(root, ".natalia", "store"),
  );
  const base = await store.capture(host);
  const dir = join(root, "cand");
  await mkdir(dir, { recursive: true });
  const index = await store.materialize(dir, base);
  await writeFile(join(dir, "new.txt"), "from the candidate\n");
  const changes = await store.diff(dir, base, await store.capture(dir, index));
  expect(changes.map((change) => change.kind)).toEqual(["add"]);
  // Someone else created the same path after the snapshot was taken.
  await writeFile(join(host, "new.txt"), "someone else's\n");

  await expect(
    store.promote("sb_add", dir, host, changes, undefined, base),
  ).rejects.toThrow(/conflicts with changes already on the host/);
  expect(await readFile(join(host, "new.txt"), "utf8")).toBe(
    "someone else's\n",
  );
});

test("a rollback reports false when there is no rollback point for that sandbox", async () => {
  // `restored: false` must mean "nothing to undo", not a silent failure — a
  // backend that cannot reach a point says so rather than claiming success.
  const root = await mkdtemp(join(tmpdir(), "natalia-sb-nolkg-"));
  const host = join(root, "host");
  await mkdir(host, { recursive: true });
  const store = new SnapshotStore(
    new ObjectStore(join(root, ".natalia", "objects")),
    join(root, ".natalia", "store"),
  );
  const manager = new SnapshotSandboxManager(root);
  await manager.initialize();

  expect(await store.rollback(host, "never_promoted")).toBe(false);
  expect(await store.rollback(host, "never_promoted")).toBe(false);
});

test("a promotion is undoable by sandbox id through the manager", async () => {
  // The entry point a tool or route reaches: the promotion is addressable by the
  // sandbox it came from, which is what makes `rollbackState` actionable.
  const root = await mkdtemp(join(tmpdir(), "natalia-sb-mgr-rollback-"));
  await writeFile(join(root, "file.txt"), "before\n");
  const manager = new SnapshotSandboxManager(root);
  await manager.initialize();
  const sandbox = await manager.create("sb_undo");
  await writeFile(join(sandbox.root, "file.txt"), "promoted\n");
  await manager.promoteWithValidation("sb_undo", {
    command: "true",
    hostRoot: root,
  });
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("promoted\n");

  const result = await manager.rollback("sb_undo");

  expect(result.restored).toBe(true);
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("before\n");
});

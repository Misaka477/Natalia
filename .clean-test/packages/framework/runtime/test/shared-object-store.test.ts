import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ObjectStore } from "@anthelia/object-store";
import { CheckpointStore } from "../src/checkpoint";
import { ContextLedger } from "../src/context";
import { SnapshotSandboxManager } from "@anthelia/sandbox";

const sha = (content: string) =>
  createHash("sha256").update(content).digest("hex");

test("checkpoint and the sandbox share one content-addressed object library", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-shared-objects-"));
  const objects = new ObjectStore(join(root, ".natalia", "objects"));

  // The checkpoint snapshots a workspace file.
  await mkdir(join(root, "work"), { recursive: true });
  await writeFile(join(root, "work", "same.txt"), "identical content\n");
  const ledger = new ContextLedger();
  const store = await CheckpointStore.open({
    sessionID: "ses_shared",
    workspaceRoot: root,
  });
  await store.createCheckpoint({ reason: "manual", context: ledger, step: 1 });

  // The sandbox captures the same content into its own snapshot index.
  const sandbox = new SnapshotSandboxManager(root);
  await sandbox.initialize();
  const manifest = await sandbox.create("snap.1");
  await writeFile(join(manifest.root, "same.txt"), "identical content\n");
  await sandbox.previewMerge("snap.1");

  // One content, one object: the shared library dedups across subsystems, and
  // both subsystems' references resolve to the same id.
  const objectID = sha("identical content\n");
  expect(await objects.has(objectID)).toBe(true);
  expect((await objects.list()).filter((id) => id === objectID)).toHaveLength(
    1,
  );
  const records = await store.list();
  const lastManifest = await store.loadManifest(records.at(-1)!);
  const checkpointHash = Object.values(lastManifest.entries)[0]!.objectHash!;
  expect(checkpointHash).toBe(objectID);
});

test("checkpoint GC preserves the sandbox's live objects via extra reachability", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-shared-gc-"));
  const objects = new ObjectStore(join(root, ".natalia", "objects"));

  // The sandbox holds a live object.
  const sandbox = new SnapshotSandboxManager(root);
  await sandbox.initialize();
  const manifest = await sandbox.create("keep.1");
  await writeFile(join(manifest.root, "keep.txt"), "sandbox content\n");
  await sandbox.previewMerge("keep.1");

  // The checkpoint has its own unrelated object.
  const ledger = new ContextLedger();
  await mkdir(join(root, "work"), { recursive: true });
  await writeFile(join(root, "work", "other.txt"), "checkpoint content\n");
  const store = await CheckpointStore.open({
    sessionID: "ses_shared_gc",
    workspaceRoot: root,
  });
  await store.createCheckpoint({ reason: "manual", context: ledger, step: 1 });

  // GC with the sandbox's reachable ids: nothing pruned — the interlock works.
  const applied = await store.gcObjects(
    false,
    await sandbox.referencedObjectIDs(),
  );
  expect(applied.unreachableObjects).toBe(0);
  expect(await objects.has(sha("sandbox content\n"))).toBe(true);

  // Without the sandbox's ids, the sandbox object would be pruned — proving it
  // is the interlock that protects it, not the object being unreferenced.
  const without = await store.gcObjects(true);
  expect(without.unreachableObjects).toBeGreaterThan(0);
});

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { expect, test } from "bun:test";
import { checkpointConfigSchema } from "@anthelia/contracts";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import {
  defaultCheckpointStoreDir,
  resolveWorkspaceObjectsRoot,
  workspaceChunksRoot,
} from "@anthelia/platform";
import { appendSessionEvent, createSessionRecord } from "@anthelia/session";
import {
  CheckpointJournalCorruptionError,
  CheckpointJournalUnsupportedError,
  CheckpointStore,
  ChunkStore,
  ContextLedger,
  contentDefinedChunks,
  initializeDefaultCheckpointStore,
  pruneV2Backups,
  runCheckpointCommand,
  type CheckpointRuntimeResource,
} from "../src";

/**
 * These fixtures create filesystem symlinks, which Windows refuses without
 * Developer Mode or an elevated process. The behaviour under test is the
 * ledger's handling of symlinked entries, so the tests are skipped when the
 * machine cannot create symlinks rather than failing on setup.
 */
const symlinkSupported = await probeSymlinkSupport();
const symlinkTest = symlinkSupported ? test : test.skip;

async function probeSymlinkSupport(): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "natalia-symlink-probe-"));
  try {
    await symlink("target", join(root, "link"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Python is only a stand-in for "a real external program wrote and ran a file
// here", not a subject of these tests. The interpreter is named `python3` on
// most POSIX distributions and `python` on Windows, so resolve whichever
// exists rather than hard-coding one and losing the whole scenario elsewhere.
function pythonInterpreter() {
  for (const candidate of ["python3", "python"]) {
    try {
      // spawnSync throws ENOENT rather than reporting failure when the
      // executable is absent, so probing has to be guarded.
      const probe = Bun.spawnSync([candidate, "--version"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if (probe.success) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

test("default baseline, user scenario rollback and session restore remain durable", async () => {
  const root = await tempWorkspace();
  const events: RuntimeEvent[] = [];
  const ledger = new ContextLedger();
  ledger.add({ id: "user-1", role: "user", content: "checkpoint" });
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_checkpoint_user",
    workspaceRoot: root,
    context: ledger,
    onEvent: (event) => events.push(event),
  });

  expect((await store.list()).map((record) => record.id)).toEqual([
    "checkpoint_0",
  ]);
  ledger.add({ id: "assistant-1", role: "assistant", content: "writing file" });
  await writeFile(join(root, "test_example.py"), "print('ok')\n");
  const interpreter = pythonInterpreter();
  if (interpreter) {
    const run = Bun.spawnSync([interpreter, join(root, "test_example.py")]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trim()).toBe("ok");
  }
  ledger.add({
    id: "tool-call",
    role: "tool_call",
    content: "write_file test_example.py",
  });
  ledger.add({
    id: "tool-result",
    role: "tool_result",
    content: "created test_example.py",
  });
  ledger.recordProviderUsage(20, 5);
  await store.createCheckpoint({
    reason: "manual",
    context: ledger,
    step: 3,
    status: "ran python",
    name: "ran python",
  });

  expect(await readFile(join(root, "test_example.py"), "utf8")).toContain("ok");
  const preview = await store.rollbackTo("checkpoint_0", { context: ledger });
  expect(
    preview.changes.some(
      (change) => change.kind === "delete" && change.path === "test_example.py",
    ),
  ).toBe(true);
  await expect(
    readFile(join(root, "test_example.py"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(ledger.snapshot().entries.map((entry) => entry.id)).toEqual([
    "user-1",
  ]);
  expect(ledger.journalStatus()).toMatchObject({
    journalOffset: 1,
    messageCount: 1,
  });
  expect(events.map((event) => event.type)).toContain("checkpoint.created");
  expect(events.map((event) => event.type)).toContain("rollback.end");

  const restored = await CheckpointStore.open({
    sessionID: "ses_checkpoint_user",
    workspaceRoot: root,
  });
  // T5-3: the rollback is a pointer, not a truncation. The visible journal
  // ends at the target; the safety record (and everything the session wrote
  // above it) stays on disk with its delta chain intact, so a later rollback
  // to any of them still works — which is exactly what the next lines do.
  const restoredRecords = await restored.list();
  expect(restoredRecords.map((record) => record.id)).toEqual(["checkpoint_0"]);
  const safety = await restored.get(preview.safetyCheckpointID!);
  expect(safety?.reason).toBe("rollback_safety");
  await restored.rollbackTo(safety!.id, { context: ledger });
  expect(await readFile(join(root, "test_example.py"), "utf8")).toContain("ok");
  // And the pointer moved the window FORWARD to the safety record, which the
  // old destructive rollback could not do: it had deleted the path there.
  const forward = await CheckpointStore.open({
    sessionID: "ses_checkpoint_user",
    workspaceRoot: root,
  });
  // The window ends at the safety record, and everything at or below it is
  // visible again — the records the first rollback moved past were never
  // deleted, so moving the pointer forward restores them all. That is the
  // property the destructive rollback could not have.
  expect((await forward.list()).map((record) => record.id)).toEqual([
    "checkpoint_0",
    "checkpoint_1",
    safety!.id,
  ]);
});

symlinkTest(
  "manifest tracks modify delete rename mode symlink and reuses objects",
  async () => {
    const root = await tempWorkspace();
    const ledger = new ContextLedger();
    await writeFile(join(root, "a.txt"), "same\n");
    await writeFile(join(root, "delete.txt"), "remove\n");
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir", "target.txt"), "target\n");
    await symlink("dir/target.txt", join(root, "link.txt"));
    const store = await initializeDefaultCheckpointStore({
      sessionID: "ses_manifest",
      workspaceRoot: root,
      context: ledger,
    });
    const baseline = (await store.list())[0]!;
    const baselineManifest = await store.loadManifest(baseline);
    expect(baselineManifest.entries["link.txt"]?.kind).toBe("symlink");

    await writeFile(join(root, "a.txt"), "changed\n");
    await rm(join(root, "delete.txt"));
    await rename(join(root, "dir", "target.txt"), join(root, "renamed.txt"));
    await chmod(join(root, "a.txt"), 0o755);
    await store.createCheckpoint({
      reason: "manual",
      context: ledger,
      step: 1,
    });
    const changed = (await store.list()).at(-1)!;
    expect(changed.changes.map((change) => change.kind)).toEqual(
      expect.arrayContaining(["modify", "delete", "rename", "mode"]),
    );
    const changedManifest = await store.loadManifest(changed);
    expect(changedManifest.entries["link.txt"]?.kind).toBe("symlink");
    await store.rollbackTo("checkpoint_0", { context: ledger });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("same\n");
    expect((await lstat(join(root, "a.txt"))).mode & 0o777).toBe(0o644);
    expect(await readFile(join(root, "delete.txt"), "utf8")).toBe("remove\n");
    expect((await lstat(join(root, "link.txt"))).isSymbolicLink()).toBe(true);

    await store.gcObjects(true);
    // Objects now live in the shared content-addressed library, not the
    // per-session checkpoint dir.
    // The shared content-addressed library's root is the store layer's
    // (it moved outside the workspace with the §1.6 migration; a hardcoded
    // workspace path here read a directory nothing writes to).
    const objectsRoot = resolveWorkspaceObjectsRoot(root);
    const buckets = await readdir(objectsRoot);
    const hashes = (
      await Promise.all(
        buckets.map((bucket) => readdir(join(objectsRoot, bucket))),
      )
    ).flat();
    expect(new Set(hashes).size).toBe(hashes.length);
  },
);

test("rollback restores a chunked object through the object store", async () => {
  // A file past the object store's `chunkMin` is split into content-defined
  // chunks and reassembled on read — it never occupies the loose
  // `<root>/<xx>/<hash>` path. Restoring one by hand-building that path
  // failed ENOENT (16 KiB restored, 100 KiB and 3 MiB did not), so every
  // chunked workspace file was unrecoverable and the atomic switch was
  // empty at any real size.
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  // Deterministic, poorly compressible bytes: one object per content, and
  // the content-defined splitter cannot collapse it into a single chunk.
  const original = Buffer.from(
    Array.from({ length: 3 * 1024 * 1024 }, (_, index) => (index * 31) & 0xff),
  );
  await writeFile(join(root, "big.payload"), original);
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_chunked_rollback",
    workspaceRoot: root,
    context: ledger,
  });
  await writeFile(
    join(root, "big.payload"),
    Buffer.alloc(original.length, 0x41),
  );
  await store.createCheckpoint({ reason: "manual", context: ledger, step: 1 });
  // The premise, pinned: the object is chunked, so the loose path the old
  // restore copied does not exist and the retry after it could not help.
  const hash = createHash("sha256").update(original).digest("hex");
  const objectsRoot = resolveWorkspaceObjectsRoot(root);
  expect(existsSync(join(objectsRoot, hash.slice(0, 2), hash))).toBe(false);
  await store.rollbackTo("checkpoint_0", { context: ledger });
  expect(await readFile(join(root, "big.payload"))).toEqual(original);
});

test("concurrent checkpoint creation assigns unique durable sequences", async () => {
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  const store = await CheckpointStore.open({
    sessionID: "ses_checkpoint_concurrent",
    workspaceRoot: root,
  });
  const records = await Promise.all(
    [1, 2, 3].map((step) =>
      store.createCheckpoint({ reason: "manual", context: ledger, step }),
    ),
  );
  expect(records.map((record) => record.sequence)).toEqual([0, 1, 2]);
  expect((await store.list()).map((record) => record.id)).toEqual([
    "checkpoint_0",
    "checkpoint_1",
    "checkpoint_2",
  ]);
});

test("rollback refuses to mutate when its safety checkpoint is incomplete", async () => {
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  const store = await CheckpointStore.open({
    sessionID: "ses_checkpoint_safety",
    workspaceRoot: root,
    maxFiles: 1,
  });
  await store.createCheckpoint({
    reason: "baseline",
    context: ledger,
    step: 0,
  });
  await writeFile(join(root, "first.txt"), "first\n");
  await writeFile(join(root, "second.txt"), "second\n");
  await expect(
    store.rollbackTo("checkpoint_0", { context: ledger }),
  ).rejects.toThrow("rollback safety checkpoint is incomplete");
  expect(await readFile(join(root, "second.txt"), "utf8")).toBe("second\n");
});

symlinkTest(
  "incomplete checkpoint and ignored files are visible and guarded",
  async () => {
    const root = await tempWorkspace();
    const ledger = new ContextLedger();
    await writeFile(join(root, "tracked.txt"), "tracked\n");
    await writeFile(join(root, "ignored.log"), "ignored\n");
    await symlink("/tmp", join(root, "escape"));
    const events: RuntimeEvent[] = [];
    const store = await CheckpointStore.open({
      sessionID: "ses_incomplete",
      workspaceRoot: root,
      ignore: ["*.log", "ignored.log"],
      additionalDirs: ["../outside"],
      onEvent: (event) => events.push(event),
    });
    const record = await store.createCheckpoint({
      reason: "manual",
      context: ledger,
      step: 1,
    });
    expect(record.complete).toBe(false);
    expect(record.errors.join("\n")).toContain("symlink outside");
    expect(record.errors.join("\n")).toContain(
      "additional directory is outside the managed workspace",
    );
    const recordManifest = await store.loadManifest(record);
    expect(recordManifest.entries["ignored.log"]).toBeUndefined();
    expect(events.map((event) => event.type)).toContain("checkpoint.failed");
    expect(events.map((event) => event.type)).not.toContain(
      "checkpoint.created",
    );
    const failed = events.find(
      (event): event is Extract<RuntimeEvent, { type: "checkpoint.failed" }> =>
        event.type === "checkpoint.failed",
    );
    expect(failed?.errors).toEqual(
      expect.arrayContaining([
        "checkpoint contains a symlink outside the managed workspace",
      ]),
    );
    expect(JSON.stringify(failed)).not.toContain("escape");
    expect(JSON.stringify(failed)).not.toContain("/tmp");
    await expect(
      store.rollbackTo(record.id, { context: ledger }),
    ).rejects.toThrow("incomplete");
  },
);

test("checkpoint structurally excludes its own stores even without .natalia/ ignore", async () => {
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  await writeFile(join(root, ".nataliaignore"), "# no .natalia rule\n");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.ts"), "export {}\n");
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_checkpoint_self_exclusion",
    workspaceRoot: root,
    context: ledger,
  });
  const [baseline] = await store.list();
  const baselineManifest = await store.loadManifest(baseline!);
  const paths = Object.keys(baselineManifest.entries);
  expect(paths).toContain("src/main.ts");
  expect(paths.some((path) => path.startsWith(".natalia/objects/"))).toBe(
    false,
  );
  expect(paths.some((path) => path.startsWith(".natalia/checkpoints/"))).toBe(
    false,
  );
  expect(paths).not.toContain(".nataliaignore");
});

symlinkTest(
  "large ignored workspace fixtures do not make a durable checkpoint incomplete",
  async () => {
    const root = await tempWorkspace();
    const ledger = new ContextLedger();
    const events: Array<
      Extract<
        RuntimeEvent,
        { type: "checkpoint.created" | "checkpoint.failed" }
      >
    > = [];
    await mkdir(join(root, "source"), { recursive: true });
    await mkdir(join(root, "fixture-output"), { recursive: true });
    await writeFile(join(root, ".nataliaignore"), "/fixture-output\n");
    await Promise.all(
      Array.from({ length: 750 }, (_, index) =>
        writeFile(join(root, "source", `${index}.txt`), `entry ${index}\n`),
      ),
    );
    await symlink(
      "/not-a-managed-target",
      join(root, "fixture-output", "broken"),
    );
    const store = await initializeDefaultCheckpointStore({
      sessionID: "ses_checkpoint_large_ignored_fixture",
      workspaceRoot: root,
      context: ledger,
      onEvent: (event) => {
        if (
          event.type === "checkpoint.created" ||
          event.type === "checkpoint.failed"
        )
          events.push(event);
      },
    });

    const [baseline] = await store.list();
    expect(baseline).toMatchObject({ complete: true });
    const baselineManifest = await store.loadManifest(baseline!);
    expect(Object.keys(baselineManifest.entries)).toHaveLength(751);
    expect(baselineManifest.entries["fixture-output/broken"]).toBeUndefined();
    expect(events).toEqual([
      expect.objectContaining({ type: "checkpoint.created", complete: true }),
    ]);
    expect(
      await store.previewRollback("checkpoint_0", ledger, [], true),
    ).toMatchObject({
      checkpointID: "checkpoint_0",
      complete: true,
      dryRun: true,
    });
    expect(
      await store.rollbackTo("checkpoint_0", { context: ledger, dryRun: true }),
    ).toMatchObject({ complete: true, dryRun: true });
  },
);

test("rollback failure restores safety checkpoint for workspace and context", async () => {
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  await writeFile(join(root, "file.txt"), "before\n");
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_transaction",
    workspaceRoot: root,
    context: ledger,
  });
  ledger.add({ id: "assistant", role: "assistant", content: "after" });
  await writeFile(join(root, "file.txt"), "after\n");
  await store.createCheckpoint({ reason: "manual", context: ledger, step: 1 });
  await expect(
    store.rollbackTo("checkpoint_0", {
      context: ledger,
      failContextRestore: true,
    }),
  ).rejects.toThrow("injected context rollback failure");
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("after\n");
  expect(ledger.snapshot().entries.map((entry) => entry.id)).toEqual([
    "assistant",
  ]);
});

test("dry-run preview includes running PTY Sandbox workflow modal policy", async () => {
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  const events: string[] = [];
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_resources",
    workspaceRoot: root,
    context: ledger,
    onEvent: (event) => events.push(event.type),
  });
  const resources: CheckpointRuntimeResource[] = [
    {
      kind: "terminal",
      id: "pty_1",
      status: "running",
      summary: "interactive shell",
    },
    {
      kind: "sandbox",
      id: "box_1",
      status: "preserve_dirty",
      summary: "dirty sandbox",
    },
    {
      kind: "workflow",
      id: "wf_1",
      status: "pending",
      summary: "pending workflow",
    },
    {
      kind: "pending_modal",
      id: "apr_1",
      status: "pending",
      summary: "approval modal",
    },
  ];
  const preview = await store.previewRollback(
    "checkpoint_0",
    ledger,
    resources,
    true,
  );
  expect(preview.dryRun).toBe(true);
  expect(preview.resources.map((resource) => resource.action)).toEqual([
    "stop",
    "preserve_dirty",
    "stop",
    "invalidate",
  ]);
  expect(events).toContain("rollback.previewed");
});

test("rollback applies resource policies and projects restored context", async () => {
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  ledger.add({ id: "baseline", role: "user", content: "baseline" });
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_resource_apply",
    workspaceRoot: root,
    context: ledger,
  });
  ledger.add({ id: "later", role: "user", content: "later" });
  const policies: string[] = [];
  let restored = 0;
  await store.rollbackTo("checkpoint_0", {
    context: ledger,
    resources: [
      { kind: "terminal", id: "pty_1", status: "running", summary: "shell" },
      {
        kind: "sandbox",
        id: "box_1",
        status: "preserve_dirty",
        summary: "dirty",
      },
    ],
    onResourcePolicy: async (policy) => {
      policies.push(`${policy.kind}:${policy.action}`);
    },
    onContextRestored: async () => {
      restored++;
    },
  });
  expect(policies).toEqual(["terminal:stop"]);
  expect(restored).toBe(1);
  expect(ledger.snapshot().entries.map((entry) => entry.id)).toEqual([
    "baseline",
  ]);
});

test("commands, typed events and session replay are stable", async () => {
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  const session = createSessionRecord("ses_projection", "projection");
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_projection",
    workspaceRoot: root,
    context: ledger,
    onEvent: (event) => appendSessionEvent(session, event),
  });
  await writeFile(join(root, "file.txt"), "content\n");
  const created = await runCheckpointCommand(store, ledger, "/checkpoint");
  expect(created.output).toContain("checkpoint_1");
  const listed = await runCheckpointCommand(
    store,
    ledger,
    "/checkpoints --limit 5",
  );
  expect(listed.output).toContain("files=1");
  const dryRun = await runCheckpointCommand(
    store,
    ledger,
    "/rollback checkpoint_0 --dry-run",
  );
  expect(dryRun.output).toContain("dry-run");
  const rollback = await runCheckpointCommand(store, ledger, "/rollback last");
  expect(rollback.output).toContain("rollback");

  const checkpointEvent = session.events.find(
    (event) => event.type === "checkpoint.created",
  )!;
  expect(checkpointEvent.type).toBe("checkpoint.created");
  expect(session.events.map((event) => event.type)).toEqual(
    expect.arrayContaining([
      "checkpoint.created",
      "rollback.previewed",
      "rollback.end",
    ]),
  );
});

test("disabled and initialization failure emit visible diagnostics", async () => {
  const root = await tempWorkspace();
  const disabled: string[] = [];
  await CheckpointStore.open({
    sessionID: "ses_disabled",
    workspaceRoot: root,
    enabled: false,
    onEvent: (event) => disabled.push(event.type),
  });
  expect(disabled).toEqual(["checkpoint.unavailable"]);

  const failed: string[] = [];
  const fileStore = join(root, "not-a-dir");
  await writeFile(fileStore, "x");
  await CheckpointStore.open({
    sessionID: "ses_failed",
    workspaceRoot: root,
    storeDir: fileStore,
    onEvent: (event) => failed.push(event.type),
  });
  expect(failed).toEqual(["checkpoint.unavailable"]);
});

test("checkpoint rename persists a user label in the journal", async () => {
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_rename",
    workspaceRoot: root,
    context: ledger,
  });
  const renamed = await store.rename("checkpoint_0", "  before tools  ");
  expect(renamed.name).toBe("before tools");
  const reopened = await CheckpointStore.open({
    sessionID: "ses_rename",
    workspaceRoot: root,
  });
  expect((await reopened.list())[0]?.name).toBe("before tools");
});

/**
 * The A + CDC contract in one test: an append-only session must store only the
 * new entries per checkpoint (so the journal stays tiny and does not grow
 * quadratically), yet every materialized context must be byte-identical to the
 * full snapshot it replaced, and a rollback must restore one exactly.
 */
test("append-only checkpoints stay small and replay their contexts exactly", async () => {
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_delta_replay",
    workspaceRoot: root,
    context: ledger,
  });
  const expected: string[][] = [[]];
  const N = 60;
  for (let index = 1; index <= N; index++) {
    ledger.add({
      id: `m${index}`,
      role: "user",
      content: `message ${index} `.repeat(40),
    });
    await store.createCheckpoint({
      reason: "manual",
      context: ledger,
      step: index,
      status: "manual",
    });
    expected.push(ledger.snapshot().entries.map((entry) => entry.id));
  }

  const records = await store.list();
  expect(records.length).toBe(N + 1);
  // Listings carry only the scalar header — no ledger entries materialized.
  expect(records.every((record) => record.context === undefined)).toBe(true);

  let naiveBytes = 0;
  for (let index = 0; index <= N; index++) {
    const record = records[index]!;
    expect(record.contextMeta.entryCount).toBe(expected[index]!.length);
    const full = await store.get(record.id);
    expect(full?.context?.entries.map((entry) => entry.id)).toEqual(
      expected[index],
    );
    naiveBytes += Buffer.byteLength(JSON.stringify(full!.context!));
  }

  const journalBytes = (
    await readFile(
      join(
        defaultCheckpointStoreDir(root, "ses_delta_replay"),
        "journal.jsonl",
      ),
    )
  ).byteLength;
  // Full snapshots would be ~sum(index * entrySize); deltas should be a small
  // fraction of that, not merely "smaller".
  expect(journalBytes * 5).toBeLessThan(naiveBytes);

  // Rolling back the ledger must restore the exact entries of a middle
  // checkpoint, reconstructed from its delta chain.
  const middle = records[Math.floor(N / 2)]!;
  const live = new ContextLedger();
  for (let index = 0; index < N * 2; index++)
    live.add({ id: `live${index}`, role: "user", content: "live state" });
  await store.rollbackTo(middle.id, { context: live });
  expect(live.snapshot().entries.map((entry) => entry.id)).toEqual(
    expected[middle.sequence]!,
  );
});

/**
 * A legacy v2 journal (inline manifest + context) must be migrated in place to
 * v3 on first open, keep its `.v2-backup`, preserve every record and replay
 * each context exactly.
 */
test("a v2 journal migrates to v3 and keeps every checkpoint", async () => {
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_migrate_v2",
    workspaceRoot: root,
    context: ledger,
  });
  const expected: string[][] = [[]];
  for (let index = 1; index <= 5; index++) {
    ledger.add({ id: `m${index}`, role: "user", content: `turn ${index}` });
    await store.createCheckpoint({
      reason: "manual",
      context: ledger,
      step: index,
      status: "manual",
    });
    expected.push(ledger.snapshot().entries.map((entry) => entry.id));
  }
  const journalPath = join(
    defaultCheckpointStoreDir(root, "ses_migrate_v2"),
    "journal.jsonl",
  );
  // Rewrite the file in the legacy inline shape.
  const full = await store
    .list()
    .then(async (records) =>
      Promise.all(records.map((record) => store.get(record.id))),
    );
  await writeFile(
    journalPath,
    `${full
      .map((record) =>
        JSON.stringify({
          ...record,
          schemaVersion: 2,
          context: record!.context,
        }),
      )
      .join("\n")}\n`,
  );

  // Re-open: the migration runs before the journal is read.
  const reopened = await CheckpointStore.open({
    sessionID: "ses_migrate_v2",
    workspaceRoot: root,
  });
  const migrated = await reopened.list();
  expect(migrated.length).toBe(6);
  for (let index = 0; index < migrated.length; index++) {
    const record = await reopened.get(migrated[index]!.id);
    expect(record?.context?.entries.map((entry) => entry.id)).toEqual(
      expected[index],
    );
  }
  const rewritten = await readFile(journalPath, "utf8");
  expect(rewritten).toContain('"schemaVersion":3');
  expect(rewritten).not.toContain('"schemaVersion":2');
  await lstat(`${journalPath}.v2-backup`);
});

/**
 * Sub-4KB payloads (the common case: a tool call adds one or two entries) are
 * inlined in the journal line instead of becoming one-block chunk files, which
 * is where most of the small-file overhead came from.
 */
test("small checkpoint payloads are inlined instead of chunked", async () => {
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_inline",
    workspaceRoot: root,
    context: ledger,
  });
  ledger.add({ id: "m1", role: "user", content: "small turn" });
  await store.createCheckpoint({
    reason: "manual",
    context: ledger,
    step: 1,
    status: "manual",
  });
  const journal = await readFile(
    join(defaultCheckpointStoreDir(root, "ses_inline"), "journal.jsonl"),
    "utf8",
  );
  expect(journal).toContain('"inline"');
  expect(journal).not.toContain('"ref"');
  // No chunk files were needed at all for these small payloads.
  const chunkFiles = await countFiles(
    join(workspaceChunksRoot(root), "ses_inline"),
  );
  expect(chunkFiles).toBe(0);
});

async function countFiles(root: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries)
    count += entry.isDirectory()
      ? await countFiles(join(root, entry.name))
      : entry.isFile()
        ? 1
        : 0;
  return count;
}

/**
 * Regression: appending one checkpoint must not read (or rewrite) the whole
 * journal. The old path called `list()` in `ensureBaseline` and again in
 * `createCheckpointLocked`, then serialized every record back out. On a long
 * session the journal reaches hundreds of MB, so each turn's
 * `createTurnCheckpoint` stalled before the provider ran — the fix reads only
 * the journal tail and appends one line. `list()` is spied on because a full
 * read is exactly what regressed; asserting on wall-clock time would be flaky.
 */
test("a checkpoint appends without reading the whole journal", async () => {
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  ledger.add({ id: "user-1", role: "user", content: "checkpoint" });
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_append_only",
    workspaceRoot: root,
    context: ledger,
  });

  const realList = store.list.bind(store);
  let listCalls = 0;
  store.list = async () => {
    listCalls += 1;
    return await realList();
  };

  // Both entry points on the turn path: the baseline existence check and the
  // turn's own checkpoint creation.
  await store.ensureBaseline(ledger, 0);
  const created = await store.createCheckpoint({
    reason: "turn_begin",
    context: ledger,
    step: 1,
    status: "turn_begin",
  });
  expect(listCalls).toBe(0);

  // Correctness is unchanged: the record is appended with the next sequence
  // and stays visible to a full read.
  expect(created.sequence).toBe(1);
  expect((await realList()).map((record) => record.id)).toEqual([
    "checkpoint_0",
    "checkpoint_1",
  ]);
});

test("list() omits the manifest and loadManifest rebuilds it on demand", async () => {
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  await writeFile(join(root, "a.txt"), "one\n");
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_manifest_lazy",
    workspaceRoot: root,
    context: ledger,
  });
  const [summary] = await store.list();
  // Scalars stay available without materializing the (potentially huge) entries.
  expect(summary!.manifest).toBeUndefined();
  expect(summary!.manifestMeta.complete).toBe(true);
  expect(summary!.manifestMeta.entryCount).toBeGreaterThan(0);
  // The full manifest is rebuilt on demand from the stored delta chain.
  const manifest = await store.loadManifest(summary!);
  expect(Object.keys(manifest.entries)).toContain("a.txt");
  // A full get() carries both context and manifest.
  const full = await store.get(summary!.id);
  expect(full?.manifest).toBeDefined();
  expect(Object.keys(full!.manifest!.entries)).toContain("a.txt");
});

async function tempWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "natalia-checkpoint-"));
  await writeFile(join(root, ".gitignore"), "ignored.log\n");
  return root;
}

test("chunk/object GC unions every session sharing the workspace stores", async () => {
  const root = await tempWorkspace();
  const ledgerA = new ContextLedger();
  const ledgerB = new ContextLedger();
  await writeFile(join(root, "a-only.txt"), "a-only-content\n");
  const storeA = await initializeDefaultCheckpointStore({
    sessionID: "ses_gc_shared_a",
    workspaceRoot: root,
    context: ledgerA,
  });
  // A checkpoints before b-only exists, so A's manifest does not reference it.
  const recordA = await storeA.createCheckpoint({
    reason: "manual",
    context: ledgerA,
    step: 1,
  });

  await writeFile(join(root, "b-only.txt"), "b-only-content\n");
  const storeB = await initializeDefaultCheckpointStore({
    sessionID: "ses_gc_shared_b",
    workspaceRoot: root,
    context: ledgerB,
  });
  const recordB = await storeB.createCheckpoint({
    reason: "manual",
    context: ledgerB,
    step: 1,
  });

  // A dry-run from A must see B's objects and chunks as reachable.
  const dryRun = await storeA.gcObjects(true);
  expect(dryRun.unreachableObjects).toBe(0);
  expect(dryRun.unreachableChunks).toBe(0);

  // A real GC from A must not prune B's shared payloads.
  await storeA.gcObjects(false);
  const manifestB = await storeB.loadManifest(recordB);
  expect(Object.keys(manifestB.entries)).toContain("b-only.txt");
  // And A's own payload still resolves.
  const manifestA = await storeA.loadManifest(recordA);
  expect(Object.keys(manifestA.entries)).toContain("a-only.txt");
});

test("checkpoint store migrates a legacy per-session chunk root on load", async () => {
  const root = await tempWorkspace();
  const sessionID = "ses_legacy_chunk_migrate";
  const ledger = new ContextLedger();
  const payload = Buffer.from("legacy chunk payload ".repeat(200));
  const legacyRoot = join(workspaceChunksRoot(root), sessionID);
  // Build the pre-A3 loose layout by hand: `<legacyRoot>/<xx>/<hash>`.
  const chunks: string[] = [];
  for (const chunk of contentDefinedChunks(payload)) {
    const hash = createHash("sha256").update(chunk).digest("hex");
    const path = join(legacyRoot, hash.slice(0, 2), hash);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, chunk);
    chunks.push(hash);
  }
  const ref = { chunks, size: payload.length };

  const store = await initializeDefaultCheckpointStore({
    sessionID,
    workspaceRoot: root,
    context: ledger,
  });
  await store.list(); // triggers loadJournal → migrateLegacyRoots

  const shared = new ChunkStore(workspaceChunksRoot(root));
  expect(await shared.get(ref)).toEqual(payload);
  let legacyStillThere = true;
  try {
    await readdir(legacyRoot);
  } catch {
    legacyStillThere = false;
  }
  expect(legacyStillThere).toBe(false);
});

test("pruneV2Backups removes the backup once the v3 journal reconstructs", async () => {
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  await writeFile(join(root, "keep.txt"), "keep\n");
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_prune_ok",
    workspaceRoot: root,
    context: ledger,
  });
  await store.createCheckpoint({ reason: "manual", context: ledger, step: 1 });
  const journalPath = join(
    defaultCheckpointStoreDir(root, "ses_prune_ok"),
    "journal.jsonl",
  );
  const backupPath = `${journalPath}.v2-backup`;
  await writeFile(backupPath, "{}\n");

  const pruned = await pruneV2Backups(root);
  expect(pruned.pruned).toBe(1);
  expect(pruned.bytes).toBeGreaterThan(0);
  expect(existsSync(backupPath)).toBe(false);
});

test("pruneV2Backups keeps the backup when v3 cannot reconstruct", async () => {
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  await writeFile(join(root, "keep.txt"), "keep\n");
  // Force the ledger payload past the inline threshold so it is chunked.
  for (let index = 0; index < 200; index++)
    ledger.add({
      id: `msg_${index}`,
      role: "user",
      content: "x".repeat(200),
    });
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_prune_keep",
    workspaceRoot: root,
    context: ledger,
  });
  await store.createCheckpoint({ reason: "manual", context: ledger, step: 1 });
  const journalPath = join(
    defaultCheckpointStoreDir(root, "ses_prune_keep"),
    "journal.jsonl",
  );
  const backupPath = `${journalPath}.v2-backup`;
  await writeFile(backupPath, "{}\n");
  // Break the shared chunk store: the newest record can no longer reconstruct.
  await rm(workspaceChunksRoot(root), { recursive: true, force: true });

  await expect(pruneV2Backups(root)).rejects.toThrow();
  expect(existsSync(backupPath)).toBe(true);
});

test("a second capture reuses the stat cache instead of re-reading the tree", async () => {
  // T5-1: the checkpoint used to readFile+sha256 every file on every
  // checkpoint — ~8 GiB of I/O per tool call on this repository's own tree,
  // which is what the 20,000-file / 512 MiB guards exist to cap. The stat
  // cache makes an unchanged file neither read nor hashed again: this counts
  // the reads through a spy on the file the scan opens.
  const root = await tempWorkspace();
  await writeFile(join(root, "keep.txt"), "stable content\n");
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_stat_cache",
    workspaceRoot: root,
    context: new ContextLedger(),
  });
  const manifestBefore = await store.loadManifest((await store.list())[0]!);
  expect(manifestBefore.entries["keep.txt"]?.objectHash).toMatch(
    /^[0-9a-f]{64}$/,
  );

  // A second capture: nothing changed, so the hash must come from the cache.
  // Proof by mutation of the cached hash — if the scan re-read the file it
  // would recompute the true one.
  const cacheFile = join(
    defaultCheckpointStoreDir(root, "ses_stat_cache"),
    "stat-cache.json",
  );
  const cache = JSON.parse(await readFile(cacheFile, "utf8")) as {
    entries: Record<string, { objectHash: string }>;
  };
  expect(Object.keys(cache.entries)).toContain("keep.txt");
  cache.entries["keep.txt"]!.objectHash = "f".repeat(64);
  await writeFile(cacheFile, JSON.stringify(cache));

  // A fresh CAPTURE (not a journal replay: that would rebuild the manifest
  // from the stored delta chain and never touch the file) with nothing
  // changed on disk.
  const reopened = await CheckpointStore.open({
    sessionID: "ses_stat_cache",
    workspaceRoot: root,
  });
  const captured = await reopened.createCheckpoint({
    reason: "manual",
    context: new ContextLedger(),
    step: 1,
  });
  const manifestAfter = await reopened.loadManifest(captured);
  // The poisoned hash came back: the file was NOT re-read.
  expect(manifestAfter.entries["keep.txt"]?.objectHash).toBe("f".repeat(64));
  // And the cache now carries it forward (the record overwrote the poison),
  // which is what the NEXT capture will trust.
  const rewritten = JSON.parse(await readFile(cacheFile, "utf8")) as {
    entries: Record<string, { objectHash: string }>;
  };
  expect(rewritten.entries["keep.txt"]?.objectHash).toBe("f".repeat(64));
});

test("a changed file is re-hashed even when its size is unchanged", async () => {
  // The stat tuple, not a shortcut: a same-size in-place rewrite keeps the
  // size and (often) lands inside one mtime tick, so size+mtime alone is
  // exactly the check that loses writes. ino is part of the tuple for the
  // replace-in-place case.
  const root = await tempWorkspace();
  await writeFile(join(root, "data.txt"), "aaaa\n");
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_stat_change",
    workspaceRoot: root,
    context: new ContextLedger(),
  });
  const first = await store.loadManifest((await store.list())[0]!);
  // Same length, different bytes.
  await writeFile(join(root, "data.txt"), "bbbb\n");
  const changed = await store.createCheckpoint({
    reason: "manual",
    context: new ContextLedger(),
    step: 1,
  });
  const after = await store.loadManifest(changed);
  expect(after.entries["data.txt"]?.objectHash).not.toBe(
    first.entries["data.txt"]?.objectHash,
  );
});

test("a corrupt stat cache degrades to a full recompute, never a wrong hash", async () => {
  const root = await tempWorkspace();
  await writeFile(join(root, "real.txt"), "real content\n");
  const storeDirless = join(root, ".natalia", "checkpoints");
  await mkdir(storeDirless, { recursive: true });
  await writeFile(join(storeDirless, "stat-cache.json"), "{ this is not json");
  const store = await CheckpointStore.open({
    sessionID: "ses_stat_corrupt",
    workspaceRoot: root,
    storeDir: storeDirless,
  });
  const record = await store.createCheckpoint({
    reason: "manual",
    context: new ContextLedger(),
    step: 1,
  });
  const manifest = await store.loadManifest(record);
  // The true hash, recomputed from the file — not the garbage in the cache.
  expect(manifest.entries["real.txt"]?.objectHash).toBe(
    createHash("sha256").update("real content\n").digest("hex"),
  );
});

test("an unbounded capture keeps a large tree complete, and a configured ceiling still guards", async () => {
  // T5-2: the 20,000-file / 512 MiB defaults were fail-closed proxies for
  // the full-tree re-read cost. This repository's own tree crossed the file
  // count at the 20,000th file (457.6 MiB), so its baseline was born
  // incomplete and /rollback refused. With the stat cache the cost is
  // O(changed files), so the proxy is gone by default — while a deployment
  // that WANTS a ceiling still gets one.
  const root = await tempWorkspace();
  await writeFile(join(root, "one.txt"), "one\n");
  await writeFile(join(root, "two.txt"), "two\n");
  const ledger = new ContextLedger();
  const unbounded = await CheckpointStore.open({
    sessionID: "ses_stat_unbounded",
    workspaceRoot: root,
  });
  const complete = await unbounded.createCheckpoint({
    reason: "baseline",
    context: ledger,
    step: 0,
  });
  expect(complete.complete).toBe(true);
  expect(complete.errors).toEqual([]);

  // The same tree, with an operator's ceiling: the guard still fires and
  // still marks the manifest incomplete (a configured cap is a real cap).
  const capped = await CheckpointStore.open({
    sessionID: "ses_stat_capped",
    workspaceRoot: root,
    maxFiles: 1,
  });
  const guarded = await capped.createCheckpoint({
    reason: "baseline",
    context: ledger,
    step: 0,
  });
  expect(guarded.complete).toBe(false);
  expect(guarded.errors.join("\n")).toContain("file count guard exceeded: 1");
});

test("the checkpoint ceilings are opt-in: an unset config ships no cap", async () => {
  // T5-2's actual change, at the layer that shipped it: the config no
  // longer carries 20,000 files / 512 MiB defaults. The temp-workspace
  // capture above cannot tell Infinity from 20,000 (three files are below
  // both), so the assertion is on the shipped default itself — the thing
  // that used to make this repository's own baseline incomplete.
  const parsed = checkpointConfigSchema.parse({});
  expect(parsed.maxFiles).toBeUndefined();
  expect(parsed.maxBytes).toBeUndefined();
  // And an explicit ceiling is still honoured (a configured cap is a real
  // cap — the guard fires at it, as the test above shows).
  expect(checkpointConfigSchema.parse({ maxFiles: 7 }).maxFiles).toBe(7);
});

test("disk usage counts the object and chunk libraries, not just the journal", async () => {
  // T5-9: the number an operator reads before touching a ceiling used to be
  // `directorySize(storeDir)` — the journal alone — while the objects and
  // chunks deliberately live outside it. On a real workspace the journal is
  // kilobytes and the shared objects are the gigabytes, so the reported
  // footprint was off by the two largest parts.
  const root = await tempWorkspace();
  // A file past the object store's chunkMin: it lands in the object library
  // (chunked), which is exactly the part the old number missed. The bytes
  // are deliberately incompressible and non-repeating: constant content
  // dedupes to a handful of chunks and the library stays tiny, which would
  // make the assertion below vacuous.
  await writeFile(
    join(root, "big.payload"),
    Buffer.from(
      Array.from({ length: 200 * 1024 }, (_, index) => (index * 31) & 0xff),
    ),
  );
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_disk_usage",
    workspaceRoot: root,
    context: new ContextLedger(),
  });
  const usage = await store.diskUsageBytes();
  const journalOnly = await directorySizeForTest(
    defaultCheckpointStoreDir(root, "ses_disk_usage"),
  );
  expect(journalOnly).toBeGreaterThan(0);
  // The object library holds the payload's bytes, so the total is strictly
  // larger than the journal it used to report.
  expect(usage).toBeGreaterThan(journalOnly + 100 * 1024);
});

async function directorySizeForTest(path: string): Promise<number> {
  const { readdir, lstat } = await import("node:fs/promises");
  const walk = async (target: string): Promise<number> => {
    try {
      const info = await lstat(target);
      if (info.isFile() || info.isSymbolicLink()) return info.size;
      if (!info.isDirectory()) return 0;
      const entries = await readdir(target);
      let size = 0;
      for (const entry of entries) size += await walk(join(target, entry));
      return size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  };
  return walk(path);
}

test("a damaged journal line and a newer-format journal are different refusals", async () => {
  // T5-8: the two rejections a reader must tell apart. A line that is not
  // JSON is a DAMAGED file — a storage fact naming the file and line. A
  // journal written by a NEWER build is intact but unreadable HERE — the
  // refusal names the upgrade, because "your file is corrupt" would send an
  // operator hunting a disk problem that does not exist. Conflating them is
  // how a version skew becomes a support ticket about disks.
  const root = await tempWorkspace();
  const damaged = await CheckpointStore.open({
    sessionID: "ses_journal_damaged",
    workspaceRoot: root,
  });
  await damaged.createCheckpoint({
    reason: "manual",
    context: new ContextLedger(),
    step: 1,
  });
  const journalPath = join(
    defaultCheckpointStoreDir(root, "ses_journal_damaged"),
    "journal.jsonl",
  );
  const good = await readFile(journalPath, "utf8");
  await writeFile(journalPath, `${good}{ this line is not json\n`);
  const reopened = await CheckpointStore.open({
    sessionID: "ses_journal_damaged",
    workspaceRoot: root,
  });
  await expect(reopened.list()).rejects.toThrow(
    CheckpointJournalCorruptionError,
  );
  await expect(reopened.list()).rejects.toThrow(
    /is damaged: line \d+ is not valid JSON/u,
  );

  // The version skew: an intact v4 record.
  const future = await CheckpointStore.open({
    sessionID: "ses_journal_future",
    workspaceRoot: root,
  });
  await future.createCheckpoint({
    reason: "manual",
    context: new ContextLedger(),
    step: 1,
  });
  const futurePath = join(
    defaultCheckpointStoreDir(root, "ses_journal_future"),
    "journal.jsonl",
  );
  const stored = await readFile(futurePath, "utf8");
  await writeFile(
    futurePath,
    stored.replace(/"schemaVersion":3/gu, '"schemaVersion":4'),
  );
  const futureReopened = await CheckpointStore.open({
    sessionID: "ses_journal_future",
    workspaceRoot: root,
  });
  await expect(futureReopened.list()).rejects.toThrow(
    CheckpointJournalUnsupportedError,
  );
  await expect(futureReopened.list()).rejects.toThrow(
    /upgrade Natalia to open it/u,
  );
});

test("a rollback moves a pointer; the records above it stay reconstructible", async () => {
  // T5-3: the rollback used to physically truncate the journal — the one
  // destructive operation in an append-only log. It re-anchored the safety
  // checkpoint by hand (its delta base was being deleted under it) and
  // destroyed every record between the target and the rollback, so rolling
  // back to one of them afterwards was impossible.
  //
  // The pointer keeps all of it: the visible window ends at the target, the
  // records above stay on disk with their delta chains, and a later rollback
  // to any of them is an ordinary pointer move.
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_rollback_pointer",
    workspaceRoot: root,
    context: ledger,
  });
  await writeFile(join(root, "v1.txt"), "one\n");
  const first = await store.createCheckpoint({
    reason: "manual",
    context: ledger,
    step: 1,
  });
  await writeFile(join(root, "v2.txt"), "two\n");
  const second = await store.createCheckpoint({
    reason: "manual",
    context: ledger,
    step: 2,
  });
  await writeFile(join(root, "v3.txt"), "three\n");
  const third = await store.createCheckpoint({
    reason: "manual",
    context: ledger,
    step: 3,
  });
  const baseline = (await store.list())[0]!;

  // Roll back to the middle record.
  await store.rollbackTo(second.id, { context: ledger });
  expect((await store.list()).map((record) => record.id)).toEqual([
    baseline.id,
    first.id,
    second.id,
  ]);
  // The workspace is the middle record's, not the newest one's.
  expect(existsSync(join(root, "v3.txt"))).toBe(false);
  expect(await readFile(join(root, "v2.txt"), "utf8")).toBe("two\n");

  // The NEWEST record is still reachable and still holds its manifest — the
  // delta chain was never truncated.
  const reopened = await CheckpointStore.open({
    sessionID: "ses_rollback_pointer",
    workspaceRoot: root,
  });
  const newest = await reopened.get(third.id);
  expect(newest?.id).toBe(third.id);
  expect(Object.keys(newest!.manifest!.entries)).toContain("v3.txt");

  // And rolling FORWARD to it is an ordinary pointer move — the records the
  // first rollback moved past come back.
  await reopened.rollbackTo(third.id, { context: ledger });
  expect((await reopened.list()).map((record) => record.id)).toEqual([
    baseline.id,
    first.id,
    second.id,
    third.id,
  ]);
  expect(existsSync(join(root, "v3.txt"))).toBe(true);
});

test("a ref resolves over the whole log, above the rollback pointer", async () => {
  // T5-4: refs used to resolve through `list()` — the visible window. A
  // rollback that moved past an audit round's checkpoint made
  // `{kind:"round", planID, round}` fail with "audit round not found" for a
  // round whose record was sitting one line above the pointer: durable,
  // addressable, and unreachable.
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_ref_above_pointer",
    workspaceRoot: root,
    context: ledger,
  });
  await writeFile(join(root, "a.txt"), "one\n");
  await store.createAuditRoundCheckpoint({
    planID: "plan_ref",
    round: 1,
    verdict: "gaps",
    context: ledger,
    step: 1,
    sessionID: "ses_ref_above_pointer" as SessionID,
  });
  await writeFile(join(root, "a.txt"), "two\n");
  await store.createCheckpoint({
    reason: "manual",
    context: ledger,
    step: 2,
  });

  // Roll back below the round's checkpoint. The workspace is restored to
  // checkpoint_0, so "current" (a live capture) and the round's content now
  // agree — an empty diff is the honest answer for THIS pair.
  await store.rollbackTo("checkpoint_0", { context: ledger });
  // The round is no longer in the visible window …
  const visible = await store.list();
  expect(visible.some((record) => record.reason === "audit_round")).toBe(false);
  // … but the ref still RESOLVES — that is the property: the round's record
  // is one line above the pointer, durable and addressable. The pair that
  // shows its content is the round against the record the session wrote
  // after it (checkpoint_1, also above the pointer).
  const above = await store.allRecords();
  const manual = above.find((record) => record.reason === "manual")!;
  const after = await store.diffCheckpoints(
    { kind: "round", planID: "plan_ref", round: 1 },
    { kind: "checkpoint", id: manual.id },
  );
  expect(
    after.some(
      (change) =>
        change.path === "a.txt" &&
        change.after?.includes("two") &&
        change.before?.includes("one"),
    ),
  ).toBe(true);
});

test("GC reachability survives a rollback that moved past live records", async () => {
  // T5-7 + T5-3: the records a rollback pointer moved past are still
  // reachable — a later rollback can move the pointer back to any of them,
  // so a GC that only saw the visible window would delete payloads the
  // journal still names. Reachability is derived from each record's direct
  // object references (an anchor names all of its entries, a delta names
  // what it added), so the walk covers the whole log without materializing
  // a single manifest.
  const root = await tempWorkspace();
  const ledger = new ContextLedger();
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_gc_pointer",
    workspaceRoot: root,
    context: ledger,
  });
  await writeFile(join(root, "keep.txt"), "kept payload ".repeat(40));
  const first = await store.createCheckpoint({
    reason: "manual",
    context: ledger,
    step: 1,
  });
  await writeFile(join(root, "above.txt"), "above the pointer\n");
  const above = await store.createCheckpoint({
    reason: "manual",
    context: ledger,
    step: 2,
  });
  const baseline = (await store.list())[0]!;
  // Roll back below the record that holds above.txt.
  await store.rollbackTo(first.id, { context: ledger });
  expect((await store.list()).map((record) => record.id)).toEqual([
    baseline.id,
    first.id,
  ]);

  // A GC now must not prune above.txt's object: the record naming it is one
  // line above the pointer.
  const dryRun = await store.gcObjects(true);
  expect(dryRun.unreachableObjects).toBe(0);
  await store.gcObjects(false);
  // And the record above the pointer still materializes its manifest.
  const reopened = await CheckpointStore.open({
    sessionID: "ses_gc_pointer",
    workspaceRoot: root,
  });
  const record = await reopened.get(above.id);
  expect(Object.keys(record!.manifest!.entries)).toContain("above.txt");
});

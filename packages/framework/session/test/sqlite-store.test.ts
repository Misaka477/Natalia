import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type { SessionRecord } from "../src";
import {
  initProjection,
  applyProjection,
  viewProjection,
  foldProjection,
  restoreProjection,
  serializeProjectionState,
  projectSessionMessages,
  SqliteSessionStore,
} from "../src";
import { createSessionRecord } from "../src";

test("SQLite auto titles preserve manual titles and unrelated metadata", () => {
  const path = join(tmpdir(), `natalia-title-${crypto.randomUUID()}.db`);
  const store = new SqliteSessionStore(path);
  const sessionID = "ses_title" as SessionID;
  try {
    store.create(sessionID, "New session");
    store.updateMetadata(sessionID, {
      pinned: true,
      lastAccessedAt: "2026-08-17T00:00:00.000Z",
    });
    store.setAutoTitle(sessionID, "Generated title", "generated");
    expect(store.get(sessionID)).toMatchObject({
      title: "Generated title",
      metadata: {
        titleSource: "generated",
        pinned: true,
        lastAccessedAt: "2026-08-17T00:00:00.000Z",
      },
    });

    store.rename(sessionID, "Manual title");
    store.setAutoTitle(sessionID, "Delayed title", "generated");
    expect(store.get(sessionID)).toMatchObject({
      title: "Manual title",
      metadata: {
        titleSource: "manual",
        pinned: true,
        lastAccessedAt: "2026-08-17T00:00:00.000Z",
      },
    });
  } finally {
    store.close();
  }
});

test("SQLite session history uses stable sequence cursors", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sqlite-history-"));
  const store = new SqliteSessionStore(join(root, "sessions.db"));
  store.create("ses_history", "History");
  for (const id of ["one", "two", "three"]) {
    store.appendEvent("ses_history", {
      type: "turn.submitted",
      id,
      text: id,
      byteLength: id.length,
      lineCount: 1,
      sha256: "test",
    });
  }
  const first = store.loadEventPage("ses_history", { limit: 2 });
  expect(first.events.map((item) => item.seq)).toEqual([1, 2]);
  expect(first.hasMore).toBe(true);
  const second = store.loadEventPage("ses_history", {
    after: first.events[1]!.seq,
    limit: 2,
  });
  expect(second.events.map((item) => item.seq)).toEqual([3]);
  expect(second.hasMore).toBe(false);
  store.close();
});

test("SQLite message pages use turn cursors without loading unrelated history", () => {
  const path = join(tmpdir(), `natalia-message-page-${crypto.randomUUID()}.db`);
  const store = new SqliteSessionStore(path);
  const sessionID = "ses_message_page" as const;
  try {
    store.create(sessionID, "Message page");
    for (const id of ["turn_one", "turn_two", "turn_three"]) {
      store.appendEvents(sessionID, [
        {
          type: "turn.submitted",
          id,
          text: id,
          byteLength: id.length,
          lineCount: 1,
          sha256: "fixture",
        },
        { type: "content.done", id, text: `${id} response` },
        { type: "turn.finished", id, stopReason: "done" },
      ]);
    }
    const first = store.loadMessagePage(sessionID, { order: "asc", limit: 2 });
    expect(first.data.map((message) => message.id)).toEqual([
      "turn_one",
      "turn_two",
    ]);
    expect(first.data[0]?.rows.map((row) => row.kind)).toEqual([
      "user",
      "assistant",
      "system",
    ]);
    expect(first.cursor.next).toEqual(expect.any(String));

    const next = store.loadMessagePage(sessionID, {
      cursor: first.cursor.next,
    });
    expect(next.data.map((message) => message.id)).toEqual(["turn_three"]);
    expect(next.cursor.previous).toEqual(expect.any(String));

    const previous = store.loadMessagePage(sessionID, {
      cursor: next.cursor.previous,
      limit: 2,
    });
    expect(previous.data.map((message) => message.id)).toEqual([
      "turn_one",
      "turn_two",
    ]);

    const latest = store.loadMessagePage(sessionID, { limit: 2 });
    expect(latest.data.map((message) => message.id)).toEqual([
      "turn_three",
      "turn_two",
    ]);
    const older = store.loadMessagePage(sessionID, {
      cursor: latest.cursor.next,
      limit: 2,
    });
    expect(older.data.map((message) => message.id)).toEqual(["turn_one"]);
  } finally {
    store.close();
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

test("SQLite descending message pages keep turn.input with its owning turn", () => {
  const path = join(
    tmpdir(),
    `natalia-message-input-${crypto.randomUUID()}.db`,
  );
  const store = new SqliteSessionStore(path);
  const sessionID = "ses_message_input" as const;
  try {
    store.create(sessionID, "Message input page");
    for (const id of ["turn_one", "turn_two", "turn_three"]) {
      store.appendEvents(sessionID, [
        {
          type: "turn.submitted",
          id,
          text: id,
          byteLength: id.length,
          lineCount: 1,
          sha256: "fixture",
        },
        // A mid-turn injected input belongs to the turn it names. Descending
        // pages ask for newest turns first, and the old seq-slice projection
        // let this row leak into the previous turn, where view-store applied it
        // a second time as a duplicate.
        ...(id === "turn_two"
          ? [
              {
                type: "turn.input" as const,
                turnID: id,
                inputID: "input_two",
                text: "steer turn two",
                delivery: "next-step" as const,
              },
            ]
          : []),
        { type: "content.done", id, text: `${id} response` },
        { type: "turn.finished", id, stopReason: "done" },
      ]);
    }

    const page = store.loadMessagePage(sessionID, { limit: 3 });
    expect(page.data.map((message) => message.id)).toEqual([
      "turn_three",
      "turn_two",
      "turn_one",
    ]);
    const rowsFor = (turnID: string) =>
      page.data
        .find((message) => message.id === turnID)
        ?.rows.map((row) => row.event)
        .filter((event) => event.type === "turn.input") ?? [];
    expect(rowsFor("turn_one")).toEqual([]);
    expect(rowsFor("turn_two")).toEqual([
      {
        type: "turn.input",
        turnID: "turn_two",
        inputID: "input_two",
        text: "steer turn two",
        delivery: "next-step",
      },
    ]);
    expect(rowsFor("turn_three")).toEqual([]);
  } finally {
    store.close();
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

test("SQLite message pages match the event-stream projector", () => {
  const path = join(
    tmpdir(),
    `natalia-message-parity-${crypto.randomUUID()}.db`,
  );
  const store = new SqliteSessionStore(path);
  const sessionID = "ses_message_parity" as const;
  try {
    store.create(sessionID, "Message parity");
    for (const id of ["turn_one", "turn_two", "turn_three"]) {
      store.appendEvents(sessionID, [
        {
          type: "turn.submitted",
          id,
          text: id,
          byteLength: id.length,
          lineCount: 1,
          sha256: "fixture",
        },
        ...(id === "turn_two"
          ? [
              {
                type: "turn.input" as const,
                turnID: id,
                inputID: "input_two",
                text: "steer two",
                delivery: "next-step" as const,
              },
            ]
          : []),
        { type: "content.done" as const, id, text: `${id} answer` },
        { type: "turn.finished" as const, id, stopReason: "done" as const },
      ]);
    }
    const events = store.loadEvents(sessionID);
    for (const order of ["asc", "desc"] as const) {
      const sqlite = store.loadMessagePage(sessionID, { order, limit: 3 });
      const projected = projectSessionMessages(
        {
          id: sessionID,
          title: "",
          createdAt: "",
          events,
          cancelled: false,
          resumable: true,
        },
        { order, limit: 3 },
      );
      expect(sqlite).toEqual(projected);
    }
  } finally {
    store.close();
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

test("SQLite context epoch tracks checkpoint baseline sequence", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sqlite-context-epoch-"));
  const store = new SqliteSessionStore(join(root, "sessions.db"));
  store.create("ses_epoch", "Epoch");
  store.appendEvent("ses_epoch", {
    type: "context.checkpoint",
    id: "epoch_one",
    snapshot: {
      entries: [{ id: "user", role: "user", content: "hello" }],
      resources: [],
      journalOffset: 1,
      step: 1,
      tokenEstimate: 2,
      compactionGeneration: 0,
    },
  });
  store.appendEvent("ses_epoch", {
    type: "turn.finished",
    id: "turn_one",
    stopReason: "done",
  });
  expect(store.loadContextEpoch("ses_epoch")).toEqual({
    baselineSeq: 1,
    snapshot: {
      entries: [{ id: "user", role: "user", content: "hello" }],
      resources: [],
      journalOffset: 1,
      step: 1,
      tokenEstimate: 2,
      compactionGeneration: 0,
    },
  });
  store.close();
});

test("SQLite compaction removes live-only and epoch-superseded events", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sqlite-compact-"));
  const store = new SqliteSessionStore(join(root, "sessions.db"));
  const sessionID = "ses_compact" as SessionID;
  try {
    store.create(sessionID, "Compact");
    store.appendEvents(sessionID, [
      {
        type: "session.snapshot",
        id: "snap_one",
        agentStatus: "idle",
        changedFiles: 0,
        unvalidatedChanges: 0,
        hasPTY: false,
        hasSandbox: false,
      },
      {
        type: "rollback.previewed",
        preview: {
          checkpointID: "checkpoint_one",
          dryRun: true,
          changes: [],
          context: {
            truncateMessages: 0,
            targetJournalOffset: 0,
            targetStep: 0,
            targetTokens: 0,
            compactionGeneration: 0,
          },
          resources: [],
          ignoredFiles: 0,
          diskUsageBytes: 0,
          complete: true,
          warnings: [],
        },
      },
      {
        type: "context.checkpoint",
        id: "epoch_one",
        snapshot: {
          entries: [{ id: "user", role: "user", content: "hello" }],
          resources: [],
          journalOffset: 1,
          step: 1,
          tokenEstimate: 2,
          compactionGeneration: 0,
        },
      },
      { type: "turn.finished", id: "turn_one", stopReason: "done" },
    ]);
    store.writeContextEpoch(sessionID, {
      entries: [{ id: "user", role: "user", content: "hello" }],
      resources: [],
      journalOffset: 1,
      step: 1,
      tokenEstimate: 2,
      compactionGeneration: 0,
    });

    expect(store.compactHistoricalEvents()).toContain(sessionID);
    const events = store.loadEvents(sessionID);
    expect(events.some((event) => event.type === "session.snapshot")).toBe(
      false,
    );
    expect(events.some((event) => event.type === "rollback.previewed")).toBe(
      false,
    );
    expect(events.some((event) => event.type === "context.checkpoint")).toBe(
      false,
    );
    expect(events.some((event) => event.type === "turn.finished")).toBe(true);
  } finally {
    store.close();
  }
});

test("SQLite recovery projection tracks durable control state and backfills history", () => {
  const path = join(tmpdir(), `natalia-recovery-${crypto.randomUUID()}.db`);
  const store = new SqliteSessionStore(path);
  const sessionID = "ses_recovery" as const;
  try {
    store.create(sessionID, "Recovery");
    store.appendEvents(sessionID, [
      {
        type: "agent.selection",
        name: "reviewer",
        pending: false,
      },
      { type: "model.selection", modelID: "model-a", variant: "fast" },
      {
        type: "turn.submitted",
        id: "turn_active",
        text: "active",
        byteLength: 6,
        lineCount: 1,
        sha256: "fixture",
        attachments: [
          {
            id: "attachment_one",
            path: "/tmp/one.txt",
            filename: "one.txt",
            mediaType: "text/plain",
            byteLength: 1,
            sha256: "fixture",
          },
        ],
      },
      {
        type: "approval.request",
        id: "turn_active:approval",
        title: "Approve",
        preview: "fixture",
      },
      {
        type: "question.request",
        id: "turn_active:question",
        title: "Question",
        questions: [],
      },
    ]);
    const projection = store.loadRecoveryProjection(sessionID);
    expect(projection.activeTurnIDs).toEqual(["turn_active"]);
    expect(projection.approvals).toHaveLength(1);
    expect(projection.questions).toHaveLength(1);
    expect(projection.selectedAgent).toBe("reviewer");
    expect(projection.selectedModel).toEqual({
      modelID: "model-a",
      variant: "fast",
    });
    expect(projection.attachments.get("turn_active")?.[0]?.filename).toBe(
      "one.txt",
    );

    store.appendEvents(sessionID, [
      {
        type: "approval.response",
        id: "turn_active:approval",
        decision: "once",
      },
      { type: "question.response", id: "turn_active:question", answers: [] },
      { type: "turn.finished", id: "turn_active", stopReason: "done" },
    ]);
    const settled = store.loadRecoveryProjection(sessionID);
    expect(settled.activeTurnIDs).toEqual([]);
    expect(settled.approvals).toEqual([]);
    expect(settled.questions).toEqual([]);
  } finally {
    store.close();
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

test("SQLite recovery projection keeps the latest bounded diagnostics", () => {
  const path = join(tmpdir(), `natalia-diagnostics-${crypto.randomUUID()}.db`);
  const store = new SqliteSessionStore(path);
  const sessionID = "ses_diagnostics" as const;
  try {
    store.create(sessionID, "Diagnostics");
    store.appendEvents(
      sessionID,
      Array.from({ length: 505 }, (_, index) => ({
        type: "diagnostic" as const,
        level: "info" as const,
        message: `diagnostic ${index}`,
        at: "2026-07-25T00:00:00.000Z",
      })),
    );
    const diagnostics = store.loadRecoveryProjection(sessionID).diagnostics;
    expect(diagnostics).toHaveLength(500);
    expect(diagnostics[0]?.message).toBe("diagnostic 5");
    expect(diagnostics.at(-1)?.message).toBe("diagnostic 504");
  } finally {
    store.close();
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

test("SQLite attachment references include history and pending input attachments", () => {
  const path = join(tmpdir(), `natalia-attachments-${crypto.randomUUID()}.db`);
  const store = new SqliteSessionStore(path);
  const session = createSessionRecord("ses_attachments", "Attachments");
  const historyAttachment = {
    id: "att_history",
    path: ".natalia/attachments/att_history-history.txt",
    filename: "history.txt",
    mediaType: "text/plain" as const,
    byteLength: 1,
    sha256: "history",
  };
  const inputAttachment = {
    id: "att_input",
    path: ".natalia/attachments/att_input-input.txt",
    filename: "input.txt",
    mediaType: "text/plain" as const,
    byteLength: 1,
    sha256: "input",
  };
  session.events.push({
    type: "turn.submitted",
    id: "turn_history",
    text: "history",
    byteLength: 7,
    lineCount: 1,
    sha256: "fixture",
    attachments: [historyAttachment],
  });
  session.inbox = [
    {
      id: "turn_input",
      sessionID: session.id,
      text: "input",
      attachments: [inputAttachment],
      delivery: "next-turn",
      admittedAt: "2026-07-25T00:00:00.000Z",
      admittedSeq: 1,
    },
  ];
  try {
    store.replace(session);
    expect(
      store.referencedAttachments().map((attachment) => attachment.id),
    ).toEqual(expect.arrayContaining(["att_history", "att_input"]));
  } finally {
    store.close();
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

test("SQLite session replacement preserves duplicate history and metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sqlite-replace-"));
  const store = new SqliteSessionStore(join(root, "sessions.db"));
  const session = createSessionRecord("ses_copy", "Copy");
  session.metadata = {
    pinned: true,
    lastAccessedAt: "2026-07-22T00:00:00.000Z",
  };
  session.events.push({
    type: "turn.submitted",
    id: "turn_copy",
    text: "hello",
    byteLength: 5,
    lineCount: 1,
    sha256: "test",
  });
  store.replace(session);
  expect(store.get("ses_copy")?.pinned).toBe(true);
  expect(store.eventCount("ses_copy")).toBe(1);
  store.updateMetadata("ses_copy", { pinned: false });
  expect(store.get("ses_copy")?.pinned).toBe(false);
  store.delete("ses_copy");
  expect(store.get("ses_copy")).toBeUndefined();
  expect(store.loadEvents("ses_copy")).toEqual([]);
  expect(store.loadContextEpoch("ses_copy")).toBeUndefined();
  store.close();
});

test("SQLite session records retain inbox through duplicate and fork", () => {
  const root = join(tmpdir(), `natalia-sqlite-inbox-${crypto.randomUUID()}.db`);
  const store = new SqliteSessionStore(root);
  const session = createSessionRecord("ses_inbox", "Inbox");
  session.events.push(
    {
      type: "turn.submitted",
      id: "turn_one",
      text: "one",
      byteLength: 3,
      lineCount: 1,
      sha256: "fixture",
    },
    {
      type: "turn.submitted",
      id: "turn_two",
      text: "two",
      byteLength: 3,
      lineCount: 1,
      sha256: "fixture",
    },
  );
  session.inbox = [
    {
      id: "turn_one",
      sessionID: session.id,
      text: "one",
      delivery: "next-step",
      admittedAt: "2026-07-25T00:00:00.000Z",
      admittedSeq: 1,
      promotedAt: "2026-07-25T00:00:01.000Z",
      promotedSeq: 1,
    },
    {
      id: "turn_two",
      sessionID: session.id,
      text: "two",
      delivery: "next-turn",
      admittedAt: "2026-07-25T00:00:02.000Z",
      admittedSeq: 2,
    },
  ];
  try {
    store.replace(session);
    expect(store.pendingInputCount(session.id)).toBe(1);
    expect(store.duplicate(session.id, "ses_inbox_copy").inbox).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionID: "ses_inbox_copy" }),
      ]),
    );
    expect(store.fork(session.id, "turn_two", "ses_inbox_fork").inbox).toEqual([
      expect.objectContaining({ id: "turn_one", sessionID: "ses_inbox_fork" }),
    ]);
  } finally {
    store.close();
    rmSync(root, { force: true, recursive: true });
    rmSync(`${root}-wal`, { force: true });
    rmSync(`${root}-shm`, { force: true });
  }
});

test("SQLite delete removes message index state before session row", () => {
  const path = join(
    tmpdir(),
    `natalia-message-index-delete-${crypto.randomUUID()}.db`,
  );
  const store = new SqliteSessionStore(path);
  const sessionID = "ses_delete_index" as const;
  try {
    store.create(sessionID, "Delete with message index");
    store.appendEvent(sessionID, {
      type: "turn.submitted",
      id: "turn_delete",
      text: "hello",
      byteLength: 5,
      lineCount: 1,
      sha256: "test",
    });
    store.loadMessagePage(sessionID, {});
    store.delete(sessionID);
    expect(store.get(sessionID)).toBeUndefined();
    expect(store.wasDeleted(sessionID)).toBe(true);
    store.create(sessionID, "Recreated");
    expect(store.wasDeleted(sessionID)).toBe(false);
  } finally {
    store.close();
  }
});

test("SQLite truncateAfter removes events and message turn suffixes", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sqlite-truncate-after-"));
  const store = new SqliteSessionStore(join(root, "sessions.db"));
  const sessionID = "ses_truncate" as const;
  try {
    store.create(sessionID, "Truncate");
    store.appendEvents(sessionID, [
      {
        type: "turn.submitted",
        id: "turn_one",
        text: "one",
        byteLength: 3,
        lineCount: 1,
        sha256: "test",
      },
      {
        type: "turn.finished",
        id: "turn_one",
        stopReason: "done",
      },
      {
        type: "turn.submitted",
        id: "turn_two",
        text: "two",
        byteLength: 3,
        lineCount: 1,
        sha256: "test",
      },
    ]);
    store.truncateAfter(sessionID, 2);
    expect(store.loadEvents(sessionID).map((event) => event.type)).toEqual([
      "turn.submitted",
      "turn.finished",
    ]);
    expect(store.loadMessagePage(sessionID, {}).data.length).toBe(1);
  } finally {
    store.close();
    rmSync(root, { force: true, recursive: true });
    rmSync(`${root}-wal`, { force: true });
    rmSync(`${root}-shm`, { force: true });
  }
});

test("SQLite enforces session foreign keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sqlite-foreign-keys-"));
  const store = new SqliteSessionStore(join(root, "sessions.db"));
  expect(() =>
    store.appendEvent("ses_missing", {
      type: "turn.finished",
      id: "turn_missing",
      stopReason: "done",
    }),
  ).toThrow();
  store.close();
});

test("SQLite batches async durable appends and flushes settlement barriers", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sqlite-async-batch-"));
  const store = new SqliteSessionStore(join(root, "sessions.db"));
  const sessionID = "ses_async_batch" as SessionID;
  try {
    store.create(sessionID, "async batch");
    store.enqueueEvent(sessionID, {
      type: "turn.submitted",
      id: "turn_async",
      text: "hello",
      byteLength: 5,
      lineCount: 1,
      sha256: "test",
    });
    store.enqueueEvent(sessionID, {
      type: "status.update",
      status: "working",
    });
    await store.flushPendingWrites(sessionID);
    expect(store.loadEvents(sessionID).map((event) => event.type)).toEqual([
      "turn.submitted",
      "status.update",
    ]);
    await store.appendEventAsync(sessionID, {
      type: "turn.finished",
      id: "turn_async",
      stopReason: "done",
    });
    expect(store.loadRecoveryProjection(sessionID).activeTurnIDs).toEqual([]);
    expect(store.loadEvents(sessionID)).toHaveLength(3);
  } finally {
    store.close();
    rmSync(root, { force: true, recursive: true });
    rmSync(`${root}-wal`, { force: true });
    rmSync(`${root}-shm`, { force: true });
  }
});

test("SQLite close flushes queued async durable appends", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sqlite-close-flush-"));
  const path = join(root, "sessions.db");
  const sessionID = "ses_close_flush" as SessionID;
  const store = new SqliteSessionStore(path);
  store.create(sessionID, "close flush");
  store.enqueueEvent(sessionID, {
    type: "turn.submitted",
    id: "turn_close",
    text: "persist me",
    byteLength: 10,
    lineCount: 1,
    sha256: "test",
  });
  store.close();
  const reopened = new SqliteSessionStore(path);
  try {
    expect(reopened.loadEvents(sessionID)).toEqual([
      expect.objectContaining({ type: "turn.submitted", id: "turn_close" }),
    ]);
  } finally {
    reopened.close();
    rmSync(root, { force: true, recursive: true });
    rmSync(`${root}-wal`, { force: true });
    rmSync(`${root}-shm`, { force: true });
  }
});

test("SQLite batch barriers survive reopen without waiting for the timer", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sqlite-barrier-reopen-"));
  const path = join(root, "sessions.db");
  const sessionID = "ses_barrier_reopen" as SessionID;
  const store = new SqliteSessionStore(path);
  store.create(sessionID, "barrier reopen");
  store.enqueueEvent(sessionID, {
    type: "turn.submitted",
    id: "turn_barrier",
    text: "durable before settlement",
    byteLength: 25,
    lineCount: 1,
    sha256: "test",
  });
  store.enqueueEvent(sessionID, {
    type: "turn.finished",
    id: "turn_barrier",
    stopReason: "done",
  });
  await store.flushPendingWrites(sessionID);
  store.close();
  const reopened = new SqliteSessionStore(path);
  try {
    expect(reopened.loadEvents(sessionID).map((event) => event.type)).toEqual([
      "turn.submitted",
      "turn.finished",
    ]);
    expect(reopened.loadRecoveryProjection(sessionID).activeTurnIDs).toEqual(
      [],
    );
  } finally {
    reopened.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test("SQLite passive checkpoint preserves event reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sqlite-checkpoint-"));
  const store = new SqliteSessionStore(join(root, "sessions.db"));
  try {
    store.create("ses_checkpoint", "checkpoint");
    store.appendEvent("ses_checkpoint", {
      type: "diagnostic",
      level: "info",
      message: "checkpoint me",
      at: "2026-07-25T00:00:00.000Z",
    });
    expect(store.checkpoint()).toMatchObject({ busy: expect.any(Number) });
    expect(store.eventCount("ses_checkpoint")).toBe(1);
  } finally {
    store.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test("auto-saved checkpoint + tail replay matches a full projection", () => {
  const path = join(
    tmpdir(),
    `natalia-projection-cache-${crypto.randomUUID()}.db`,
  );
  const store = new SqliteSessionStore(path);
  const sessionID = "ses_projection_cache" as SessionID;
  try {
    store.create(sessionID, "Projection cache");
    const events: RuntimeEvent[] = [];
    const push = (event: RuntimeEvent) => {
      events.push(event);
      store.appendEvent(sessionID, event);
    };
    // A durable barrier auto-saves the checkpoint here (seq 4).
    push({
      type: "turn.submitted",
      id: "t1",
      text: "a",
      byteLength: 1,
      lineCount: 1,
      sha256: "x",
    });
    push({ type: "agent.selection", name: "reviewer", pending: false });
    push({ type: "model.selection", modelID: "alpha", variant: "fast" });
    push({ type: "turn.finished", id: "t1", stopReason: "done" });

    const checkpoint = store.loadProjectionCheckpoint(sessionID);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.lastSeq).toBe(4);

    // A non-barrier tail: the checkpoint stays at the barrier sequence.
    push({
      type: "turn.submitted",
      id: "t2",
      text: "b",
      byteLength: 1,
      lineCount: 1,
      sha256: "y",
    });
    push({
      type: "tool.update",
      id: "t2:call_1",
      name: "read_file",
      callID: "call_1",
      status: "succeeded",
      summary: "read",
      result: "ok",
    });
    push({ type: "model.selection", modelID: "beta", variant: "careful" });

    const loaded = store.loadProjectionCheckpoint(sessionID);
    expect(loaded!.lastSeq).toBe(4);
    for (const event of store.loadEventsAfter(sessionID, loaded!.lastSeq))
      applyProjection(loaded!.state, event);
    const resumed = viewProjection(loaded!.state);

    const full = foldProjection(events);
    expect(resumed).toEqual(full);
    expect(resumed.selectedModel).toEqual({
      modelID: "beta",
      variant: "careful",
    });
    expect(resumed.completedTurnIDs.sort()).toEqual(["t1"]);
    expect(resumed.activeTurnIDs).toEqual(["t2"]);
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
});

test("a projection checkpoint from an older state version is discarded", () => {
  const path = join(
    tmpdir(),
    `natalia-projection-stale-${crypto.randomUUID()}.db`,
  );
  const store = new SqliteSessionStore(path);
  const sessionID = "ses_projection_stale" as SessionID;
  try {
    store.create(sessionID, "Stale cache");
    store.appendEvent(sessionID, {
      type: "turn.submitted",
      id: "t1",
      text: "a",
      byteLength: 1,
      lineCount: 1,
      sha256: "x",
    });
    const state = initProjection();
    applyProjection(state, {
      type: "turn.submitted",
      id: "t1",
      text: "a",
      byteLength: 1,
      lineCount: 1,
      sha256: "x",
    });
    store.saveProjectionCheckpoint(sessionID, state);
    // Simulate a checkpoint written by a future/older fold shape.
    const db = store as unknown as {
      db: { run: (sql: string, params: unknown[]) => void };
    };
    db.db.run(
      `UPDATE projection_checkpoints SET state_version = state_version + 999 WHERE session_id = ?`,
      [sessionID],
    );
    expect(store.loadProjectionCheckpoint(sessionID)).toBeUndefined();
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
});

test("restoreProjection uses a disk checkpoint + tail and fails soft to full", () => {
  const path = join(
    tmpdir(),
    `natalia-restore-ladder-${crypto.randomUUID()}.db`,
  );
  const store = new SqliteSessionStore(path);
  const sessionID = "ses_restore_ladder" as SessionID;
  try {
    store.create(sessionID, "Restore ladder");
    const events: RuntimeEvent[] = [];
    const push = (event: RuntimeEvent) => {
      events.push(event);
      store.appendEvent(sessionID, event);
    };
    push({
      type: "turn.submitted",
      id: "t1",
      text: "a",
      byteLength: 1,
      lineCount: 1,
      sha256: "x",
    });
    push({ type: "model.selection", modelID: "alpha", variant: "fast" });

    const full = { id: sessionID, events } as unknown as SessionRecord;
    const adapter = {
      loadProjectionCheckpoint: (id: string) => {
        const loaded = store.loadProjectionCheckpoint(id as SessionID);
        return loaded
          ? {
              serializedState: serializeProjectionState(loaded.state),
              lastSeq: loaded.lastSeq,
            }
          : undefined;
      },
      eventsAfter: (id: string, after: number) =>
        store.loadEventsAfter(id as SessionID, after),
    };

    // No checkpoint yet: fail soft to a full projection (no regression).
    expect(restoreProjection(sessionID, full, adapter)).toEqual(
      foldProjection(events),
    );

    // Checkpoint after the first two events (lastSeq = 2).
    const checkpointState = initProjection();
    applyProjection(checkpointState, events[0]!);
    applyProjection(checkpointState, events[1]!);
    expect(store.saveProjectionCheckpoint(sessionID, checkpointState)).toBe(2);

    // Append the tail, then restore: checkpoint + tail replay.
    push({ type: "turn.finished", id: "t1", stopReason: "done" });
    const resumed = restoreProjection(sessionID, full, adapter);
    expect(resumed).toEqual(foldProjection(events));
    expect(resumed.completedTurnIDs).toEqual(["t1"]);
    expect(resumed.selectedModel).toEqual({
      modelID: "alpha",
      variant: "fast",
    });
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
});

test("appending durable events auto-saves a projection checkpoint", () => {
  const path = join(
    tmpdir(),
    `natalia-projection-autosave-${crypto.randomUUID()}.db`,
  );
  const store = new SqliteSessionStore(path);
  const sessionID = "ses_projection_autosave" as SessionID;
  try {
    store.create(sessionID, "Autosave");
    // A non-barrier event does not persist a checkpoint yet.
    store.appendEvent(sessionID, {
      type: "model.selection",
      modelID: "alpha",
      variant: "fast",
    });
    expect(store.loadProjectionCheckpoint(sessionID)).toBeUndefined();

    // A durable barrier (turn.finished) flushes a checkpoint.
    store.appendEvent(sessionID, {
      type: "turn.submitted",
      id: "t1",
      text: "a",
      byteLength: 1,
      lineCount: 1,
      sha256: "x",
    });
    store.appendEvent(sessionID, {
      type: "turn.finished",
      id: "t1",
      stopReason: "done",
    });
    const checkpoint = store.loadProjectionCheckpoint(sessionID);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.lastSeq).toBe(3);
    expect([...checkpoint!.state.completedTurnIDs]).toEqual(["t1"]);
    expect(viewProjection(checkpoint!.state).selectedModel).toEqual({
      modelID: "alpha",
      variant: "fast",
    });

    // A rollback drops the checkpoint and the live fold.
    store.truncateAfter(sessionID, 2);
    expect(store.loadProjectionCheckpoint(sessionID)).toBeUndefined();
    // A new durable barrier re-saves a checkpoint reflecting the truncated log
    // (turn.submitted survived, so t1 completes again).
    store.appendEvent(sessionID, {
      type: "turn.finished",
      id: "t1",
      stopReason: "done",
    });
    const afterRollback = store.loadProjectionCheckpoint(sessionID);
    expect(afterRollback).toBeDefined();
    expect([...afterRollback!.state.completedTurnIDs]).toEqual(["t1"]);
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
});

test("SQLite message pages index turns below an overshot watermark", () => {
  // The watermark in message_index_state is the session's MAX sequence, which
  // in a shared journal is a journal-global number. buildMessageIndex used it
  // as a per-session cursor (`seq > last_seq`), so a turn written below it was
  // never indexed and the page came back empty: a restart showed a blank
  // transcript and a zero usage bar for a session that was correct live.
  const path = join(
    tmpdir(),
    `natalia-message-overshoot-${crypto.randomUUID()}.db`,
  );
  const store = new SqliteSessionStore(path);
  const sessionID = "ses_message_overshoot" as SessionID;
  const raw = store as unknown as {
    db: { run: (sql: string, params: unknown[]) => void };
  };
  try {
    store.create(sessionID, "Overshoot");
    store.appendEvents(sessionID, [
      {
        type: "turn.submitted",
        id: "turn_old",
        text: "old question",
        byteLength: 12,
        lineCount: 1,
        sha256: "fixture",
      },
      {
        type: "runtime.step_usage",
        id: "turn_old:usage:1",
        inputTokens: 1_200,
        outputTokens: 300,
      },
      { type: "turn.finished", id: "turn_old", stopReason: "done" },
    ]);
    // The state the broken cursor produced: the turn exists in the journal but
    // was never indexed, and the watermark sits above it (a shared journal's
    // sequence number). Both halves are needed — an eager append indexes the
    // turn, so the repair path only runs for a journal written by another
    // path (an import, a rollback) or an older build.
    raw.db.run(`DELETE FROM message_turns WHERE session_id = ?`, [sessionID]);
    raw.db.run(
      `INSERT INTO message_index_state(session_id, last_seq) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_seq = excluded.last_seq`,
      [sessionID, 5_000],
    );
    const page = store.loadMessagePage(sessionID, { limit: 100 });
    expect(page.data.map((message) => message.id)).toEqual(["turn_old"]);
    const usageRows = page.data[0]?.rows.filter(
      (row) => row.event.type === "runtime.step_usage",
    );
    expect(usageRows).toHaveLength(1);
  } finally {
    store.close();
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

test("SQLite message index currency is measured in the sequence domain", () => {
  // messageIndexIsCurrent compared the session's max sequence against its
  // EVENT COUNT. Those only match for a single-session journal whose
  // sequences start at 1, so on a real multi-session journal the index was
  // never current and every page load rebuilt it — the skip never fired.
  const path = join(
    tmpdir(),
    `natalia-message-currency-${crypto.randomUUID()}.db`,
  );
  const store = new SqliteSessionStore(path);
  const filler = "ses_message_currency_filler" as SessionID;
  const sessionID = "ses_message_currency" as SessionID;
  try {
    // A first session takes the low sequence numbers.
    store.create(filler, "Filler");
    store.appendEvents(
      filler,
      Array.from({ length: 50 }, (_, index) => ({
        type: "diagnostic" as const,
        level: "info" as const,
        message: `filler ${index}`,
        at: new Date().toISOString(),
      })),
    );
    // The session under test therefore starts far above sequence 1.
    store.create(sessionID, "Late");
    store.appendEvents(sessionID, [
      {
        type: "turn.submitted",
        id: "turn_late",
        text: "late question",
        byteLength: 13,
        lineCount: 1,
        sha256: "fixture",
      },
      { type: "turn.finished", id: "turn_late", stopReason: "done" },
    ]);
    // First load builds the index.
    expect(
      store.loadMessagePage(sessionID, { limit: 100 }).data.map((m) => m.id),
    ).toEqual(["turn_late"]);
    // Currency is now true in the sequence domain: the watermark equals the
    // session's max sequence (not its event count, which is 2 here while the
    // sequence is past 50). The observable promise is that the page stays
    // correct without a rebuild, so the second load is exact too.
    expect(
      store.loadMessagePage(sessionID, { limit: 100 }).data.map((m) => m.id),
    ).toEqual(["turn_late"]);
  } finally {
    store.close();
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

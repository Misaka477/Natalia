import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttachmentService } from "@anthelia/attachments";
import type { SessionID } from "@anthelia/contracts";
import {
  JsonSessionStore,
  SqliteSessionStore,
  createSessionRecord,
} from "@anthelia/session";
import {
  createLocalSessionService,
  createSessionStoreController,
} from "../src";

test("local session service preserves offline JSON and SQLite visibility", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-local-session-service-"));
  const json = new JsonSessionStore(join(root, ".natalia", "sessions"));
  await json.save(createSessionRecord("ses_json" as SessionID, "JSON"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  const sqlite = new SqliteSessionStore(join(root, ".natalia", "sessions.db"));
  sqlite.create("ses_sqlite" as SessionID, "SQLite");
  sqlite.close();

  const sessions = createLocalSessionService(root);
  expect((await sessions.list()).map((session) => session.id).sort()).toEqual([
    "ses_json",
    "ses_sqlite",
  ]);
  expect(await sessions.show("ses_sqlite")).toMatchObject({
    id: "ses_sqlite",
    title: "SQLite",
  });
  expect(await sessions.rename("ses_json", "Renamed")).toEqual({
    id: "ses_json",
    title: "Renamed",
  });
});

test("session store controller initializes sqlite mode and lists sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-store-"));
  const controller = createSessionStoreController({
    workspaceRoot: root,
    sessionID: () => "ses_host" as SessionID,
    useSqliteStore: true,
    attachments: createAttachmentService(root),
  });

  await controller.init();
  expect(controller.status()).toEqual({ initialized: true, mode: "sqlite" });
  const listing = await controller.list();
  expect(listing.some((session) => session.id === "ses_host")).toBe(true);
  await controller.close();
  expect(controller.status()).toEqual({ initialized: false, mode: "sqlite" });
});

test("sqlite init preserves existing active JSON session history", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-session-store-active-json-"),
  );
  const json = new JsonSessionStore(join(root, ".natalia", "sessions"));
  const legacy = createSessionRecord(
    "ses_active_json" as SessionID,
    "Active JSON",
  );
  legacy.events.push({
    type: "turn.finished",
    id: "turn_json",
    sessionID: "ses_active_json",
  } as never);
  await json.save(legacy);
  const controller = createSessionStoreController({
    workspaceRoot: root,
    sessionID: () => "ses_active_json" as SessionID,
    useSqliteStore: true,
    attachments: createAttachmentService(root),
  });

  await controller.init();
  const listing = await controller.list();
  expect(
    listing.find((session) => session.id === "ses_active_json"),
  ).toMatchObject({
    id: "ses_active_json",
    title: "Active JSON",
    events: 1,
  });
  await controller.close();
});

test("sqlite mode deletes a legacy JSON session not yet imported", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-session-store-delete-legacy-"),
  );
  const json = new JsonSessionStore(join(root, ".natalia", "sessions"));
  await json.save(
    createSessionRecord("ses_legacy_delete" as SessionID, "Legacy Delete"),
  );
  const controller = createSessionStoreController({
    workspaceRoot: root,
    sessionID: () => "ses_host" as SessionID,
    useSqliteStore: true,
    attachments: createAttachmentService(root),
  });

  await controller.init();
  await controller.delete("ses_legacy_delete" as SessionID);

  const after = new JsonSessionStore(join(root, ".natalia", "sessions"));
  expect(await after.load("ses_legacy_delete" as SessionID)).toBeUndefined();
  await controller.close();
});

test("sqlite init does not resurrect JSON sessions after they were deleted", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-session-store-no-resurrect-"),
  );
  const json = new JsonSessionStore(join(root, ".natalia", "sessions"));
  await json.save(createSessionRecord("ses_keep" as SessionID, "Keep"));
  await json.save(createSessionRecord("ses_gone" as SessionID, "Gone"));
  const first = createSessionStoreController({
    workspaceRoot: root,
    sessionID: () => "ses_host" as SessionID,
    useSqliteStore: true,
    attachments: createAttachmentService(root),
  });
  await first.init();
  expect(
    (await first.list()).some((session) => session.id === "ses_keep"),
  ).toBe(true);
  await first.delete("ses_gone" as SessionID);
  await json.save(createSessionRecord("ses_gone" as SessionID, "Gone again"));
  await first.close();

  const second = createSessionStoreController({
    workspaceRoot: root,
    sessionID: () => "ses_host" as SessionID,
    useSqliteStore: true,
    attachments: createAttachmentService(root),
  });
  await second.init();
  const listing = await second.list();
  expect(listing.some((session) => session.id === "ses_keep")).toBe(true);
  expect(listing.some((session) => session.id === "ses_gone")).toBe(false);
  const leftover = new JsonSessionStore(join(root, ".natalia", "sessions"));
  expect(await leftover.load("ses_gone" as SessionID)).toBeUndefined();
  expect(await leftover.load("ses_keep" as SessionID)).toBeUndefined();
  await second.close();
});

test("session store eventWindow pages contiguous per-session order", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-window-"));
  const controller = createSessionStoreController({
    workspaceRoot: root,
    sessionID: () => "ses_host" as SessionID,
    useSqliteStore: true,
    attachments: createAttachmentService(root),
  });
  await controller.init();
  const created = await controller.create({
    id: "ses_window",
    title: "Window",
  });
  const loaded = await controller.load(created.sessionID as SessionID);
  await controller.appendEvents(
    loaded.session,
    Array.from({ length: 5 }, (_, index) => ({
      type: "content.done" as const,
      id: `turn_${index}`,
      text: `answer ${index}`,
    })),
  );
  await controller.flush(created.sessionID as SessionID);

  const tail = await controller.eventWindow(
    created.sessionID as SessionID,
    [],
    {
      limit: 3,
    },
  );
  expect(tail.events.map((entry) => entry.sessionSeq)).toEqual([3, 4, 5]);
  expect(
    tail.events.map((entry) =>
      entry.event.type === "content.done" ? entry.event.text : undefined,
    ),
  ).toEqual(["answer 2", "answer 3", "answer 4"]);
  expect(tail.hasMore).toBe(true);

  const older = await controller.eventWindow(
    created.sessionID as SessionID,
    [],
    { beforeSeq: 3, limit: 3 },
  );
  expect(older.events.map((entry) => entry.sessionSeq)).toEqual([1, 2]);
  expect(older.hasMore).toBe(false);
  await controller.close();
});

test("session store controller archives and restores a session without deleting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-archive-"));
  const controller = createSessionStoreController({
    workspaceRoot: root,
    sessionID: () => "ses_host" as SessionID,
    useSqliteStore: true,
    attachments: createAttachmentService(root),
  });

  await controller.init();
  await controller.create({ id: "ses_archive", title: "Archive me" });

  const archived = await controller.archive("ses_archive");
  expect(archived).toEqual({ id: "ses_archive", archived: true });

  const listing = await controller.list();
  expect(
    listing.find((session) => session.id === "ses_archive")?.archived,
  ).toBe(true);

  const restored = await controller.restore("ses_archive");
  expect(restored).toEqual({ id: "ses_archive", archived: false });

  const after = await controller.list();
  expect(after.find((session) => session.id === "ses_archive")?.archived).toBe(
    false,
  );

  await controller.close();
});

test("session store controller rolls messages back to a turn boundary", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-session-message-rollback-"),
  );
  const controller = createSessionStoreController({
    workspaceRoot: root,
    sessionID: () => "ses_host" as SessionID,
    useSqliteStore: true,
    attachments: createAttachmentService(root),
  });
  await controller.init();
  const created = await controller.create({
    id: "ses_rollback",
    title: "Rollback",
  });
  const loaded = await controller.load(created.sessionID as SessionID);
  await controller.appendEvents(loaded.session, [
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
  // Roll back from the second turn: the selected turn and everything after it
  // are removed, so the first turn's boundary remains.
  const result = await controller.messageRollback("ses_rollback", "turn_two");
  expect(result).toEqual({ id: "ses_rollback", rolledBackTo: "turn_two" });
  const after = await controller.load("ses_rollback" as SessionID);
  expect(after.session.events.map((event) => event.type)).toEqual([
    "turn.submitted",
    "turn.finished",
  ]);
  await controller.close();
});

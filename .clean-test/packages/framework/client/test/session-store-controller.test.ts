import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStoreController } from "@anthelia/session-store";
import { createAttachmentService } from "@anthelia/attachments";
import type { SessionID } from "@anthelia/contracts";

test("session store: create is idempotent, archive marks, export dumps", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-store-"));
  const controller = createSessionStoreController({
    workspaceRoot: root,
    sessionID: () => "ses_host" as const,
    attachments: createAttachmentService(root),
  });
  await controller.init();

  const created = await controller.create({ id: "ses_a", title: "A" });
  expect(created).toEqual({ sessionID: "ses_a", created: true });
  const replay = await controller.create({ id: "ses_a" });
  expect(replay.created).toBe(false);

  // Metadata updates only need the session id; callers must not have to clone
  // (or otherwise construct) the full event-bearing record.
  await controller.updateMetadata("ses_a" as SessionID, { pinned: true });
  const loaded = await controller.load("ses_a" as SessionID);
  expect(loaded).toBeDefined();
  expect(loaded?.session?.metadata?.pinned).toBe(true);

  const archived = await controller.archive("ses_a");
  expect(archived.archived).toBe(true);
  const exported = await controller.export("ses_a");
  expect(exported.title).toBe("A");
  expect(exported.archived).toBe(true);

  const list = await controller.list();
  expect(list.some((summary) => summary.id === "ses_a")).toBe(true);

  const removed = await controller.delete("ses_a");
  expect(removed.removedAttachments).toBe(0);
  const after = await controller.list();
  expect(after.some((summary) => summary.id === "ses_a")).toBe(false);

  const missing = await controller
    .archive("ses_unknown")
    .catch((error: unknown) => error);
  expect((missing as Error).message).toContain("session not found");

  await controller.close();
});

test("session store: the active session refuses deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-store-2-"));
  const controller = createSessionStoreController({
    workspaceRoot: root,
    sessionID: () => "ses_active" as const,
    attachments: createAttachmentService(root),
  });
  await controller.init();
  const refused = await controller
    .delete("ses_active")
    .catch((error: unknown) => error);
  expect((refused as Error).message).toContain(
    "cannot delete the active runtime session",
  );
  await controller.close();
});

test("session store: JSON summaries project the pending human terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-store-pending-"));
  const controller = createSessionStoreController({
    workspaceRoot: root,
    sessionID: () => "ses_host" as const,
    attachments: createAttachmentService(root),
  });
  await controller.init();
  try {
    await controller.create({ id: "ses_wait", title: "Waiting" });
    const record = (await controller.load("ses_wait" as const)).session;
    record!.metadata = {
      pendingHumanTerminal: {
        terminalID: "tty_wait",
        reason: "needs the sudo password",
        since: "2026-08-12T00:00:00.000Z",
      },
    };
    await controller.updateMetadata(record!, record!.metadata);

    const summary = (await controller.list()).find(
      (entry) => entry.id === "ses_wait",
    );
    expect(summary?.pendingHumanTerminal).toMatchObject({
      terminalID: "tty_wait",
      reason: "needs the sudo password",
      since: "2026-08-12T00:00:00.000Z",
    });

    delete record!.metadata!.pendingHumanTerminal;
    await controller.updateMetadata(record!, {
      pendingHumanTerminal: undefined,
    });
    const after = await controller.list();
    expect(
      after.find((entry) => entry.id === "ses_wait")?.pendingHumanTerminal,
    ).toBeUndefined();
  } finally {
    await controller.close();
  }
});

test("session store: SQLite summaries project the pending human terminal", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-session-store-pending-db"),
  );
  const controller = createSessionStoreController({
    workspaceRoot: root,
    sessionID: () => "ses_host" as const,
    useSqliteStore: true,
    attachments: createAttachmentService(root),
  });
  await controller.init();
  try {
    await controller.create({ id: "ses_wait_sqlite", title: "Waiting" });
    const record = (await controller.load("ses_wait_sqlite" as const)).session;
    record.metadata = {
      pendingHumanTerminal: {
        terminalID: "tty_wait_sqlite",
        reason: "needs the sudo password",
        since: "2026-08-12T00:00:00.000Z",
      },
    };
    await controller.updateMetadata(record, record.metadata);

    const summary = (await controller.list()).find(
      (entry) => entry.id === "ses_wait_sqlite",
    );
    expect(summary?.pendingHumanTerminal).toMatchObject({
      terminalID: "tty_wait_sqlite",
      reason: "needs the sudo password",
    });

    delete record.metadata.pendingHumanTerminal;
    await controller.updateMetadata(record, {
      pendingHumanTerminal: undefined,
    });
    const after = await controller.list();
    expect(
      after.find((entry) => entry.id === "ses_wait_sqlite")
        ?.pendingHumanTerminal,
    ).toBeUndefined();
  } finally {
    await controller.close();
  }
});

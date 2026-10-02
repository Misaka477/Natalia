import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { JsonSessionStore } from "../src";

test("session store supports rename and delete for TUI session management", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-manage-"));
  const store = new JsonSessionStore(root);
  const session = await store.loadOrCreate("ses_manage" as SessionID, "before");
  expect((await store.rename(session.id, "after")).title).toBe("after");
  await store.delete(session.id);
  expect(await store.load(session.id)).toBeUndefined();
});

test("session store updateMetadata merges into existing record", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-meta-"));
  const store = new JsonSessionStore(root);
  const session = await store.loadOrCreate(
    "ses_meta1" as SessionID,
    "meta test",
  );
  await store.updateMetadata(session.id, {
    pinned: true,
    lastAccessedAt: "2026-07-01T00:00:00.000Z",
  });
  const loaded = await store.load(session.id);
  expect(loaded?.metadata?.pinned).toBe(true);
  expect(loaded?.metadata?.lastAccessedAt).toBe("2026-07-01T00:00:00.000Z");

  await store.updateMetadata(session.id, {
    lastAccessedAt: "2026-07-18T00:00:00.000Z",
  });
  const reloaded = await store.load(session.id);
  expect(reloaded?.metadata?.pinned).toBe(true);
  expect(reloaded?.metadata?.lastAccessedAt).toBe("2026-07-18T00:00:00.000Z");
});

test("session store updateMetadata rejects missing session", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-meta-miss-"));
  const store = new JsonSessionStore(root);
  await expect(
    store.updateMetadata("ses_nonexistent" as SessionID, { pinned: true }),
  ).rejects.toThrow("session not found");
});

test("session store duplicate creates a copy with new ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-dup-"));
  const store = new JsonSessionStore(root);
  const original = await store.loadOrCreate(
    "ses_orig" as SessionID,
    "original",
  );
  const event: RuntimeEvent = {
    type: "diagnostic",
    level: "info",
    message: "test",
  };
  original.events.push(event);
  await store.save(original);

  const copy = await store.duplicate(
    "ses_orig" as SessionID,
    "ses_copy" as SessionID,
  );
  expect(copy.id).toBe("ses_copy");
  expect(copy.title).toBe("original (copy)");
  expect(copy.events).toHaveLength(1);
  expect(copy.metadata?.lastAccessedAt).toBeDefined();

  const loaded = await store.load("ses_orig" as SessionID);
  expect(loaded?.id).toBe("ses_orig");
});

test("session store duplicate generates ID when not provided", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-dup-auto-"));
  const store = new JsonSessionStore(root);
  await store.loadOrCreate("ses_autodup" as SessionID, "auto dup");
  const copy = await store.duplicate("ses_autodup" as SessionID);
  expect(copy.id).toMatch(/^ses_/u);
  expect(copy.title).toBe("auto dup (copy)");
  expect(await store.load(copy.id)).toBeDefined();
});

test("session store duplicate rejects missing session", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-dup-miss-"));
  const store = new JsonSessionStore(root);
  await expect(store.duplicate("ses_ghost" as SessionID)).rejects.toThrow(
    "session not found",
  );
});

test("session list orders pinned sessions first, then by lastAccessedAt", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-order-"));
  const store = new JsonSessionStore(root);
  const s1 = await store.loadOrCreate("ses_a" as SessionID, "A");
  const s2 = await store.loadOrCreate("ses_b" as SessionID, "B");
  const s3 = await store.loadOrCreate("ses_c" as SessionID, "C");
  await store.updateMetadata(s3.id, {
    pinned: true,
    lastAccessedAt: "2026-07-18T00:00:00.000Z",
  });
  await store.updateMetadata(s1.id, {
    pinned: true,
    lastAccessedAt: "2026-07-17T00:00:00.000Z",
  });
  await store.updateMetadata(s2.id, {
    lastAccessedAt: "2026-07-16T00:00:00.000Z",
  });

  const list = await store.list();
  expect(list[0]!.id).toBe("ses_c");
  expect(list[1]!.id).toBe("ses_a");
  expect(list[2]!.id).toBe("ses_b");
});

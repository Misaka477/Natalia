import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type { SessionExecutionState } from "@anthelia/substrate";
import { ensureSessionFullEvents } from "@anthelia/substrate";
import { sessionStoreController } from "@anthelia/session-store";
import { createTestContext } from "@anthelia/runtime-services";
import type { SessionStoreController } from "@anthelia/session-store";

test("ensureSessionFullEvents loads the full log when the fast path seeded only a tail", async () => {
  const partial: RuntimeEvent[] = [
    {
      type: "navi.chat.message.new",
      id: "navi:partial",
      messageID: "partial",
      role: "chat",
      text: "tail only",
      at: "2026-01-01T00:00:00.000Z",
    },
  ];
  const full: RuntimeEvent[] = [
    {
      type: "navi.chat.message.new",
      id: "navi:old",
      messageID: "old",
      role: "chat",
      text: "old durable row",
      at: "2025-01-01T00:00:00.000Z",
    },
    ...partial,
  ];
  let loadFullCalls = 0;
  const store = {
    status: () => ({ initialized: true, mode: "sqlite" as const }),
    flush: async () => undefined,
    loadFullAsync: async () => {
      loadFullCalls += 1;
      return {
        id: "ses_full_events" as SessionID,
        title: "",
        createdAt: "",
        events: full,
        cancelled: false,
        resumable: true,
      };
    },
  };
  const ctx = {
    state: {
      // The full-events path reads only the status/loadFullAsync pair; the
      // double is path-limited, hence the explicit face cast.
      serviceDirectory: createTestContext([
        sessionStoreController.mock(store as unknown as SessionStoreController),
      ]),
    },
    ports: {
      resolveService: () => store,
      // Production always exposes this; the test store has no pending
      // persistence chain to drain, but the contract must still be honored.
      getSessionPersistenceForSession: async () => undefined,
    },
  } as unknown as import("@anthelia/substrate").RuntimeContext;
  const exec = {
    session: {
      id: "ses_full_events" as SessionID,
      title: "",
      createdAt: "",
      events: partial,
      cancelled: false,
      resumable: true,
    },
    eventCount: partial.length,
    fullEventsLoaded: false,
  } as unknown as SessionExecutionState;

  await ensureSessionFullEvents(ctx, exec);

  expect(loadFullCalls).toBe(1);
  expect(exec.fullEventsLoaded).toBe(true);
  expect(exec.session.events).toEqual(full);

  await ensureSessionFullEvents(ctx, exec);
  expect(loadFullCalls).toBe(1);
});

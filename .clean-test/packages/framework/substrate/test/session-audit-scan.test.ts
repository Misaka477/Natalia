import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { scanAuditRequestFacts } from "@anthelia/substrate";
import { sessionStoreController } from "@anthelia/session-store";
import { createTestContext } from "@anthelia/runtime-services";
import type { SessionStoreController } from "@anthelia/session-store";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";

/**
 * The audit wake dedupe/round scan (the two fold-direct debts' shared fix):
 * a fast-attach execution holds only the post-epoch tail, so an older
 * audit.requested must come from the durable log's pages — not from the
 * resident array.
 */

function auditRequested(
  id: string,
  planID: string,
  triggerEventID: string,
): RuntimeEvent {
  return {
    type: "audit.requested",
    id,
    planID,
    planVersion: 1,
    triggerEventID,
    round: 1,
    scope: "completion_recorded",
    at: "2026-01-01T00:00:00.000Z",
  };
}

function completion(id: string, taskID: string): RuntimeEvent {
  return {
    type: "completion.recorded",
    id,
    taskID,
    completionID: id,
    sessionID: "ses_audit" as SessionID,
    recordedAt: "2026-01-02T00:00:00.000Z",
  } as unknown as RuntimeEvent;
}

/** A store double that pages `events` with the same shape as production. */
function pagedStore(events: RuntimeEvent[], pageLimit = 2) {
  return {
    status: () => ({ initialized: true, mode: "sqlite" as const }),
    flush: async () => undefined,
    history: async (
      _id: SessionID,
      _fallback: RuntimeEvent[],
      options: { offset?: number; limit?: number } = {},
    ) => {
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 100;
      const page = events.slice(offset, offset + limit + 1);
      return {
        events: page.slice(0, limit).map((event, index) => ({
          seq: offset + index + 1,
          sessionSeq: offset + index + 1,
          event,
        })),
        hasMore: page.length > limit,
      };
    },
  };
}

function ctxWith(store: unknown): RuntimeContext {
  return {
    state: {
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
  } as unknown as RuntimeContext;
}

function execWith(resident: RuntimeEvent[]): SessionExecutionState {
  return {
    session: {
      id: "ses_audit" as SessionID,
      title: "",
      createdAt: "",
      events: resident,
      cancelled: false,
      resumable: true,
    },
    eventCount: resident.length,
  } as unknown as SessionExecutionState;
}

test("a fast-attach tail sees the older audit.requested from the durable pages", async () => {
  const old = auditRequested("audit:old", "plan_a", "completion:old");
  const store = pagedStore([old]);
  // The resident tail starts after the epoch boundary: the old request is
  // NOT here — the exact shape the resident scan could not answer.
  const resident = [completion("completion:new", "plan_a")];
  const facts = await scanAuditRequestFacts(
    ctxWith(store),
    execWith(resident),
    "plan_a",
  );
  expect(facts.count).toBe(1);
  expect(facts.triggerEventIDs).toEqual(["completion:old"]);
});

test("the round base counts every page of the durable log", async () => {
  const durable = [
    auditRequested("audit:1", "plan_a", "completion:1"),
    auditRequested("audit:2", "plan_a", "completion:2"),
    auditRequested("audit:3", "plan_a", "completion:3"),
    auditRequested("audit:4", "plan_b", "completion:4"),
  ];
  const store = pagedStore(durable);
  const facts = await scanAuditRequestFacts(
    ctxWith(store),
    execWith([completion("completion:5", "plan_a")]),
    "plan_a",
  );
  expect(facts.count).toBe(3);
  expect(facts.triggerEventIDs).toEqual([
    "completion:1",
    "completion:2",
    "completion:3",
  ]);
});

test("an event both persisted and resident is counted once", async () => {
  const event = auditRequested("audit:1", "plan_a", "completion:1");
  const store = pagedStore([event]);
  const facts = await scanAuditRequestFacts(
    ctxWith(store),
    execWith([event, completion("completion:2", "plan_a")]),
    "plan_a",
  );
  expect(facts.count).toBe(1);
});

test("a just-published request not yet persisted is seen from the resident tail", async () => {
  const store = pagedStore([]);
  const live = auditRequested("audit:live", "plan_a", "completion:live");
  const facts = await scanAuditRequestFacts(
    ctxWith(store),
    execWith([live]),
    "plan_a",
  );
  expect(facts.triggerEventIDs).toEqual(["completion:live"]);
});

test("with no store the resident scan is the honest fallback", async () => {
  const resident = [
    auditRequested("audit:r1", "plan_a", "completion:r1"),
    auditRequested("audit:r2", "plan_b", "completion:r2"),
  ];
  const facts = await scanAuditRequestFacts(
    ctxWith(undefined),
    execWith(resident),
    "plan_a",
  );
  expect(facts.count).toBe(1);
  expect(facts.triggerEventIDs).toEqual(["completion:r1"]);
});

import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { SessionWindow, type SessionWindowEntry } from "@anthelia/substrate";
import { scanSessionWindowNewestFirst } from "@anthelia/substrate";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";
import { sessionStoreController } from "@anthelia/session-store";
import type { SessionStoreController } from "@anthelia/session-store";
import { createTestContext } from "@anthelia/runtime-services";

function entry(seq: number): SessionWindowEntry<RuntimeEvent> {
  return {
    seq,
    event: { type: "content.done", id: `e${seq}`, text: `body-${seq}` },
  };
}

/** A six-event log served two entries per page, newest-first by the window. */
async function harness() {
  const all = [1, 2, 3, 4, 5, 6].map(entry);
  const window = new SessionWindow<SessionWindowEntry<RuntimeEvent>>({
    loader: {
      loadTail: async () => ({ events: all.slice(-2), hasMore: true }),
      loadBefore: async (beforeSeq) => {
        const end = beforeSeq - 1;
        const start = Math.max(0, end - 2);
        return { events: all.slice(start, end), hasMore: start > 0 };
      },
    },
  });
  await window.open();
  const exec = {
    session: { id: "ses_scan", events: [] },
    eventWindow: window,
  } as unknown as SessionExecutionState;
  const ctx = {
    state: {
      // The scan path only needs the binding to exist: with an open window it
      // returns before touching the store, so a minimal double stands in.
      serviceDirectory: createTestContext([
        sessionStoreController.mock({
          flush: async () => undefined,
        } as SessionStoreController),
      ]),
    },
    ports: { resolveService: () => ({}) },
  } as unknown as RuntimeContext;
  const project = (events: RuntimeEvent[]) =>
    events.map((event) => ({ id: "id" in event ? String(event.id) : "" }));
  return { ctx, exec, project };
}

test("scan finds in the tail without paging older", async () => {
  const { ctx, exec, project } = await harness();
  const result = await scanSessionWindowNewestFirst(
    ctx,
    exec,
    project,
    (row) => row.id === "e6",
  );
  expect(result).toEqual({
    kind: "found",
    item: { id: "e6" },
    newerCount: 0,
  });
  expect(exec.eventWindow!.baseSeq).toBe(5);
});

test("scan pages older until it finds the row and counts newer rows", async () => {
  const { ctx, exec, project } = await harness();
  const result = await scanSessionWindowNewestFirst(
    ctx,
    exec,
    project,
    (row) => row.id === "e2",
  );
  expect(result).toEqual({
    kind: "found",
    item: { id: "e2" },
    newerCount: 4,
  });
  // It had to walk back to the base of the log.
  expect(exec.eventWindow!.baseSeq).toBe(1);
});

test("scan reports exhausted when the whole log is searched", async () => {
  const { ctx, exec, project } = await harness();
  const result = await scanSessionWindowNewestFirst(
    ctx,
    exec,
    project,
    (row) => row.id === "missing",
  );
  expect(result).toEqual({ kind: "exhausted" });
  expect(exec.eventWindow!.baseSeq).toBe(1);
});

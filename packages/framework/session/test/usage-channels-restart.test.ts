// Does a navi/nia usage event SURVIVE a restart?
//
// The user's report: the usage bar reads numbers for main and 0 for navi / nia /
// subagent on every start, so the data "never lands". Everything upstream of the
// store has already been checked and cleared:
//   - runtimeEventDurability() classifies navi./nia.runtime.step_usage as
//     "durable" (default branch, not in the live list)
//   - foldSessionUsageInto() attributes them to the right channel
//   - event-sink's publishForSession appends every durable event
// What is NOT yet proven is the leg this test covers: an event appended through
// the store's own public API comes back out of the durable log, through the
// surface a restarting UI reads, into the restored projection — for all three
// channels.
//
// JSON and sqlite are both driven, because they take DIFFERENT read paths: the
// JSON store's exec surface is the full log (eventsAfter returns [] for it),
// while sqlite tail-replays from eventsAfter. A channel that works in one and
// not the other is exactly the asymmetry a single-store test would miss.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  runtimeEventDurability,
  type RuntimeEvent,
  type SessionID,
} from "@anthelia/contracts";
import { JsonSessionStore, SqliteSessionStore } from "../src/index.ts";
import { appendSessionEvent } from "../src/facts.ts";
import {
  emptySessionUsageTotals,
  foldSessionUsageInto,
} from "../src/projector.ts";

const SESSION = "ses_usage_channels" as SessionID;

function stepUsage(
  type: string,
  id: string,
  inputTokens: number,
  channel?: "main" | "navi" | "nia",
) {
  return {
    type,
    id,
    inputTokens,
    outputTokens: 5,
    ...(channel === undefined ? {} : { channel }),
  } as unknown as RuntimeEvent;
}

for (const mode of ["json", "sqlite"] as const) {
  test(`navi and nia usage survive a restart in a ${mode} store`, async () => {
    const root = await mkdtemp(join(tmpdir(), `natalia-usage-${mode}-`));
    try {
      const work = join(root, mode);
      await mkdir(work, { recursive: true });
      // The two stores take different constructor arguments and expose different
      // methods, so they are bound separately rather than unioned: a union would
      // need narrowing at every call, and TypeScript cannot narrow a class union
      // by a runtime flag alone.
      const sqlite =
        mode === "sqlite"
          ? new SqliteSessionStore(join(work, "sessions.db"))
          : undefined;
      const json = sqlite ? undefined : new JsonSessionStore(work);

      try {
        const events = [
          stepUsage("runtime.step_usage", "m:1", 1_000),
          stepUsage("navi.runtime.step_usage", "n:1", 20),
          stepUsage("nia.runtime.step_usage", "i:1", 3),
          // A channel-tagged step on the un-namespaced type: the subagent
          // runner's shape. It must be attributed by its tag, not to main.
          stepUsage("runtime.step_usage", "s:1", 7, "navi"),
        ];
        // The same call event-sink makes for every durable event, per store:
        // sqlite owns its own journal, JSON keeps a SessionRecord the pure
        // appendSessionEvent mutates before save().
        let readBack: RuntimeEvent[];
        if (sqlite) {
          sqlite.create(SESSION, "usage channels");
          for (const event of events) sqlite.appendEvent(SESSION, event);
          await sqlite.flushPendingWrites?.(SESSION);
          readBack = sqlite.loadEventsAfter(SESSION, 0);
        } else {
          const record = await json!.loadOrCreate(SESSION, "usage channels");
          for (const event of events)
            appendSessionEvent(record, event as never);
          await json!.save(record);
          const reloaded = await json!.load(SESSION);
          // The JSON store's SessionRecord keeps a flat event list; the sqlite
          // store's row shape is {seq, event}.
          const rows = (reloaded?.events ?? []) as unknown[];
          readBack = rows.map((row) =>
            row && typeof row === "object" && "event" in row
              ? (row as { event: RuntimeEvent }).event
              : (row as unknown as RuntimeEvent),
          );
        }

        const kinds = readBack.map((event) => event.type);
        expect(kinds).toContain("navi.runtime.step_usage");
        expect(kinds).toContain("nia.runtime.step_usage");

        // And the fold the usage snapshot is built from.
        const totals = emptySessionUsageTotals();
        for (const event of readBack) foldSessionUsageInto(totals, event);

        expect(totals.main.inputTokens).toBe(1_000);
        // 20 from the namespaced event + 7 from the tagged one.
        expect(totals.navi.inputTokens).toBe(27);
        expect(totals.nia.inputTokens).toBe(3);
      } finally {
        // JSON's store has no close: its writes are queued fs writes that
        // resolve before save() returns.
        if (sqlite) sqlite.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a navi/nia turn's settlement is durable, so the turn count survives a restart", async () => {
  // The other half of the bar: the token sums came back from the journal
  // while `turns` (and its llmMs share) reset to zero on every restart,
  // because `*.chat.turn.finished` was classified live-only. The fold has
  // always known how to count one; the event just never reached the log.
  const root = await mkdtemp(join(tmpdir(), "natalia-usage-turns-"));
  try {
    const events = [
      {
        type: "navi.runtime.step_usage",
        id: "n:1",
        inputTokens: 20,
        outputTokens: 5,
        llmMs: 40,
      },
      {
        type: "navi.chat.turn.finished",
        id: "n:f",
        messageID: "m1",
        stopReason: "done",
        startedAt: 1_000,
        endedAt: 1_250,
      },
      {
        type: "nia.chat.turn.finished",
        id: "i:f",
        messageID: "m2",
        stopReason: "done",
        startedAt: 2_000,
        endedAt: 2_400,
      },
    ] as unknown as RuntimeEvent[];
    // The classification is the fix: both settlements are durable now, and
    // the progress rows that carry no fact stay live.
    expect(runtimeEventDurability(events[1]!)).toBe("durable");
    expect(runtimeEventDurability(events[2]!)).toBe("durable");
    expect(
      runtimeEventDurability({
        type: "navi.chat.turn.started",
        id: "n:s",
        messageID: "m1",
        startedAt: 1_000,
      } as unknown as RuntimeEvent),
    ).toBe("live");

    const sqlite = new SqliteSessionStore(join(root, "sessions.db"));
    try {
      sqlite.create(SESSION, "usage turns");
      for (const event of events) sqlite.appendEvent(SESSION, event);
      await sqlite.flushPendingWrites?.(SESSION);
      const readBack = sqlite.loadEventsAfter(SESSION, 0);
      expect(readBack.map((event) => event.type)).toContain(
        "navi.chat.turn.finished",
      );
      expect(readBack.map((event) => event.type)).toContain(
        "nia.chat.turn.finished",
      );
      const totals = emptySessionUsageTotals();
      for (const event of readBack) foldSessionUsageInto(totals, event);
      // The turn counts and their wall clock survive the round trip.
      expect(totals.navi.turns).toBe(1);
      expect(totals.navi.llmMs).toBe(290); // 40 from the step + 250 from the turn
      expect(totals.nia.turns).toBe(1);
      expect(totals.nia.llmMs).toBe(400);
      expect(totals.main.turns).toBe(0);
    } finally {
      sqlite.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

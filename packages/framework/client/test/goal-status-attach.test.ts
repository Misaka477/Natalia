import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttachmentService } from "@anthelia/attachments";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type {
  ProviderStreamRequest,
  StreamingProvider,
} from "@anthelia/runtime";
import { createSessionStoreController } from "@anthelia/session-store";
import { projectSessionMessages } from "@anthelia/session";
import { createRealRuntimeClient } from "../src/runtime/main";

const provider: StreamingProvider = {
  provider: "goal-status-test",
  model: "goal-status-test-model",
  async *stream(_request: ProviderStreamRequest) {
    yield { type: "done" as const };
  },
};

/**
 * Regression: the fast startup path attaches to the runtime's already-selected
 * session without replaying the durable journal, so an existing goal never
 * reached the status bar. Attach must re-seed it from `recovery_goal` and emit
 * a live `goal.status`.
 */
test("same-id attach re-publishes an existing goal as a live goal.status", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-goal-status-"));
  const sessionID = "ses_goal_status" as SessionID;

  const seeder = createSessionStoreController({
    workspaceRoot: root,
    sessionID: () => sessionID,
    useSqliteStore: true,
    attachments: createAttachmentService(root),
  });
  await seeder.init();
  await seeder.create({ id: sessionID, title: "Goal status" });
  const record = (await seeder.load(sessionID)).session;
  const goalEvent: RuntimeEvent = {
    type: "goal.changed",
    id: "goal_evt_seed",
    operation: "create",
    snapshot: {
      goalID: "goal_seed",
      revision: 1,
      objective: "resume the plan",
      phase: "active",
      maxGoalRounds: 256,
      maxGoalTokens: 0,
      maxGoalWallClockMs: 0,
      spentGoalTokens: 0,
      goalWallClockMs: 0,
    },
    roundsStarted: 0,
    at: "2026-01-01T00:00:00.000Z",
  };
  record.events.push(goalEvent);
  await seeder.appendEvent(record, goalEvent);
  await seeder.flush(sessionID);
  await seeder.close();

  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    useSqliteStore: true,
    provider,
  });
  try {
    client.start((event) => events.push(event));
    await client.sessionAttach?.(sessionID);
    const deadline = Date.now() + 2000;
    while (
      Date.now() < deadline &&
      !events.some((event) => event.type === "goal.status")
    )
      await Bun.sleep(20);

    const status = events.find((event) => event.type === "goal.status");
    expect(status).toMatchObject({
      type: "goal.status",
      goal: {
        goalID: "goal_seed",
        revision: 1,
        objective: "resume the plan",
        phase: "active",
        roundsStarted: 0,
      },
    });

    // Status-bar controls go through the real client surface, not the model.
    // Regression: `goalControl` was routed over RPC but never exposed on the
    // client surface, so every button click resolved to undefined.
    const waitForGoalEvent = async (
      predicate: (event: RuntimeEvent) => boolean,
    ) => {
      const waitUntil = Date.now() + 2000;
      while (Date.now() < waitUntil && !events.some(predicate))
        await Bun.sleep(20);
      return events.filter(predicate);
    };

    const edited = await client.goalEdit?.(
      { goalID: "goal_seed", revision: 1, objective: "edited objective" },
      sessionID,
    );
    expect(edited).toMatchObject({ ok: true, action: "edit" });
    const editEvents = await waitForGoalEvent(
      (event) => event.type === "goal.changed" && event.operation === "edit",
    );
    expect(editEvents).toHaveLength(1);
    expect(editEvents[0]).toMatchObject({
      type: "goal.changed",
      operation: "edit",
      snapshot: { objective: "edited objective", revision: 2 },
    });

    // Compare-and-set: a stale revision is refused, not applied.
    const stale = await client.goalEdit?.(
      { goalID: "goal_seed", revision: 1, objective: "stale objective" },
      sessionID,
    );
    expect(stale).toMatchObject({ ok: false, action: "edit" });

    const paused = await client.goalControl?.("pause", sessionID);
    expect(paused).toMatchObject({ ok: true, action: "pause" });
    expect(
      await waitForGoalEvent(
        (event) => event.type === "goal.changed" && event.operation === "pause",
      ),
    ).toHaveLength(1);

    const resumed = await client.goalControl?.("resume", sessionID);
    expect(resumed).toMatchObject({ ok: true, action: "resume" });
    expect(
      await waitForGoalEvent(
        (event) =>
          event.type === "goal.changed" && event.operation === "resume",
      ),
    ).toHaveLength(1);

    const cleared = await client.goalControl?.("clear", sessionID);
    expect(cleared).toMatchObject({ ok: true, action: "clear" });
    expect(
      await waitForGoalEvent(
        (event) => event.type === "goal.changed" && event.operation === "clear",
      ),
    ).toHaveLength(1);
  } finally {
    await client.dispose?.();
  }
});

/**
 * The status-bar toggle and inline editor act on the *running* round the dsh
 * way: `pause` DISARMS it (the round finishes, the next one never starts —
 * the user's 2026-10-07 ruling), and `edit` steers it at the next step while
 * the durable edit makes the next round use the new objective.
 */
test("pause disarms — the running goal round finishes and no next one starts (user 2026-10-07)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-goal-steer-"));
  const sessionID = "ses_goal_steer" as SessionID;

  const seeder = createSessionStoreController({
    workspaceRoot: root,
    sessionID: () => sessionID,
    useSqliteStore: true,
    attachments: createAttachmentService(root),
  });
  await seeder.init();
  await seeder.create({ id: sessionID, title: "Goal steer" });
  const record = (await seeder.load(sessionID)).session;
  const goalEvent: RuntimeEvent = {
    type: "goal.changed",
    id: "goal_evt_steer",
    operation: "create",
    snapshot: {
      goalID: "goal_steer",
      revision: 1,
      objective: "steady the boat",
      phase: "active",
      maxGoalRounds: 256,
      maxGoalTokens: 0,
      maxGoalWallClockMs: 0,
      spentGoalTokens: 0,
      goalWallClockMs: 0,
    },
    roundsStarted: 0,
    at: new Date().toISOString(),
  };
  record.events.push(goalEvent);
  await seeder.appendEvent(record, goalEvent);
  await seeder.flush(sessionID);
  await seeder.close();

  // Provider call 0 blocks (round 1 step 1) so the round stays in flight while
  // the human edits/pauses; call 2 blocks (round 2 step 1) so the paused
  // round is provably still running after the pause.
  let calls = 0;
  const releases = new Map<number, () => void>();
  const provider: StreamingProvider = {
    provider: "goal-steer-test",
    model: "goal-steer-test-model",
    async *stream(request: ProviderStreamRequest) {
      const index = calls++;
      if (index === 0 || index === 2) {
        await new Promise<void>((resolve) => {
          releases.set(index, resolve);
          request.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }
      yield { type: "done" as const };
    },
  };

  const events: RuntimeEvent[] = [];
  // 45s, the runtime-condition budget the real-runtime harness documents:
  // a goal round admission crosses the runtime boundary (a settle on disk, a
  // wake that has to run), and a 5s default is a lottery under the concurrent
  // suite — a different victim every run. The 60s per-test cap still bounds a
  // genuine hang.
  //
  // 20s was measured on THIS machine, where the whole file runs in ~3s; the
  // CI runner is ~3.4x slower (the same client-rest-1 batch: 49s local vs
  // 167s there), which turned the default into a coin flip — it failed twice
  // on client-rest-1 while every local run, loaded or not, passed. 45s gives
  // the runner headroom without loosening what a genuine hang looks like.
  const waitUntil = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 45_000,
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await Bun.sleep(20);
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    useSqliteStore: true,
    provider,
  });
  try {
    client.start((event) => events.push(event));
    await client.sessionAttach?.(sessionID);

    // Arm + drive a round: the seeded goal starts disarmed by design.
    await client.goalControl?.("pause", sessionID);
    await client.goalControl?.("resume", sessionID);
    await waitUntil(
      () =>
        events.some(
          (event) => event.type === "goal.round" && event.round === 1,
        ),
      "goal round 1 admission",
    );
    await waitUntil(
      () =>
        events.some(
          (event) =>
            event.type === "turn.started" && event.id.includes("round_1"),
        ),
      "round 1 turn start",
    );

    // Edit while round 1 is in flight: durable edit + a next-step steering note.
    const goalRevision = events
      .filter(
        (event): event is Extract<RuntimeEvent, { type: "goal.changed" }> =>
          event.type === "goal.changed",
      )
      .at(-1)!.snapshot!.revision;
    const edited = await client.goalEdit?.(
      {
        goalID: "goal_steer",
        revision: goalRevision,
        objective: "steady the NEW boat",
      },
      sessionID,
    );
    expect(edited).toMatchObject({ ok: true, action: "edit" });
    expect(
      events.some(
        (event) => event.type === "goal.changed" && event.operation === "edit",
      ),
    ).toBe(true);

    releases.get(0)?.();
    await waitUntil(
      () =>
        events.some(
          (event) =>
            event.type === "turn.input" &&
            event.internal === true &&
            event.text.includes("goal edited by user"),
        ),
      "next-step steering note",
    );

    // The edit preserves continuation authority, so round 2 is driven and its
    // first provider call blocks. Pausing then DISARMS: round 2 finishes, no
    // round 3 starts (the user's 2026-10-07 dsh-parity ruling).
    await waitUntil(
      () =>
        events.some(
          (event) => event.type === "goal.round" && event.round === 2,
        ),
      "goal round 2 admission",
    );
    await waitUntil(
      () =>
        events.some(
          (event) =>
            event.type === "turn.started" && event.id.includes("round_2"),
        ),
      "round 2 turn start",
    );
    // Pausing DISARMS: the in-flight round runs to completion and the next
    // one is never started (the user's 2026-10-07 dsh-parity ruling — the
    // old behaviour hard-cancelled the round, which the user rejected).
    const paused = await client.goalControl?.("pause", sessionID);
    expect(paused).toMatchObject({ ok: true, action: "pause" });
    expect(
      events.some(
        (event) => event.type === "goal.changed" && event.operation === "pause",
      ),
    ).toBe(true);
    // The in-flight round SURVIVES the pause (no hard-stop) — dsh's
    // semantics: pause disarms, it does not cancel.
    expect(
      events.some(
        (event) =>
          event.type === "turn.cancelled" && event.id.includes("round_2"),
      ),
    ).toBe(false);
    // Let round 2 finish: its turn ENDS after the pause (never cancelled —
    // that is the whole point of the disarm), and NO round 3 is admitted,
    // because the paused phase is the driver's gate.
    releases.get(2)?.();
    await waitUntil(
      () =>
        events.some(
          (event) => event.type === "goal.round.cost" && event.round === 2,
        ),
      "round 2 settlement",
      40_000,
    );
    expect(
      events.some((event) => event.type === "goal.round" && event.round === 3),
    ).toBe(false);
  } finally {
    for (const release of releases.values()) release();
    await client.dispose?.();
  }
}, 60_000);

/**
 * A stream killed mid-flight must keep the text it already generated. The
 * event sink coalesces `content.delta` into durable `content.partial` batches,
 * and dispose flushes the last buffer before the store closes.
 */
test("a killed stream keeps its generated text as durable partial batches", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-partial-kill-"));
  const sessionID = "ses_partial_kill" as SessionID;
  let yielded: (() => void) | undefined;
  const bothChunksYielded = new Promise<void>((resolve) => {
    yielded = resolve;
  });
  const provider: StreamingProvider = {
    provider: "partial-kill-test",
    model: "partial-kill-test-model",
    async *stream(request: ProviderStreamRequest) {
      yield { type: "content", text: "Recovered " };
      yield { type: "content", text: "partial text" };
      yielded?.();
      // Simulate a provider request that never completes on its own; the abort
      // is what lets dispose finish.
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) return resolve();
        request.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      yield { type: "done" as const };
    },
  };

  const live: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    useSqliteStore: true,
    provider,
  });
  client.start((event) => live.push(event));
  await client.sessionAttach?.(sessionID);
  void client.submit?.("go");
  await bothChunksYielded;
  await client.dispose?.();

  // Partials are the durable copy; they must never be re-broadcast live (the
  // live transcript already has the raw deltas).
  expect(live.some((event) => event.type === "content.delta")).toBe(true);
  expect(live.some((event) => event.type === "content.partial")).toBe(false);

  const reader = createSessionStoreController({
    workspaceRoot: root,
    sessionID: () => sessionID,
    useSqliteStore: true,
    attachments: createAttachmentService(root),
  });
  await reader.init();
  const session = (await reader.load(sessionID)).session;
  await reader.close();

  const projected = projectSessionMessages(session, { order: "asc" });
  const assistantRows = projected.data.flatMap((message) =>
    message.rows.filter((row) => row.kind === "assistant"),
  );
  // The partial batches alone reconstruct the full generated text, so a real
  // SIGKILL (which never publishes `content.done`) still recovers it.
  const partialText = assistantRows
    .flatMap((row) =>
      row.event.type === "content.partial" ? [row.event.text] : [],
    )
    .join("");
  expect(partialText).toBe("Recovered partial text");
});

/**
 * Regression for the original ordering bug: when an answer partial flushes on
 * its timer before the provider stream ends, the durable journal must still
 * settle reasoning before that partial.
 */
test("durable thinking.done precedes a timer-flushed answer partial", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-partial-order-"));
  const sessionID = "ses_partial_order" as SessionID;
  const previousFlushMs = process.env.NATALIA_PARTIAL_FLUSH_MS;
  process.env.NATALIA_PARTIAL_FLUSH_MS = "100";
  try {
    const provider: StreamingProvider = {
      provider: "partial-order-test",
      model: "partial-order-test-model",
      async *stream() {
        yield { type: "thinking", text: "reasoning" };
        yield { type: "content", text: "answer" };
        await Bun.sleep(150);
        yield { type: "done" as const };
      },
    };

    const live: RuntimeEvent[] = [];
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID,
      useSqliteStore: true,
      provider,
    });
    try {
      client.start((event) => live.push(event));
      await client.sessionAttach?.(sessionID);
      void client.submit?.("go");
      const deadline = Date.now() + 5000;
      while (
        Date.now() < deadline &&
        !live.some((event) => event.type === "turn.finished")
      )
        await Bun.sleep(20);
      expect(live.some((event) => event.type === "turn.finished")).toBe(true);
    } finally {
      await client.dispose?.();
    }

    const reader = createSessionStoreController({
      workspaceRoot: root,
      sessionID: () => sessionID,
      useSqliteStore: true,
      attachments: createAttachmentService(root),
    });
    await reader.init();
    const session = (await reader.load(sessionID)).session;
    await reader.close();

    const turnID = live.find((event) => event.type === "turn.finished")?.id;
    expect(turnID).toBeDefined();
    const turnEvents = session.events.filter(
      (event) => "id" in event && event.id === turnID,
    );
    const thinkingIndex = turnEvents.findIndex(
      (event) => event.type === "thinking.done",
    );
    const partialIndex = turnEvents.findIndex(
      (event) => event.type === "content.partial",
    );
    expect(thinkingIndex).toBeGreaterThanOrEqual(0);
    expect(partialIndex).toBeGreaterThanOrEqual(0);
    expect(thinkingIndex).toBeLessThan(partialIndex);
  } finally {
    if (previousFlushMs === undefined)
      delete process.env.NATALIA_PARTIAL_FLUSH_MS;
    else process.env.NATALIA_PARTIAL_FLUSH_MS = previousFlushMs;
  }
});

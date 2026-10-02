import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  applyProjection,
  initProjection,
  serializeProjectionState,
  sessionFactConstitutionRules,
  sessionFactGoal,
  sessionFactMailboxMessages,
  sessionFactStateFromEvents,
  sessionFactWorkContracts,
} from "@anthelia/session";
import { completeSessionFactState } from "@anthelia/substrate";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";
import { sessionStoreController } from "@anthelia/session-store";
import type { SessionStoreController } from "@anthelia/session-store";
import { createTestContext } from "@anthelia/runtime-services";

const rule: RuntimeEvent = {
  type: "constitution.rule_added",
  id: "rule:1",
  ruleID: "C-001",
  statement: "Never commit without approval",
  scope: "project",
  priority: "critical",
  source: "user",
  enforcement: "approval",
  overridePolicy: "forbidden",
};

const mailbox: RuntimeEvent = {
  type: "mailbox.queued",
  id: "mailbox:1:queued",
  messageID: "mailbox:1",
  source: "system",
  priority: "normal",
  intent: "constraint",
  text: "never commit",
  safeSummary: "a constraint",
  deliveryPolicy: "before_next_tool",
  createdAt: "t0",
};

function noise(index: number): RuntimeEvent {
  return {
    type: "tool.update",
    id: `turn_1:call_${index}`,
    name: "read_file",
    callID: `call_${index}`,
    status: "succeeded",
    summary: "read",
  };
}

/** A 2502-event log: the fact lands on the first page, the tail on the last. */
function log(): RuntimeEvent[] {
  const all: RuntimeEvent[] = [rule];
  for (let index = 0; index < 2_500; index += 1) all.push(noise(index));
  all.push(mailbox);
  return all;
}

function harness(all: RuntimeEvent[]) {
  let historyCalls = 0;
  const store = {
    flush: () => Promise.resolve(),
    history: (
      _id: string,
      _fallback: RuntimeEvent[],
      options: { offset?: number; limit?: number } = {},
    ) => {
      historyCalls += 1;
      const start = options.offset ?? 0;
      const limit = options.limit ?? 100;
      const slice = all.slice(start, start + limit);
      return Promise.resolve({
        events: slice.map((event, index) => ({
          seq: start + index + 1,
          sessionSeq: start + index + 1,
          event,
        })),
        hasMore: start + slice.length < all.length,
      });
    },
  };
  const ctx = {
    state: {
      serviceDirectory: createTestContext([
        sessionStoreController.mock(store as unknown as SessionStoreController),
      ]),
    },
    ports: {
      resolveService: () => store,
      getSessionPersistenceForSession: () => Promise.resolve(undefined),
    },
  } as unknown as RuntimeContext;
  // The execution carries only its fast-attach tail.
  const exec = {
    session: { id: "ses_cold_fold", events: all.slice(-2) },
    fullEventsLoaded: false,
  } as unknown as SessionExecutionState;
  return { ctx, exec, calls: () => historyCalls };
}

test("completeSessionFactState folds paged history without loading the journal", async () => {
  const all = log();
  const { ctx, exec, calls } = harness(all);

  const ok = await completeSessionFactState(ctx, exec);
  expect(ok).toBe(true);
  expect(exec.factStateComplete).toBe(true);
  // It had to page more than once, and it left session.events as the tail.
  expect(calls()).toBeGreaterThan(1);
  expect(exec.session.events).toHaveLength(2);

  const state = exec.factState!;
  const expected = sessionFactStateFromEvents(all);
  expect(sessionFactConstitutionRules(state)).toEqual(
    sessionFactConstitutionRules(expected),
  );
  expect(sessionFactMailboxMessages(state)).toEqual(
    sessionFactMailboxMessages(expected),
  );
  // The first-page fact survived the paging.
  expect(sessionFactConstitutionRules(state)[0]?.ruleID).toBe("C-001");
  expect(sessionFactMailboxMessages(state)[0]?.messageID).toBe("mailbox:1");
});

test("completeSessionFactState is a no-op once the state is complete", async () => {
  const all = log();
  const { ctx, exec, calls } = harness(all);
  await completeSessionFactState(ctx, exec);
  const before = calls();
  expect(await completeSessionFactState(ctx, exec)).toBe(true);
  expect(calls()).toBe(before);
});

test("completeSessionFactState completes from a persisted projection checkpoint (B tier)", async () => {
  const all = log();
  // A checkpoint carrying the durable prefix (first 100 events); the tail is
  // read via eventsAfter. Folding prefix + tail must equal a full fold, and it
  // must not page the history at all.
  const prefix = all.slice(0, 100);
  const projection = initProjection();
  for (const event of prefix) applyProjection(projection, event);
  const serializedState = serializeProjectionState(projection);
  const lastSeq = prefix.length;

  let historyCalls = 0;
  const store = {
    flush: () => Promise.resolve(),
    loadProjectionCheckpoint: () => ({ serializedState, lastSeq }),
    eventsAfter: (_id: string, after: number) => all.slice(after),
    history: () => {
      historyCalls += 1;
      return Promise.resolve({ events: [], hasMore: false });
    },
  };
  const ctx = {
    state: {
      serviceDirectory: createTestContext([
        sessionStoreController.mock(store as unknown as SessionStoreController),
      ]),
    },
    ports: {
      resolveService: () => store,
      getSessionPersistenceForSession: () => Promise.resolve(undefined),
    },
  } as unknown as RuntimeContext;
  const exec = {
    session: { id: "ses_cold_fold", events: all.slice(-2) },
    fullEventsLoaded: false,
  } as unknown as SessionExecutionState;

  await completeSessionFactState(ctx, exec);

  // B tier: folded from the checkpoint + tail, never paged the journal.
  expect(historyCalls).toBe(0);
  expect(exec.factStateComplete).toBe(true);
  const full = sessionFactStateFromEvents(all);
  expect(sessionFactConstitutionRules(exec.factState!)).toEqual(
    sessionFactConstitutionRules(full),
  );
  expect(sessionFactMailboxMessages(exec.factState!)).toEqual(
    sessionFactMailboxMessages(full),
  );
});

test("paged completion keeps the slices the boundary reads fact-first", async () => {
  // The reconcile path (boundary.ts) reads the constitution rules, work
  // contracts and goal from the complete fact state — these two events sit
  // on the FIRST page while the execution carries only its tail, so a
  // fact-blind fold would judge the turn against no contract and no goal.
  const goal: RuntimeEvent = {
    type: "goal.changed",
    id: "goal:create:1",
    operation: "create",
    snapshot: {
      goalID: "goal_cold",
      revision: 1,
      objective: "ship the thing",
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
  const contract: RuntimeEvent = {
    type: "work_contract.accepted",
    id: "work_contract:plan_cold:accepted",
    planID: "plan_cold",
    planVersion: 1,
    scope: ["src/**"],
    verification: ["bun test"],
    constraints: ["never commit without approval"],
    acceptedBy: "user",
    acceptedAt: "2026-01-01T00:00:00.000Z",
  };
  const log: RuntimeEvent[] = [goal, contract];
  for (let index = 0; index < 2_500; index += 1)
    log.push({
      type: "tool.update",
      id: `turn_1:call_${index}`,
      name: "read_file",
      callID: `call_${index}`,
      status: "succeeded",
      summary: "read",
    });
  const { ctx, exec } = harness(log);

  expect(await completeSessionFactState(ctx, exec)).toBe(true);
  const state = exec.factState!;
  const full = sessionFactStateFromEvents(log);
  expect(sessionFactWorkContracts(state)).toEqual(
    sessionFactWorkContracts(full),
  );
  expect(sessionFactWorkContracts(state)[0]?.status).toBe("current");
  expect(sessionFactGoal(state)).toEqual(sessionFactGoal(full));
  expect(sessionFactGoal(state)?.objective).toBe("ship the thing");
});

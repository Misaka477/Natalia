import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  GoalRoundDriver,
  GoalService,
  buildGoalChanged,
  foldGoal,
  renderGoalRoundPrompt,
  type GoalRoundHost,
} from "../src";

function harness(
  options: {
    idle?: boolean;
    competing?: boolean;
    flushFails?: boolean;
    linkedPlanStatus?: GoalRoundHost["linkedPlanStatus"];
  } = {},
) {
  const events: RuntimeEvent[] = [];
  const published: RuntimeEvent[] = [];
  const admitted: Array<{ id: string; text: string }> = [];
  let counter = 0;
  const now = () => new Date(1_700_000_000_000 + counter * 1000).toISOString();
  const nextEventId = () => `evt_${++counter}`;
  const nextGoalId = () => `goal_${++counter}`;
  const service = new GoalService({ now, nextEventId, nextGoalId });
  const host: GoalRoundHost = {
    current: (sessionID) => service.current(sessionID, events),
    isIdle: () => options.idle ?? true,
    hasCompetingInput: () => options.competing ?? false,
    flush: async () => {
      if (options.flushFails) throw new Error("flush failed");
    },
    admit: async (_sessionID, input) => {
      admitted.push(input);
      return true;
    },
    publish: (_sessionID, event) => {
      published.push(event as RuntimeEvent);
      events.push(event as RuntimeEvent);
    },
    ...(options.linkedPlanStatus
      ? { linkedPlanStatus: options.linkedPlanStatus }
      : {}),
    now,
    nextEventId,
  };
  const driver = new GoalRoundDriver(service, host);
  const seed = (
    objective: string,
    maxGoalRounds?: number,
    planID?: string,
    budget?: { maxGoalTokens?: number; maxGoalWallClockMs?: number },
  ) => {
    const result = service.create("s1", service.current("s1", events), {
      objective,
      ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
      ...(planID === undefined ? {} : { planID }),
      ...(budget ?? {}),
    });
    host.publish("s1", result.event);
    return result;
  };
  return { events, published, admitted, service, host, driver, seed };
}

test("service arms creation, disarms stops, and never persists activation", () => {
  const h = harness();
  const created = h.seed("ship it");
  expect(created.view.phase).toBe("active");
  expect(created.view.activation).toBe("armed");
  expect(JSON.stringify(created.event)).not.toContain("activation");

  const paused = h.service.pause("s1", h.service.current("s1", h.events)!);
  h.host.publish("s1", paused.event);
  const afterPause = h.service.current("s1", h.events)!;
  expect(afterPause.phase).toBe("paused");
  expect(afterPause.activation).toBe("disarmed");
  expect(afterPause.lastStop?.code).toBe("user-paused");

  const resumed = h.service.resume("s1", afterPause);
  h.host.publish("s1", resumed.event);
  const afterResume = h.service.current("s1", h.events)!;
  expect(afterResume.phase).toBe("active");
  expect(afterResume.activation).toBe("armed");
  expect(afterResume.lastStop).toBeUndefined();
});

test("driver admits exactly one round and records it durably", async () => {
  const h = harness();
  const created = h.seed("ship it");
  await h.driver.drive("s1");
  expect(h.admitted).toHaveLength(1);
  expect(h.admitted[0]!.text).toContain("<goal_round>");
  expect(h.admitted[0]!.id).toBe(`goal_${created.view.goalID}_round_1`);
  expect(
    h.published.filter((event) => event.type === "goal.round"),
  ).toHaveLength(1);
  expect(h.service.current("s1", h.events)?.roundsStarted).toBe(1);
  // A reserved round is not re-driven until it settles.
  await h.driver.drive("s1");
  expect(h.admitted).toHaveLength(1);
});

test("driver yields to human work and to a non-idle session", async () => {
  const busy = harness({ idle: false });
  busy.seed("a");
  await busy.driver.drive("s1");
  expect(busy.admitted).toHaveLength(0);

  const competing = harness({ competing: true });
  competing.seed("b");
  await competing.driver.drive("s1");
  expect(competing.admitted).toHaveLength(0);
});

test("driver blocks the goal when the round cap is reached", async () => {
  const h = harness();
  h.seed("capped", 1);
  await h.driver.drive("s1");
  const goalID = h.service.current("s1", h.events)!.goalID;
  h.driver.settle("s1", `goal_${goalID}_round_1`, "done");
  await h.driver.drive("s1");
  const goal = h.service.current("s1", h.events)!;
  expect(goal.phase).toBe("blocked");
  expect(goal.blockedReason?.code).toBe("round-limit");
});

test("driver disarms on flush failure without admitting work", async () => {
  const h = harness({ flushFails: true });
  h.seed("x");
  await h.driver.drive("s1");
  expect(h.admitted).toHaveLength(0);
  expect(h.service.current("s1", h.events)?.activation).toBe("disarmed");
});

test("settlement pauses on cancellation and blocks on error", async () => {
  const cancelled = harness();
  cancelled.seed("x");
  await cancelled.driver.drive("s1");
  cancelled.driver.settle("s1", cancelled.admitted[0]!.id, "cancelled");
  expect(cancelled.service.current("s1", cancelled.events)?.phase).toBe(
    "paused",
  );

  const errored = harness();
  errored.seed("y");
  await errored.driver.drive("s1");
  errored.driver.settle("s1", errored.admitted[0]!.id, "error");
  const goal = errored.service.current("s1", errored.events)!;
  expect(goal.phase).toBe("blocked");
  expect(goal.blockedReason?.code).toBe("turn-error");
});

test("cancelling unrelated work disarms the goal so it cannot auto-restart", async () => {
  const h = harness();
  h.seed("keep going");
  // The cancelled turn is NOT one of the driver's rounds (e.g. the human's
  // /goal turn or any other turn): the goal must still stop auto-continuing.
  h.driver.settle("s1", "turn_human", "cancelled");
  const goal = h.service.current("s1", h.events)!;
  expect(goal.phase).toBe("paused");
  expect(goal.activation).toBe("disarmed");
  expect(goal.lastStop?.code).toBe("cancelled");
  await h.driver.drive("s1");
  expect(h.admitted).toHaveLength(0);
});

test("a recovery seed keeps current() correct without a replayed journal", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const service = new GoalService({
    now: () => at,
    nextEventId: () => "evt_seed",
    nextGoalId: () => "goal_seed",
  });
  // Fast path at startup: recovery_goal carries the current goal while the
  // in-memory journal is empty (the epoch baseline is the last seq).
  service.seed("s1", {
    goalID: "goal_seed",
    revision: 4,
    objective: "resume the plan",
    phase: "paused",
    maxGoalRounds: 256,
    maxGoalTokens: 0,
    maxGoalWallClockMs: 0,
    spentGoalTokens: 0,
    goalWallClockMs: 0,
    roundsStarted: 2,
    createdAt: at,
    updatedAt: at,
  });
  const seeded = service.current("s1", [])!;
  expect(seeded.goalID).toBe("goal_seed");
  expect(seeded.phase).toBe("paused");
  expect(seeded.roundsStarted).toBe(2);
  // Replay never arms continuation.
  expect(seeded.activation).toBe("disarmed");

  // A replayed round for the same revision still advances the count.
  const round: RuntimeEvent = {
    type: "goal.round",
    id: "evt_round",
    at,
    goalID: "goal_seed",
    revision: 4,
    round: 3,
  };
  expect(service.current("s1", [round])?.roundsStarted).toBe(3);

  // A live mutation updates the cache (activation included).
  service.resume("s1", service.current("s1", [])!);
  expect(service.current("s1", [])?.phase).toBe("active");
  expect(service.current("s1", [])?.activation).toBe("armed");

  // Clearing tombstones the cache so a tail-only journal cannot resurrect it.
  const cleared = service.clear("s1", service.current("s1", [])!);
  expect(cleared.event.operation).toBe("clear");
  expect(service.current("s1", [])).toBeUndefined();
});

test("seed(undefined) leaves journal folding intact", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const service = new GoalService({
    now: () => at,
    nextEventId: () => "evt_x",
    nextGoalId: () => "goal_fold",
  });
  service.seed("s1", undefined);
  const event = buildGoalChanged({
    id: "evt_create",
    at,
    operation: "create",
    snapshot: {
      goalID: "goal_fold",
      revision: 1,
      objective: "legacy",
      phase: "active",
      maxGoalRounds: 256,
      maxGoalTokens: 0,
      maxGoalWallClockMs: 0,
      spentGoalTokens: 0,
      goalWallClockMs: 0,
    },
    roundsStarted: 0,
  });
  // No positive seed and no tombstone: `current` folds the journal instead.
  expect(service.current("s1", [event])?.objective).toBe("legacy");
});

test("edit preserves continuation authority instead of disarming", () => {
  const h = harness();
  h.seed("first objective");
  expect(h.service.isArmed("s1")).toBe(true);

  const edited = h.service.edit("s1", h.service.current("s1", h.events)!, {
    objective: "second objective",
  });
  h.host.publish("s1", edited.event);
  expect(h.service.current("s1", h.events)?.objective).toBe("second objective");
  expect(edited.view.activation).toBe("armed");
  expect(h.service.isArmed("s1")).toBe(true);

  // A goal that was disarmed (e.g. after a pause) stays disarmed across an edit.
  h.service.disarm("s1");
  const again = h.service.edit("s1", h.service.current("s1", h.events)!, {
    objective: "third objective",
  });
  expect(again.view.activation).toBe("disarmed");
  expect(h.service.isArmed("s1")).toBe(false);
});

test("renderGoalRoundPrompt carries the linked plan's lifecycle when present", () => {
  const withPlan = renderGoalRoundPrompt(
    {
      goalID: "g1",
      revision: 1,
      objective: "ship the feature",
      phase: "active",
      maxGoalRounds: 0,
      maxGoalTokens: 0,
      maxGoalWallClockMs: 0,
      spentGoalTokens: 0,
      goalWallClockMs: 0,
      roundsStarted: 0,
      activation: "armed",
      createdAt: "now",
      updatedAt: "now",
      planID: "plan_x",
    },
    2,
    { planID: "plan_x", lifecycle: "completed" },
  );
  expect(withPlan).toContain("Linked plan: plan_x");
  expect(withPlan).toContain("lifecycle: completed");
  // The plan is evidence, not the objective itself: the prompt says so.
  expect(withPlan).toContain("one instrument of this objective");

  const withoutPlan = renderGoalRoundPrompt(
    {
      goalID: "g1",
      revision: 1,
      objective: "ship the feature",
      phase: "active",
      maxGoalRounds: 0,
      maxGoalTokens: 0,
      maxGoalWallClockMs: 0,
      spentGoalTokens: 0,
      goalWallClockMs: 0,
      roundsStarted: 0,
      activation: "armed",
      createdAt: "now",
      updatedAt: "now",
    },
    2,
  );
  expect(withoutPlan).not.toContain("Linked plan");
});

test("driver surfaces the linked plan status into the admitted round", async () => {
  const seen: Array<string | undefined> = [];
  const h = harness({
    linkedPlanStatus: (_sessionID, planID) => {
      seen.push(planID);
      return { planID: planID!, lifecycle: "executing" };
    },
  });
  h.seed("with a plan", undefined, "plan_x");
  await h.driver.drive("s1");
  expect(seen).toEqual(["plan_x"]);
  expect(h.admitted[0]!.text).toContain("Linked plan: plan_x");
  expect(h.admitted[0]!.text).toContain("lifecycle: executing");
});

test("driver omits the plan block when the goal has no planID", async () => {
  let called = false;
  const h = harness({
    linkedPlanStatus: () => {
      called = true;
      return { planID: "unused", lifecycle: "completed" };
    },
  });
  h.seed("no plan");
  await h.driver.drive("s1");
  expect(called).toBe(false);
  expect(h.admitted[0]!.text).not.toContain("Linked plan");
});

test("driver omits the plan block when the plan is gone", async () => {
  const h = harness({
    linkedPlanStatus: () => undefined,
  });
  h.seed("plan vanished", undefined, "plan_gone");
  await h.driver.drive("s1");
  expect(h.admitted[0]!.text).not.toContain("Linked plan");
});

test("a goal over its token budget does not start another round", async () => {
  // Rounds are a poor proxy for cost: ten short exchanges and ten file reads are
  // the same round count and an order of magnitude apart in tokens.
  const { driver, events, host, service } = harness();
  const seeded = service.create("s1", undefined, {
    objective: "spend carefully",
    maxGoalRounds: 100,
    maxGoalTokens: 1000,
  });
  host.publish("s1", seeded.event);

  // Two rounds, each spending 600 tokens, put the goal over before the third.
  await driver.drive("s1");
  driver.settle("s1", "goal_goal_1_round_1", "done", {
    tokens: 600,
    durationMs: 10,
  });
  await driver.drive("s1");
  driver.settle("s1", "goal_goal_1_round_2", "done", {
    tokens: 600,
    durationMs: 10,
  });

  const blocked = await driver.drive("s1");
  expect(blocked).toBeUndefined();

  const goal = service.current("s1", events);
  expect(goal?.phase).toBe("blocked");
  expect(goal?.blockedReason?.code).toBe("token-limit");
  expect(goal?.spentGoalTokens).toBe(1200);
});

test("a goal over its wall-clock budget does not start another round", async () => {
  const { driver, events, host, service } = harness();
  const seeded = service.create("s1", undefined, {
    objective: "be quick",
    maxGoalRounds: 100,
    maxGoalWallClockMs: 5_000,
  });
  host.publish("s1", seeded.event);

  await driver.drive("s1");
  driver.settle("s1", "goal_goal_1_round_1", "done", {
    tokens: 10,
    durationMs: 3_000,
  });
  await driver.drive("s1");
  driver.settle("s1", "goal_goal_1_round_2", "done", {
    tokens: 10,
    durationMs: 3_000,
  });

  await driver.drive("s1");

  const goal = service.current("s1", events);
  expect(goal?.phase).toBe("blocked");
  expect(goal?.blockedReason?.code).toBe("time-limit");
  expect(goal?.goalWallClockMs).toBe(6_000);
});

test("a failed round still books its cost, so a goal cannot spend by failing", async () => {
  // An errored round consumed its tokens and its wall clock before it failed, so
  // it is booked. Skipping it would let a goal that fails every round spend
  // without ever reaching a budget.
  const { driver, events, host, service } = harness();
  const seeded = service.create("s1", undefined, {
    objective: "fail expensively",
    maxGoalRounds: 100,
    maxGoalTokens: 1000,
  });
  host.publish("s1", seeded.event);

  await driver.drive("s1");
  // The round errored, and the goal is blocked for it — so the round it did run
  // is the only one that can carry cost.
  driver.settle("s1", "goal_goal_1_round_1", "error", {
    tokens: 400,
    durationMs: 50,
  });

  const goal = service.current("s1", events);
  expect(goal?.spentGoalTokens).toBe(400);
  expect(goal?.goalWallClockMs).toBe(50);
  expect(goal?.blockedReason?.code).toBe("turn-error");
  // The blocked snapshot carries the spend, so a later resume cannot pretend the
  // failed round was free.
  const blocked = events.find(
    (event) => event.type === "goal.changed" && event.operation === "blocked",
  );
  expect(
    blocked && blocked.type === "goal.changed"
      ? blocked.snapshot?.spentGoalTokens
      : undefined,
  ).toBe(400);
});

test("spend survives replay, so a restart resumes with the same figures", async () => {
  // The accumulators are derived from the durable cost events rather than held
  // as an in-memory total, so replay reaches exactly what the log says.
  const { driver, events, host, service } = harness();
  const seeded = service.create("s1", undefined, {
    objective: "replay me",
    maxGoalRounds: 100,
    maxGoalTokens: 1000,
  });
  host.publish("s1", seeded.event);
  await driver.drive("s1");
  driver.settle("s1", "goal_goal_1_round_1", "done", {
    tokens: 400,
    durationMs: 40,
  });

  const replayed = foldGoal([
    seeded.event,
    ...events.filter((event) => event.type !== "goal.changed"),
  ]);
  expect(replayed?.spentGoalTokens).toBe(400);
  expect(replayed?.goalWallClockMs).toBe(40);
  expect(replayed?.roundsStarted).toBe(1);
});

test("a goal with no budget never blocks on a figure it cannot observe", async () => {
  const { driver, events, host, service } = harness();
  const seeded = service.create("s1", undefined, { objective: "unbounded" });
  host.publish("s1", seeded.event);

  for (let round = 0; round < 3; round += 1) {
    await driver.drive("s1");
    driver.settle("s1", `goal_goal_1_round_${round + 1}`, "done", {
      tokens: 10_000,
      durationMs: 60_000,
    });
  }
  await driver.drive("s1");

  const goal = service.current("s1", events);
  expect(goal?.phase).toBe("active");
});

test("a durable view answers on a fast-attach tail the fold cannot", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const service = new GoalService({
    now: () => at,
    nextEventId: () => "evt_d",
    nextGoalId: () => "goal_d",
  });
  // The durable view is the engine fact state's goal slice: complete (paged
  // from the durable log, hence holding pre-epoch goals) and disarmed.
  const durable = {
    goalID: "goal_d",
    revision: 2,
    objective: "resume the plan",
    phase: "paused" as const,
    maxGoalRounds: 256,
    maxGoalTokens: 0,
    maxGoalWallClockMs: 0,
    spentGoalTokens: 42,
    goalWallClockMs: 1000,
    roundsStarted: 2,
    createdAt: at,
    updatedAt: at,
    activation: "disarmed" as const,
  };
  // The fast-attach tail: the goal's mutations predate the epoch baseline, so
  // only newer events are resident.
  const tail: RuntimeEvent[] = [
    {
      type: "turn.submitted",
      id: "turn_tail",
      text: "keep going",
      byteLength: 10,
      lineCount: 1,
      sha256: "tail",
    },
  ];
  // Without the durable view the tail fold answers "no goal" — the debt.
  expect(service.current("s1", tail)).toBeUndefined();
  // With it, the service answers the durable view and keeps its live
  // activation discipline (process-local, never from the fold).
  const view = service.current("s1", tail, durable)!;
  expect(view.goalID).toBe("goal_d");
  expect(view.spentGoalTokens).toBe(42);
  expect(view.activation).toBe("disarmed");
  service.arm("s1");
  expect(service.current("s1", tail, durable)?.activation).toBe("armed");
  // A live mutation makes the cache the authority: from then on the durable
  // view is not consulted, and the bare tail call serves the cached phase.
  service.resume("s1", view);
  expect(service.current("s1", tail, durable)?.phase).toBe("active");
  expect(service.current("s1", tail)?.phase).toBe("active");
});

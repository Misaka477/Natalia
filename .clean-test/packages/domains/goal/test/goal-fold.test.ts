import { expect, test } from "bun:test";
import type { GoalBlockCode } from "@anthelia/contracts";
import type { GoalSnapshot, RuntimeEvent } from "@anthelia/contracts";
import { foldGoal } from "../src";

const AT = "2026-01-01T00:00:00.000Z";

function snap(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalID: "goal_1",
    revision: 1,
    objective: "ship the thing",
    phase: "active",
    maxGoalRounds: 256,
    // A goal without a budget beyond its round cap, and nothing spent.
    maxGoalTokens: 0,
    maxGoalWallClockMs: 0,
    spentGoalTokens: 0,
    goalWallClockMs: 0,
    ...overrides,
  };
}

function changed(
  operation: "create" | "edit" | "pause" | "resume" | "complete" | "blocked",
  snapshot: GoalSnapshot,
  roundsStarted = 0,
  at = AT,
): RuntimeEvent {
  return {
    type: "goal.changed",
    id: `goal:${operation}:${snapshot.revision}`,
    operation,
    snapshot,
    roundsStarted,
    at,
  } as RuntimeEvent;
}

function cleared(goalID: string, revision: number): RuntimeEvent {
  return {
    type: "goal.changed",
    id: `goal:clear:${revision}`,
    operation: "clear",
    cleared: { goalID, revision },
    roundsStarted: 0,
    at: AT,
  } as RuntimeEvent;
}

function goalRound(
  goalID: string,
  revision: number,
  round: number,
): RuntimeEvent {
  return {
    type: "goal.round",
    id: `goal:round:${round}`,
    goalID,
    revision,
    round,
    at: AT,
  } as RuntimeEvent;
}

test("an empty log has no goal", () => {
  expect(foldGoal([])).toBeUndefined();
});

test("create yields a disarmed active goal at revision 1", () => {
  const goal = foldGoal([changed("create", snap())]);
  expect(goal).toMatchObject({
    goalID: "goal_1",
    revision: 1,
    phase: "active",
    roundsStarted: 0,
    activation: "disarmed",
    createdAt: AT,
    updatedAt: AT,
  });
});

test("edit keeps the phase and advances the revision", () => {
  const goal = foldGoal([
    changed("create", snap()),
    changed("edit", snap({ revision: 2, objective: "ship it well" })),
  ]);
  expect(goal?.revision).toBe(2);
  expect(goal?.objective).toBe("ship it well");
  expect(goal?.phase).toBe("active");
});

test("pause then resume toggles phase, resume clears the blocker", () => {
  const goal = foldGoal([
    changed("create", snap()),
    changed("pause", snap({ revision: 2, phase: "paused" })),
    changed("resume", snap({ revision: 3 })),
  ]);
  expect(goal?.phase).toBe("active");
  expect(goal?.revision).toBe(3);
});

test("block records a reason and resume clears it", () => {
  const blocked = snap({
    revision: 2,
    phase: "blocked",
    // A code from the closed set: the value is incidental to what this test
    // checks, which is that a block records a reason and a resume clears it.
    blockedReason: { code: "round-limit", message: "quota" },
  });
  const goal = foldGoal([
    changed("create", snap()),
    changed("blocked", blocked),
    changed("resume", snap({ revision: 3 })),
  ]);
  expect(goal?.phase).toBe("active");
  expect(goal?.blockedReason).toBeUndefined();
});

test("complete stops continuation and a completed goal may be replaced", () => {
  const done = foldGoal([
    changed("create", snap()),
    changed("complete", snap({ revision: 2, phase: "complete" })),
  ]);
  expect(done?.phase).toBe("complete");
  const replaced = foldGoal([
    changed("create", snap()),
    changed("complete", snap({ revision: 2, phase: "complete" })),
    changed("create", snap({ goalID: "goal_2", revision: 1 })),
  ]);
  expect(replaced?.goalID).toBe("goal_2");
});

test("clear drops the current goal", () => {
  const goal = foldGoal([
    changed("create", snap()),
    changed("edit", snap({ revision: 2 })),
    cleared("goal_1", 3),
  ]);
  expect(goal).toBeUndefined();
});

test("goal rounds advance only from matching sequential goal-sourced turns", () => {
  const goal = foldGoal([
    changed("create", snap()),
    goalRound("goal_1", 1, 1),
    goalRound("goal_1", 1, 2),
    // A turn for a different revision or a human turn does not count.
    goalRound("goal_1", 99, 99),
    changed("edit", snap({ revision: 2 }), 2),
  ]);
  expect(goal?.roundsStarted).toBe(2);
});

test("resume is refused when the round cap is exhausted", () => {
  const paused = snap({ revision: 2, phase: "paused", maxGoalRounds: 2 });
  expect(() =>
    foldGoal([
      changed("create", snap({ maxGoalRounds: 2 })),
      goalRound("goal_1", 1, 1),
      goalRound("goal_1", 1, 2),
      changed("pause", paused, 2),
      changed("resume", snap({ revision: 3, maxGoalRounds: 2 }), 2),
    ]),
  ).toThrow(/round cap is exhausted/);
});

test("strict fold refuses malformed or illegal records", () => {
  // create while a non-complete goal is current
  expect(() =>
    foldGoal([changed("create", snap()), changed("create", snap())]),
  ).toThrow(/cannot create a goal/);
  // revision gap
  expect(() =>
    foldGoal([
      changed("create", snap()),
      changed("edit", snap({ revision: 3 })),
    ]),
  ).toThrow(/advance the revision/);
  // edit changing phase
  expect(() =>
    foldGoal([
      changed("create", snap()),
      changed("edit", snap({ revision: 2, phase: "paused" })),
    ]),
  ).toThrow(/must not change the phase/);
  // blocked without a reason
  expect(() =>
    foldGoal([
      changed("create", snap()),
      changed("blocked", snap({ revision: 2, phase: "blocked" })),
    ]),
  ).toThrow(/must carry a blockedReason/);
  // round out of sequence
  expect(() =>
    foldGoal([changed("create", snap()), goalRound("goal_1", 1, 2)]),
  ).toThrow(/out of sequence/);
  // round beyond cap (sequential but past the budget)
  expect(() =>
    foldGoal([
      changed("create", snap({ maxGoalRounds: 1 })),
      goalRound("goal_1", 1, 1),
      goalRound("goal_1", 1, 2),
    ]),
  ).toThrow(/exceeds maxGoalRounds/);
});

test("a block reason's code comes from the closed set, so a typo cannot reach durable state", () => {
  // The closed set is the point: before it, a misspelled code from any of the
  // three producers rolled forward into the durable snapshot, where a consumer
  // switching on the code fell through to a default and the goal displayed as
  // blocked with no reason it could name.
  const codes: GoalBlockCode[] = [
    "round-limit",
    "turn-error",
    "model-reported",
    "queue-failed",
    "cancelled",
    "max-tokens",
  ];
  // Every code a producer can emit folds to a usable reason, rather than being
  // accepted and then lost at the rendering boundary.
  for (const code of codes) {
    const goal = foldGoal([
      changed("create", snap()),
      changed(
        "blocked",
        snap({
          revision: 2,
          phase: "blocked",
          blockedReason: { code, message: "why" },
        }),
      ),
    ]);
    expect(goal?.blockedReason?.code).toBe(code);
    expect(goal?.blockedReason?.message).toBe("why");
  }
});

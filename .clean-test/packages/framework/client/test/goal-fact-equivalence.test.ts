import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  applySessionFactEvent,
  emptySessionFactState,
  sessionFactGoal,
  sessionFactStateFromEvents,
} from "@anthelia/session";
import { foldGoal } from "@natalia/goal";

/**
 * The goal fact twin's cross-package anchor: the engine's lenient fold (fed
 * by the event sink, orphans ignored, never thrown) and the domain's strict
 * fold (the write boundary, malformed histories refused) must agree EXACTLY
 * on a well-formed journal. One discipline per side, no drift in between.
 *
 * The strict fold doubles as the fixture's validator: if the journal below
 * were malformed, `foldGoal` would throw instead of returning.
 */

const AT = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";

function snapshot(
  revision: number,
  goalID: string,
  phase: "active" | "paused" | "complete" = "active",
  spent = { spentGoalTokens: 0, goalWallClockMs: 0 },
) {
  return {
    goalID,
    revision,
    objective: "ship the thing",
    phase,
    maxGoalRounds: 256,
    maxGoalTokens: 0,
    maxGoalWallClockMs: 0,
    ...spent,
  };
}

function changed(
  operation: "create" | "edit" | "pause" | "resume" | "complete",
  snap: ReturnType<typeof snapshot>,
  roundsStarted: number,
  at = AT,
): RuntimeEvent {
  return {
    type: "goal.changed",
    id: `goal:${operation}:${snap.goalID}:${snap.revision}`,
    operation,
    snapshot: snap,
    roundsStarted,
    at,
  } as RuntimeEvent;
}

function cleared(goalID: string, revision: number, at = LATER): RuntimeEvent {
  return {
    type: "goal.changed",
    id: `goal:clear:${goalID}:${revision}`,
    operation: "clear",
    cleared: { goalID, revision },
    roundsStarted: 2,
    at,
  } as RuntimeEvent;
}

/** A full lifecycle: create, round + cost, edit, pause, resume, complete. */
function lifecycle(): RuntimeEvent[] {
  const spent = { spentGoalTokens: 10, goalWallClockMs: 100 };
  return [
    changed("create", snapshot(1, "goal_1"), 0),
    {
      type: "goal.round",
      id: "goal:round:1",
      goalID: "goal_1",
      revision: 1,
      round: 1,
      at: AT,
    },
    {
      type: "goal.round.cost",
      id: "goal:cost:1",
      goalID: "goal_1",
      revision: 1,
      round: 1,
      at: AT,
      tokens: 10,
      durationMs: 100,
    },
    changed("edit", snapshot(2, "goal_1", "active", spent), 1, LATER),
    changed("pause", snapshot(3, "goal_1", "paused", spent), 1, LATER),
    changed("resume", snapshot(4, "goal_1", "active", spent), 1, LATER),
  ];
}

test("the engine goal fold equals the domain's strict fold on a well-formed journal", () => {
  const events = lifecycle();
  // The strict fold validates: a malformed fixture throws here instead.
  const strict = foldGoal(events);
  expect(strict).toBeDefined();
  expect(sessionFactGoal(sessionFactStateFromEvents(events))).toEqual(strict);
});

test("feeding the twin event-by-event still equals the strict fold", () => {
  const events: RuntimeEvent[] = [
    ...lifecycle(),
    changed(
      "complete",
      snapshot(5, "goal_1", "complete", {
        spentGoalTokens: 10,
        goalWallClockMs: 100,
      }),
      2,
      LATER,
    ),
    cleared("goal_1", 5),
    changed("create", snapshot(1, "goal_2"), 0, LATER),
    {
      type: "goal.round",
      id: "goal:round:goal_2:1",
      goalID: "goal_2",
      revision: 1,
      round: 1,
      at: LATER,
    },
  ];
  const strict = foldGoal(events);
  const state = emptySessionFactState();
  for (const event of events) applySessionFactEvent(state, event);
  expect(sessionFactGoal(state)).toEqual(strict);
  // The resurrected goal carries its own create time, not the old goal's.
  expect(sessionFactGoal(state)?.goalID).toBe("goal_2");
  expect(sessionFactGoal(state)?.createdAt).toBe(LATER);
});

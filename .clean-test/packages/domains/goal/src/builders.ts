import type {
  GoalOperation,
  GoalSnapshot,
  RuntimeEvent,
} from "@anthelia/contracts";

/** Durable goal mutation event (`goal.changed`). */
export type GoalChangedEvent = Extract<RuntimeEvent, { type: "goal.changed" }>;

/**
 * Builds one `goal.changed` event. Callers own the event id and timestamp (the
 * runtime's `nextGoalSequence` / clock), matching the work-ledger builders.
 */
export function buildGoalChanged(input: {
  id: string;
  at: string;
  operation: GoalOperation;
  /** Full post-mutation snapshot; omitted only for `clear`. */
  snapshot?: GoalSnapshot;
  /** Cleared identity; present only for `clear`. */
  cleared?: { goalID: string; revision: number };
  roundsStarted: number;
}): GoalChangedEvent {
  return {
    type: "goal.changed",
    id: input.id,
    operation: input.operation,
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
    ...(input.cleared ? { cleared: input.cleared } : {}),
    roundsStarted: input.roundsStarted,
    at: input.at,
  };
}

/** Durable goal round event (`goal.round`). */
export type GoalRoundEvent = Extract<RuntimeEvent, { type: "goal.round" }>;

/**
 * Builds one `goal.round` event. Written by the round driver the moment it
 * admits a `<goal_round>` turn, so replay counts only rounds that actually
 * started.
 */
export function buildGoalRound(input: {
  id: string;
  at: string;
  goalID: string;
  revision: number;
  round: number;
}): GoalRoundEvent {
  return {
    type: "goal.round",
    id: input.id,
    goalID: input.goalID,
    revision: input.revision,
    round: input.round,
    at: input.at,
  };
}

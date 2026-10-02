/**
 * Strict fold of the same-session goal domain.
 *
 * The session event log is the only durable source of truth: every accepted
 * mutation appends one `goal.changed` event carrying the full post-mutation
 * snapshot (or a `clear` tombstone), and each admitted round appends one
 * `goal.round` event. Replay validates shape, revision continuity, lifecycle
 * transitions, round sequencing and the round cap, and refuses malformed
 * current-format records instead of repairing them.
 */
import type {
  GoalBlockReason,
  GoalLastStop,
  GoalOperation,
  GoalPhase,
  GoalSnapshot,
  RuntimeEvent,
} from "@anthelia/contracts";
import type { GoalView } from "./types";

const PHASES: readonly GoalPhase[] = [
  "active",
  "paused",
  "blocked",
  "complete",
];

function isPhase(value: unknown): value is GoalPhase {
  return (
    typeof value === "string" && (PHASES as readonly string[]).includes(value)
  );
}

function assertBlockReason(reason: GoalBlockReason): void {
  if (typeof reason.code !== "string" || !reason.code.trim())
    throw new Error("goal blockedReason.code must be a non-empty string");
  if (typeof reason.message !== "string" || !reason.message.trim())
    throw new Error("goal blockedReason.message must be a non-empty string");
}

function assertLastStop(lastStop: GoalLastStop): void {
  if (typeof lastStop.code !== "string" || !lastStop.code.trim())
    throw new Error("goal lastStop.code must be a non-empty string");
  if (typeof lastStop.at !== "number" || !Number.isFinite(lastStop.at))
    throw new Error("goal lastStop.at must be a finite number");
}

/** Validates the shape of a persisted goal snapshot; throws when malformed. */
export function assertGoalSnapshot(snapshot: GoalSnapshot): void {
  if (typeof snapshot.goalID !== "string" || !snapshot.goalID.trim())
    throw new Error("goal snapshot must carry a non-empty goalID");
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 1)
    throw new Error("goal snapshot revision must be a positive integer");
  if (typeof snapshot.objective !== "string" || !snapshot.objective.trim())
    throw new Error("goal snapshot objective must be a non-empty string");
  if (!isPhase(snapshot.phase))
    throw new Error(
      `goal snapshot phase is invalid: ${String(snapshot.phase)}`,
    );
  if (!Number.isInteger(snapshot.maxGoalRounds) || snapshot.maxGoalRounds < 0)
    throw new Error(
      "goal snapshot maxGoalRounds must be a non-negative integer (0 = unlimited)",
    );
  if (snapshot.phase === "blocked") {
    if (snapshot.blockedReason === undefined)
      throw new Error("a blocked goal must carry a blockedReason");
    assertBlockReason(snapshot.blockedReason);
  } else if (snapshot.blockedReason !== undefined) {
    throw new Error("only a blocked goal may carry a blockedReason");
  }
  if (snapshot.lastStop !== undefined) assertLastStop(snapshot.lastStop);
  if (
    snapshot.planID !== undefined &&
    (typeof snapshot.planID !== "string" || !snapshot.planID.trim())
  )
    throw new Error("goal planID must be a non-empty string when present");
}

/** Validates one lifecycle transition (and the revision it must carry). */
function assertTransition(
  previous: GoalView | undefined,
  operation: GoalOperation,
  next: GoalSnapshot,
  roundsStarted: number,
): void {
  if (operation === "create") {
    if (previous !== undefined && previous.phase !== "complete")
      throw new Error(
        `cannot create a goal while ${previous.goalID} is ${previous.phase}`,
      );
    if (next.revision !== 1)
      throw new Error("a newly created goal must start at revision 1");
    return;
  }
  if (previous === undefined)
    throw new Error(`goal ${operation} requires a current goal`);
  if (next.goalID !== previous.goalID)
    throw new Error(`goal ${operation} must not change identity`);
  if (next.revision !== previous.revision + 1)
    throw new Error(
      `goal ${operation} must advance the revision by exactly one`,
    );
  switch (operation) {
    case "edit":
      if (next.phase !== previous.phase)
        throw new Error("goal edit must not change the phase");
      return;
    case "pause":
      if (previous.phase !== "active" || next.phase !== "paused")
        throw new Error("goal pause requires active -> paused");
      return;
    case "resume":
      if (next.phase !== "active")
        throw new Error("goal resume must produce an active goal");
      if (previous.phase !== "paused" && previous.phase !== "blocked")
        throw new Error("goal resume requires a paused or blocked goal");
      if (next.maxGoalRounds !== 0 && roundsStarted >= next.maxGoalRounds)
        throw new Error("goal resume refused: the round cap is exhausted");
      return;
    case "complete":
      if (previous.phase === "complete" || next.phase !== "complete")
        throw new Error("goal complete requires a non-complete -> complete");
      return;
    case "blocked":
      if (previous.phase !== "active" || next.phase !== "blocked")
        throw new Error("goal blocked requires active -> blocked");
      return;
    default:
      throw new Error(`unsupported goal operation: ${String(operation)}`);
  }
}

/**
 * Folds the current goal from a session log prefix. Returns `undefined` when no
 * goal is current. The result is always `disarmed`: process-local continuation
 * authority is never reconstructed by replay.
 */
/**
 * One strict step of the goal fold. Extracted so a durable projection can carry
 * the goal forward incrementally (O(1) per event) instead of rescanning the log;
 * `foldGoal` is defined in terms of it so the two can never drift.
 */
export function foldGoalStep(
  current: GoalView | undefined,
  event: RuntimeEvent,
): GoalView | undefined {
  if (event.type === "goal.changed") {
    if (event.operation === "clear") {
      if (event.cleared === undefined)
        throw new Error("goal clear is missing its cleared identity");
      if (event.snapshot !== undefined)
        throw new Error("goal clear must not carry a snapshot");
      if (current === undefined || current.goalID !== event.cleared.goalID)
        throw new Error("goal clear does not match the current goal");
      return undefined;
    }
    const snapshot = event.snapshot;
    if (snapshot === undefined)
      throw new Error(`goal ${event.operation} is missing its snapshot`);
    assertGoalSnapshot(snapshot);
    if (
      current !== undefined &&
      current.goalID === snapshot.goalID &&
      event.roundsStarted < current.roundsStarted
    )
      throw new Error("goal roundsStarted must not go backwards");
    assertTransition(current, event.operation, snapshot, event.roundsStarted);
    const sameGoal =
      current !== undefined && current.goalID === snapshot.goalID;
    return {
      ...snapshot,
      roundsStarted: event.roundsStarted,
      createdAt: sameGoal ? current!.createdAt : event.at,
      updatedAt: event.at,
      // Replay never arms continuation.
      activation: "disarmed",
    };
  }
  if (event.type === "goal.round.cost") {
    if (current === undefined) return current;
    // A cost for a superseded revision is ignored, not charged — the same rule
    // the admission event follows, so a late report cannot bill a retired goal.
    if (event.goalID !== current.goalID || event.revision !== current.revision)
      return current;
    if (event.round !== current.roundsStarted)
      throw new Error(
        `goal round ${event.round} cost is out of sequence (expected the admitted round ${current.roundsStarted})`,
      );
    if (!Number.isFinite(event.tokens) || event.tokens < 0)
      throw new Error("goal round cost tokens must be a non-negative number");
    if (!Number.isFinite(event.durationMs) || event.durationMs < 0)
      throw new Error(
        "goal round cost durationMs must be a non-negative number",
      );
    return {
      ...current,
      spentGoalTokens: current.spentGoalTokens + event.tokens,
      goalWallClockMs: current.goalWallClockMs + event.durationMs,
    };
  }
  if (event.type === "goal.round") {
    if (current === undefined) return current;
    // A round for a superseded revision is ignored, not charged.
    if (event.goalID !== current.goalID || event.revision !== current.revision)
      return current;
    if (event.round !== current.roundsStarted + 1)
      throw new Error(
        `goal round ${event.round} is out of sequence (expected ${current.roundsStarted + 1})`,
      );
    if (current.maxGoalRounds !== 0 && event.round > current.maxGoalRounds)
      throw new Error(
        `goal round ${event.round} exceeds maxGoalRounds ${current.maxGoalRounds}`,
      );
    return { ...current, roundsStarted: event.round };
  }
  return current;
}

export function foldGoal(
  events: readonly RuntimeEvent[],
): GoalView | undefined {
  let current: GoalView | undefined;
  for (const event of events) current = foldGoalStep(current, event);
  return current;
}

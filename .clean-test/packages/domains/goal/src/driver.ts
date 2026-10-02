/**
 * Same-session goal round driver.
 *
 * Turns an active, armed goal into sequential `<goal_round>` turns through a
 * small host interface (admission, idle/queue observation, flush, publish), so
 * it stays independent of the concrete agent loop — the same split dsh uses
 * between `goal`, `goal-round-driver` and `tool-goal`.
 *
 * This is what replaces "wake an auditor every turn to prod the model": the
 * driver itself continues the goal while work remains, and stops explicitly on
 * completion, cancellation, error, a provider budget stop or the round cap.
 */
import { buildGoalRound, type GoalRoundEvent } from "./builders";
import type { RuntimeEvent } from "@anthelia/contracts";

/** One durable round-cost event, booked when a round settles. */
export type GoalRoundCostEvent = Extract<
  RuntimeEvent,
  { type: "goal.round.cost" }
>;
import type { GoalBlockReason } from "@anthelia/contracts";
import type { GoalService } from "./service";
import type { GoalView } from "./types";

/** Renders one retained goal-round instruction (dsh's `<goal_round>` block). */
export function renderGoalRoundPrompt(
  goal: GoalView,
  round: number,
  linkedPlan?: GoalLinkedPlanStatus,
): string {
  const cap =
    goal.maxGoalRounds === 0 ? "unlimited" : String(goal.maxGoalRounds);
  // EI Open Question "goal 关联的 plan 完成是否自动推进 goal round" — decided:
  // 不自动（plan 完成是证据不是目标本身，goal 完成权在模型+用户），只做可见性。
  // The round is told the linked plan's live lifecycle so the model decides
  // with it in view; the driver never completes the goal on the plan's behalf.
  const planBlock = linkedPlan
    ? `\nLinked plan: ${linkedPlan.planID} — lifecycle: ${linkedPlan.lifecycle}. ` +
      "The plan is one instrument of this objective, not the objective itself: " +
      "treat its completion as evidence, and mark the goal complete only when " +
      "the whole objective is achieved.\n"
    : "";
  return (
    "<goal_round>\n" +
    `Objective: ${JSON.stringify(goal.objective)}\n` +
    `Round: ${round}/${cap}\n` +
    planBlock +
    "\n" +
    "Continue working toward the objective in this same session. Treat the current " +
    "workspace, tool results, and durable session state as authoritative; inspect them " +
    "instead of assuming earlier narration is still current. Make concrete progress and " +
    "verify the result. Before claiming completion, gather evidence that the whole " +
    "objective is achieved, read the current goal, and mark it complete. If work remains, " +
    "leave the goal active for the next round. If you must stop for a human decision, use " +
    "ask_user. Follow the goal-tool policy before reporting a blocked goal.\n" +
    "</goal_round>"
  );
}

/**
 * How a goal round ended, as the runtime reports it.
 *
 * `error` covers a round the provider stopped early — including a token-cap
 * truncation, which surfaces as an error carrying the finish reason. There is no
 * separate `max-tokens` because it would be a label with no behaviour of its
 * own: both block the goal, and the finish reason already travels in the error.
 */
export type GoalRoundStop = "done" | "error" | "cancelled";

/**
 * The linked plan's status, surfaced into the goal round (EI Open Question:
 * goal 关联的 plan 完成是否自动推进 goal round — decided: 不自动，只做可见性).
 * Read fresh every round so a plan completed mid-round (or in another session
 * before a handoff) is visible without the driver waking on its behalf.
 */
export type GoalLinkedPlanStatus = {
  planID: string;
  /** The plan's lifecycle state (marked … completed). */
  lifecycle: string;
};

/**
 * Which budget, if any, the goal has exhausted.
 *
 * Round caps are checked separately at the round boundary, because a round is
 * admitted or refused rather than interrupted. Token and wall-clock caps are also
 * checked here rather than mid-round: a goal already over budget must not start
 * another round it cannot finish.
 */
export function goalBudgetExhausted(
  goal: Pick<
    GoalView,
    | "maxGoalTokens"
    | "maxGoalWallClockMs"
    | "spentGoalTokens"
    | "goalWallClockMs"
  >,
): GoalBlockReason | undefined {
  if (goal.maxGoalTokens > 0 && goal.spentGoalTokens >= goal.maxGoalTokens)
    return {
      code: "token-limit",
      message:
        `Goal reached its configured limit of ${goal.maxGoalTokens} tokens ` +
        `(spent ${goal.spentGoalTokens}).`,
    };
  if (
    goal.maxGoalWallClockMs > 0 &&
    goal.goalWallClockMs >= goal.maxGoalWallClockMs
  )
    return {
      code: "time-limit",
      message:
        `Goal reached its configured limit of ${goal.maxGoalWallClockMs}ms of ` +
        `work (used ${goal.goalWallClockMs}ms).`,
    };
  return undefined;
}

/** Everything the driver needs from the runtime, injected for testability. */
export type GoalRoundHost = {
  /** Current goal view (folded snapshot + live activation). */
  current(sessionID: string): GoalView | undefined;
  /** No active turn, not paused, no queued drain. */
  isIdle(sessionID: string): boolean;
  /** A human (non-goal) input is queued, so automatic work must yield. */
  hasCompetingInput(sessionID: string): boolean;
  /** Durability checkpoint before reserving a round. */
  flush(sessionID: string): Promise<void>;
  /** Admits the goal round; false when admission was refused. */
  admit(
    sessionID: string,
    input: { id: string; text: string },
  ): Promise<boolean>;
  /** Persists and publishes a durable goal event. */
  publish(
    sessionID: string,
    event:
      | GoalRoundEvent
      | GoalRoundCostEvent
      | import("./builders").GoalChangedEvent,
  ): void;
  /**
   * Optional: the linked plan's live status for the round prompt. A goal
   * without a planID, or a host that does not provide it, renders no plan
   * block — the driver never requires a plan to continue.
   */
  linkedPlanStatus?(
    sessionID: string,
    planID: string,
  ): GoalLinkedPlanStatus | undefined;
  now(): string;
  nextEventId(): string;
  /** Optional debug sink (`[goal-driver] ...`); runs only when provided. */
  log?(event: string, detail?: Record<string, unknown>): void;
};

type Reservation = {
  goalID: string;
  revision: number;
  round: number;
  messageID: string;
};

export class GoalRoundDriver {
  private readonly reservations = new Map<string, Reservation>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly service: GoalService,
    private readonly host: GoalRoundHost,
  ) {}

  /** True when this turn id belongs to a round this driver reserved. */
  isGoalRound(sessionID: string, turnID: string): boolean {
    return this.reservations.get(sessionID)?.messageID === turnID;
  }

  /** Coalesces triggers onto one per-session serialized drive. */
  async drive(sessionID: string): Promise<void> {
    const previous = this.chains.get(sessionID) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.driveOnce(sessionID));
    this.chains.set(sessionID, run);
    try {
      await run;
    } finally {
      if (this.chains.get(sessionID) === run) this.chains.delete(sessionID);
    }
  }

  private trace(event: string, detail: Record<string, unknown> = {}): void {
    this.host.log?.(event, detail);
  }

  private async driveOnce(sessionID: string): Promise<void> {
    if (this.reservations.has(sessionID)) {
      this.trace("skip", { sessionID, reason: "round-already-reserved" });
      return;
    }
    const idle = this.host.isIdle(sessionID);
    const competing = this.host.hasCompetingInput(sessionID);
    if (!idle || competing) {
      this.trace("skip", {
        sessionID,
        reason: !idle ? "not-idle" : "human-input-pending",
      });
      return;
    }
    const goal = this.host.current(sessionID);
    if (!goal || goal.phase !== "active" || goal.activation !== "armed") {
      this.trace("skip", {
        sessionID,
        reason: goal
          ? `phase=${goal.phase} activation=${goal.activation}`
          : "no-goal",
      });
      return;
    }
    this.trace("drive", {
      sessionID,
      goalID: goal.goalID,
      revision: goal.revision,
      round: goal.roundsStarted + 1,
    });
    if (goal.maxGoalRounds !== 0 && goal.roundsStarted >= goal.maxGoalRounds) {
      this.stop(sessionID, goal, {
        code: "round-limit",
        message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`,
      });
      return;
    }
    // Token and wall-clock caps are checked here rather than mid-round, so a goal
    // that is over budget never starts another round it cannot finish. Both read
    // the folded accumulators, so a restart resumes with the same figures.
    const exhausted = goalBudgetExhausted(goal);
    if (exhausted) {
      this.stop(sessionID, goal, exhausted);
      return;
    }
    const round = goal.roundsStarted + 1;
    const reservation: Reservation = {
      goalID: goal.goalID,
      revision: goal.revision,
      round,
      messageID: `goal_${goal.goalID}_round_${round}`,
    };
    this.reservations.set(sessionID, reservation);
    try {
      // Durability obligation before reserving work, then recheck everything
      // the await could have changed.
      await this.host.flush(sessionID);
    } catch {
      this.reservations.delete(sessionID);
      this.service.disarm(sessionID);
      this.trace("disarm", { sessionID, reason: "flush-failed" });
      return;
    }
    if (
      !this.host.isIdle(sessionID) ||
      this.host.hasCompetingInput(sessionID)
    ) {
      this.reservations.delete(sessionID);
      this.trace("reservation-dropped", { sessionID, reason: "stale-input" });
      return;
    }
    const latest = this.host.current(sessionID);
    if (
      !latest ||
      latest.goalID !== goal.goalID ||
      latest.revision !== goal.revision ||
      latest.phase !== "active" ||
      latest.activation !== "armed"
    ) {
      // A mutation, a human prompt or a disarm won the race: drop the
      // reservation without charging a round.
      this.reservations.delete(sessionID);
      this.trace("reservation-dropped", { sessionID, reason: "stale-goal" });
      return;
    }
    this.trace("admit", {
      sessionID,
      round,
      messageID: reservation.messageID,
    });
    let admitted = false;
    try {
      // EI Open Question "goal 关联的 plan 联动" — decided: 不自动推进 / 不自动
      // 完成，只做可见性。 Read the linked plan's live lifecycle fresh at admit
      // time (a plan completed mid-round, or in another session before a
      // handoff, is visible to the next round), and let the round decide.
      const linkedPlan = latest.planID
        ? this.host.linkedPlanStatus?.(sessionID, latest.planID)
        : undefined;
      admitted = await this.host.admit(sessionID, {
        id: reservation.messageID,
        text: renderGoalRoundPrompt(latest, round, linkedPlan),
      });
    } catch {
      admitted = false;
    }
    if (!admitted) {
      this.reservations.delete(sessionID);
      this.trace("admit-failed", { sessionID, round });
      this.stop(sessionID, latest, {
        code: "queue-failed",
        message: `Could not queue goal round ${round}.`,
      });
      return;
    }
    // The round is admitted: record it durably so replay counts it.
    this.trace("round-admitted", { sessionID, goalID: goal.goalID, round });
    this.host.publish(
      sessionID,
      buildGoalRound({
        id: this.host.nextEventId(),
        at: this.host.now(),
        goalID: goal.goalID,
        revision: goal.revision,
        round,
      }),
    );
  }

  /**
   * Books one finished goal round's cost.
   *
   * The numbers come from the turn's own report, and they are published as a
   * durable event rather than added to an in-memory total: the accumulators are
   * derived by replay, so a restart resumes with exactly the figures the log
   * says instead of whatever the last process happened to know.
   */
  private bookRoundCost(
    sessionID: string,
    goal: GoalView,
    reservation: Reservation,
    tokens: number,
    durationMs: number,
  ): void {
    this.host.publish(sessionID, {
      type: "goal.round.cost",
      id: this.host.nextEventId(),
      goalID: goal.goalID,
      revision: goal.revision,
      round: reservation.round,
      at: this.host.now(),
      tokens,
      durationMs,
    });
  }

  /** Classifies a finished turn and stops continuation when appropriate. */
  settle(
    sessionID: string,
    turnID: string,
    stopReason: GoalRoundStop,
    cost?: { tokens: number; durationMs: number },
  ): void {
    const reservation = this.reservations.get(sessionID);
    const wasGoalRound = reservation?.messageID === turnID;
    if (wasGoalRound) this.reservations.delete(sessionID);
    // Mutable: re-read after a round's cost is booked, so a stop writes
    // the figures that include it rather than the ones loaded before it.
    let goal = this.host.current(sessionID);
    if (!goal) return;
    this.trace("settle", {
      sessionID,
      turnID,
      stopReason,
      goalRound: wasGoalRound,
    });
    if (!wasGoalRound) {
      // A broad cancellation of UNRELATED work must not let the goal
      // auto-restart: drop process-local continuation authority. The durable
      // phase is unchanged, so a human `/goal resume` re-arms it.
      if (stopReason === "cancelled") {
        // Pause (durable, visible) so the status bar shows the goal stopped,
        // and disarm so even a failed pause cannot restart it.
        this.stop(
          sessionID,
          goal,
          {
            code: "cancelled",
            message: "automatic continuation was cancelled",
          },
          true,
        );
      }
      return;
    }
    // A cancelled or errored round still consumed its tokens and its wall clock,
    // so it is booked before classification: skipping it would let a goal that
    // fails every round spend without ever hitting a budget.
    if (cost && wasGoalRound) {
      this.bookRoundCost(
        sessionID,
        goal,
        reservation!,
        cost.tokens,
        cost.durationMs,
      );
      // Re-read: `goal` above was loaded before the cost was booked, so stopping
      // with it would write a snapshot that says the round spent nothing.
      goal = this.host.current(sessionID) ?? goal;
    }
    switch (stopReason) {
      case "cancelled":
        this.stop(
          sessionID,
          goal,
          { code: "cancelled", message: "the goal round was cancelled" },
          true,
        );
        return;
      case "error":
        this.stop(sessionID, goal, {
          code: "turn-error",
          message: "the goal round ended with an error",
        });
        return;
      default:
        // `done`: the next idle drive decides whether to continue.
        return;
    }
  }

  private stop(
    sessionID: string,
    goal: GoalView,
    reason: GoalBlockReason,
    pause = false,
  ): void {
    this.trace("stop", {
      sessionID,
      action: pause ? "pause" : "block",
      code: reason.code,
    });
    try {
      const result = pause
        ? this.service.pause(sessionID, goal, reason)
        : this.service.block(sessionID, goal, reason);
      this.host.publish(sessionID, result.event);
    } catch {
      // A refused/failed stop must never leave cancelled work able to restart.
      this.service.disarm(sessionID);
    }
  }
}

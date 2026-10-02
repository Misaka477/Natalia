/**
 * Same-session goal service (producer side of the goal domain).
 *
 * Every method builds one durable `goal.changed` event from the current folded
 * view and returns the resulting view with process-local activation applied.
 * Persistence is the caller's job (the runtime publishes the returned event),
 * so this class is pure except for the in-memory `activation` map.
 *
 * `activation` is deliberately NOT persisted: restart, resume and fork all
 * begin disarmed, so opening a session never starts work on its own.
 */
import type {
  GoalBlockReason,
  GoalLastStop,
  GoalSnapshot,
  RuntimeEvent,
} from "@anthelia/contracts";
import { buildGoalChanged, type GoalChangedEvent } from "./builders";
import { foldGoal } from "./fold";
import type { GoalView } from "./types";

export const DEFAULT_MAX_GOAL_ROUNDS = 256;

export type GoalServicePorts = {
  now(): string;
  nextEventId(): string;
  nextGoalId(): string;
};

export type GoalMutationResult = { event: GoalChangedEvent; view: GoalView };

export type CreateGoalInput = {
  objective: string;
  /** 0 means unlimited. */
  maxGoalRounds?: number;
  /** Cumulative token cap for the whole goal; 0 means unlimited. */
  maxGoalTokens?: number;
  /** Cumulative goal-work wall-clock cap in ms; 0 means unlimited. */
  maxGoalWallClockMs?: number;
  planID?: string;
};

export type EditGoalInput = {
  objective?: string;
  /** 0 means unlimited. */
  maxGoalRounds?: number;
  /** Cumulative token cap for the whole goal; 0 means unlimited. */
  maxGoalTokens?: number;
  /** Cumulative goal-work wall-clock cap in ms; 0 means unlimited. */
  maxGoalWallClockMs?: number;
  planID?: string;
};

function stopCode(code: string, message: string, at: number): GoalLastStop {
  return { code, at, message };
}

/**
 * Copies only the durable snapshot fields (never `activation` / timestamps,
 * which belong to the live view and must not be persisted in the event).
 */
function snapshotOf(
  view: GoalView,
  phase: GoalSnapshot["phase"],
): GoalSnapshot {
  return {
    goalID: view.goalID,
    revision: view.revision + 1,
    objective: view.objective,
    phase,
    maxGoalRounds: view.maxGoalRounds,
    // Budget and spend carry forward with the snapshot, so a later mutation
    // cannot silently reset what the goal has already consumed.
    maxGoalTokens: view.maxGoalTokens,
    maxGoalWallClockMs: view.maxGoalWallClockMs,
    spentGoalTokens: view.spentGoalTokens,
    goalWallClockMs: view.goalWallClockMs,
    ...(view.planID ? { planID: view.planID } : {}),
  };
}

export class GoalService {
  private readonly activation = new Map<string, "armed" | "disarmed">();
  /**
   * Per-session view cache. A live mutation or a recovery seed makes this the
   * authority so `current()` stays correct while the fast-path journal is only
   * a tail (or still empty). `null` is a tombstone: the goal was cleared.
   */
  private readonly views = new Map<string, GoalView | null>();
  /**
   * Cost events already applied to the cached view, per session.
   *
   * `current()` is called repeatedly against a growing journal tail, so charging
   * by scanning would bill the same round twice. Keying on the event id makes
   * the accounting idempotent without needing to reason about where the tail
   * starts.
   */
  private readonly chargedCosts = new Map<string, Set<string>>();

  constructor(private readonly ports: GoalServicePorts) {}

  /**
   * Seeds the current view from the durable recovery projection. Positive
   * views only: a goal-less session keeps folding its journal (which may still
   * hold a goal that predates the recovery table).
   */
  seed(
    sessionID: string,
    view:
      | (GoalSnapshot & {
          roundsStarted: number;
          createdAt?: string;
          updatedAt?: string;
          activation?: "armed" | "disarmed";
        })
      | undefined,
  ): void {
    if (!view) return;
    // A recovery row read mid-batch can lag a live mutation; never let it
    // downgrade a newer cached revision/round count.
    const existing = this.views.get(sessionID);
    if (
      existing &&
      existing.goalID === view.goalID &&
      (existing.revision > view.revision ||
        (existing.revision === view.revision &&
          existing.roundsStarted > view.roundsStarted))
    )
      return;
    const at = this.ports.now();
    this.views.set(sessionID, {
      ...view,
      createdAt: view.createdAt ?? at,
      updatedAt: view.updatedAt ?? view.createdAt ?? at,
      activation: "disarmed",
    });
  }

  private withActivation(
    sessionID: string,
    view: GoalView | undefined,
  ): GoalView | undefined {
    if (!view) return undefined;
    return {
      ...view,
      activation: this.activation.get(sessionID) ?? "disarmed",
    };
  }

  /**
   * Current goal for the session, from the cache, journal, or recovery seed.
   *
   * `durable` is the engine fact state's goal slice when the caller has one:
   * a complete projection (paged from the durable log, `disarmed`), which the
   * no-cache path prefers over folding `events` — a fast-attach tail would
   * otherwise hide an older goal and answer "there is no goal". The cache path
   * is the live authority (it charges settled rounds/costs incrementally) and
   * never consults it.
   */
  current(
    sessionID: string,
    events: readonly RuntimeEvent[],
    durable?: GoalView,
  ): GoalView | undefined {
    if (!this.views.has(sessionID))
      return this.withActivation(sessionID, durable ?? foldGoal(events));
    // Mutable because settled costs are charged into it below.
    let cached = this.views.get(sessionID) ?? undefined;
    if (!cached) return undefined;
    // Admitted rounds and settled costs are appended to the journal before the
    // cache is told (unit callers publish directly), so charge them here — the
    // same accounting `foldGoal` does from scratch, applied incrementally.
    let roundsStarted = cached.roundsStarted;
    const charged = this.chargedCosts.get(sessionID) ?? new Set<string>();
    this.chargedCosts.set(sessionID, charged);
    for (const event of events) {
      if (event.type !== "goal.round" && event.type !== "goal.round.cost")
        continue;
      // A cost for a superseded revision belongs to the goal it was billed
      // against, not to the current one.
      if (event.goalID !== cached.goalID || event.revision !== cached.revision)
        continue;
      if (event.type === "goal.round") {
        if (event.round > roundsStarted) roundsStarted = event.round;
        continue;
      }
      if (charged.has(event.id)) continue;
      charged.add(event.id);
      cached = {
        ...cached,
        spentGoalTokens: cached.spentGoalTokens + event.tokens,
        goalWallClockMs: cached.goalWallClockMs + event.durationMs,
      };
    }
    // The round count is charged into the cache too, or the next call would
    // re-derive it from a journal that has not grown.
    if (roundsStarted !== cached.roundsStarted)
      cached = { ...cached, roundsStarted };
    this.views.set(sessionID, cached);
    return this.withActivation(sessionID, cached);
  }

  /** Removes process-local continuation authority without touching the log. */
  disarm(sessionID: string): void {
    this.activation.set(sessionID, "disarmed");
  }

  arm(sessionID: string): void {
    this.activation.set(sessionID, "armed");
  }

  isArmed(sessionID: string): boolean {
    return (this.activation.get(sessionID) ?? "disarmed") === "armed";
  }

  private emit(
    sessionID: string,
    operation: GoalChangedEvent["operation"],
    next: GoalSnapshot,
    roundsStarted: number,
    current: GoalView | undefined,
    at: string,
  ): GoalMutationResult {
    const event = buildGoalChanged({
      id: this.ports.nextEventId(),
      at,
      operation,
      snapshot: next,
      roundsStarted,
    });
    // Lifecycle stops disarm; create/resume arm. An edit is a modification, not
    // a stop, so it preserves the current continuation authority — otherwise a
    // mid-flight edit would silently prevent the next round from running.
    const armed =
      operation === "create" || operation === "resume"
        ? true
        : operation === "edit"
          ? this.isArmed(sessionID)
          : false;
    this.activation.set(sessionID, armed ? "armed" : "disarmed");
    const createdAt =
      current && current.goalID === next.goalID ? current.createdAt : at;
    const view: GoalView = {
      ...next,
      roundsStarted,
      createdAt,
      updatedAt: at,
      activation: armed ? "armed" : "disarmed",
    };
    this.views.set(sessionID, view);
    return { event, view };
  }

  create(
    sessionID: string,
    current: GoalView | undefined,
    input: CreateGoalInput,
  ): GoalMutationResult {
    if (current && current.phase !== "complete")
      throw new Error(
        `cannot create a goal while ${current.goalID} is ${current.phase}`,
      );
    const objective = input.objective.trim();
    if (!objective) throw new Error("goal objective must not be empty");
    const at = this.ports.now();
    const snapshot: GoalSnapshot = {
      goalID: this.ports.nextGoalId(),
      revision: 1,
      objective,
      phase: "active",
      maxGoalRounds: input.maxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS,
      // A fresh goal has spent nothing and, unless asked otherwise, has no
      // budget beyond its round cap.
      maxGoalTokens: input.maxGoalTokens ?? 0,
      maxGoalWallClockMs: input.maxGoalWallClockMs ?? 0,
      spentGoalTokens: 0,
      goalWallClockMs: 0,
      ...(input.planID ? { planID: input.planID } : {}),
    };
    return this.emit(sessionID, "create", snapshot, 0, current, at);
  }

  /** Edits objective / cap / plan. Editing a completed goal starts a new one. */
  edit(
    sessionID: string,
    current: GoalView | undefined,
    input: EditGoalInput,
  ): GoalMutationResult {
    if (!current) throw new Error("there is no goal to edit");
    if (current.phase === "complete") {
      return this.create(sessionID, current, {
        objective: input.objective ?? current.objective,
        maxGoalRounds: input.maxGoalRounds,
        planID: input.planID,
      });
    }
    if (
      input.objective === undefined &&
      input.maxGoalRounds === undefined &&
      input.planID === undefined
    )
      throw new Error("goal edit requires at least one field");
    const at = this.ports.now();
    const objective = (input.objective ?? current.objective).trim();
    if (!objective) throw new Error("goal objective must not be empty");
    const snapshot: GoalSnapshot = {
      goalID: current.goalID,
      revision: current.revision + 1,
      objective,
      phase: current.phase,
      ...(current.blockedReason
        ? { blockedReason: current.blockedReason }
        : {}),
      ...(current.lastStop ? { lastStop: current.lastStop } : {}),
      maxGoalRounds: input.maxGoalRounds ?? current.maxGoalRounds,
      // Budgets are editable alongside the round cap; spend always carries
      // forward, because an edit revising the objective cannot unspend it.
      maxGoalTokens: input.maxGoalTokens ?? current.maxGoalTokens,
      maxGoalWallClockMs:
        input.maxGoalWallClockMs ?? current.maxGoalWallClockMs,
      spentGoalTokens: current.spentGoalTokens,
      goalWallClockMs: current.goalWallClockMs,
      ...((input.planID ?? current.planID)
        ? { planID: input.planID ?? current.planID }
        : {}),
    };
    return this.emit(
      sessionID,
      "edit",
      snapshot,
      current.roundsStarted,
      current,
      at,
    );
  }

  pause(
    sessionID: string,
    current: GoalView | undefined,
    reason?: { code?: string; message?: string },
  ): GoalMutationResult {
    if (!current || current.phase !== "active")
      throw new Error("goal pause requires an active goal");
    const at = this.ports.now();
    const snapshot: GoalSnapshot = {
      ...snapshotOf(current, "paused"),
      lastStop: stopCode(
        reason?.code ?? "user-paused",
        reason?.message ?? "automatic continuation was paused",
        Date.parse(at),
      ),
    };
    return this.emit(
      sessionID,
      "pause",
      snapshot,
      current.roundsStarted,
      current,
      at,
    );
  }

  resume(sessionID: string, current: GoalView | undefined): GoalMutationResult {
    if (!current) throw new Error("there is no goal to resume");
    if (current.phase !== "paused" && current.phase !== "blocked")
      throw new Error("goal resume requires a paused or blocked goal");
    if (
      current.maxGoalRounds !== 0 &&
      current.roundsStarted >= current.maxGoalRounds
    )
      throw new Error("cannot resume: the round cap is exhausted");
    const at = this.ports.now();
    const snapshot = snapshotOf(current, "active");
    return this.emit(
      sessionID,
      "resume",
      snapshot,
      current.roundsStarted,
      current,
      at,
    );
  }

  complete(
    sessionID: string,
    current: GoalView | undefined,
  ): GoalMutationResult {
    if (!current) throw new Error("there is no goal to complete");
    if (current.phase === "complete")
      throw new Error("the goal is already complete");
    const at = this.ports.now();
    const snapshot: GoalSnapshot = {
      ...snapshotOf(current, "complete"),
      lastStop: stopCode(
        "completed",
        "the objective was reported complete",
        Date.parse(at),
      ),
    };
    return this.emit(
      sessionID,
      "complete",
      snapshot,
      current.roundsStarted,
      current,
      at,
    );
  }

  block(
    sessionID: string,
    current: GoalView | undefined,
    reason: GoalBlockReason,
  ): GoalMutationResult {
    if (!current || current.phase !== "active")
      throw new Error("goal block requires an active goal");
    if (!reason.code.trim() || !reason.message.trim())
      throw new Error("goal block requires a code and a message");
    const at = this.ports.now();
    const snapshot: GoalSnapshot = {
      ...snapshotOf(current, "blocked"),
      blockedReason: reason,
      lastStop: stopCode(reason.code, reason.message, Date.parse(at)),
    };
    return this.emit(
      sessionID,
      "blocked",
      snapshot,
      current.roundsStarted,
      current,
      at,
    );
  }

  clear(
    sessionID: string,
    current: GoalView | undefined,
  ): { event: GoalChangedEvent } {
    if (!current) throw new Error("there is no goal to clear");
    const at = this.ports.now();
    this.activation.set(sessionID, "disarmed");
    // Tombstone the cache so a tail-only journal cannot resurrect the goal.
    this.views.set(sessionID, null);
    return {
      event: buildGoalChanged({
        id: this.ports.nextEventId(),
        at,
        operation: "clear",
        cleared: { goalID: current.goalID, revision: current.revision + 1 },
        roundsStarted: current.roundsStarted,
      }),
    };
  }
}

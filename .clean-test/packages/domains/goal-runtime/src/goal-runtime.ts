/**
 * Client-runtime wiring for the goal round driver.
 *
 * Owns the per-runtime `GoalService` (live activation) and `GoalRoundDriver`,
 * and exposes the host interface the driver needs. The driver itself lives in
 * `@natalia/goal` and is unit-tested there; this module only adapts it to the
 * runtime context.
 */
import { GoalRoundDriver } from "@natalia/goal";
import type { GoalRoundHost, GoalRoundStop } from "@natalia/goal";
import { GoalService } from "@natalia/goal";
import type { GoalView } from "@natalia/goal";
import { admittedInputs, sessionFactGoal } from "@anthelia/session";
import type { SessionStoreController } from "@anthelia/session-store";
import { sessionStoreController } from "@anthelia/session-store";
import type {
  GoalEditInput,
  RuntimeEvent,
  SessionID,
} from "@anthelia/contracts";
import type { RuntimeTool } from "@anthelia/tools";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import { goalTools } from "./goal-tools";
import { runCompletionCheck } from "./goal-completion-check";
import { logOf } from "@anthelia/operation-log";

export type GoalRuntime = {
  service: GoalService;
  driver: GoalRoundDriver;
  /** Model-facing goal tools, registered into the main tool registry. */
  tools: RuntimeTool[];
  /**
   * Called for every finished turn: classify a finished goal round, then let
   * the driver decide whether another round should start.
   */
  onTurnFinished(exec: SessionExecutionState, event: RuntimeEvent): void;
  /** Re-check the goal now (e.g. after a create/resume mutation). */
  requestDrive(exec: SessionExecutionState): void;
  /** Drop process-local continuation authority for a session. */
  disarm(sessionID: SessionID): void;
  /**
   * Re-seed the live goal from the durable recovery projection and re-publish
   * a live `goal.status`. Called on (re)attach so an existing goal reaches the
   * status bar even though the fast path never replays the durable journal.
   */
  refresh(sessionID: SessionID): Promise<void>;
  /**
   * Direct human control (status-bar button / RPC), bypassing the model.
   * `pause` hard-stops the in-flight goal round; `resume` re-arms and starts a
   * fresh round; `clear` tombstones the goal.
   */
  control(
    action: "pause" | "resume" | "clear",
    sessionID: SessionID,
  ): Promise<{ ok: boolean; action: string; message?: string }>;
  /**
   * Human edit of the current goal. Applies the durable edit (so the next round
   * uses it) and, if a goal round is in flight, steers it with a `next-step`
   * note so the model can adapt without restarting the round.
   */
  edit(
    input: GoalEditInput,
    sessionID: SessionID,
  ): Promise<{ ok: boolean; action: string; message?: string }>;
};

export function createGoalRuntime(ctx: RuntimeContext): GoalRuntime {
  let sequence = 0;
  let goalSequence = 0;
  const now = () => new Date().toISOString();
  const nextEventId = () => `goal_evt_${Date.now().toString(36)}_${++sequence}`;
  const execFor = (sessionID: string) =>
    ctx.ports.getExecutionBySession().get(sessionID as SessionID);

  /**
   * The engine fact state's goal slice when it is complete (paged from the
   * durable log, so it holds pre-epoch goals a fast-attach tail cannot see).
   * Passed to the service as the durable view; absent or incomplete leaves
   * the service's journal fold as the belt. The service's cache, when warm,
   * remains the live authority either way.
   */
  const durableGoal = (exec: SessionExecutionState) =>
    exec.factStateComplete === true && exec.factState
      ? sessionFactGoal(exec.factState)
      : undefined;

  const service = new GoalService({
    now,
    nextEventId,
    nextGoalId: () =>
      `goal_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}_${++goalSequence}`,
  });

  const host: GoalRoundHost = {
    current: (sessionID) => {
      const exec = execFor(sessionID);
      if (!exec) return undefined;
      return service.current(sessionID, exec.session.events, durableGoal(exec));
    },
    isIdle: (sessionID) => {
      const exec = execFor(sessionID);
      if (!exec) return false;
      return (
        !exec.activeTurnID &&
        !exec.paused &&
        !exec.endTurnWaitingHuman &&
        !exec.activeAbort
      );
    },
    hasCompetingInput: (sessionID) => {
      const exec = execFor(sessionID);
      if (!exec) return true;
      // A queued human (non-internal) input outranks automatic goal work.
      return admittedInputs(exec.session).some(
        (input) => !input.promotedAt && !input.internal,
      );
    },
    flush: async (sessionID) => {
      const store = ctx.state.serviceDirectory.getOptional(
        sessionStoreController,
      );
      await store?.flush(sessionID as SessionID);
    },
    admit: async (sessionID, input) => {
      try {
        await ctx.ports.submitInput(
          {
            id: input.id,
            text: input.text,
            delivery: "next-turn",
            internal: true,
            sessionID,
          },
          sessionID as SessionID,
        );
        return true;
      } catch {
        return false;
      }
    },
    publish: (sessionID, event) => {
      const exec = execFor(sessionID);
      if (exec) ctx.ports.publishForSession(exec, event as RuntimeEvent);
    },
    // EI Open Question "goal 关联的 plan 联动" — decided: 不自动推进 / 不自动
    // 完成，只做可见性。 The round prompt is told the linked plan's live
    // lifecycle (read fresh every round); the goal's completion authority
    // stays with the model and the user.
    linkedPlanStatus: (sessionID, planID) => {
      const exec = execFor(sessionID);
      if (!exec) return undefined;
      const plan = ctx.ports.planDocRuntime.planDocByID(planID);
      if (!plan) return undefined;
      return { planID, lifecycle: plan.status };
    },
    now,
    nextEventId,
    log: (event, detail) => {
      if (process.env.NATALIA_GOAL_DEBUG === "0") return;
      logOf(ctx.state.serviceDirectory).info("goal-driver", "", {
        args: [event, detail ?? {}],
      });
    },
  };

  const driver = new GoalRoundDriver(service, host);

  const requestDrive = (exec: SessionExecutionState) => {
    const sessionID = exec.session.id;
    // A turn is NOT idle at the instant `turn.finished` fires: the runner still
    // clears its active-turn fields a tick later. Poll briefly for the idle edge
    // instead of giving up on the first check. Bounded: the next `turn.finished`
    // (or a create/resume) re-triggers anyway.
    let attempts = 0;
    const attempt = () => {
      attempts += 1;
      if (host.isIdle(sessionID) && !host.hasCompetingInput(sessionID)) {
        void driver.drive(sessionID).catch(() => undefined);
        return;
      }
      if (attempts < 25) setTimeout(attempt, 200);
    };
    setTimeout(attempt, 0);
  };

  // Waits (bounded) for an already-cancelled goal round to leave the reserved
  // slot, so its `settle(cancelled)` cannot re-pause a goal we are resuming.
  const waitForGoalRoundToSettle = async (exec: SessionExecutionState) => {
    const sessionID = exec.session.id;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const turnID = exec.activeTurnID;
      if (!turnID || !driver.isGoalRound(sessionID, turnID)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  };

  const capLabel = (cap: number) => (cap === 0 ? "unlimited" : String(cap));

  // A `next-step` steering note, injected as a user message at the next step of
  // the running round so the model adapts without a restart.
  const renderGoalEditNote = (previous: GoalView, next: GoalView) => {
    const changes: string[] = [];
    if (previous.objective !== next.objective)
      changes.push(
        `- Objective: ${JSON.stringify(previous.objective)} -> ${JSON.stringify(next.objective)}`,
      );
    if (previous.maxGoalRounds !== next.maxGoalRounds)
      changes.push(
        `- Round cap: ${capLabel(previous.maxGoalRounds)} -> ${capLabel(next.maxGoalRounds)}`,
      );
    if ((previous.planID ?? "none") !== (next.planID ?? "none"))
      changes.push(
        `- Plan: ${previous.planID ?? "none"} -> ${next.planID ?? "none"}`,
      );
    return [
      "[goal edited by user]",
      "The human edited the active goal. New durable goal state:",
      `Objective: ${JSON.stringify(next.objective)}`,
      `Revision: ${next.revision}`,
      ...changes,
      "Adapt the remaining work in this round to the new objective; the next round will start from it. Call get_goal if you need the exact state.",
    ].join("\n");
  };

  const control: GoalRuntime["control"] = async (action, sessionID) => {
    const exec = execFor(sessionID);
    if (!exec) return { ok: false, action, message: "session not found" };
    const current = service.current(
      sessionID,
      exec.session.events,
      durableGoal(exec),
    );
    if (!current) return { ok: false, action, message: "there is no goal" };
    try {
      if (action === "pause") {
        const result = service.pause(sessionID, current, {
          code: "user-paused",
          message: "paused from the status bar",
        });
        ctx.ports.publishForSession(exec, result.event);
        // A durable `paused` phase alone only stops the NEXT round, so the
        // in-flight round would keep running for minutes. Hard-stop it — but
        // only a goal round; a human turn keeps working.
        const activeTurnID = exec.activeTurnID;
        if (activeTurnID && driver.isGoalRound(sessionID, activeTurnID))
          await ctx.ports.cancelTurn?.("goal paused", sessionID);
        return { ok: true, action };
      }
      if (action === "resume") {
        // If our pause cancelled a round that is still winding down, let it
        // settle first or its `settle(cancelled)` would re-pause this resume.
        await waitForGoalRoundToSettle(exec);
        const latest = service.current(
          sessionID,
          exec.session.events,
          durableGoal(exec),
        );
        if (!latest) return { ok: false, action, message: "there is no goal" };
        const result = service.resume(sessionID, latest);
        ctx.ports.publishForSession(exec, result.event);
        requestDrive(exec);
        return { ok: true, action };
      }
      const result = service.clear(sessionID, current);
      ctx.ports.publishForSession(exec, result.event);
      return { ok: true, action };
    } catch (error) {
      return {
        ok: false,
        action,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const edit: GoalRuntime["edit"] = async (input, sessionID) => {
    const exec = execFor(sessionID);
    if (!exec)
      return { ok: false, action: "edit", message: "session not found" };
    const current = service.current(sessionID, exec.session.events);
    if (!current)
      return { ok: false, action: "edit", message: "there is no goal" };
    if (input.goalID !== current.goalID || input.revision !== current.revision)
      return {
        ok: false,
        action: "edit",
        message: "stale goal_id/revision; refresh and retry",
      };
    try {
      const result = service.edit(sessionID, current, {
        ...(input.objective !== undefined
          ? { objective: input.objective }
          : {}),
        ...(input.maxGoalRounds !== undefined
          ? { maxGoalRounds: input.maxGoalRounds }
          : {}),
        ...(input.planID !== undefined ? { planID: input.planID } : {}),
      });
      ctx.ports.publishForSession(exec, result.event);
      // The durable edit already makes the NEXT round use the new objective;
      // also steer the in-flight round so the model adapts at its next step.
      const activeTurnID = exec.activeTurnID;
      if (
        result.event.operation === "edit" &&
        activeTurnID &&
        driver.isGoalRound(sessionID, activeTurnID)
      ) {
        await ctx.ports
          .submitInput(
            {
              id: `goal_edit_${result.view.revision}`,
              text: renderGoalEditNote(current, result.view),
              delivery: "next-step",
              internal: true,
              sessionID,
            },
            sessionID,
          )
          .catch(() => undefined);
      }
      requestDrive(exec);
      return { ok: true, action: "edit" };
    } catch (error) {
      return {
        ok: false,
        action: "edit",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const refresh: GoalRuntime["refresh"] = async (sessionID) => {
    const store = ctx.state.serviceDirectory.get(sessionStoreController);
    // Any goal mutation already queued for persistence must land before the
    // recovery row is read, or a just-cleared goal would be resurrected.
    await ctx.ports
      .getSessionPersistenceForSession(sessionID)
      .catch(() => undefined);
    await store?.flush(sessionID).catch(() => undefined);
    const recovered = store?.loadRecoveryProjection(sessionID)?.goal;
    if (recovered) service.seed(sessionID, recovered);
    const exec = execFor(sessionID);
    if (!exec) return;
    let goal: ReturnType<GoalService["current"]>;
    try {
      goal = service.current(sessionID, exec.session.events, durableGoal(exec));
    } catch {
      // A mid-history journal tail cannot be folded. The recovery seed (when
      // present) already won above, so leave the current UI state untouched.
      return;
    }
    ctx.ports.publishForSession(exec, {
      type: "goal.status",
      ...(goal ? { goal } : {}),
      at: now(),
    });
  };
  const runtime: GoalRuntime = {
    service,
    driver,
    tools: [],
    control,
    edit,
    refresh,
    onTurnFinished(exec, event) {
      if (event.type !== "turn.finished") return;
      const stop: GoalRoundStop =
        event.stopReason === "cancelled"
          ? "cancelled"
          : event.stopReason === "error"
            ? "error"
            : "done";
      // The turn's own report is the round's cost: input plus output tokens, and
      // its wall clock. A turn that reports neither books nothing, so a goal
      // without a budget never blocks on a figure it cannot observe.
      const tokens =
        event.inputTokens === undefined && event.outputTokens === undefined
          ? undefined
          : (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
      driver.settle(exec.session.id, event.id, stop, {
        tokens: tokens ?? 0,
        durationMs: event.durationMs ?? 0,
      });
      requestDrive(exec);
    },
    requestDrive,
    disarm(sessionID) {
      service.disarm(sessionID);
    },
  };
  runtime.tools = goalTools(ctx, runtime, {
    // The configured command, read at call time rather than captured here, so a
    // config reload takes effect without rebuilding the tool.
    completionCheck: () =>
      runCompletionCheck({
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        command: ctx.ports.getTsRuntimeConfig()?.goal.completionCommand,
      }),
  });
  return runtime;
}

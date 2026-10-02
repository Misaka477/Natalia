/**
 * Model-facing goal tools: `get_goal`, `create_goal`, `update_goal`.
 *
 * Creation is the semi-explicit C flow: the model is instructed to confirm with
 * `ask_user` first and only then call `create_goal`. Authority is enforced here:
 * create/edit/pause/resume require a human (non-internal) current turn, while
 * complete/blocked additionally accept the exact current goal round.
 */
import type { GoalBlockReason, SessionID } from "@anthelia/contracts";
import { sessionFactGoal } from "@anthelia/session";
import type { RuntimeTool } from "@anthelia/tools";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import type { GoalRuntime } from "./goal-runtime";

type Params = Record<string, unknown>;

/**
 * A model-reported block from a goal round is mechanically refused until the
 * same condition has had at least this many consecutive admitted rounds. Humans
 * may stop a goal immediately, and `ask_user` remains the escape hatch.
 */
const BLOCKED_AFTER_CONSECUTIVE_ROUNDS = 3;

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

export function goalTools(
  ctx: RuntimeContext,
  goalRuntime: GoalRuntime,
  options: {
    /**
     * Runs the configured completion check. Absent, or a workspace with no
     * configured command, means no check and the completion is accepted exactly
     * as before.
     */
    completionCheck?: () =>
      | {
          ok: boolean;
          command?: string;
          detail?: string;
        }
      | undefined;
  } = {},
): RuntimeTool[] {
  const sessionID = (context: { sessionID?: string }) =>
    (context.sessionID ?? ctx.ports.getSessionID()) as SessionID | undefined;

  const execFor = (id: SessionID | undefined) =>
    id === undefined ? undefined : ctx.ports.getExecutionBySession().get(id);

  function isHumanTurn(exec: SessionExecutionState): boolean {
    const turnID = exec.activeTurnID;
    if (!turnID) return false;
    const input = exec.session.inbox?.find((item) => item.id === turnID);
    return input !== undefined && input.internal !== true;
  }

  function canStopGoal(exec: SessionExecutionState): boolean {
    if (isHumanTurn(exec)) return true;
    const turnID = exec.activeTurnID;
    return Boolean(
      turnID && goalRuntime.driver.isGoalRound(exec.session.id, turnID),
    );
  }

  function currentView(exec: SessionExecutionState) {
    // The engine fact state's goal slice when complete: a fast-attach tail
    // cannot hide an older goal from the tool face. The belt (the service's
    // journal fold) stays for the incomplete case.
    const durable =
      exec.factStateComplete === true && exec.factState
        ? sessionFactGoal(exec.factState)
        : undefined;
    return goalRuntime.service.current(
      exec.session.id,
      exec.session.events,
      durable,
    );
  }

  function publish(exec: SessionExecutionState, event: unknown) {
    ctx.ports.publishForSession(exec, event as never);
  }

  const getGoal: RuntimeTool = {
    name: "get_goal",
    description:
      "Read the current same-session goal: id, revision, objective, phase, blockedReason, rounds started/max, and whether automatic continuation is armed. Returns { goal: null } when there is none.",
    requiresApproval: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_parsed, context) {
      const exec = execFor(sessionID(context));
      if (!exec) return JSON.stringify({ goal: null });
      const goal = currentView(exec);
      if (!goal) return JSON.stringify({ goal: null });
      return JSON.stringify({
        goal: {
          id: goal.goalID,
          revision: goal.revision,
          objective: goal.objective,
          phase: goal.phase,
          ...(goal.blockedReason ? { blockedReason: goal.blockedReason } : {}),
          ...(goal.lastStop ? { lastStop: goal.lastStop } : {}),
          roundsStarted: goal.roundsStarted,
          maxGoalRounds: goal.maxGoalRounds,
          ...(goal.planID ? { planID: goal.planID } : {}),
          activation: goal.activation,
        },
      });
    },
  };

  const createGoal: RuntimeTool = {
    name: "create_goal",
    description:
      "Create one long-running same-session goal. Confirm with the user via ask_user before calling this. Do not create a goal for routine single-turn work. max_goal_rounds=0 means unlimited.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string" },
        max_goal_rounds: { type: "number" },
        plan_id: { type: "string" },
      },
      required: ["objective"],
      additionalProperties: false,
    },
    async execute(parsed, context) {
      const args = (parsed ?? {}) as Params;
      const objective = stringArg(args.objective);
      if (!objective) return "create_goal requires an objective";
      const exec = execFor(sessionID(context));
      if (!exec) return "create_goal: session is not initialized";
      if (!isHumanTurn(exec))
        return "create_goal requires a direct human request in the current turn";
      try {
        const result = goalRuntime.service.create(
          exec.session.id,
          currentView(exec),
          {
            objective,
            ...(numberArg(args.max_goal_rounds) !== undefined
              ? { maxGoalRounds: numberArg(args.max_goal_rounds) }
              : {}),
            ...(stringArg(args.plan_id)
              ? { planID: stringArg(args.plan_id) }
              : {}),
          },
        );
        publish(exec, result.event);
        goalRuntime.requestDrive(exec);
        return JSON.stringify({
          goal: {
            id: result.view.goalID,
            revision: result.view.revision,
            phase: result.view.phase,
          },
        });
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    },
  };

  const updateGoal: RuntimeTool = {
    name: "update_goal",
    description:
      "Mutate the current goal. Call get_goal first and pass its exact goal_id and revision. actions: edit | pause | resume | complete | blocked. edit replaces objective/max_goal_rounds/plan_id; blocked requires blocked_reason. Mark complete only when the objective is actually achieved.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        revision: { type: "number" },
        action: { type: "string" },
        objective: { type: "string" },
        max_goal_rounds: { type: "number" },
        plan_id: { type: "string" },
        blocked_reason: { type: "string" },
      },
      required: ["goal_id", "revision", "action"],
      additionalProperties: false,
    },
    async execute(parsed, context) {
      const args = (parsed ?? {}) as Params;
      const action = stringArg(args.action);
      const exec = execFor(sessionID(context));
      if (!exec) return "update_goal: session is not initialized";
      const service = goalRuntime.service;
      const current = currentView(exec);
      if (!current) return "update_goal: there is no current goal";
      if (
        stringArg(args.goal_id) !== current.goalID ||
        numberArg(args.revision) !== current.revision
      )
        return "update_goal: stale goal_id/revision; call get_goal and retry";
      const needsHuman =
        action === "edit" || action === "pause" || action === "resume";
      if (needsHuman && !isHumanTurn(exec))
        return `update_goal ${action} requires a direct human request in the current turn`;
      if (!needsHuman && !canStopGoal(exec))
        return `update_goal ${action} requires a human turn or the current goal round`;
      try {
        let event: unknown;
        switch (action) {
          case "edit":
            event = service.edit(exec.session.id, current, {
              ...(stringArg(args.objective) !== undefined
                ? { objective: stringArg(args.objective) }
                : {}),
              ...(numberArg(args.max_goal_rounds) !== undefined
                ? { maxGoalRounds: numberArg(args.max_goal_rounds) }
                : {}),
              ...(stringArg(args.plan_id) !== undefined
                ? { planID: stringArg(args.plan_id) }
                : {}),
            }).event;
            break;
          case "pause":
            event = service.pause(exec.session.id, current).event;
            break;
          case "resume":
            event = service.resume(exec.session.id, current).event;
            break;
          case "complete": {
            // The model's own claim used to be the whole authority. A configured
            // check makes it checkable — and a human's completion is still the
            // authority, for the same reason a human may stop a goal immediately.
            const check = !isHumanTurn(exec)
              ? options.completionCheck?.()
              : undefined;
            if (check && !check.ok)
              return [
                "update_goal complete is refused: the configured completion check failed.",
                check.command ? `Command: ${check.command}` : undefined,
                check.detail ?? "The check reported failure without detail.",
                "The objective is not demonstrably met. Keep the goal active and continue, or use ask_user if this needs a human decision.",
              ]
                .filter(Boolean)
                .join("\n");
            event = service.complete(exec.session.id, current).event;
            break;
          }
          case "blocked": {
            const message = stringArg(args.blocked_reason);
            if (!message) return "update_goal blocked requires blocked_reason";
            // Hard lower bound: a goal round cannot self-block before the
            // condition has persisted across enough rounds. A human may stop
            // immediately, and ask_user is the escape hatch for a real decision.
            if (
              !isHumanTurn(exec) &&
              current.roundsStarted < BLOCKED_AFTER_CONSECUTIVE_ROUNDS
            )
              return `update_goal blocked is refused until the same condition has persisted for at least ${BLOCKED_AFTER_CONSECUTIVE_ROUNDS} goal rounds (currently ${current.roundsStarted}). If work remains, keep the goal active and continue; if you need a human decision, use ask_user.`;
            // A member of the closed `GoalBlockCode` set, like the codes the goal
            // driver emits: a misspelling here is a compile error rather than a
            // durable snapshot a consumer cannot name.
            const reason: GoalBlockReason = {
              code: "model-reported",
              message,
            };
            event = service.block(exec.session.id, current, reason).event;
            break;
          }
          default:
            return `update_goal: unknown action ${String(action)}`;
        }
        publish(exec, event);
        if (action === "resume") goalRuntime.requestDrive(exec);
        return JSON.stringify({ updated: true, action });
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    },
  };

  return [getGoal, createGoal, updateGoal];
}

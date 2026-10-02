/**
 * Same-session goal domain.
 *
 * Owns the durable goal lifecycle (`active | paused | blocked | complete`), its
 * compare-and-set revision, the admitted-round counter and the strict fold that
 * reconstructs it from the session log. Scheduling (the round driver) and the
 * model-facing tools live in their own layers, exactly like dsh's
 * goal / goal-round-driver / tool-goal split.
 *
 * See `.kilo/plans/natalia-goal-subsystem.zh-CN.md`.
 */
export type { GoalView, GoalMutation } from "./types";
export type {
  GoalBlockReason,
  GoalLastStop,
  GoalMessageSource,
  GoalOperation,
  GoalPhase,
  GoalSnapshot,
} from "@anthelia/contracts";
export { assertGoalSnapshot, foldGoal, foldGoalStep } from "./fold";
export {
  buildGoalChanged,
  buildGoalRound,
  type GoalChangedEvent,
  type GoalRoundEvent,
} from "./builders";
export {
  DEFAULT_MAX_GOAL_ROUNDS,
  GoalService,
  type CreateGoalInput,
  type EditGoalInput,
  type GoalMutationResult,
  type GoalServicePorts,
} from "./service";
export {
  GoalRoundDriver,
  renderGoalRoundPrompt,
  type GoalLinkedPlanStatus,
  type GoalRoundHost,
  type GoalRoundStop,
} from "./driver";

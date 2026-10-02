import type { GoalOperation } from "@anthelia/contracts";

/**
 * The live goal projection lives in the contract vocabulary (the fact state in
 * `@anthelia/session` folds the same shape engine-side); the domain re-exports
 * it so consumers keep one import site.
 */
export type { GoalView } from "@anthelia/contracts";

/** Mutations accepted by the domain (the `clear` tombstone is its own event). */
export type GoalMutation = Exclude<GoalOperation, "clear">;

/** The durable goal state after one accepted mutation. */
export type { GoalSnapshot } from "@anthelia/contracts";

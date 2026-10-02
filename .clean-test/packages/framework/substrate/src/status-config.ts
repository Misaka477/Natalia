import type { ContextBudget } from "@anthelia/runtime";

/**
 * The resolved context budget carried by the runtime and each exec.
 *
 * Named for its origin as the context *status* config; it is now the canonical
 * `ContextBudget` (plan §2.3) — window, reserve and source, threshold, the
 * preserved-recent tail, overflow retries and the prune options — resolved once
 * per provider/model selection in `resolveContextStatusConfig`.
 */
export type RuntimeContextStatusConfig = ContextBudget;

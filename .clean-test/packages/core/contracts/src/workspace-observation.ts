import { z } from "zod";

/**
 * WG4 workspace observation / confirmed change contract (§56.9, Phase 1).
 *
 * Phase 1 defines the secret-safe contract before any watcher hint is promoted
 * to a confirmed fact. Three rules shape it:
 *
 * 1. **A watcher event is only a hint.** A `WorkspaceObservation` records what
 *    was seen and the health it was seen under; it never claims a path,
 *    operation type or actor by itself. Only a reconciled
 *    `ConfirmedWorkspaceChange` is a fact that can reach the Work Graph.
 * 2. **No secrets.** The contract carries workspace-relative paths, operation
 *    types, correlation metadata and health — never file content, diffs,
 *    patches, command text, tool arguments or results, context snapshots or
 *    raw errors. `assertSecretSafeObservation` in `@natalia/client` enforces
 *    the boundary at a single point.
 * 3. **Attribution is constrained, not free text.** `origin` and `attribution`
 *    are enums, and a change with no reliable identity stays unattributed or
 *    indeterminate instead of being force-attributed.
 */

export const workspaceObservationHealthSchema = z.enum([
  "healthy",
  "degraded",
  "unavailable",
]);

export const workspaceObservationHealthReasonSchema = z.enum([
  "watcher_error",
  "inotify_limit",
  "directory_replaced",
  "permission_changed",
  "event_integrity_uncertain",
  "reconciliation_timeout",
]);

export const workspaceOperationSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
]);

export const workspaceChangeOriginSchema = z.enum([
  "tool",
  "sandbox_merge",
  "checkpoint_rollback",
  "external",
  "unknown",
]);

export const workspaceChangeAttributionSchema = z.enum([
  "attributed",
  "unattributed",
  "indeterminate",
]);

/**
 * Which execution a change correlates with. A turn identity is
 * `turnID`+`callID` together; a non-turn operation uses `operationID`
 * (sandbox merge, checkpoint rollback, a direct runtime side-effect API).
 * Both are optional: a confirmed external change carries neither, and that is
 * exactly the "confirmed but source unknown" case.
 */
export const workspaceCorrelationSchema = z
  .object({
    sessionID: z.string().optional(),
    episodeID: z.string().optional(),
    turnID: z.string().optional(),
    callID: z.string().optional(),
    operationID: z.string().optional(),
  })
  .refine(
    (correlation) => !(correlation.operationID && correlation.turnID),
    "a change correlates with either a turn identity (turnID+callID) or a non-turn operation identity, never both",
  )
  .refine(
    (correlation) => !correlation.turnID || Boolean(correlation.callID),
    "a turn identity requires callID",
  );

/**
 * A watcher-level hint, before reconciliation. `health` says how much the
 * observation is worth: a degraded watcher's hint must not become a confirmed
 * fact without a full reconciliation.
 */
export const workspaceObservationSchema = z.object({
  id: z.string().min(1),
  /** Workspace identity, not part of the changed path. */
  workspaceRoot: z.string().min(1),
  /** Workspace-relative; never an absolute path. */
  path: z.string().min(1),
  operation: workspaceOperationSchema,
  health: workspaceObservationHealthSchema,
  healthReason: workspaceObservationHealthReasonSchema.optional(),
  correlation: workspaceCorrelationSchema.optional(),
  /** Event-integrity is uncertain for the window this observation sits in. */
  indeterminate: z.boolean().default(false),
  at: z.string(),
});

/**
 * A change that survived reconciliation. This is the fact that may become a
 * `workspace_change` Work Graph node (Phase 4), never a raw observation.
 */
export const confirmedWorkspaceChangeSchema = z.object({
  id: z.string().min(1),
  workspaceRoot: z.string().min(1),
  path: z.string().min(1),
  operation: workspaceOperationSchema,
  origin: workspaceChangeOriginSchema,
  attribution: workspaceChangeAttributionSchema,
  correlation: workspaceCorrelationSchema,
  health: workspaceObservationHealthSchema,
  healthReason: workspaceObservationHealthReasonSchema.optional(),
  at: z.string(),
});

export type WorkspaceObservationHealth = z.infer<
  typeof workspaceObservationHealthSchema
>;
export type WorkspaceObservationHealthReason = z.infer<
  typeof workspaceObservationHealthReasonSchema
>;
export type WorkspaceOperation = z.infer<typeof workspaceOperationSchema>;
export type WorkspaceChangeOrigin = z.infer<typeof workspaceChangeOriginSchema>;
export type WorkspaceChangeAttribution = z.infer<
  typeof workspaceChangeAttributionSchema
>;
export type WorkspaceCorrelation = z.infer<typeof workspaceCorrelationSchema>;
export type WorkspaceObservation = z.infer<typeof workspaceObservationSchema>;
export type ConfirmedWorkspaceChange = z.infer<
  typeof confirmedWorkspaceChangeSchema
>;

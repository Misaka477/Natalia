/**
 * WG4 Phase 2: the WorkspaceChangeAuditor — the sole production owner of
 * workspace observation (§56.9).
 *
 * Ownership boundaries (mainline plan §56.9):
 *
 * - `WorkspaceFilesController` owns the watcher lifecycle and catalog
 *   invalidation; it must NOT write the Work Graph or generate workspace
 *   provenance. It hands every fs.watch event to the auditor as a hint.
 * - This auditor is the ONLY production owner of workspace observation:
 *   baseline, hint coalescing, reconciliation, expected-mutation matching and
 *   observation health. It turns hints into `ConfirmedWorkspaceChange` facts —
 *   and only reconciliation can do that, never a raw watcher event.
 * - `work-graph.ts` stays the only Work Graph writer (Phase 4 wires the
 *   confirmed changes into the graph; this module does not write it).
 * - `DriftEvaluator` is the only writer of `drift.finding_opened` (Phase 4).
 *
 * The three-problem split from §56.9:
 *
 *   1. "the filesystem changed" → a hint (`WorkspaceObservation`), health
 *      included.
 *   2. "who changed it" → attribution decided by `attributionFor`, driven by
 *      an expected-mutation registry (Phase 3) or none (unattributed).
 *   3. "does it violate a goal" → drift (Phase 4, not here).
 *
 * A watcher event is only a hint: it must survive debounce + reconciliation
 * before it becomes a confirmed change. A degraded/unavailable watcher cannot
 * produce confirmed facts without a full reconciliation, and an indeterminate
 * window marks its confirmed changes indeterminate instead of forcing
 * attribution.
 *
 * Secret-safe: confirmed changes carry only workspace-relative paths,
 * operation types, correlation and health — `assertSecretSafeObservation`
 * rejects content/diff/command/result fields at a single point.
 */
import type {
  ConfirmedWorkspaceChange,
  WorkspaceChangeOrigin,
  WorkspaceObservation,
  WorkspaceObservationHealth,
  WorkspaceObservationHealthReason,
  WorkspaceOperation,
} from "@anthelia/contracts";
import { workspaceObservationSchema } from "@anthelia/contracts";
import {
  assertSecretSafeObservation,
  attributionFor,
} from "./workspace-observation";

/** How long a hint is held before reconciliation, so bursts coalesce (§56.9). */
const DEFAULT_DEBOUNCE_MS = 200;

/**
 * The in-memory hint buffer. A hint is keyed by workspace-relative path so
 * repeated fs.watch events for the same path within the debounce window merge
 * into one observation before reconciliation.
 */
type PendingHint = {
  path: string;
  operation: WorkspaceOperation;
  health: WorkspaceObservationHealth;
  healthReason?: WorkspaceObservationHealthReason;
  indeterminate: boolean;
  observedAt: number;
};

export type WorkspaceChangeAuditor = ReturnType<
  typeof createWorkspaceChangeAuditor
>;

/** The correlation/identity a confirmed change carries, if the registry matched it. */
export type WorkspaceChangeIdentity = {
  turnID?: string;
  callID?: string;
  operationID?: string;
  sessionID?: string;
  episodeID?: string;
  origin: WorkspaceChangeOrigin;
};

export function createWorkspaceChangeAuditor(input: {
  workspaceRoot: string;
  /** Consult the expected-mutation registry (Phase 3) to attribute a path. */
  resolveOrigin?: (path: string) => WorkspaceChangeOrigin | undefined;
  /** Correlation/identity for a matched expected mutation. */
  resolveIdentity?: (path: string) => WorkspaceChangeIdentity | undefined;
  /** Whether the auditor has a reliable identity for attribution (Phase 3). */
  hasReliableIdentity?: () => boolean;
  debounceMs?: number;
}) {
  const { workspaceRoot } = input;
  const debounceMs = input.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pending = new Map<string, PendingHint>();
  let health: WorkspaceObservationHealth = "healthy";
  let healthReason: WorkspaceObservationHealthReason | undefined;
  let indeterminateWindow = false;
  let confirmSequence = 0;
  let baselinePaths: Set<string> | undefined;

  /**
   * Feed a raw watcher event as a hint. This is the ONLY entry for fs.watch
   * events. The hint is validated against the secret-safe observation contract
   * (so a leaked absolute path, command or content field fails here) and held
   * for the debounce window.
   */
  function observe(inputHint: {
    path: string;
    operation: WorkspaceOperation;
    at?: string;
  }) {
    const observation: WorkspaceObservation = {
      id: `hint:${workspaceRoot}:${Date.now().toString(36)}`,
      workspaceRoot,
      path: inputHint.path,
      operation: inputHint.operation,
      health,
      ...(healthReason ? { healthReason } : {}),
      indeterminate: indeterminateWindow,
      at: inputHint.at ?? new Date().toISOString(),
    };
    workspaceObservationSchema.parse(observation);
    assertSecretSafeObservation(observation);
    const existing = pending.get(inputHint.path);
    if (existing) {
      // A burst of events for one path coalesces: the newest operation wins
      // (a write after a create is still "modified" for reconciliation), but a
      // delete is terminal until it is reconciled.
      if (inputHint.operation !== "deleted")
        existing.operation = inputHint.operation;
      existing.observedAt = Date.now();
      return;
    }
    pending.set(inputHint.path, {
      path: inputHint.path,
      operation: inputHint.operation,
      health,
      ...(healthReason ? { healthReason } : {}),
      indeterminate: indeterminateWindow,
      observedAt: Date.now(),
    });
  }

  /** Record the baseline path set (the "what existed" snapshot). */
  async function baseline(paths: Iterable<string>) {
    baselinePaths = new Set(paths);
  }

  /**
   * Reconcile the pending hints against the current path set. A hint is
   * confirmed only when reconciliation runs (never at observe time), and only
   * a healthy-or-reconciled window may confirm facts.
   */
  function reconcile(
    currentPaths: Iterable<string>,
  ): ConfirmedWorkspaceChange[] {
    const now = new Set(currentPaths);
    const confirmed: ConfirmedWorkspaceChange[] = [];
    for (const hint of pending.values()) {
      // A deleted path is gone: confirm the delete directly (no current entry
      // to compare). A path still present confirms as its coalesced operation;
      // a path that is absent despite a modified/added hint means it is gone
      // (a create+delete burst coalesced to the terminal state).
      const operation: WorkspaceOperation =
        hint.operation === "deleted"
          ? "deleted"
          : now.has(hint.path)
            ? hint.operation
            : "deleted";
      const origin = input.resolveOrigin?.(hint.path) ?? "unknown";
      const identity = input.resolveIdentity?.(hint.path);
      const correlatedOrigin = identity?.origin ?? origin;
      const attributed = attributionFor(correlatedOrigin, {
        hasReliableIdentity:
          (input.hasReliableIdentity?.() ?? false) &&
          correlatedOrigin !== "external" &&
          correlatedOrigin !== "unknown",
        indeterminate: hint.indeterminate,
      });
      const change: ConfirmedWorkspaceChange = {
        id: `change:${workspaceRoot}:${confirmSequence++}`,
        workspaceRoot,
        path: hint.path,
        operation,
        origin: correlatedOrigin,
        attribution: attributed,
        correlation: {
          sessionID: identity?.sessionID,
          episodeID: identity?.episodeID,
          turnID: identity?.turnID,
          callID: identity?.callID,
          operationID: identity?.operationID,
        },
        health: hint.health,
        ...(hint.healthReason ? { healthReason: hint.healthReason } : {}),
        at: new Date(hint.observedAt).toISOString(),
      };
      assertSecretSafeObservation(change);
      confirmed.push(change);
    }
    pending.clear();
    return confirmed;
  }

  /**
   * Mark the watcher as degraded or recovered. A degraded watcher's hints are
   * still buffered but their health is carried through, and an indeterminate
   * window keeps confirmed changes indeterminate.
   */
  function setHealth(
    status: WorkspaceObservationHealth,
    reason?: WorkspaceObservationHealthReason,
  ) {
    health = status;
    healthReason = reason;
    if (status === "healthy") {
      indeterminateWindow = false;
    }
  }

  /** A reconciliation-timeout / integrity-uncertain window flag. */
  function markIndeterminate() {
    indeterminateWindow = true;
  }

  function status() {
    return { health, healthReason, pending: pending.size };
  }

  return {
    observe,
    baseline,
    reconcile,
    setHealth,
    markIndeterminate,
    status,
  };
}

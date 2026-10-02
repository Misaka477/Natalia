/**
 * Evidence ledger writer — the production half of P2 (E2 起步).
 *
 * The `evidence.recorded` schema, projection and query have existed since E1,
 * but nothing in production ever published the event, so `evidenceRecords()`
 * answered empty and the availability report named it unimplemented. This
 * module is the writer's pure half, following the work-graph, session-
 * intelligence and constitution-ledger writers: event construction lives here,
 * the runtime supplies the executed validation facts, and the tests cover the
 * pure functions without building a runtime.
 *
 * Secret-safe boundary (from the plan §4/§7): a validation result records the
 * command, the outcome, a bounded safe summary and a duration. The raw output
 * that produced the summary never enters the journal — the runtime redacts
 * secrets and truncates before calling this builder, and the summary is prose,
 * not a paste of the tool result.
 */
import type { RuntimeEvent } from "@anthelia/contracts";
import type { PlanLifecycleState } from "@anthelia/runtime-services";

export type ValidationOutcome = {
  command: string;
  result: "passed" | "failed" | "skipped";
  safeSummary: string;
  /** EI E2: a ref to the stored (redacted) full output of the run. */
  artifactRef?: string;
  durationMs?: number;
};

export type EvidenceInput = {
  id: string;
  taskID: string;
  objective: string;
  status:
    | "planned"
    | "implemented"
    | "validated"
    | "accepted"
    | "promoted"
    | "blocked"
    | "failed"
    | "partial";
  changes?: Array<{
    path: string;
    changeType: "added" | "modified" | "deleted";
    summary: string;
  }>;
  validations?: ValidationOutcome[];
  knownGaps?: string[];
  /** EI E2: when the evidence was recorded. */
  recordedAt?: string;
  /** EI E2: a safe environment summary (platform/arch). */
  environment?: string;
  /** EI E2: repository version the evidence was recorded against. */
  repositoryVersion?: string;
  /** EI E2: git commit hash the evidence was recorded against (safe, public). */
  commit?: string;
  /** EI E2: a safe manifest ref (catalog/plugin-store id, never a path). */
  manifestRef?: string;
};

/**
 * Builds an `evidence.recorded` event. `validations` entries are bounded to a
 * command + outcome + safe summary; nothing else about the run may enter the
 * journal. Empty validation lists are omitted rather than emitted as `[]` so a
 * consumer can tell "no validation recorded" from "recorded as skipped".
 */
/**
 * EI Phase 0: a human's validation note on a completion card (the user's UI
 * entry point for humanValidation). Durable; the read surface merges the latest
 * one per task onto the completion card. The note is safe prose (redacted by
 * the caller before this runs).
 */
export function buildHumanValidation(input: {
  id: string;
  taskID: string;
  validation: string;
  recordedAt: string;
}): Extract<RuntimeEvent, { type: "completion.human_validation" }> {
  return {
    type: "completion.human_validation",
    id: input.id,
    taskID: input.taskID,
    validation: input.validation,
    recordedAt: input.recordedAt,
  };
}

export function buildEvidenceRecorded(
  input: EvidenceInput,
): Extract<RuntimeEvent, { type: "evidence.recorded" }> {
  return {
    type: "evidence.recorded",
    id: input.id,
    taskID: input.taskID,
    objective: input.objective,
    status: input.status,
    ...(input.changes && input.changes.length
      ? { changes: input.changes }
      : {}),
    ...(input.validations && input.validations.length
      ? { validations: input.validations }
      : {}),
    ...(input.knownGaps && input.knownGaps.length
      ? { knownGaps: input.knownGaps }
      : {}),
    ...(input.recordedAt ? { recordedAt: input.recordedAt } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.repositoryVersion
      ? { repositoryVersion: input.repositoryVersion }
      : {}),
    ...(input.commit ? { commit: input.commit } : {}),
    ...(input.manifestRef ? { manifestRef: input.manifestRef } : {}),
  };
}

/**
 * Bounds a validation outcome to its safe, journal-safe shape: the command,
 * the result, a truncated safe summary and an optional duration. The summary is
 * capped at 2000 characters so a chatty runner cannot bloat the journal, and
 * secret redaction is the caller's job before this runs.
 */
export function boundValidationOutcome(input: {
  command: string;
  result: "passed" | "failed" | "skipped";
  safeSummary: string;
  artifactRef?: string;
  durationMs?: number;
}): ValidationOutcome {
  return {
    command: input.command,
    result: input.result,
    safeSummary: input.safeSummary.slice(0, 2000),
    ...(input.artifactRef ? { artifactRef: input.artifactRef } : {}),
    ...(input.durationMs !== undefined
      ? { durationMs: Math.max(0, Math.round(input.durationMs)) }
      : {}),
  };
}

/**
 * A completion card (P2 E4): the fixed report structure from the evidence plan
 * §5 — change summary, behavior impact, validation evidence, human validation,
 * known gaps, external side effects, rollback state. `changeSummary` is safe
 * prose (a summary, never a diff or file content); validation entries are the
 * same bounded outcomes as evidence. A completion records which evidence facts
 * it rests on via `evidenceIDs`.
 */
export function buildCompletionRecorded(input: {
  id: string;
  taskID: string;
  objective: string;
  changeSummary: string;
  behaviorImpact?: string;
  validations?: ValidationOutcome[];
  humanValidation?: string;
  knownGaps?: string[];
  externalSideEffects?: string[];
  rollbackState?: "clean" | "available" | "none" | "needs_promotion";
  evidenceIDs?: string[];
  recordedAt: string;
}): Extract<RuntimeEvent, { type: "completion.recorded" }> {
  return {
    type: "completion.recorded",
    id: input.id,
    taskID: input.taskID,
    objective: input.objective,
    changeSummary: input.changeSummary,
    ...(input.behaviorImpact ? { behaviorImpact: input.behaviorImpact } : {}),
    validations: input.validations ?? [],
    ...(input.humanValidation
      ? { humanValidation: input.humanValidation }
      : {}),
    ...(input.knownGaps && input.knownGaps.length
      ? { knownGaps: input.knownGaps }
      : {}),
    ...(input.externalSideEffects && input.externalSideEffects.length
      ? { externalSideEffects: input.externalSideEffects }
      : {}),
    ...(input.rollbackState ? { rollbackState: input.rollbackState } : {}),
    ...(input.evidenceIDs && input.evidenceIDs.length
      ? { evidenceIDs: input.evidenceIDs }
      : {}),
    recordedAt: input.recordedAt,
  };
}

/**
 * P2 E3: the evidence status transition policy. A plan's lifecycle drives the
 * EFFECTIVE status of the evidence records that belong to its task — an
 * evidence record is an immutable fact (it records what was run when), but its
 * meaning progresses as the plan does. This is a projection policy: it never
 * rewrites the journal, it answers "what does this evidence mean now".
 *
 * Mapping (§6.2 statuses):
 *   - plan proposed/queued:      evidence stays as recorded
 *   - plan accepted:             evidence moves to "planned" (the task is
 *                                committed to, validation not yet run)
 *   - plan activated:            evidence moves to "implemented" (work in
 *                                progress under this plan)
 *   - plan completed:            evidence moves to "accepted" (the plan's task
 *                                passed its validation contract)
 *   - plan superseded/archived:  evidence stays as recorded (a dead plan does
 *                                not promote its evidence)
 */
export type EvidenceRecordedStatus =
  | "planned"
  | "implemented"
  | "validated"
  | "accepted"
  | "promoted"
  | "blocked"
  | "failed"
  | "partial";

export function evidenceStatusForPlanState(
  planState: PlanLifecycleState,
  recordedStatus: EvidenceRecordedStatus,
): EvidenceRecordedStatus {
  switch (planState) {
    case "executing":
    case "awaiting_audit":
    case "auditing":
    case "audit_gaps":
      return "implemented";
    case "completed":
      return "accepted";
    default:
      return recordedStatus;
  }
}

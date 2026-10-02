/**
 * Lightweight plan document registry — replaces the former P8 C4 plan ledger.
 *
 * The Markdown file under `.natalia/plans/` is the only source of plan
 * content. This module only builds the small records/events that identify a
 * plan document (`planID + documentPath`), its lifecycle status, and the
 * transitions used by the runtime/UI to route handoff/execution/audit.
 *
 * Like the other ledger writers, these are pure event builders; the runtime
 * owns persistence and delivery timing. Plan content is not stored here.
 */
import type { RuntimeEvent } from "@anthelia/contracts";

export type PlanAuthor = "user" | "live_chat" | "main_agent";

export type PlanStatus =
  | "marked"
  | "handed_off"
  | "executing"
  | "paused"
  | "awaiting_audit"
  | "auditing"
  | "audit_pending"
  | "audit_gaps"
  | "completed";

export type PlanRecord = {
  planID: string;
  title: string;
  documentPath: string;
  status: PlanStatus;
  createdBy: PlanAuthor;
  createdAt: string;
  updatedAt: string;
  markedAt?: string;
};

export type PlanDocCreatedInput = {
  id: string;
  planID: string;
  title: string;
  documentPath: string;
  createdBy: PlanAuthor;
  status: PlanStatus;
  createdAt: string;
};

export function buildPlanDocCreated(
  input: PlanDocCreatedInput,
): Extract<RuntimeEvent, { type: "plan.doc.created" }> {
  return {
    type: "plan.doc.created",
    id: input.id,
    planID: input.planID,
    title: input.title,
    documentPath: input.documentPath,
    createdBy: input.createdBy,
    status: input.status,
    createdAt: input.createdAt,
  };
}

export function buildPlanDocUpdated(input: {
  id: string;
  planID: string;
  revision: number;
  updatedAt: string;
  reason?: string;
}): Extract<RuntimeEvent, { type: "plan.doc.updated" }> {
  return {
    type: "plan.doc.updated",
    id: input.id,
    planID: input.planID,
    revision: input.revision,
    updatedAt: input.updatedAt,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

export function buildPlanDocMarked(input: {
  id: string;
  planID: string;
  markedAt: string;
}): Extract<RuntimeEvent, { type: "plan.doc.marked" }> {
  return {
    type: "plan.doc.marked",
    id: input.id,
    planID: input.planID,
    markedAt: input.markedAt,
  };
}

export function buildPlanDocDeleted(input: {
  id: string;
  planID: string;
  deletedAt: string;
}): Extract<RuntimeEvent, { type: "plan.doc.deleted" }> {
  return {
    type: "plan.doc.deleted",
    id: input.id,
    planID: input.planID,
    deletedAt: input.deletedAt,
  };
}

export function buildPlanDocStatus(input: {
  id: string;
  planID: string;
  status: PlanStatus;
  at: string;
  reason?: string;
}): Extract<RuntimeEvent, { type: "plan.doc.status" }> {
  return {
    type: "plan.doc.status",
    id: input.id,
    planID: input.planID,
    status: input.status,
    at: input.at,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

/**
 * EI §3.9: durable audit request. One trigger event → one request; the
 * request is the restart-safe shadow for the process-local Nia wake queue.
 */
export function buildAuditRequested(input: {
  id: string;
  planID: string;
  planVersion: number;
  triggerEventID: string;
  round: number;
  checkpointID?: string;
  scope: string;
  at: string;
}): Extract<RuntimeEvent, { type: "audit.requested" }> {
  return {
    type: "audit.requested",
    id: input.id,
    planID: input.planID,
    planVersion: input.planVersion,
    triggerEventID: input.triggerEventID,
    round: input.round,
    scope: input.scope,
    at: input.at,
    ...(input.checkpointID ? { checkpointID: input.checkpointID } : {}),
  };
}

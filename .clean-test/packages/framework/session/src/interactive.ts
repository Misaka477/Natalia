import type { RuntimeEvent, SessionID } from "@anthelia/contracts";

export type PendingApproval = Extract<
  RuntimeEvent,
  { type: "approval.request" }
>;
export type PendingQuestion = Extract<
  RuntimeEvent,
  { type: "question.request" }
>;

export type PendingInteractive = Extract<
  RuntimeEvent,
  { type: "interactive.request" }
>;

export type InteractiveProjection = {
  approvals: PendingApproval[];
  questions: PendingQuestion[];
  interactives: PendingInteractive[];
};

/** Projects durable request/reply events; in-memory waiters are not replay state. */
export function projectInteractiveRequests(
  events: RuntimeEvent[],
): InteractiveProjection {
  const approvals = new Map<string, PendingApproval>();
  const questions = new Map<string, PendingQuestion>();
  const interactives = new Map<string, PendingInteractive>();
  for (const event of events) {
    if (event.type === "approval.request") approvals.set(event.id, event);
    if (event.type === "approval.response") approvals.delete(event.id);
    if (event.type === "question.request") questions.set(event.id, event);
    if (event.type === "question.response") questions.delete(event.id);
    if (event.type === "interactive.request") interactives.set(event.id, event);
    if (event.type === "interactive.response") interactives.delete(event.id);
  }
  return {
    approvals: [...approvals.values()],
    questions: [...questions.values()],
    interactives: [...interactives.values()],
  };
}

export function requestsForSession(
  _sessionID: SessionID,
  events: RuntimeEvent[],
) {
  return projectInteractiveRequests(events);
}

/**
 * Live Work Chat mailbox ledger — the durable half of P8 Phase C3.
 *
 * P8 §5.1 defines an `AgentMailboxMessage`: user intent the Live Chat turns
 * into a durable message the main agent consumes at a safe boundary. Nothing
 * of that surface exists yet — `session.inbox` is the input queue, but the
 * intent-typed, priority- and policy-carrying mailbox message is a distinct
 * fact type with its own lifecycle (queued → delivered/acknowledged/deferred/
 * superseded, §5.1 + §9.2).
 *
 * This module is the ledger's pure half, following the work-graph /
 * session-intelligence / constitution-ledger / evidence-ledger writers: event
 * construction lives here, the runtime owns delivery timing and secret
 * redaction, and the tests cover the pure functions without a runtime.
 *
 * Secret-safe boundary (plan §5.1, §11): `text` is user intent prose and may
 * reach the journal; `safeSummary` is a bounded, redacted summary. Passwords,
 * tokens and MFA values must be redacted by the caller before the text is
 * handed to `buildMailboxQueued` — the runtime does this at `mailboxSend`.
 */
import type { RuntimeEvent } from "@anthelia/contracts";

export type MailboxIntent =
  | "clarification"
  | "constraint"
  | "reprioritize"
  | "pause"
  | "cancel"
  | "request_report"
  | "proposed_change"
  | "next_plan_handoff";

export type MailboxPriority = "normal" | "high" | "urgent";

export type MailboxDeliveryPolicy =
  | "next_safe_boundary"
  | "before_next_tool"
  | "before_next_side_effect"
  | "immediate_control";

export type MailboxStatus =
  | "queued"
  | "delivered"
  | "acknowledged"
  | "deferred"
  | "superseded";

export type MailboxQueuedInput = {
  id: string;
  messageID: string;
  source: "user_via_live_chat" | "system";
  priority: MailboxPriority;
  intent: MailboxIntent;
  text: string;
  safeSummary: string;
  relatedPlanID?: string;
  deliveryPolicy: MailboxDeliveryPolicy;
  createdAt: string;
};

export function buildMailboxQueued(
  input: MailboxQueuedInput,
): Extract<RuntimeEvent, { type: "mailbox.queued" }> {
  return {
    type: "mailbox.queued",
    id: input.id,
    messageID: input.messageID,
    source: input.source,
    priority: input.priority,
    intent: input.intent,
    text: input.text,
    safeSummary: input.safeSummary,
    ...(input.relatedPlanID ? { relatedPlanID: input.relatedPlanID } : {}),
    deliveryPolicy: input.deliveryPolicy,
    createdAt: input.createdAt,
  };
}

/**
 * The lifecycle transition events. Each carries the message id it refers to and
 * a timestamp; the projection (`projectedMailboxMessages`) replays them into the
 * current status per message. `reason` is safe prose (why it was deferred or
 * superseded) and may reach the journal — never tool output or secrets.
 */
export type MailboxStatusTransition =
  | "delivered"
  | "acknowledged"
  | "deferred"
  | "superseded";

export type MailboxStatusEvent = Extract<
  RuntimeEvent,
  {
    type:
      | "mailbox.delivered"
      | "mailbox.acknowledged"
      | "mailbox.deferred"
      | "mailbox.superseded";
  }
>;

export function buildMailboxStatus(input: {
  id: string;
  messageID: string;
  status: MailboxStatusTransition;
  at: string;
  reason?: string;
}): MailboxStatusEvent {
  switch (input.status) {
    case "delivered":
      return {
        type: "mailbox.delivered",
        id: input.id,
        messageID: input.messageID,
        deliveredAt: input.at,
      };
    case "acknowledged":
      return {
        type: "mailbox.acknowledged",
        id: input.id,
        messageID: input.messageID,
        acknowledgedAt: input.at,
      };
    case "deferred":
      return {
        type: "mailbox.deferred",
        id: input.id,
        messageID: input.messageID,
        reason: input.reason ?? "deferred at an unsafe boundary",
        deferredAt: input.at,
      };
    case "superseded":
      return {
        type: "mailbox.superseded",
        id: input.id,
        messageID: input.messageID,
        reason: input.reason ?? "superseded by a newer instruction",
        supersededAt: input.at,
      };
  }
}

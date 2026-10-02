import { resolveConsult } from "./consult-bridge";
import type {
  CollaborationMessage,
  CollaborationParticipant,
  RuntimeEvent,
  SessionID,
} from "@anthelia/contracts";
import {
  projectedCollabMessages,
  type ProjectedCollabMessage,
} from "@anthelia/session";

export const COLLABORATION_SERVICE = "natalia.collaboration.service";

export type CollaborationWake = {
  recipient: CollaborationParticipant;
  messageID: string;
  replyRequired: boolean;
};

type SendBase = {
  sessionID: SessionID;
  text: string;
  to?: CollaborationParticipant;
};

export type SendCollaborationInput =
  | (SendBase & {
      kind: "chat";
      from: CollaborationParticipant;
      replyToID?: string;
      continueConversation?: boolean;
    })
  | (SendBase & {
      kind: "suggestion";
      from: "live_chat";
      priority?: "normal" | "high";
      rationale?: string;
    })
  | (SendBase & {
      kind: "notice";
      from: "main_agent";
      noticeType: "step_completed" | "blocked" | "needs_input" | "risk";
    })
  | (SendBase & { kind: "question"; from: "main_agent" })
  | (SendBase & {
      kind: "answer";
      from: "live_chat";
      replyToID: string;
      advisorOutcome?: "advised" | "declined";
    })
  | (SendBase & {
      kind: "response";
      from: "main_agent";
      replyToID: string;
      decision: "adopted" | "rejected" | "deferred";
      reason?: string;
    });

export type CollaborationService = {
  send(input: SendCollaborationInput): Promise<{
    message: CollaborationMessage;
    wake: CollaborationWake;
  }>;
  list(sessionID: SessionID): ProjectedCollabMessage[];
  pendingFor(
    sessionID: SessionID,
    recipient: CollaborationParticipant,
  ): ProjectedCollabMessage[];
};

export type CollaborationServicePorts = {
  events(sessionID: SessionID): RuntimeEvent[] | undefined;
  publish(sessionID: SessionID, event: RuntimeEvent): void;
  nextSequence(): number;
  maxAutoRounds(): number;
  now?(): Date;
};

export function createCollaborationService(
  ports: CollaborationServicePorts,
): CollaborationService {
  const list = (sessionID: SessionID) =>
    projectedCollabMessages(ports.events(sessionID) ?? []);

  return {
    list,
    pendingFor(sessionID, recipient) {
      return list(sessionID).filter(
        (message) => message.to === recipient && message.status === "pending",
      );
    },
    async send(input) {
      if (!input.text.trim()) throw new Error("collaboration text is required");
      if (!ports.events(input.sessionID)) throw new Error("no session");
      const messages = list(input.sessionID);
      const to =
        input.to ?? (input.from === "main_agent" ? "live_chat" : "main_agent");
      const target =
        "replyToID" in input
          ? messages.find((message) => message.id === input.replyToID)
          : undefined;
      const message = buildMessage(input, to, target, messages, ports);
      ports.publish(input.sessionID, {
        type: `${collaborationStream(input.from)}.collab.message`,
        message,
      } as RuntimeEvent);
      // The synchronous consult line (advisor block A): an answer for a
      // question the main agent is waiting on resolves that wait. The
      // question side (`collab_ask`) registers the wait; this is where
      // the answer side every agent's send flows through resolves it.
      if (message.kind === "answer" && message.replyToID)
        resolveConsult(message.replyToID, message.text, message.at);
      console.log("[collab-trace] send", {
        from: input.from,
        to,
        kind: message.kind,
        messageID: message.id,
        threadID: message.threadID,
        replyToID: message.replyToID,
        expectsReply: message.expectsReply,
        text: input.text.slice(0, 120),
      });
      return {
        message,
        wake: {
          recipient: to,
          messageID: message.id,
          replyRequired: message.expectsReply,
        },
      };
    },
  };
}

function collaborationStream(
  from: CollaborationParticipant,
): "natalia" | "navi" | "nia" {
  switch (from) {
    case "main_agent":
      return "natalia";
    case "live_chat":
      return "navi";
    case "nia":
      return "nia";
  }
}

function buildMessage(
  input: SendCollaborationInput,
  to: CollaborationParticipant,
  target: ProjectedCollabMessage | undefined,
  messages: ProjectedCollabMessage[],
  ports: CollaborationServicePorts,
): CollaborationMessage {
  const now = ports.now?.() ?? new Date();
  const at = now.toISOString();
  const id = `collab:${input.kind}:${now.getTime().toString(36)}:${ports.nextSequence()}`;
  if (input.kind === "chat") {
    const pendingIncoming = messages.find(
      (message) =>
        message.kind === "chat" &&
        message.to === input.from &&
        message.status === "pending",
    );
    const pendingOutgoing = messages.find(
      (message) =>
        message.kind === "chat" &&
        message.from === input.from &&
        message.status === "pending",
    );
    if (input.replyToID) {
      validateReply(target, input.from, "chat");
    } else if (input.continueConversation !== undefined) {
      throw new Error(
        "continueConversation is only valid when replying with replyToID; a new chat always requests one reply",
      );
    } else if (pendingIncoming) {
      throw new Error(`reply required for chat message ${pendingIncoming.id}`);
    } else if (pendingOutgoing) {
      throw new Error(`awaiting reply to chat message ${pendingOutgoing.id}`);
    }
    const chatTarget = target?.kind === "chat" ? target : undefined;
    const maxRounds = ports.maxAutoRounds();
    const mayContinue = chatTarget
      ? input.continueConversation === true && chatTarget.round < maxRounds
      : true;
    return {
      id,
      threadID: chatTarget?.threadID ?? id,
      ...(chatTarget ? { replyToID: chatTarget.id } : {}),
      kind: "chat",
      from: input.from,
      to,
      text: input.text,
      round: chatTarget
        ? mayContinue
          ? chatTarget.round + 1
          : chatTarget.round
        : 1,
      expectsReply: mayContinue,
      at,
    };
  }
  if (input.kind === "suggestion")
    return {
      id,
      threadID: id,
      kind: input.kind,
      from: input.from,
      to,
      text: input.text,
      expectsReply: true,
      priority: input.priority ?? "normal",
      ...(input.rationale ? { rationale: input.rationale } : {}),
      at,
    };
  if (input.kind === "notice")
    return {
      id,
      threadID: id,
      kind: input.kind,
      from: input.from,
      to,
      text: input.text,
      expectsReply: false,
      noticeType: input.noticeType,
      at,
    };
  if (input.kind === "question")
    return {
      id,
      threadID: id,
      kind: input.kind,
      from: input.from,
      to,
      text: input.text,
      expectsReply: true,
      at,
    };
  validateReply(
    target,
    input.from,
    input.kind === "answer" ? "question" : "suggestion",
  );
  if (input.kind === "answer")
    return {
      id,
      threadID: target!.threadID,
      replyToID: target!.id,
      kind: input.kind,
      from: input.from,
      to,
      text: input.text,
      expectsReply: false,
      ...(input.advisorOutcome ? { advisorOutcome: input.advisorOutcome } : {}),
      at,
    };
  return {
    id,
    threadID: target!.threadID,
    replyToID: target!.id,
    kind: input.kind,
    from: input.from,
    to,
    text: input.text,
    expectsReply: false,
    decision: input.decision,
    ...(input.reason ? { reason: input.reason } : {}),
    at,
  };
}

function validateReply(
  target: ProjectedCollabMessage | undefined,
  sender: CollaborationParticipant,
  expectedKind: ProjectedCollabMessage["kind"],
) {
  if (!target || target.kind !== expectedKind || target.status !== "pending")
    throw new Error(`no pending ${expectedKind} message`);
  if (target.to !== sender || target.from === sender)
    throw new Error("collaboration reply direction is invalid");
}

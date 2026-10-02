import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import {
  projectedCollabMessages,
  projectedMailboxMessages,
} from "@anthelia/session";
import {
  buildMailboxStatus,
  createMailboxAcknowledgeTool,
} from "@anthelia/runtime-services";
import type { RuntimeTool } from "@anthelia/tools";
import type { CollaborationService } from "./collaboration-service";
import { waitForConsult } from "./consult-bridge";

export const COLLAB_RESPONSE_DECISIONS = [
  "adopted",
  "rejected",
  "deferred",
] as const;
export const COLLAB_CHAT_RECIPIENTS = ["live_chat", "nia"] as const;

const COLLAB_INBOX_PAGE_LIMIT = 8;
const COLLAB_INBOX_BYTE_BUDGET = 40 * 1024;

export type CollaborationToolPorts = {
  events(sessionID: SessionID): RuntimeEvent[] | undefined;
  publish(sessionID: SessionID, event: RuntimeEvent): void;
  redact(text: string): string;
  nextMailboxSequence(): number;
  requestWake(
    sessionID: SessionID,
    request?: {
      recipient: import("@anthelia/contracts").CollaborationParticipant;
      messageID: string;
      kind?: string;
      source?: import("@anthelia/contracts").CollaborationParticipant;
    },
  ): void;
  maxAutoRounds(): number;
  service: CollaborationService;
};

export function collaborationTools(
  ports: CollaborationToolPorts,
): RuntimeTool[] {
  const sessionEvents = (sessionID: string | undefined) =>
    sessionID ? ports.events(sessionID as SessionID) : undefined;

  const mailboxAcknowledge = createMailboxAcknowledgeTool({
    async onAcknowledge(messageIDs, context) {
      const sessionID = context.sessionID as SessionID | undefined;
      const events = sessionEvents(sessionID);
      if (!sessionID || !events) return;
      const at = new Date().toISOString();
      for (const messageID of messageIDs) {
        const message = projectedMailboxMessages(events).find(
          (candidate) =>
            candidate.messageID === messageID &&
            candidate.status === "delivered",
        );
        if (!message) continue;
        ports.publish(
          sessionID,
          buildMailboxStatus({
            id: `${messageID}:acknowledged:${ports.nextMailboxSequence()}`,
            messageID,
            status: "acknowledged",
            at,
          }),
        );
      }
    },
  });

  const respond: RuntimeTool = {
    name: "collab_respond",
    description:
      "Respond to a suggestion from Navi, the Live Work Chat collaborator: adopt it, reject it, or defer it with a reason. The message id comes from the <navi_collaborations> context block.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        messageID: { type: "string" },
        decision: {
          type: "string",
          enum: [...COLLAB_RESPONSE_DECISIONS],
        },
        reason: { type: "string" },
      },
      required: ["messageID", "decision"],
      additionalProperties: false,
    },
    async execute(parsed, context) {
      const args = parsed as {
        messageID?: string;
        decision?: string;
        reason?: string;
      };
      if (
        typeof args.messageID !== "string" ||
        typeof args.decision !== "string"
      )
        return "collab_respond requires messageID and decision; messageID comes from the <navi_collaborations> context block";
      const sessionID = context.sessionID as SessionID | undefined;
      if (!sessionID || !sessionEvents(sessionID)) return "no session";
      let result;
      try {
        result = await ports.service.send({
          sessionID,
          kind: "response",
          from: "main_agent",
          replyToID: args.messageID,
          decision: args.decision as "adopted" | "rejected" | "deferred",
          text: ports.redact(args.reason ?? args.decision),
          ...(args.reason ? { reason: ports.redact(args.reason) } : {}),
        });
      } catch (error) {
        return `collab_respond: ${error instanceof Error ? error.message : String(error)}`;
      }
      ports.requestWake(sessionID, {
        recipient: result.wake.recipient,
        messageID: result.message.id,
        kind: "response",
        source: "live_chat",
      });
      return JSON.stringify({ responded: true });
    },
  };

  const inbox: RuntimeTool = {
    name: "collab_inbox",
    description:
      "Read the collaboration channel with Navi: her answers, pending suggestions, and their outcomes. The response is a JSON page with messages, returned, total, truncated, and nextCursor. Pass nextCursor back to read older pages.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description:
            "Opaque cursor from a previous collab_inbox response; returns older messages before it.",
        },
      },
      additionalProperties: false,
    },
    async execute(parsed, context) {
      const events = sessionEvents(context.sessionID);
      if (!events) return "[]";
      const args = parsed as { cursor?: unknown };
      const messages = ports.service.list(context.sessionID as SessionID);
      let end = messages.length;
      if (typeof args.cursor === "string" && args.cursor) {
        const index = messages.findIndex(
          (message) => message.id === args.cursor,
        );
        if (index < 0)
          return JSON.stringify({
            messages: [],
            returned: 0,
            total: messages.length,
            truncated: false,
            error: "cursor_not_found",
          });
        end = index;
      }
      const page: Array<Record<string, unknown>> = [];
      for (
        let index = end - 1;
        index >= 0 && page.length < COLLAB_INBOX_PAGE_LIMIT;
        index -= 1
      ) {
        const entry = collabInboxMessage(messages[index]!);
        const candidate = [entry, ...page];
        if (
          page.length > 0 &&
          utf8Bytes(JSON.stringify({ messages: candidate })) >
            COLLAB_INBOX_BYTE_BUDGET
        )
          break;
        page.unshift(entry);
      }
      const start = end - page.length;
      return JSON.stringify({
        messages: page,
        returned: page.length,
        total: messages.length,
        truncated: start > 0,
        ...(start > 0 ? { nextCursor: messages[start]!.id } : {}),
      });
    },
  };

  const chat = createMainAgentChatTool(ports, sessionEvents);
  const ask: RuntimeTool = {
    name: "collab_ask",
    description:
      "Ask Navi, the Live Work Chat collaborator, for a second opinion on an approach, risk, or tradeoff. " +
      "Use proactively when you need expert technical advice on architecture, test strategy, implementation detail, " +
      "or a difficult decision — not only after an error. " +
      "The tool WAITS for her answer and returns it as its result, so a consult informs the same step (her answer or her turn ending ends the wait; a wedged advisor is cut off at ten minutes); " +
      "her guidance is an input, not a command — when your own evidence contradicts it, surface the conflict. " +
      "If no answer arrives in time the result says unavailable and you continue without it.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
    async execute(parsed, context) {
      const question = (parsed as { question?: string }).question;
      if (typeof question !== "string" || !question.trim())
        return "collab_ask requires a non-empty question";
      const sessionID = context.sessionID as SessionID | undefined;
      if (!sessionID || !sessionEvents(sessionID))
        return "collab_ask: no active session; retry after the session is ready";
      let result;
      try {
        result = await ports.service.send({
          sessionID,
          kind: "question",
          from: "main_agent",
          text: ports.redact(question),
        });
      } catch (error) {
        return `collab_ask: ${error instanceof Error ? error.message : String(error)}`;
      }
      ports.requestWake(sessionID, {
        recipient: result.wake.recipient,
        messageID: result.message.id,
        kind: "question",
        source: "main_agent",
      });
      // The synchronous consult line (advisor block A): wait (bounded)
      // for the advisor's answer and return it as THIS tool's result, so
      // the decision it informs lands in the same step. Navi's answer
      // resolves the wait through the service's send; a timeout or the
      // turn's abort answers unavailable — never a hang, and the async
      // mailbox/wake channel still carries the answer either way.
      const reply = await waitForConsult(result.message.id, {
        signal: context.signal,
        ...(sessionID ? { sessionID } : {}),
      });
      return JSON.stringify(
        reply.state === "answered"
          ? { consult: "answered", advice: reply.advice }
          : { consult: "unavailable", reason: reply.reason },
      );
    },
  };

  return [mailboxAcknowledge, respond, inbox, chat, ask];
}

function createMainAgentChatTool(
  ports: CollaborationToolPorts,
  sessionEvents: (sessionID: string | undefined) => RuntimeEvent[] | undefined,
): RuntimeTool {
  return {
    name: "collab_chat",
    description:
      'Send or directly reply to an informal message with Navi or Nia. A new message has no messageID and always continues the thread. To answer a REPLY_REQUIRED message, provide its exact messageID; having that messageID means that sister already replied to you. Every reply is sent as the next step of the thread unless the automatic exchange limit is reached. For a new message to Nia, set to to "nia"; otherwise it defaults to Navi. ',
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        to: {
          type: "string",
          enum: [...COLLAB_CHAT_RECIPIENTS],
          description:
            "The sister to send a new informal chat to. Omitted means Navi (live_chat). When replying with messageID, the recipient is inferred from the original message.",
        },
        messageID: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(parsed, context) {
      const args = parsed as {
        text?: string;
        to?: "live_chat" | "nia";
        messageID?: string;
      };
      if (typeof args.text !== "string" || !args.text.trim())
        return "collab_chat requires a non-empty text";
      const sessionID = context.sessionID as SessionID | undefined;
      const events = sessionEvents(sessionID);
      if (!sessionID || !events) return "no session";
      const suppliedID = args.messageID?.trim();
      const wantsContinuation = Boolean(suppliedID);
      const messages = projectedCollabMessages(events);
      const target = suppliedID
        ? messages.find((message) => message.id === suppliedID)
        : undefined;
      const to =
        args.to ??
        (target
          ? target.from === "main_agent"
            ? target.to
            : target.from
          : "live_chat");
      let result;
      try {
        result = await ports.service.send({
          sessionID,
          kind: "chat",
          from: "main_agent",
          to,
          text: ports.redact(args.text),
          ...(suppliedID ? { replyToID: suppliedID } : {}),
          ...(suppliedID ? { continueConversation: true } : {}),
        });
      } catch (error) {
        return `collab_chat: ${error instanceof Error ? error.message : String(error)}`;
      }
      ports.requestWake(sessionID, {
        recipient: result.wake.recipient,
        messageID: result.message.id,
        kind: "chat",
        source: "main_agent",
      });
      return JSON.stringify({
        sent: true,
        messageID: result.message.id,
        threadID: result.message.threadID,
        to: result.message.to,
        round: result.message.kind === "chat" ? result.message.round : 1,
        expectsReply: result.message.expectsReply,
        receivedReply: Boolean(suppliedID),
        ...(wantsContinuation && !result.message.expectsReply
          ? {
              autoRoundLimitReached: true,
              maxAutoRounds: ports.maxAutoRounds(),
            }
          : {}),
      });
    },
  };
}

function collabInboxMessage(message: {
  id: string;
  kind: string;
  from: string;
  to: string;
  text: string;
  status: string;
  questionID?: string;
  threadID?: string;
  replyToID?: string;
  round?: number;
  expectsReply?: boolean;
}): Record<string, unknown> {
  return {
    id: message.id,
    kind: message.kind,
    from: message.from,
    to: message.to,
    text: message.text,
    status: message.status,
    ...(message.questionID ? { questionID: message.questionID } : {}),
    ...(message.threadID ? { threadID: message.threadID } : {}),
    ...(message.replyToID ? { replyToID: message.replyToID } : {}),
    ...(message.kind === "chat" ? { round: message.round } : {}),
    ...(message.expectsReply !== undefined
      ? { expectsReply: message.expectsReply }
      : {}),
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

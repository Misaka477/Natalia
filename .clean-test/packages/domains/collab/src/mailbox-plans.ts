/**
 * Collaboration mailbox and plan drafting — runtime/collaboration/
 * mailbox-plans.ts.
 *
 * The `collab_chat` tool constructor, the durable mailbox intent queue writer,
 * and the plan draft writer. Reads live state through `RuntimeContext` at call
 * time.
 */
import {
  sessionRunCoordinator,
  projectedWorkContracts,
} from "@anthelia/session";
import {
  buildMailboxQueued,
  buildMailboxStatus,
} from "@anthelia/runtime-services";
import type { RuntimeTool } from "@anthelia/tools";
import type { CollaborationParticipant, SessionID } from "@anthelia/contracts";
import {
  COLLABORATION_SERVICE,
  type CollaborationService,
} from "@natalia/collaboration";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";
import { ensureSessionFullEvents } from "@anthelia/substrate";
import { findMailboxMessage } from "./mailbox";
import { logOf } from "@anthelia/operation-log";

export function createMailboxPlans(ctx: RuntimeContext) {
  return {
    createCollabChatTool,
    enqueueMailboxMessage,
    cancelMailboxMessage,
  };

  function collaborationMaxAutoRounds() {
    return (
      ctx.ports.getTsRuntimeConfig()?.runtime.collaboration.maxAutoRounds ?? 3
    );
  }

  function createCollabChatTool(
    sender: CollaborationParticipant,
    boundExec?: SessionExecutionState,
  ): RuntimeTool {
    logOf(ctx.state.serviceDirectory).info("collab-chat-tool", "create", {
      sender,
      hasExec: Boolean(boundExec),
    });
    const {
      getExecutionBySession,
      redactToolOutput,
      requestNaviWake,
      wakeMainForCollaboration,
    } = ctx.ports;
    return {
      name: "collab_chat",
      description:
        sender === "main_agent"
          ? "Send or directly reply to an informal message with Navi. A new message has no messageID and always continues the thread. To answer a REPLY_REQUIRED message, provide its exact messageID; having that messageID means Navi already replied to you. Every reply is sent as the next step of the thread. Automatic exchanges are capped by runtime.collaboration.maxAutoRounds. This is never a user directive or work-state decision."
          : sender === "nia"
            ? 'Send or directly reply to an informal message with Natalia or Navi. Use to report audit findings, request continuation, or ask for context. A new message has no messageID and always continues the thread. To answer a REPLY_REQUIRED message, provide its exact messageID. Reply example: { "text": "具体缺口...", "messageID": "collab:chat:..." }. If you do not pass the exact messageID, collab_chat will refuse the new chat.'
            : "Send or directly reply to an informal message with Natalia. A new message has no messageID and always continues the thread. To answer a REPLY_REQUIRED message, provide its exact messageID; having that messageID means Natalia already replied to you. Every reply is sent as the next step of the thread. Automatic exchanges are capped by runtime.collaboration.maxAutoRounds. Never use this instead of mailbox_send for a confirmed user directive.",
      requiresApproval: false,
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          messageID: { type: "string" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      async execute(parsed, context) {
        const args = parsed as {
          text?: string;
          messageID?: string;
        };
        if (typeof args.text !== "string" || !args.text.trim())
          return "collab_chat requires a non-empty text";
        const owner =
          boundExec ??
          (context.sessionID
            ? getExecutionBySession().get(context.sessionID as SessionID)
            : undefined);
        if (!owner) return "no session";
        const suppliedID = args.messageID?.trim();
        const wantsContinuation = Boolean(suppliedID);
        const service = ctx.ports.resolveService<CollaborationService>(
          COLLABORATION_SERVICE,
        );
        if (!service) return "collaboration service unavailable";
        const cleanText = redactToolOutput(args.text, true);
        let result;
        try {
          result = await service.send({
            sessionID: owner.session.id as SessionID,
            kind: "chat",
            from: sender,
            text: cleanText,
            ...(suppliedID ? { replyToID: suppliedID } : {}),
            ...(suppliedID ? { continueConversation: true } : {}),
          });
        } catch (error) {
          return `collab_chat: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
        logOf(ctx.state.serviceDirectory).info("collab-chat-tool", "result", {
          sender,
          messageID: result.message.id,
          threadID: result.message.threadID,
          recipient: result.wake.recipient,
          messageTo: result.message.to,
          expectsReply: result.message.expectsReply,
          text: args.text.slice(0, 120),
        });
        if (result.wake.recipient === "live_chat") {
          logOf(ctx.state.serviceDirectory).info(
            "navi-wake-trigger",
            "collab_chat to live_chat",
            {
              sender,
              messageID: result.message.id,
              recipient: result.wake.recipient,
            },
          );
          requestNaviWake(owner);
        } else if (result.wake.recipient === "nia") {
          logOf(ctx.state.serviceDirectory).info(
            "nia-wake-trigger",
            "collab_chat to nia",
            {
              sender,
              messageID: result.message.id,
            },
          );
          ctx.ports.requestNiaWake(owner);
        } else
          wakeMainForCollaboration(
            owner,
            result.message.id,
            "chat message",
            sender === "nia" ? "Nia" : "Navi",
          );
        return JSON.stringify({
          sent: true,
          messageID: result.message.id,
          threadID: result.message.threadID,
          round:
            result.message.kind === "chat" ? result.message.round : undefined,
          expectsReply: result.message.expectsReply,
          receivedReply: Boolean(suppliedID),
          ...(wantsContinuation && !result.message.expectsReply
            ? {
                autoRoundLimitReached: true,
                maxAutoRounds: collaborationMaxAutoRounds(),
              }
            : {}),
        });
      },
    } as RuntimeTool;
  }

  async function enqueueMailboxMessage(
    input: {
      source?: "user_via_live_chat" | "system";
      priority?: "normal" | "high" | "urgent";
      intent: string;
      text: string;
      safeSummary?: string;
      relatedPlanID?: string;
      deliveryPolicy?: string;
    },
    targetExec?: SessionExecutionState,
  ) {
    const {
      getReady,
      getActiveExec,
      publishForSession,
      redactToolOutput,
      nextMailboxSequence,
      scheduleInternalWake,
    } = ctx.ports;
    await getReady();
    const owner = targetExec ?? getActiveExec();
    if (!owner) return { queued: false as const };
    // Keep enqueue anchored on the full log: the wake-turn injection and the
    // mailbox lifecycle expect the whole mailbox to be present.
    await ensureSessionFullEvents(ctx, owner);
    if (
      typeof input.intent !== "string" ||
      input.intent.trim().length === 0 ||
      typeof input.text !== "string" ||
      input.text.trim().length === 0
    )
      return { queued: false as const };
    if (input.intent === "next_plan_handoff") {
      const planID = input.relatedPlanID?.trim();
      if (!planID)
        return {
          queued: false as const,
          reason: "next_plan_handoff requires relatedPlanID",
        };
      const plan = ctx.ports.planDocRuntime.planDocByID(planID);
      if (!plan)
        return {
          queued: false as const,
          reason: `no marked plan ${planID} for next_plan_handoff`,
        };
      if (plan.status === "completed")
        return {
          queued: false as const,
          reason: `plan ${planID} is already completed`,
        };
      // EI §8.1: the handoff is the user-tier promise — the R drift is judged
      // against. Refuse to hand off a plan the user has not committed to; the
      // proposer must draft the contract (plan_propose) and wait for the
      // user's approval first. (ensureSessionFullEvents above guarantees the
      // full journal is present for the projection.)
      const acceptedContract = projectedWorkContracts(
        owner.session.events,
      ).find(
        (contract) =>
          contract.planID === planID && contract.status === "current",
      );
      if (!acceptedContract)
        return {
          queued: false as const,
          reason: `plan ${planID} has no accepted work contract; propose one with plan_propose and wait for the user's approval before handing off`,
        };
    }
    const fingerprint = mailboxFingerprint(
      input.intent,
      input.text,
      input.relatedPlanID,
    );
    const duplicate = await findMailboxMessage(
      ctx,
      owner,
      (message) =>
        (message.status === "queued" || message.status === "delivered") &&
        mailboxFingerprint(
          message.intent,
          message.text,
          message.relatedPlanID,
        ) === fingerprint,
    );
    if (duplicate)
      return {
        queued: false as const,
        messageID: duplicate.messageID,
        reason: "duplicate mailbox intent already pending",
      };
    const now = new Date();
    const messageID = `mailbox:${Date.now().toString(36)}:${nextMailboxSequence()}`;
    // E2: a next_plan_handoff is a formal Main Agent handoff. Capture a
    // checkpoint before the mailbox is queued/woken so the user can restore
    // the exact pre-handoff Main Agent context and workspace state.
    if (input.intent === "next_plan_handoff") {
      try {
        const checkpointController =
          await ctx.ports.initializeCheckpointController(owner);
        if (checkpointController?.isEnabled()) {
          await checkpointController.createCheckpoint({
            reason: "manual",
            context: owner.context,
            step: owner.context.journalStatus().messageCount,
            stepID: `mailbox:${messageID}`,
            model: owner.provider?.model,
            status: "next_plan_handoff",
          });
        }
      } catch (error) {
        ctx.ports.publishForSession(owner, {
          type: "diagnostic",
          level: "warning",
          message: `plan handoff checkpoint failed for ${messageID}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
    publishForSession(
      owner,
      buildMailboxQueued({
        id: `${messageID}:queued`,
        messageID,
        source: input.source ?? "user_via_live_chat",
        priority: input.priority ?? "normal",
        intent: input.intent as
          | "clarification"
          | "constraint"
          | "reprioritize"
          | "pause"
          | "cancel"
          | "request_report"
          | "proposed_change"
          | "next_plan_handoff",
        text: redactToolOutput(input.text, true),
        safeSummary:
          redactToolOutput(input.safeSummary ?? input.text, true).slice(
            0,
            500,
          ) || "mailbox message queued",
        ...(input.relatedPlanID ? { relatedPlanID: input.relatedPlanID } : {}),
        deliveryPolicy: (input.deliveryPolicy ?? "next_safe_boundary") as
          | "next_safe_boundary"
          | "before_next_tool"
          | "before_next_side_effect"
          | "immediate_control",
        createdAt: now.toISOString(),
      }),
    );
    if (input.intent === "next_plan_handoff" && input.relatedPlanID) {
      await ctx.ports.planDocRuntime.planDocUpdateStatus({
        planID: input.relatedPlanID,
        status: "handed_off",
        sessionID: owner.session.id,
      });
      // Handoff is the explicit activation step: the plan becomes active for
      // the session that accepted the handoff, while its lifecycle status stays
      // workspace-level.
      await ctx.ports.planDocRuntime.planDocActivate(
        input.relatedPlanID,
        owner.session.id,
      );
    }
    // Wake the main agent when it is idle: a directive sent through the Live
    // Work Chat must reach it without waiting for the next manual turn, so it
    // is simulated as a direct submission (P8 §7 — the Chat is the steering
    // channel, not a queue that idles silently until the user types again).
    const coordinator = sessionRunCoordinator(owner.session.id as SessionID);
    if (!coordinator.active) {
      scheduleInternalWake(owner, {
        id: `turn_mailbox_${messageID.replace(/[^a-zA-Z0-9]/gu, "_")}`,
        text: `(internal mailbox wake: read pending user intents, including message ${messageID}. This is not a user message.)`,
        delivery: "next-turn",
      });
    }
    return { queued: true as const, messageID };
  }

  async function cancelMailboxMessage(
    messageID: string,
    reason?: string,
    targetExec?: SessionExecutionState,
  ) {
    const owner = targetExec ?? ctx.ports.getActiveExec();
    if (!owner || !messageID.trim()) return { cancelled: false as const };
    const message = await findMailboxMessage(
      ctx,
      owner,
      (candidate) =>
        candidate.messageID === messageID &&
        (candidate.status === "queued" || candidate.status === "delivered"),
    );
    if (!message) return { cancelled: false as const };
    ctx.ports.publishForSession(
      owner,
      buildMailboxStatus({
        id: `${messageID}:superseded:${ctx.ports.nextMailboxSequence()}`,
        messageID,
        status: "superseded",
        at: new Date().toISOString(),
        reason:
          ctx.ports
            .redactToolOutput(reason ?? "cancelled by live chat", true)
            .slice(0, 500) || "cancelled by live chat",
      }),
    );
    return { cancelled: true as const, messageID };
  }
}

function mailboxFingerprint(
  intent: string,
  text: string,
  relatedPlanID?: string,
) {
  return `${intent}\n${relatedPlanID ?? ""}\n${text.trim()}`;
}

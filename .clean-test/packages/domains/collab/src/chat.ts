import { attachmentService } from "@anthelia/attachments";
import { providerModelController } from "@anthelia/provider-model";
import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import type {
  ChatMessageRow,
  ChatModelProfile,
  ChatStreamSurface,
  RuntimeEvent,
  RuntimeReasoningEffort,
  SessionID,
} from "@anthelia/contracts";
import {
  projectedNaviChatMessages,
  projectedNiaChatMessages,
} from "@anthelia/session";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import { ensureSessionFullEvents } from "@anthelia/substrate";
import { scanSessionWindowNewestFirst } from "@anthelia/substrate";
import { paginateTranscript } from "@anthelia/substrate";

/**
 * Find `toMessageID` from the newest event backwards across the shared window
 * and return the number of projected rows after it. `undefined` means the
 * message does not exist. A page that cannot be stitched falls back to the
 * explicit full-history escape hatch.
 */
async function removedAfterMessage(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
  project: (events: RuntimeEvent[]) => Array<{ messageID: string }>,
  toMessageID: string,
): Promise<number | undefined> {
  const scan = await scanSessionWindowNewestFirst(
    ctx,
    exec,
    project,
    (message) => message.messageID === toMessageID,
  );
  if (scan.kind === "found") return scan.newerCount;
  if (scan.kind === "exhausted") return undefined;
  await ensureSessionFullEvents(ctx, exec);
  const history = project(exec.session.events);
  const index = history.findIndex(
    (message) => message.messageID === toMessageID,
  );
  return index === -1 ? undefined : history.length - index - 1;
}
import { streamEvent } from "./chat-turn-common";
import type { AttachmentService } from "@anthelia/runtime";
import type { ProviderModelController } from "@anthelia/provider-model";

type Surface = Pick<RuntimeServiceClient, "naviChat" | "niaChat">;
type SubmitInput = {
  text: string;
  model?: { modelID?: string; variant?: string };
  reasoningEffort?: RuntimeReasoningEffort;
  attachments?: string[];
  sessionID?: string;
};
type StreamSurface = {
  messages(
    sessionID?: string,
  ): ReturnType<
    NonNullable<NonNullable<RuntimeClientSurface["naviChat"]>["messages"]>
  >;
  rollback(
    input: { toMessageID: string },
    sessionID?: string,
  ): ReturnType<
    NonNullable<NonNullable<RuntimeClientSurface["naviChat"]>["rollback"]>
  >;
  modelProfile(
    sessionID?: string,
  ): ReturnType<
    NonNullable<NonNullable<RuntimeClientSurface["naviChat"]>["modelProfile"]>
  >;
  setModelProfile(
    profile: ChatModelProfile,
    sessionID?: string,
  ): ReturnType<
    NonNullable<
      NonNullable<RuntimeClientSurface["naviChat"]>["setModelProfile"]
    >
  >;
  abort(
    sessionID?: string,
  ): ReturnType<
    NonNullable<NonNullable<RuntimeClientSurface["naviChat"]>["abort"]>
  >;
  submit(input: SubmitInput): Promise<{ messageID: string }>;
};
type RuntimeClientSurface = RuntimeServiceClient;

function redactToolOutput(output: string) {
  return output.replace(
    /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/giu,
    (match) =>
      `${match.slice(0, match.indexOf("=") >= 0 ? match.indexOf("=") + 1 : match.indexOf(":") + 1)}[REDACTED]`,
  );
}

async function streamExec(ctx: RuntimeContext, sessionID?: string) {
  // `start()` only kicks initialization off in the background. Chat read
  // surfaces may be the first routed call on a workspace proxy, so wait for
  // the composition root before `ensureExecution` touches runtime services.
  await ctx.ports.getReady();
  if (sessionID)
    return (
      ctx.ports.getExecutionBySession().get(sessionID as SessionID) ??
      (await ctx.ports.ensureExecution(sessionID as SessionID))
    );
  return ctx.ports.getActiveExec();
}

/**
 * Stream-owned chat row projection. Navi and Nia each project their own
 * durable `*.chat.*` events into rows; the row no longer carries a channel tag
 * (the surface it came from is the identity), and no shared projector takes a
 * channel parameter (three-stream P1).
 */
function toChatRow(
  message:
    | ReturnType<typeof projectedNaviChatMessages>[number]
    | ReturnType<typeof projectedNiaChatMessages>[number],
): ChatMessageRow {
  return {
    messageID: message.messageID,
    role: message.role,
    text: message.text,
    at: message.at,
    ...(message.kind ? { kind: message.kind } : {}),
    ...(message.tool ? { tool: message.tool } : {}),
    ...(message.attachments ? { attachments: message.attachments } : {}),
  };
}

function projectNaviChatRows(events: RuntimeEvent[]): ChatMessageRow[] {
  return projectedNaviChatMessages(events).map(toChatRow);
}

function projectNiaChatRows(events: RuntimeEvent[]): ChatMessageRow[] {
  return projectedNiaChatMessages(events).map(toChatRow);
}

function scheduleChatTitle(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
  text: string,
) {
  ctx.ports.rememberTitleInput(exec.session.id, text);
  ctx.state.initialize?.scheduleTitleGeneration?.(exec.session.id);
}

async function prepareSubmit(ctx: RuntimeContext, input: SubmitInput) {
  const attachments = input.attachments?.length
    ? await ctx.state.serviceDirectory
        .getOptional(attachmentService)
        ?.store(input.attachments)
    : undefined;
  await ctx.ports.getReady();
  return {
    text: typeof input.text === "string" ? input.text.trim() : "",
    attachments,
    exec: await streamExec(ctx, input.sessionID),
    controller: ctx.state.serviceDirectory.getOptional(providerModelController),
  };
}

export function createNaviChatSurface(ctx: RuntimeContext): StreamSurface {
  return {
    async messages(sessionID) {
      const exec = await streamExec(ctx, sessionID);
      if (!exec) return [];
      // Chat has no paging UI yet, so project the complete durable log. The
      // shared event window only holds the newest page and can silently drop
      // older chat once the session tail is tool/turn traffic.
      await ensureSessionFullEvents(ctx, exec);
      return projectNaviChatRows(exec.session.events);
    },
    async rollback(input, sessionID) {
      const exec = await streamExec(ctx, sessionID);
      if (!exec) return { rolledBackTo: input.toMessageID, removed: 0 };
      const removed = await removedAfterMessage(
        ctx,
        exec,
        projectedNaviChatMessages,
        input.toMessageID,
      );
      if (removed === undefined)
        return { rolledBackTo: input.toMessageID, removed: 0 };
      ctx.ports.publishForSession(
        exec,
        streamEvent({
          type: "navi.chat.rollback",
          id: `navi:rollback:${Date.now().toString(36)}:${ctx.ports.nextChatSequence()}`,
          toMessageID: input.toMessageID,
          removed,
          at: new Date().toISOString(),
        }),
      );
      return { rolledBackTo: input.toMessageID, removed };
    },
    async modelProfile(sessionID) {
      return (await streamExec(ctx, sessionID))?.naviChatModelProfile ?? {};
    },
    async setModelProfile(profile, sessionID) {
      const exec = await streamExec(ctx, sessionID);
      if (!exec) return { saved: false };
      exec.naviChatModelProfile = profile;
      ctx.ports.publishForSession(
        exec,
        streamEvent({ type: "navi.chat.model.profile", profile }),
      );
      return { saved: true };
    },
    async abort(sessionID) {
      const exec = await streamExec(ctx, sessionID);
      const controller = ctx.state.serviceDirectory.getOptional(
        providerModelController,
      );
      if (!exec || !controller) return { aborted: false as const };
      const ownerSessionID = exec.session.id as SessionID;
      const aborted = controller.abortNavi(ownerSessionID);
      if (aborted) {
        exec.naviAbortWakePending = true;
        if (exec.naviPendingQueue.length) {
          exec.naviAbortWakePending = false;
          controller.requestNaviWake(ownerSessionID);
        }
      }
      return { aborted };
    },
    async submit(input) {
      const { text, attachments, exec, controller } = await prepareSubmit(
        ctx,
        input,
      );
      if (!text || !exec || !controller) return { messageID: "" };
      scheduleChatTitle(ctx, exec, text);
      const safeText = redactToolOutput(text);
      const userMessageID = `navi-chat:${Date.now().toString(36)}:${ctx.ports.nextChatSequence()}`;
      ctx.ports.publishForSession(
        exec,
        streamEvent({
          type: "navi.chat.message.new",
          id: `${userMessageID}:user`,
          messageID: userMessageID,
          role: "user",
          text: safeText,
          at: new Date().toISOString(),
          ...(attachments ? { attachments } : {}),
        }),
      );
      const responseMessageID = `navi-chat:${Date.now().toString(36)}:${ctx.ports.nextChatSequence()}`;
      if (controller.naviBusy(exec.session.id as SessionID)) {
        exec.naviPendingQueue.push({
          messageID: userMessageID,
          text: safeText,
          attachments,
        });
        if (exec.naviAbortWakePending) {
          exec.naviAbortWakePending = false;
          controller.requestNaviWake(exec.session.id as SessionID);
        }
        return { messageID: userMessageID };
      }
      exec.naviAbortWakePending = false;
      try {
        await controller.runNaviChatTurn({
          sessionID: exec.session.id as SessionID,
          text,
          responseMessageID,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          attachments,
        });
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        ctx.ports.publishForSession(
          exec,
          streamEvent({
            type: "navi.chat.message.new",
            id: `${responseMessageID}:chat`,
            messageID: responseMessageID,
            role: "chat",
            text: `Chat could not finish this turn: ${detail.split("\n")[0]!.slice(0, 240)}`,
            at: new Date().toISOString(),
          }),
        );
      }
      return { messageID: responseMessageID };
    },
  };
}

export function createNiaChatSurface(ctx: RuntimeContext): StreamSurface {
  return {
    async messages(sessionID) {
      const exec = await streamExec(ctx, sessionID);
      if (!exec) return [];
      // Chat has no paging UI yet, so project the complete durable log. The
      // shared event window only holds the newest page and can silently drop
      // older chat once the session tail is tool/turn traffic.
      await ensureSessionFullEvents(ctx, exec);
      return projectNiaChatRows(exec.session.events);
    },
    async rollback(input, sessionID) {
      const exec = await streamExec(ctx, sessionID);
      if (!exec) return { rolledBackTo: input.toMessageID, removed: 0 };
      const removed = await removedAfterMessage(
        ctx,
        exec,
        projectedNiaChatMessages,
        input.toMessageID,
      );
      if (removed === undefined)
        return { rolledBackTo: input.toMessageID, removed: 0 };
      ctx.ports.publishForSession(
        exec,
        streamEvent({
          type: "nia.chat.rollback",
          id: `nia:rollback:${Date.now().toString(36)}:${ctx.ports.nextChatSequence()}`,
          toMessageID: input.toMessageID,
          removed,
          at: new Date().toISOString(),
        }),
      );
      return { rolledBackTo: input.toMessageID, removed };
    },
    async modelProfile(sessionID) {
      return (await streamExec(ctx, sessionID))?.niaChatModelProfile ?? {};
    },
    async setModelProfile(profile, sessionID) {
      const exec = await streamExec(ctx, sessionID);
      if (!exec) return { saved: false };
      exec.niaChatModelProfile = profile;
      ctx.ports.publishForSession(
        exec,
        streamEvent({ type: "nia.chat.model.profile", profile }),
      );
      return { saved: true };
    },
    async abort(sessionID) {
      const exec = await streamExec(ctx, sessionID);
      const controller = ctx.state.serviceDirectory.getOptional(
        providerModelController,
      );
      if (!exec || !controller) return { aborted: false as const };
      const ownerSessionID = exec.session.id as SessionID;
      const aborted = controller.abortNia(ownerSessionID);
      if (aborted) {
        exec.niaAbortWakePending = true;
        if (exec.niaPendingQueue.length) {
          exec.niaAbortWakePending = false;
          controller.requestNiaWake(ownerSessionID);
        }
      }
      return { aborted };
    },
    async submit(input) {
      const { text, attachments, exec, controller } = await prepareSubmit(
        ctx,
        input,
      );
      if (!text || !exec || !controller) return { messageID: "" };
      scheduleChatTitle(ctx, exec, text);
      const safeText = redactToolOutput(text);
      const userMessageID = `nia-chat:${Date.now().toString(36)}:${ctx.ports.nextChatSequence()}`;
      ctx.ports.publishForSession(
        exec,
        streamEvent({
          type: "nia.chat.message.new",
          id: `${userMessageID}:user`,
          messageID: userMessageID,
          role: "user",
          text: safeText,
          at: new Date().toISOString(),
          ...(attachments ? { attachments } : {}),
        }),
      );
      const responseMessageID = `nia-chat:${Date.now().toString(36)}:${ctx.ports.nextChatSequence()}`;
      if (controller.niaBusy(exec.session.id as SessionID)) {
        exec.niaPendingQueue.push({
          messageID: userMessageID,
          text: safeText,
          attachments,
        });
        if (exec.niaAbortWakePending) {
          exec.niaAbortWakePending = false;
          controller.requestNiaWake(exec.session.id as SessionID);
        }
        return { messageID: userMessageID };
      }
      exec.niaAbortWakePending = false;
      try {
        await controller.runNiaChatTurn({
          sessionID: exec.session.id as SessionID,
          text,
          responseMessageID,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          attachments,
        });
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        ctx.ports.publishForSession(
          exec,
          streamEvent({
            type: "nia.chat.message.new",
            id: `${responseMessageID}:chat`,
            messageID: responseMessageID,
            role: "chat",
            text: `Nia could not finish this turn: ${detail.split("\n")[0]!.slice(0, 240)}`,
            at: new Date().toISOString(),
          }),
        );
      }
      return { messageID: responseMessageID };
    },
  };
}

export function createChatSurface(ctx: RuntimeContext): Surface {
  const navi = createNaviChatSurface(ctx);
  const nia = createNiaChatSurface(ctx);
  // Each stream owns its history page source (three-stream P1: no shared
  // channel-parameterized pager).
  const naviMessagesPage = async (input: {
    sessionID?: string;
    cursor?: string;
    limit?: number;
  }) => {
    const exec = await streamExec(ctx, input.sessionID);
    if (!exec) return { data: [], cursor: {} };
    await ensureSessionFullEvents(ctx, exec);
    return paginateTranscript(
      projectNaviChatRows(exec.session.events),
      input.cursor,
      input.limit,
      "chat",
    );
  };
  const niaMessagesPage = async (input: {
    sessionID?: string;
    cursor?: string;
    limit?: number;
  }) => {
    const exec = await streamExec(ctx, input.sessionID);
    if (!exec) return { data: [], cursor: {} };
    await ensureSessionFullEvents(ctx, exec);
    return paginateTranscript(
      projectNiaChatRows(exec.session.events),
      input.cursor,
      input.limit,
      "chat",
    );
  };
  const naviChat: ChatStreamSurface = {
    submit: (input) => navi.submit(input),
    abort: (sessionID) => navi.abort(sessionID),
    modelProfile: (sessionID) => navi.modelProfile(sessionID),
    setModelProfile: (profile, sessionID) =>
      navi.setModelProfile(profile, sessionID),
    messages: (sessionID) => navi.messages(sessionID),
    messagesPage: (input) => naviMessagesPage(input),
    rollback: (input, sessionID) => navi.rollback(input, sessionID),
  };
  const niaChat: ChatStreamSurface = {
    submit: (input) => nia.submit(input),
    abort: (sessionID) => nia.abort(sessionID),
    modelProfile: (sessionID) => nia.modelProfile(sessionID),
    setModelProfile: (profile, sessionID) =>
      nia.setModelProfile(profile, sessionID),
    messages: (sessionID) => nia.messages(sessionID),
    messagesPage: (input) => niaMessagesPage(input),
    rollback: (input, sessionID) => nia.rollback(input, sessionID),
  };
  return {
    naviChat,
    niaChat,
  };
}

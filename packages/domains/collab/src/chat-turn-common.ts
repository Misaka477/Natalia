import {
  projectedCollabMessages,
  projectedNaviChatMessages,
  projectedNiaChatMessages,
  sessionFactNaviChatMessages,
  sessionFactNiaChatMessages,
  sessionFactCollabMessages,
} from "@anthelia/session";
import {
  ContextLedger,
  contextEntriesToProviderMessages,
  type ContextEntry,
  type ProviderMessage,
  type StreamingProvider,
  type TokenMeter,
} from "@anthelia/runtime";
import { resolveEffectiveModel } from "@anthelia/provider-model";
import {
  modelRefKey,
  type LocalAttachment,
  type ModelCapabilities,
  type ProviderContentPart,
} from "@anthelia/contracts";
import type { AttachmentService } from "@anthelia/runtime";
import { attachmentService as attachmentServiceToken } from "@anthelia/attachments";
import { compactionService } from "@anthelia/compaction";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import { logOf } from "@anthelia/operation-log";
import type { RuntimeEvent } from "@anthelia/contracts";

const ledgerHistories = new WeakMap<ContextLedger, ProviderMessage[]>();

const DEFAULT_CHAT_MODEL_CAPABILITIES: ModelCapabilities = {
  toolCall: true,
  reasoning: true,
  thinking: true,
  imageInput: false,
  videoInput: false,
};

/**
 * Resolves the active chat model's configured capabilities. Chat model
 * profiles may point at a model different from the main agent, so this must be
 * derived from the chat selection (falling back to the runtime default model)
 * rather than from the main execution state.
 */
export function chatModelCapabilities(
  ctx: RuntimeContext,
  provider: StreamingProvider,
  model?: { modelID?: string; variant?: string },
): ModelCapabilities {
  const config = ctx.ports.getTsRuntimeConfig();
  const candidate =
    model?.modelID ??
    (config?.defaultModel ? modelRefKey(config.defaultModel) : undefined);
  if (config && candidate) {
    try {
      const effective = resolveEffectiveModel(config, candidate);
      if (effective) return effective.capabilities;
    } catch {
      // Fall through to the adapter-level capability fallback below.
    }
  }
  return {
    ...DEFAULT_CHAT_MODEL_CAPABILITIES,
    imageInput: provider.imageInput === true,
    videoInput: provider.videoInput === true,
  };
}

type ChatImageAttachment = {
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  dataURL: string;
};

type ChatVideoAttachment = {
  mediaType: "video/mp4" | "video/webm";
  dataURL: string;
};

function isChatImageAttachment(
  mediaType: string,
): mediaType is ChatImageAttachment["mediaType"] {
  return (
    mediaType === "image/png" ||
    mediaType === "image/jpeg" ||
    mediaType === "image/webp" ||
    mediaType === "image/gif"
  );
}

function isChatVideoAttachment(
  mediaType: string,
): mediaType is ChatVideoAttachment["mediaType"] {
  return mediaType === "video/mp4" || mediaType === "video/webm";
}

/**
 * Applies local attachments to one provider message using the same text,
 * image and video lowering rules for Navi and Nia. Text is always folded into
 * message content; image/video payloads are only attached when both the model
 * capability and provider adapter support that input modality. Unsupported
 * media is represented by a stable text marker (PDF is ignored with a
 * diagnostic because document support was removed).
 */
export async function applyChatAttachments(
  ctx: RuntimeContext,
  input: {
    message: ProviderMessage;
    attachments?: LocalAttachment[];
    modelCapabilities: ModelCapabilities;
    provider: StreamingProvider;
    onDiagnostic?: (message: string) => void;
  },
): Promise<void> {
  if (!input.attachments?.length) return;
  const attachmentService = ctx.state.serviceDirectory.getOptional(
    attachmentServiceToken,
  );
  if (!attachmentService) return;

  const textBlocks: string[] = [];
  const imageAttachments: ChatImageAttachment[] = [];
  const videoAttachments: ChatVideoAttachment[] = [];
  const markers: string[] = [];
  for (const attachment of input.attachments) {
    if (attachmentService.isText(attachment)) {
      textBlocks.push(
        `[Attachment: ${attachment.filename}]\n${await attachmentService.text(attachment)}`,
      );
      continue;
    }
    const mediaType = String(attachment.mediaType);
    if (isChatImageAttachment(mediaType)) {
      if (input.modelCapabilities.imageInput && input.provider.imageInput) {
        imageAttachments.push({
          mediaType,
          dataURL: await attachmentService.dataURL(attachment),
        });
      } else {
        markers.push(`[Attached ${mediaType}: ${attachment.filename}]`);
      }
      continue;
    }
    if (isChatVideoAttachment(mediaType)) {
      if (input.modelCapabilities.videoInput && input.provider.videoInput) {
        videoAttachments.push({
          mediaType,
          dataURL: await attachmentService.dataURL(attachment),
        });
      } else {
        markers.push(`[Attached ${mediaType}: ${attachment.filename}]`);
      }
      continue;
    }
    input.onDiagnostic?.(
      `Unsupported attachment ${attachment.filename} (${mediaType}) was ignored`,
    );
  }

  if (textBlocks.length)
    input.message.content = `${input.message.content}\n\n${textBlocks.join("\n\n")}`;
  if (markers.length)
    input.message.content = `${input.message.content}\n\n${markers.join("\n\n")}`;
  if (imageAttachments.length)
    input.message.images = [
      ...(input.message.images ?? []),
      ...imageAttachments,
    ];
  if (videoAttachments.length)
    input.message.videos = [
      ...(input.message.videos ?? []),
      ...videoAttachments,
    ];
}

export async function applyChatHistoryAttachments(
  ctx: RuntimeContext,
  input: {
    messages: ProviderMessage[];
    attachments: Array<LocalAttachment[] | undefined>;
    modelCapabilities: ModelCapabilities;
    provider: StreamingProvider;
    onDiagnostic?: (message: string) => void;
  },
): Promise<void> {
  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index];
    const attachments = input.attachments[index];
    if (!message || message.role !== "user" || !attachments?.length) continue;
    await applyChatAttachments(ctx, {
      message,
      attachments,
      modelCapabilities: input.modelCapabilities,
      provider: input.provider,
      onDiagnostic: input.onDiagnostic,
    });
  }
}

export function promptData(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * The tool call ids a chat stream's turns used, keyed by the message the turn
 * belongs to — the pairing an OpenAI-compatible gateway requires.
 *
 * A tool row projects as `role: "chat"` with a display summary, so the history
 * fold has to look at the events to recover the call's identity; without it the
 * rebuilt request either loses the tool exchange entirely or carries a
 * `role: "tool"` result with no assistant `toolCalls` to pair it with, which
 * the gateway rejects with "tool_calls.id and tool_calls.type are required".
 */
/**
 * Rebuild the provider messages for a chat transcript.
 *
 * A tool row is a DISPLAY row (its summary is prose for the transcript), and it
 * is projected BEFORE the message that settles the turn. Left as-is it produces
 * an unpaired `role: "tool"` message, which an OpenAI-compatible gateway
 * rejects with "tool_calls.id and tool_calls.type are required".
 *
 * So the tool rows are pulled forward onto the assistant entry that owns them:
 * `assistant(toolCalls=…)` immediately followed by one `role: "tool"` result
 * per call, in call order.
 */
/** A projected chat row, as the mapper needs it (a display tool row + its result). */
export type HistoryChatRow = {
  messageID: string;
  role: "user" | "chat" | "system";
  text: string;
  kind?: "message" | "thinking" | "tool" | "compaction" | "collab";
  tool?: { name: string; result?: string; toolCallID?: string };
};

/**
 * The provider messages for a chat history, with every call answered.
 *
 * A call is paired with its result by the provider call's id — the ONLY key
 * that identifies it. Pairing by tool NAME (what this did until 2026-10-10)
 * collides the moment one message calls the same tool twice: both results got
 * the FIRST call's id, and the gateway rejected the next turn with
 * "Duplicate value for 'tool_call_id'".
 *
 * A call with no recorded result is answered with a row that says so, because
 * a call left unanswered is rejected outright — "No tool output found for
 * function call". An honest placeholder beats a rejected turn.
 */
export function chatProviderMessages(
  history: readonly HistoryChatRow[],
  callsByMessage: ReadonlyMap<
    string,
    Array<{ id: string; name: string; arguments: string }>
  >,
): ProviderMessage[] {
  const pending = new Map(callsByMessage);
  const messages: ProviderMessage[] = [];
  for (const message of history) {
    if (message.kind === "tool") continue;
    const calls = pending.get(message.messageID);
    messages.push(
      calls?.length
        ? { role: "assistant", content: message.text, toolCalls: calls }
        : {
            role:
              message.role === "user"
                ? ("user" as const)
                : ("assistant" as const),
            content: message.text,
          },
    );
    if (!calls?.length) continue;
    pending.delete(message.messageID);
    // The tool rows that belong to this message, in projection order.
    const toolRows = history.filter(
      (candidate) =>
        candidate.kind === "tool" && candidate.messageID === message.messageID,
    );
    const answered = new Set<string>();
    for (const toolRow of toolRows) {
      const call = calls.find(
        (candidate) => candidate.id === toolRow.tool?.toolCallID,
      );
      if (!call) continue;
      answered.add(call.id);
      messages.push({
        role: "tool",
        toolCallID: call.id,
        content: toolRow.tool?.result ?? toolRow.text,
      });
    }
    // A call whose result never landed still needs its row.
    for (const call of calls) {
      if (answered.has(call.id)) continue;
      messages.push({
        role: "tool",
        toolCallID: call.id,
        content:
          `The result of ${call.name} was not recorded for this call. ` +
          `Do not assume it succeeded; re-run it if the outcome matters.`,
      });
    }
  }
  return messages;
}

function chatToolCallsByMessage(
  events: readonly RuntimeEvent[],
  channel: "navi" | "nia",
): Map<string, Array<{ id: string; name: string; arguments: string }>> {
  const byMessage = new Map<
    string,
    Array<{ id: string; name: string; arguments: string }>
  >();
  const prefix =
    channel === "navi" ? "navi.chat.tool.used" : "nia.chat.tool.used";
  for (const event of events) {
    if (event.type !== prefix) continue;
    const used = event as Extract<
      RuntimeEvent,
      { type: "navi.chat.tool.used" }
    >;
    if (!used.toolCallID) continue;
    const calls = byMessage.get(used.messageID) ?? [];
    calls.push({
      id: used.toolCallID,
      name: used.toolName,
      arguments: used.argumentsRaw ?? "",
    });
    byMessage.set(used.messageID, calls);
  }
  return byMessage;
}

/** The durable events a chat stream's history is rebuilt from. */
function chatHistoryEvents(
  exec: SessionExecutionState,
  channel: "navi" | "nia",
): readonly RuntimeEvent[] {
  const state = exec.factStateComplete === true ? exec.factState : undefined;
  return state
    ? channel === "navi"
      ? state.naviChatEvents
      : state.niaChatEvents
    : exec.session.events;
}

/**
 * Navi transcript, folded from hot state when complete, otherwise projected
 * from the resident event log.
 */
function naviChatMessagesForHistory(exec: SessionExecutionState) {
  const state = exec.factStateComplete === true ? exec.factState : undefined;
  return state
    ? sessionFactNaviChatMessages(state)
    : projectedNaviChatMessages(exec.session.events);
}

/** Nia transcript; same fold, separate stream. */
function niaChatMessagesForHistory(exec: SessionExecutionState) {
  const state = exec.factStateComplete === true ? exec.factState : undefined;
  return state
    ? sessionFactNiaChatMessages(state)
    : projectedNiaChatMessages(exec.session.events);
}

export function naviChatProviderMessagesFromHistory(
  exec: SessionExecutionState,
): ProviderMessage[] {
  return naviChatMessagesForHistory(exec)
    .filter((message) => message.kind !== "thinking")
    .map((message) => ({
      role: message.role === "user" ? "user" : "assistant",
      content: message.text,
    }));
}

export function niaChatProviderMessagesFromHistory(
  exec: SessionExecutionState,
): ProviderMessage[] {
  return niaChatMessagesForHistory(exec)
    .filter((message) => message.kind !== "thinking")
    .map((message) => ({
      role: message.role === "user" ? "user" : "assistant",
      content: message.text,
    }));
}

export function naviChatHistory(
  exec: SessionExecutionState,
  responseMessageID: string,
): {
  messages: ProviderMessage[];
  attachments: Array<LocalAttachment[] | undefined>;
  messageIDs: Set<string>;
  durableMessages: Array<{
    messageID: string;
    role: "user" | "chat" | "system";
    text: string;
  }>;
} {
  const history = naviChatMessagesForHistory(exec).filter(
    (message) =>
      message.messageID !== responseMessageID && message.kind !== "thinking",
  );
  const callsByMessage = chatToolCallsByMessage(
    chatHistoryEvents(exec, "navi"),
    "navi",
  );
  return {
    messages: chatProviderMessages(history, callsByMessage),
    attachments: history.map((message) => message.attachments),
    messageIDs: new Set(history.map((message) => message.messageID)),
    durableMessages: history,
  };
}

export function niaChatHistory(
  exec: SessionExecutionState,
  responseMessageID: string,
): {
  messages: ProviderMessage[];
  attachments: Array<LocalAttachment[] | undefined>;
  messageIDs: Set<string>;
  durableMessages: Array<{
    messageID: string;
    role: "user" | "chat" | "system";
    text: string;
  }>;
} {
  const history = niaChatMessagesForHistory(exec).filter(
    (message) =>
      message.messageID !== responseMessageID && message.kind !== "thinking",
  );
  const callsByMessage = chatToolCallsByMessage(
    chatHistoryEvents(exec, "nia"),
    "nia",
  );
  return {
    messages: chatProviderMessages(history, callsByMessage),
    attachments: history.map((message) => message.attachments),
    messageIDs: new Set(history.map((message) => message.messageID)),
    durableMessages: history,
  };
}

export function collabMessagesForExec(exec: SessionExecutionState) {
  // The hot state holds the complete collab slice even when session.events is a
  // fast-attach tail; prefer it over the (possibly tail-based) snapshot.
  if (exec.factStateComplete === true && exec.factState)
    return sessionFactCollabMessages(exec.factState);
  const snapshot = exec.collabSnapshot;
  return snapshot && snapshot.eventCount === exec.session.events.length
    ? snapshot.collabMessages
    : projectedCollabMessages(exec.session.events);
}

export async function compactChatBeforeProviderStep(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
  ledger: ContextLedger,
  provider: StreamingProvider,
  messages: ProviderMessage[],
  signal: AbortSignal,
  stream: {
    /** Stream-owned meter; no channel identity is used by compaction. */
    meter: TokenMeter;
    tools?: unknown;
    contextWindow?: number;
    compactionID: string;
    instruction: string;
    durableMessages: Array<{
      messageID: string;
      role: "user" | "chat" | "system";
      text: string;
    }>;
    /**
     * Whether this request runs the model-free tool-result prune. The chat
     * streams issue one provider request per step, so only the turn's first
     * request may rewrite the ledger — a later rewrite invalidates the prefix
     * cache the earlier requests of the same turn just wrote.
     */
    prune: boolean;
    publishCompacted(summary: string, compactedThroughMessageID: string): void;
    publishCompactionEvent(
      event: import("@anthelia/contracts").RuntimeEvent,
    ): void;
  },
) {
  const compaction = ctx.state.serviceDirectory.getOptional(compactionService);
  const budget =
    stream.contextWindow === undefined
      ? exec.runtimeContextConfig
      : { ...exec.runtimeContextConfig, max: stream.contextWindow };
  if (!compaction || !budget) return messages;

  // This ledger is owned by the stream execution state. Incremental updates
  // preserve a stream's compacted summary without observing a sibling stream.
  const previousMessages = ledgerHistories.get(ledger) ?? [];
  const hasSharedPrefix =
    previousMessages.length <= messages.length &&
    previousMessages.every(
      (message, index) =>
        index >= previousMessages.length ||
        providerMessageKey(previousMessages[index]!) ===
          providerMessageKey(message),
    );
  const firstNewMessage = hasSharedPrefix ? previousMessages.length : 0;
  if (!hasSharedPrefix) ledger.restore({ entries: [], resources: [] });
  for (const [index, message] of messages.entries()) {
    if (index < firstNewMessage) continue;
    if (message.role === "system") continue;
    if (message.role === "assistant" && message.toolCalls?.length) {
      ledger.add({
        id: `${stream.compactionID}:${index}:assistant`,
        role: "assistant",
        content: message.content,
        ...reasoningLedgerFields(message),
      });
      for (const call of message.toolCalls)
        ledger.add({
          id: `${stream.compactionID}:${index}:${call.id}:call`,
          role: "tool_call",
          content: `${call.name} ${call.arguments}`,
          pairID: call.id,
          ...(call.thoughtSignature
            ? { thoughtSignature: call.thoughtSignature }
            : {}),
        });
      continue;
    }
    if (message.role === "tool" && message.toolCallID) {
      ledger.add({
        id: `${stream.compactionID}:${index}:${message.toolCallID}:result`,
        role: "tool_result",
        content: message.content,
        pairID: message.toolCallID,
      });
      continue;
    }
    ledger.add({
      id: `${stream.compactionID}:${index}:${message.role}`,
      role: message.role === "user" ? "user" : "assistant",
      content: message.content,
      ...reasoningLedgerFields(message),
    });
  }
  const runtimeInstruction =
    messages[0]?.role === "system" ? messages[0] : undefined;
  const system =
    messages[0]?.role === "system" ? messages[0].content : undefined;

  // Re-derive the outbound messages from the (possibly rewritten) ledger,
  // restoring provider-native fields from the pre-compaction surface. On a real
  // compaction (not a model-free prune) also announce how far the summary
  // reached through the durable chat history.
  const rebuildOutbound = (
    entries: ContextEntry[],
    phase: "prune" | "compact",
  ): ProviderMessage[] => {
    const rebuilt = contextEntriesToProviderMessages(entries);
    const originalByKey = new Map(
      messages.map((message) => [providerMessageKey(message), message]),
    );
    for (const message of rebuilt) {
      const original = originalByKey.get(providerMessageKey(message));
      if (!original) continue;
      if (original.images?.length) message.images = original.images;
      if (original.videos?.length) message.videos = original.videos;
      if (original.reasoningContent !== undefined)
        message.reasoningContent = original.reasoningContent;
      if (original.reasoningField)
        message.reasoningField = original.reasoningField;
      if (original.reasoningSignature)
        message.reasoningSignature = original.reasoningSignature;
      if (original.reasoningRedacted) message.reasoningRedacted = true;
      if (original.reasoningBlocks?.length)
        message.reasoningBlocks = original.reasoningBlocks;
      if (original.contentParts?.length)
        message.contentParts = original.contentParts;
      if (original.providerMetadata)
        message.providerMetadata = original.providerMetadata;
      if (original.textSignature)
        message.textSignature = original.textSignature;
    }
    if (
      runtimeInstruction &&
      rebuilt[0]?.content !== runtimeInstruction.content
    )
      rebuilt.unshift(runtimeInstruction);
    if (phase === "compact") {
      const rebuiltKeys = new Set(
        rebuilt
          .filter((message) => message.role !== "system")
          .map(
            (message) =>
              `${message.role === "user" ? "user" : "chat"}\u0000${message.content}`,
          ),
      );
      let compactedThroughMessageID = "";
      for (const message of stream.durableMessages) {
        const key = `${message.role}\u0000${message.text}`;
        if (rebuiltKeys.has(key)) break;
        compactedThroughMessageID = message.messageID;
      }
      const summaryEntry = entries.find((entry) => entry.role === "summary");
      const summary = summaryEntry?.content ?? "";
      logOf(ctx.state.serviceDirectory).info(
        "stream-chat-compact",
        "compacted",
        {
          sessionID: exec.session.id,
          compactedThroughMessageID,
          summaryLength: summary.length,
        },
      );
      if (compactedThroughMessageID)
        stream.publishCompacted(summary, compactedThroughMessageID);
    }
    return rebuilt;
  };

  const result = await compaction.prepareContextRequest({
    id: stream.compactionID,
    ledger,
    meter: stream.meter,
    scope: "stream",
    system,
    tools: stream.tools,
    contextWindow: budget.max,
    // The stream budget already carries the preserved tail and prune options
    // (plan §2.3): the pipeline reads them, so chat does not re-read config.
    budget,
    prune: stream.prune,
    outbound: messages,
    rebuildOutbound,
    provider,
    instruction: stream.instruction,
    // The workspace's standing preference for what a summary must keep. Read
    // here because every stream — main, Navi, Nia — compacts through this one
    // helper, so the instruction cannot be hardcoded per stream.
    userInstruction: ctx.ports.getTsRuntimeConfig()?.context.customInstruction,
    compactionEnabled:
      ctx.ports.getTsRuntimeConfig()?.context.compactionEnabled ?? true,
    signal,
    publish: stream.publishCompactionEvent,
    emitStatus: () => {},
    emitSnapshot: () => {},
  });
  ledgerHistories.set(ledger, [...result.outbound]);
  return result.outbound;
}

function reasoningLedgerFields(message: ProviderMessage): {
  reasoningContent?: string;
  reasoningField?: string;
  reasoningSignature?: string;
  reasoningRedacted?: boolean;
  reasoningBlocks?: import("@anthelia/contracts").ProviderReasoningBlock[];
  contentParts?: ProviderContentPart[];
  providerMetadata?: Record<string, unknown>;
  textSignature?: string;
} {
  return {
    ...(message.reasoningContent !== undefined
      ? { reasoningContent: message.reasoningContent }
      : {}),
    ...(message.reasoningField
      ? { reasoningField: message.reasoningField }
      : {}),
    ...(message.reasoningSignature
      ? { reasoningSignature: message.reasoningSignature }
      : {}),
    ...(message.reasoningRedacted ? { reasoningRedacted: true } : {}),
    ...(message.reasoningBlocks?.length
      ? { reasoningBlocks: message.reasoningBlocks }
      : {}),
    ...(message.contentParts?.length
      ? { contentParts: message.contentParts }
      : {}),
    ...(message.providerMetadata
      ? { providerMetadata: message.providerMetadata }
      : {}),
    ...(message.textSignature ? { textSignature: message.textSignature } : {}),
  };
}

function providerMessageKey(message: ProviderMessage): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    toolCallID: message.toolCallID,
    toolName: message.toolName,
    toolCalls: message.toolCalls,
    reasoningBlocks: message.reasoningBlocks,
    contentParts: message.contentParts,
    providerMetadata: message.providerMetadata,
    textSignature: message.textSignature,
  });
}

type ExpandEventTypes<Event> = Event extends {
  type: infer Type extends string;
}
  ? Type extends string
    ? Omit<Event, "type"> & { type: Type }
    : never
  : never;

export type ConcreteRuntimeEvent = ExpandEventTypes<
  import("@anthelia/contracts").RuntimeEvent
>;

export function streamEvent<Event extends ConcreteRuntimeEvent>(
  event: Event,
): Event {
  return event;
}

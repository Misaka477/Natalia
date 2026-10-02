import type { ContextEntry } from "./context";
import { ensureBuiltinProviderAdapters } from "./builtin-provider-adapters";
import {
  anthropicCacheControl,
  resolveEndpointCapabilities,
  type CacheRetention,
  type EndpointCapabilities,
} from "./provider-caps";
import {
  getProviderAdapter,
  resolveEndpointProtocol,
  type ProviderFormat,
} from "./provider-adapters";
import { modelSelectionStatus, resolveEffectiveModel } from "@anthelia/config";
import {
  parseModelRef,
  type ConfigV3,
  type LocalAttachment,
  type ModelCapabilities,
  type ModelRef,
  type ProviderContentPart,
  type ProviderReasoningBlock,
} from "@anthelia/contracts";
import {
  asProviderError,
  providerError,
  providerErrorFromHttp,
} from "./errors";
import {
  CONSERVATIVE_MODEL_LIMIT_FALLBACK,
  knownModelOutputLimit,
  modelsDevModelLimits,
  type ModelMetadataProvider,
} from "./modelmeta";

/** Durable attachment reference carried into the provider layer. */
export type ProviderAttachmentRef = LocalAttachment;

/** Legacy wire shape kept during migration; new lowerings use refs. */
export type ProviderAttachmentLegacy = {
  mediaType: string;
  dataURL: string;
};

export type ProviderAttachment =
  | ProviderAttachmentRef
  | ProviderAttachmentLegacy;

export type ProviderMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * Provider-native reasoning text that some OpenAI-compatible thinking
   * models require in the assistant tool-call message on the next request
   * (DeepSeek's `reasoning_content` is the canonical example). Anthropic
   * carries the opaque signature separately in `reasoningSignature`.
   */
  reasoningContent?: string;
  /** OpenAI-compatible reasoning field this content came from. */
  reasoningField?: string;
  /**
   * Provider-native reasoning signature/encrypted payload. Anthropic needs it
   * on the thinking block; Gemini carries it as a sibling of its functionCall
   * part. OpenAI-compatible gateways generally do not use this field.
   */
  reasoningSignature?: string;
  /** True when `reasoningSignature` is Anthropic redacted_thinking rather than
   * a normal thinking block. */
  reasoningRedacted?: boolean;
  /** Ordered provider-native reasoning blocks for providers that emit more
   * than one signed thinking block in a single assistant turn. */
  reasoningBlocks?: ProviderReasoningBlock[];
  /** Ordered provider-native assistant content parts. When present, adapters
   * use this to preserve the provider's original part order on replay. */
  contentParts?: ProviderContentPart[];
  /** Generic provider metadata carried across turns (OpenRouter details, etc.). */
  providerMetadata?: Record<string, unknown>;
  /**
   * Gemini thought signature attached to a non-thought text part. The
   * signature must be replayed on the same text part, not moved onto a
   * reasoning or functionCall part.
   */
  textSignature?: string;
  images?: ProviderAttachment[];
  videos?: ProviderAttachment[];
  toolCallID?: string;
  toolName?: string;
  toolCalls?: ProviderToolCall[];
};

export type ProviderTool = {
  name: string;
  description: string;
  parameters: unknown;
};

export type ProviderToolCall = {
  id: string;
  name: string;
  arguments: string;
  /**
   * Provider-native opaque metadata that must accompany this function call.
   * Gemini stores its thoughtSignature here; OpenAI-compatible OpenRouter
   * `reasoning_details` stores the serialized encrypted reasoning entry.
   */
  thoughtSignature?: string;
  /** Generic provider metadata copied onto replay messages. */
  providerMetadata?: Record<string, unknown>;
};

/**
 * Provider call ids are expected to be unique across the request, but an
 * OpenAI-compatible gateway can emit the same id on two streamed tool calls.
 * Rewrite only the duplicates to deterministic unique ids while reserving every
 * original id so a generated id never steals another call's identity. The
 * returned calls are safe to put in assistant `tool_calls` and to pair with
 * their tool results.
 */
export function uniqueProviderToolCallIds(
  calls: ProviderToolCall[],
  reservedIDs: Iterable<string> = [],
): {
  calls: ProviderToolCall[];
  duplicates: string[];
} {
  const reserved = new Set([...reservedIDs, ...calls.map((call) => call.id)]);
  const seen = new Set<string>(reservedIDs);
  const duplicates: string[] = [];
  const unique = calls.map((call) => {
    if (!seen.has(call.id)) {
      seen.add(call.id);
      return call;
    }
    duplicates.push(call.id);
    let suffix = 1;
    let id = `${call.id}#${suffix}`;
    while (seen.has(id) || reserved.has(id)) {
      suffix += 1;
      id = `${call.id}#${suffix}`;
    }
    seen.add(id);
    return { ...call, id };
  });
  return { calls: unique, duplicates };
}

export type ProviderFinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "error"
  | "unknown";

export type ProviderStreamChunk =
  | { type: "content"; text: string; textSignature?: string }
  | {
      type: "thinking";
      text: string;
      /** OpenAI-compatible field name, e.g. reasoning_content or reasoning. */
      field?: string;
      /** Anthropic signature_delta payload, or Gemini thought signature. */
      signature?: string;
      /** Anthropic redacted_thinking payload rather than displayable text. */
      redacted?: boolean;
      /** Anthropic content block index, used to keep multiple blocks distinct. */
      blockIndex?: number;
    }
  | { type: "tool_call"; calls: ProviderToolCall[] }
  | { type: "tool_protocol_violation"; text: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      /** Anthropic cache metrics (ADR E): cache_creation = prefix written, cache_read = prefix reused. */
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    }
  | {
      type: "done";
      finishReason?: ProviderFinishReason;
      providerMetadata?: Record<string, unknown>;
    };

/**
 * Keeps textual tool-call markup out of the assistant transcript. Plain text is
 * never promoted to an executable call; only the provider's structured
 * `tool_call` chunks are authorized to reach the runtime.
 */
export async function* requireNativeToolCallProtocol(
  source: AsyncIterable<ProviderStreamChunk>,
): AsyncIterable<ProviderStreamChunk> {
  let content = "";
  let contentSignature: string | undefined;
  let violation = "";
  let structuredCalls = false;
  let done: Extract<ProviderStreamChunk, { type: "done" }> | undefined;

  const flushContent = function* (
    final: boolean,
  ): Iterable<ProviderStreamChunk> {
    while (content) {
      const signature = contentSignature
        ? { textSignature: contentSignature }
        : {};
      const start = textualToolCallMarkerIndex(content);
      if (start < 0) {
        const retained = final
          ? ""
          : textualToolCallMarkerPrefixSuffix(content);
        const text = content.slice(0, content.length - retained.length);
        content = retained;
        if (text) yield { type: "content", text, ...signature };
        return;
      }
      if (start > 0) {
        yield { type: "content", text: content.slice(0, start), ...signature };
        content = content.slice(start);
      }
      // Once model-authored tool syntax begins, retain the remainder as one
      // violation. This also catches malformed or bare <function=...> output.
      violation += content;
      content = "";
      return;
    }
  };

  for await (const chunk of source) {
    if (chunk.type === "content") {
      content += chunk.text;
      if (chunk.textSignature) contentSignature = chunk.textSignature;
      yield* flushContent(false);
      continue;
    }
    if (chunk.type === "tool_call") {
      yield* flushContent(true);
      contentSignature = undefined;
      structuredCalls ||= chunk.calls.length > 0;
      yield chunk;
      continue;
    }
    if (chunk.type === "done") {
      done = chunk;
      continue;
    }
    yield* flushContent(true);
    yield chunk;
  }
  yield* flushContent(true);
  if (violation && !structuredCalls)
    yield { type: "tool_protocol_violation", text: violation };
  if (done) yield done;
}

export function nativeToolCallCorrection(attempt: number) {
  return [
    `Tool-call protocol correction ${attempt}: your previous response wrote a tool call as assistant text.`,
    "Use the provider's native structured function/tool-calling channel now.",
    "Choose the intended function from the tool definitions supplied with this request and submit its arguments through that function call's structured arguments object.",
    "Do not print <tool_call> XML, JSON that describes a call, Markdown, or an explanation of the call in assistant content.",
    "Repeat the intended call through the native tool-calling interface. If no tool is needed, answer the user normally instead.",
  ].join(" ");
}

/**
 * Converts complete XML-like tool protocol blocks leaked into content by
 * compatible model gateways into ordinary provider tool calls. The parser is
 * intentionally strict: anything it cannot recognize remains assistant text.
 */
export async function* normalizeRawToolCallProtocol(
  source: AsyncIterable<ProviderStreamChunk>,
): AsyncIterable<ProviderStreamChunk> {
  let content = "";
  let contentSignature: string | undefined;
  let generatedCallCount = 0;
  const orderedCalls: ProviderToolCall[] = [];
  const rawCallIndices = new Map<string, number[]>();
  const structuredSignatures = new Set<string>();
  let done: Extract<ProviderStreamChunk, { type: "done" }> | undefined;

  const flushContent = function* (
    final: boolean,
  ): Iterable<ProviderStreamChunk> {
    while (content) {
      const signature = contentSignature
        ? { textSignature: contentSignature }
        : {};
      const start = rawToolCallStart(content);
      if (start < 0) {
        const retained = final ? "" : rawToolCallPrefixSuffix(content);
        const text = content.slice(0, content.length - retained.length);
        content = retained;
        if (text) yield { type: "content", text, ...signature };
        return;
      }
      if (start > 0) {
        yield { type: "content", text: content.slice(0, start), ...signature };
        content = content.slice(start);
      }
      const simple = /^<([A-Za-z_][\w.-]*)>\s*<args>/u.exec(content);
      const endMarker = simple ? `</${simple[1]}>` : "</tool_call>";
      const end = content.indexOf(endMarker);
      if (end < 0) {
        if (final) {
          yield { type: "content", text: content, ...signature };
          content = "";
        }
        return;
      }
      const blockEnd = end + endMarker.length;
      const block = content.slice(0, blockEnd);
      content = content.slice(blockEnd);
      const call = parseRawToolCall(
        block,
        `raw_xml_tool_${generatedCallCount}`,
      );
      if (call) {
        generatedCallCount += 1;
        const signature = toolCallSignature(call);
        if (!structuredSignatures.has(signature)) {
          const indices = rawCallIndices.get(signature) ?? [];
          indices.push(orderedCalls.length);
          rawCallIndices.set(signature, indices);
          orderedCalls.push(call);
        }
      } else yield { type: "content", text: block, ...signature };
    }
  };

  for await (const chunk of source) {
    if (chunk.type === "content") {
      content += chunk.text;
      if (chunk.textSignature) contentSignature = chunk.textSignature;
      yield* flushContent(false);
      continue;
    }
    if (chunk.type === "tool_call") {
      yield* flushContent(true);
      contentSignature = undefined;
      for (const call of chunk.calls) {
        const signature = toolCallSignature(call);
        structuredSignatures.add(signature);
        const indices = rawCallIndices.get(signature);
        const index = indices?.shift();
        if (!indices?.length) rawCallIndices.delete(signature);
        if (index === undefined) orderedCalls.push(call);
        else orderedCalls[index] = call;
      }
      continue;
    }
    if (chunk.type === "done") {
      done = chunk;
      continue;
    }
    yield* flushContent(true);
    yield chunk;
  }
  yield* flushContent(true);
  if (orderedCalls.length) yield { type: "tool_call", calls: orderedCalls };
  if (done) yield done;
}

function parseRawToolCall(
  block: string,
  id: string,
): ProviderToolCall | undefined {
  const match =
    /^<tool_call>\s*<function=([A-Za-z_][\w.:-]*)>([\s\S]*?)<\/function>\s*<\/tool_call>$/u.exec(
      block,
    );
  if (match) {
    const name = decodeXMLEntities(match[1]!);
    const body = match[2]!;
    const parameters = parseParameterElements(body);
    if (parameters !== undefined)
      return { id, name, arguments: JSON.stringify(parameters) };
  }

  const simple = /^<([A-Za-z_][\w.-]*)>([\s\S]*)<\/\1>$/u.exec(block.trim());
  if (simple) {
    const name = decodeXMLEntities(simple[1]!);
    const body = simple[2]!;
    const parameters = parseArgsElements(body);
    if (parameters !== undefined)
      return { id, name, arguments: JSON.stringify(parameters) };
  }

  return undefined;
}

function parseParameterElements(
  body: string,
): Record<string, unknown> | undefined {
  const parameters: Record<string, unknown> = {};
  let cursor = 0;
  const parameter =
    /\s*<parameter=([A-Za-z_][\w.:-]*)>([\s\S]*?)<\/parameter>/guy;
  while (cursor < body.length) {
    parameter.lastIndex = cursor;
    const item = parameter.exec(body);
    if (!item) return undefined;
    cursor = parameter.lastIndex;
    const key = decodeXMLEntities(item[1]!);
    if (Object.hasOwn(parameters, key)) return undefined;
    parameters[key] = parseRawToolParameter(decodeXMLEntities(item[2]!));
  }
  return parameters;
}

function parseArgsElements(body: string): Record<string, unknown> | undefined {
  const parameters: Record<string, unknown> = {};
  const trimmed = body.trim();
  const argsMatch = /^<args>([\s\S]*)<\/args>$/.exec(trimmed);
  const inner = argsMatch ? argsMatch[1]! : trimmed;
  const json = parseRawToolParameter(decodeXMLEntities(inner.trim()));
  if (json && typeof json === "object" && !Array.isArray(json))
    return json as Record<string, unknown>;
  let cursor = 0;
  const element = /<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\1>/gu;
  while (cursor < inner.length) {
    element.lastIndex = cursor;
    const item = element.exec(inner);
    if (!item)
      return /^\s*$/u.test(inner.slice(cursor)) ? parameters : undefined;
    cursor = element.lastIndex;
    const key = decodeXMLEntities(item[1]!);
    if (Object.hasOwn(parameters, key)) return undefined;
    parameters[key] = parseRawToolParameter(decodeXMLEntities(item[2]!));
  }
  return parameters;
}

function parseRawToolParameter(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function decodeXMLEntities(value: string) {
  return value.replace(
    /&(amp|lt|gt|quot|apos);/gu,
    (_entity, name: string) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name]!,
  );
}

function toolCallPrefixSuffix(value: string) {
  const marker = "<tool_call>";
  for (
    let length = Math.min(value.length, marker.length - 1);
    length > 0;
    length--
  )
    if (value.endsWith(marker.slice(0, length))) return value.slice(-length);
  return "";
}

function simpleToolCallStart(value: string) {
  return /<[A-Za-z_][\w.-]*>\s*<args>/u.exec(value)?.index ?? -1;
}

function rawToolCallStart(value: string) {
  const wrapped = value.indexOf("<tool_call>");
  const simple = simpleToolCallStart(value);
  if (wrapped < 0) return simple;
  if (simple < 0) return wrapped;
  return Math.min(wrapped, simple);
}

function rawToolCallPrefixSuffix(value: string) {
  const wrapped = toolCallPrefixSuffix(value);
  if (wrapped) return wrapped;
  const match = /<[A-Za-z_][\w.-]*(?:>\s*<[A-Za-z]*)?$/u.exec(value);
  return match ? value.slice(match.index) : "";
}

const textualToolCallMarkers = ["<tool_call", "<function=", "<parameter="];

function textualToolCallMarkerIndex(value: string) {
  let earliest = -1;
  for (const marker of textualToolCallMarkers) {
    const index = value.indexOf(marker);
    if (index >= 0 && (earliest < 0 || index < earliest)) earliest = index;
  }
  return earliest;
}

function textualToolCallMarkerPrefixSuffix(value: string) {
  for (const marker of textualToolCallMarkers)
    for (
      let length = Math.min(value.length, marker.length - 1);
      length > 0;
      length--
    )
      if (value.endsWith(marker.slice(0, length))) return value.slice(-length);
  return "";
}

function toolCallSignature(call: ProviderToolCall) {
  return `${call.name}\u0000${canonicalJSON(call.arguments)}`;
}

function canonicalJSON(value: string) {
  try {
    return JSON.stringify(sortJSON(JSON.parse(value) as unknown));
  } catch {
    return value;
  }
}

function sortJSON(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJSON);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJSON(item)]),
    );
  return value;
}

export type ProviderStreamRequest = {
  messages: ProviderMessage[];
  tools?: ProviderTool[];
  toolChoice?: "auto" | "required" | "none";
  signal?: AbortSignal;
  /**
   * Resolves a durable attachment ref to a data URL at provider-dispatch time.
   * Legacy inline data URLs remain supported during migration.
   */
  resolveAttachment?: (attachment: ProviderAttachmentRef) => Promise<string>;
};

export const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that maximum steps for this agent have been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.`;

export const MISSING_FINAL_RESPONSE_FALLBACK =
  "Tool execution completed, but the model did not provide a final text summary. The completed tool results remain available in the conversation context.";

function attachmentHasInlineDataURL(
  attachment: ProviderAttachment,
): attachment is ProviderAttachmentLegacy {
  return (
    typeof (attachment as { dataURL?: unknown }).dataURL === "string" &&
    (attachment as { dataURL: string }).dataURL.length > 0
  );
}

function attachmentIsRef(
  attachment: ProviderAttachment,
): attachment is ProviderAttachmentRef {
  return (
    typeof (attachment as { id?: unknown }).id === "string" &&
    typeof (attachment as { path?: unknown }).path === "string"
  );
}

async function materializeAttachment(
  attachment: ProviderAttachment,
  resolve?: (attachment: ProviderAttachmentRef) => Promise<string>,
): Promise<ProviderAttachmentLegacy> {
  if (attachmentHasInlineDataURL(attachment)) return attachment;
  if (!attachmentIsRef(attachment) || !resolve)
    throw new Error("provider attachment ref is missing a resolver");
  return {
    mediaType: attachment.mediaType,
    dataURL: await resolve(attachment),
  };
}

async function materializeMessage(
  message: ProviderMessage,
  resolve?: (attachment: ProviderAttachmentRef) => Promise<string>,
): Promise<ProviderMessage> {
  const materializeList = async (
    attachments: ProviderAttachment[] | undefined,
  ) =>
    attachments
      ? await Promise.all(
          attachments.map((attachment) =>
            materializeAttachment(attachment, resolve),
          ),
        )
      : undefined;
  const [images, videos] = await Promise.all([
    materializeList(message.images),
    materializeList(message.videos),
  ]);
  if (!images && !videos) return message;
  return {
    ...message,
    ...(images ? { images } : {}),
    ...(videos ? { videos } : {}),
  };
}

/**
 * Converts durable attachment refs into inline data URLs immediately before an
 * adapter serializes its request. This keeps base64 out of projection, durable
 * events, provider-message estimates, and the runner's message array.
 */
export async function materializeProviderMessages(
  request: ProviderStreamRequest,
): Promise<ProviderStreamRequest> {
  if (
    !request.messages.some(
      (message) => message.images?.length || message.videos?.length,
    )
  )
    return request;
  return {
    ...request,
    messages: await Promise.all(
      request.messages.map((message) =>
        materializeMessage(message, request.resolveAttachment),
      ),
    ),
  };
}

export type StreamingProvider = {
  provider: string;
  model: string;
  imageInput?: boolean;
  videoInput?: boolean;
  listModels?: ModelMetadataProvider["listModels"];
  modelDetail?: ModelMetadataProvider["modelDetail"];
  stream(request: ProviderStreamRequest): AsyncIterable<ProviderStreamChunk>;
};

export type OpenAICompatibleReasoningField =
  | "reasoning"
  | "reasoning_content"
  | "reasoning_details";

export type OpenAICompatibleProviderOptions = {
  apiKey: string;
  model: string;
  baseURL?: string;
  provider?: string;
  fetch?: typeof fetch;
  authHeader?: string;
  customHeaders?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  reasoningEffort?: string;
  thinkingEnabled?: boolean;
  /** Interleaved reasoning field forced onto every assistant replay. */
  interleavedReasoningField?: OpenAICompatibleReasoningField;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  /** Declared optional cache extensions; absent means none are used. */
  capabilities?: EndpointCapabilities;
  /** Stable session id, sent only when a cache key is declared. */
  sessionID?: string;
  /** How long this endpoint's prompt cache should be retained. */
  cacheRetention?: CacheRetention;
};

export type AnthropicProviderOptions = {
  apiKey: string;
  model: string;
  baseURL?: string;
  provider?: string;
  fetch?: typeof fetch;
  version?: string;
  /** The T3 telemetry channel; absent means diagnostic silence. */
  log?: ProviderDebugLog;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number;
  /** Declared optional cache extensions; absent means none are used. */
  capabilities?: EndpointCapabilities;
  /** Stable session id, sent only when the endpoint declares affinity headers. */
  sessionID?: string;
  /** How long this endpoint's prompt cache should be retained. */
  cacheRetention?: CacheRetention;
};

export type GeminiProviderOptions = {
  apiKey: string;
  model: string;
  baseURL?: string;
  provider?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
};

/**
 * The session-cache-key parameter for an OpenAI-family endpoint, or nothing.
 *
 * Two independent gates: the endpoint must declare that it accepts a key at
 * all, and must name the spelling. Neither is inferred.
 */
function openAICacheKeyParams(
  capabilities: EndpointCapabilities | undefined,
  sessionID: string | undefined,
  retention: CacheRetention | undefined,
): Record<string, unknown> {
  const caps = resolveEndpointCapabilities(capabilities);
  // `none` opts out of the cache entirely, so the key has nothing to route.
  if (retention === "none") return {};
  if (!caps.supportsPromptCacheKey || !sessionID) return {};
  // `prompt_cache_key` is the spelling on the wire, which is what these
  // adapters post. `promptCacheKey` is the AI SDK's option name for the same
  // thing; it only applies to an endpoint that speaks the SDK's shape rather
  // than the HTTP one, so it is opt-in rather than the default.
  const field = caps.promptCacheKeyField ?? "prompt_cache_key";
  return { [field]: sessionID };
}

/**
 * The operation-log channel an adapter may carry (T3): the transport layer
 * stays context-free by design, so the runtime injects the channel at
 * construction. Optional everywhere — a bare adapter (tests, the SDK's own
 * construction) simply records nothing.
 */
export type ProviderDebugLog = {
  debug(
    component: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void;
};

export type OpenAIResponsesProviderOptions = {
  apiKey: string;
  model: string;
  /** The T3 telemetry channel; absent means diagnostic silence. */
  log?: ProviderDebugLog;
  baseURL?: string;
  provider?: string;
  fetch?: typeof fetch;
  authHeader?: string;
  customHeaders?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  reasoningEffort?: string;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  /** Declared optional cache extensions; absent means none are used. */
  capabilities?: EndpointCapabilities;
  /** Stable session id, sent only when a cache key is declared. */
  sessionID?: string;
  /** How long this endpoint's prompt cache should be retained. */
  cacheRetention?: CacheRetention;
};

/** Responses rejects `max_output_tokens` below this. */
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

function responsesURL(baseURL: string) {
  return baseURL.endsWith("/responses") ? baseURL : `${baseURL}/responses`;
}

/** One Responses `input` item. */
type ResponsesInputItem =
  | { role: "system" | "user"; content: Array<Record<string, unknown>> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/**
 * Map the neutral message list onto Responses `input` items.
 *
 * The Responses family has no `messages` array: a user turn is a
 * `{role, content}` item, an assistant tool call is a `function_call` item, and
 * a tool result is a `function_call_output` item. Tool calls therefore have to
 * be lifted out of the assistant message that carried them, because the pairing
 * lives in `call_id` rather than in message order.
 */
function toResponsesInput(
  messages: readonly ProviderMessage[],
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.toolCallID) continue;
      items.push({
        type: "function_call_output",
        call_id: message.toolCallID,
        output: message.content,
      });
      continue;
    }
    if (message.role === "assistant") {
      // An assistant tool call is its own `function_call` item, so it has to be
      // lifted out of the message that carried it. Skipping the role here would
      // silently drop every historical call and the results that pair with it.
      for (const call of message.toolCalls ?? [])
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      continue;
    }
    if (message.role !== "user" && message.role !== "system") continue;
    const content: Array<Record<string, unknown>> = [];
    if (message.content)
      content.push({ type: "input_text", text: message.content });
    for (const image of message.images ?? [])
      content.push({
        type: "input_image",
        image_url: materializedDataURL(image),
      });
    // An empty content array is rejected, so a message that carried only
    // attachments that failed to materialise still needs a text part.
    if (!content.length) content.push({ type: "input_text", text: "" });
    items.push({ role: message.role, content });
  }
  return items;
}

/**
 * The retention parameter pair for one endpoint, or nothing at all.
 *
 * Exactly one of the two shapes is ever emitted, and only when the endpoint
 * declared it accepts that one. `prompt_cache_key` is separate: it rides along
 * whenever a key is configured, because a session key is accepted far more
 * widely than either retention parameter.
 */
/**
 * The prompt-cache parameters for a Responses endpoint, or nothing.
 *
 * The family has two mutually exclusive retention shapes and sending the one a
 * deployment rejects is a hard 400, so which one goes out comes from the
 * declaration rather than from a model id. `prompt_cache_key` is separate and
 * rides along whenever a key is declared, because a session key is accepted far
 * more widely than either retention parameter.
 */
function responsesPromptCacheParams(
  capabilities: EndpointCapabilities | undefined,
  sessionID: string | undefined,
  retention: CacheRetention | undefined,
): Record<string, unknown> {
  if (retention === "none") return {};
  const caps = resolveEndpointCapabilities(capabilities);
  const params = {
    ...openAICacheKeyParams(capabilities, sessionID, retention),
  };
  if (caps.supportsExplicitPromptCacheMode) {
    params.prompt_cache_options = caps.supportsLongCacheRetention
      ? { mode: "explicit", ttl: "30m" }
      : { mode: "explicit" };
  } else if (caps.supportsLongCacheRetention) {
    params.prompt_cache_retention = "24h";
  }
  return params;
}

type ResponsesSSEState = {
  toolCalls: Map<number, ProviderToolCall>;
  /** Arguments accumulated per tool-call output index. */
  toolArguments: Map<number, string>;
  /** Item id of the tool call currently being streamed, per output index. */
  toolItemIDs: Map<number, string>;
  finishReason?: ProviderFinishReason;
  responseID?: string;
};

function parseResponsesSSEPart(
  part: string,
  state: ResponsesSSEState,
  /** The T3 telemetry channel (T3: a context-free parser takes it in). */
  log?: ProviderDebugLog,
): ProviderStreamChunk[] {
  const chunks: ProviderStreamChunk[] = [];
  for (const line of part.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    const event = JSON.parse(data) as {
      type?: string;
      response?: { id?: string; usage?: ResponsesUsage };
      item?: { id?: string; type?: string; name?: string; call_id?: string };
      output_index?: number;
      delta?: string;
      arguments?: string;
    };
    // Was an env gate; now the log's level gate (T3).
    log?.debug("[provider]", "responses SSE", { type: event.type });

    switch (event.type) {
      case "response.created":
        if (event.response?.id) state.responseID = event.response.id;
        break;
      case "response.output_item.added":
      case "response.output_item.done": {
        const index = event.output_index ?? state.toolCalls.size;
        if (event.item?.type !== "function_call") break;
        if (event.item.id) state.toolItemIDs.set(index, event.item.id);
        // The item may already exist from an earlier `added`; only create it
        // once so a `done` event cannot reset accumulated arguments.
        if (
          !state.toolCalls.has(index) &&
          event.item.call_id &&
          event.item.name
        )
          state.toolCalls.set(index, {
            id: event.item.call_id,
            name: event.item.name,
            arguments: "",
          });
        break;
      }
      case "response.output_text.delta":
        if (event.delta) chunks.push({ type: "content", text: event.delta });
        break;
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta":
        if (event.delta)
          chunks.push({
            type: "thinking",
            text: event.delta,
            field: "reasoning_text",
          });
        break;
      case "response.refusal.delta":
        // A refusal is model output the caller must see; it is not an error.
        if (event.delta) chunks.push({ type: "content", text: event.delta });
        break;
      case "response.function_call_arguments.delta": {
        const index = event.output_index ?? 0;
        state.toolArguments.set(
          index,
          (state.toolArguments.get(index) ?? "") + (event.delta ?? ""),
        );
        break;
      }
      case "response.function_call_arguments.done": {
        const index = event.output_index ?? 0;
        const call = state.toolCalls.get(index);
        if (call) {
          const finalArguments =
            event.arguments ?? state.toolArguments.get(index) ?? "";
          state.toolCalls.set(index, { ...call, arguments: finalArguments });
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        state.finishReason =
          event.type === "response.incomplete" ? "length" : "stop";
        const usage = event.response?.usage;
        if (usage) chunks.push(responsesUsageChunk(usage));
        break;
      }
      default:
        break;
    }
  }
  return chunks;
}

type ResponsesUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
};

/**
 * Map Responses usage onto the neutral chunk.
 *
 * Unlike Anthropic — whose `input_tokens` excludes cached traffic — the
 * Responses family **includes** cached and cache-write tokens inside
 * `input_tokens`. Reporting it directly would double-count every cached token
 * and inflate the request total, so both are subtracted here.
 */
function responsesUsageChunk(usage: ResponsesUsage): ProviderStreamChunk {
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const written = usage.input_tokens_details?.cache_write_tokens ?? 0;
  const reported = usage.input_tokens ?? 0;
  return {
    type: "usage",
    inputTokens: Math.max(0, reported - cached - written),
    outputTokens: usage.output_tokens ?? 0,
    ...(cached === 0 ? {} : { cacheReadInputTokens: cached }),
    ...(written === 0 ? {} : { cacheCreationInputTokens: written }),
  };
}

async function* streamResponsesSSE(
  body: ReadableStream<Uint8Array>,
  streamIdleTimeoutMs?: number,
  /** The T3 telemetry channel, threaded down to the SSE parser. */
  log?: ProviderDebugLog,
): AsyncIterable<ProviderStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: ResponsesSSEState = {
    toolCalls: new Map(),
    toolArguments: new Map(),
    toolItemIDs: new Map(),
  };
  let buffer = "";
  while (true) {
    const next = await readWithIdleTimeout(reader, streamIdleTimeoutMs);
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/u);
    buffer = parts.pop() ?? "";
    for (const part of parts) yield* parseResponsesSSEPart(part, state, log);
  }
  buffer += decoder.decode();
  if (buffer) yield* parseResponsesSSEPart(buffer, state, log);
  if (state.toolCalls.size)
    yield { type: "tool_call", calls: [...state.toolCalls.values()] };
  yield { type: "done", finishReason: state.finishReason };
}

/**
 * OpenAI Responses adapter.
 *
 * A separate family from chat completions rather than a flag on it: the request
 * has no `messages` array, tool calls are standalone `function_call` items
 * keyed by `call_id`, and the prompt-cache controls are two mutually exclusive
 * parameter pairs. Folding that into the completions adapter would put every one
 * of those differences behind a conditional.
 */
export class OpenAIResponsesProvider implements StreamingProvider {
  readonly provider: string;
  readonly model: string;
  readonly imageInput = true;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeader: string;
  private readonly customHeaders: Record<string, string>;
  private readonly temperature?: number;
  private readonly maxTokens?: number;
  private readonly topP?: number;
  private readonly reasoningEffort?: string;
  private readonly timeoutMs?: number;
  private readonly streamIdleTimeoutMs?: number;
  private readonly log?: ProviderDebugLog;
  private readonly capabilities?: EndpointCapabilities;
  private readonly sessionID?: string;
  private readonly cacheRetention?: CacheRetention;

  constructor(options: OpenAIResponsesProviderOptions) {
    this.apiKey = options.apiKey;
    this.log = options.log;
    this.model = options.model;
    this.baseURL = (options.baseURL ?? "https://api.openai.com/v1").replace(
      /\/+$/u,
      "",
    );
    this.provider = options.provider ?? "openai-responses";
    this.fetchImpl = options.fetch ?? fetch;
    this.authHeader = options.authHeader ?? "authorization";
    this.customHeaders = options.customHeaders ?? {};
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.topP = options.topP;
    this.reasoningEffort = options.reasoningEffort;
    this.timeoutMs = options.timeoutMs;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs;
    this.capabilities = options.capabilities;
    this.sessionID = options.sessionID;
    this.cacheRetention = options.cacheRetention;
  }

  async *stream(
    request: ProviderStreamRequest,
  ): AsyncIterable<ProviderStreamChunk> {
    const timeout = this.timeoutMs;
    const signal = timeout ? AbortSignal.timeout(timeout) : request.signal;
    const input = toResponsesInput(request.messages);
    const tools =
      request.toolChoice === "none"
        ? undefined
        : request.tools?.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          }));
    const body: Record<string, unknown> = {
      model: this.model,
      input,
      stream: true,
      // Stateless by default: the harness owns history, so retaining it server
      // side would duplicate state nothing reads.
      store: false,
      ...responsesPromptCacheParams(
        this.capabilities,
        this.sessionID,
        this.cacheRetention,
      ),
      ...(tools?.length ? { tools } : {}),
      ...(request.toolChoice && request.toolChoice !== "none"
        ? { tool_choice: request.toolChoice }
        : {}),
      ...(this.maxTokens === undefined
        ? {}
        : {
            max_output_tokens: Math.max(
              this.maxTokens,
              OPENAI_RESPONSES_MIN_OUTPUT_TOKENS,
            ),
          }),
      ...(this.temperature === undefined
        ? {}
        : { temperature: this.temperature }),
      ...(this.topP === undefined ? {} : { top_p: this.topP }),
      ...(this.reasoningEffort
        ? { reasoning: { effort: this.reasoningEffort } }
        : {}),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(responsesURL(this.baseURL), {
        method: "POST",
        headers: {
          [this.authHeader]: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          ...this.customHeaders,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw asProviderError(error);
    }
    if (!response.ok)
      throw providerErrorFromHttp({
        statusCode: response.status,
        statusText: response.statusText,
        retryAfter: response.headers.get("retry-after"),
        retryAfterMs: response.headers.get("retry-after-ms"),
        message: await safeResponseText(response),
      });
    if (!response.body)
      throw new Error("OpenAI Responses response body unavailable");
    yield* streamResponsesSSE(
      response.body,
      this.streamIdleTimeoutMs,
      this.log,
    );
  }
}

export class OpenAICompatibleProvider implements StreamingProvider {
  readonly provider: string;
  readonly model: string;
  readonly imageInput = true;
  readonly videoInput = false;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeader: string;
  private readonly customHeaders: Record<string, string>;
  private readonly temperature?: number;
  private readonly maxTokens?: number;
  private readonly topP?: number;
  private readonly reasoningEffort?: string;
  private readonly thinkingEnabled?: boolean;
  private readonly interleavedReasoningField?: OpenAICompatibleReasoningField;
  private readonly timeoutMs?: number;
  private readonly streamIdleTimeoutMs?: number;
  private readonly log?: ProviderDebugLog;
  private readonly capabilities?: EndpointCapabilities;
  private readonly sessionID?: string;
  private readonly cacheRetention?: CacheRetention;
  private modelMetadata?: ReturnType<
    OpenAICompatibleProvider["fetchModelMetadata"]
  >;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.provider = options.provider ?? "openai-compatible";
    this.baseURL = (options.baseURL ?? "https://api.openai.com/v1").replace(
      /\/+$/u,
      "",
    );
    this.fetchImpl = options.fetch ?? fetch;
    this.authHeader = options.authHeader ?? "authorization";
    this.customHeaders = options.customHeaders ?? {};
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.topP = options.topP;
    this.reasoningEffort = options.reasoningEffort;
    this.thinkingEnabled = options.thinkingEnabled;
    this.interleavedReasoningField = options.interleavedReasoningField;
    this.timeoutMs = options.timeoutMs;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs;
    this.capabilities = options.capabilities;
    this.sessionID = options.sessionID;
    this.cacheRetention = options.cacheRetention;
  }

  async *stream(
    request: ProviderStreamRequest,
  ): AsyncIterable<ProviderStreamChunk> {
    request = await materializeProviderMessages(request);

    const timeout = this.timeoutMs
      ? AbortSignal.timeout(this.timeoutMs)
      : undefined;
    const signal = timeout
      ? request.signal
        ? AbortSignal.any([request.signal, timeout])
        : timeout
      : request.signal;
    const response = await this.fetchImpl(chatCompletionsURL(this.baseURL), {
      method: "POST",
      headers: {
        [this.authHeader]: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        ...this.customHeaders,
      },
      body: JSON.stringify({
        model: this.model,
        messages: request.messages.map((message) =>
          toOpenAIMessage(message, this.interleavedReasoningField),
        ),
        tools:
          request.toolChoice === "none"
            ? undefined
            : request.tools?.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
        tool_choice: request.toolChoice,
        stream: true,
        stream_options: { include_usage: true },
        // A session key is an extension rather than part of either OpenAI
        // spec, and the field spelling differs per deployment. Both come from
        // the declaration; a key sent under the wrong name is silently ignored,
        // which looks exactly like a cache that never works.
        ...openAICacheKeyParams(
          this.capabilities,
          this.sessionID,
          this.cacheRetention,
        ),
        ...(this.temperature === undefined
          ? {}
          : { temperature: this.temperature }),
        ...(this.maxTokens === undefined ? {} : { max_tokens: this.maxTokens }),
        ...(this.topP === undefined ? {} : { top_p: this.topP }),
        ...(this.reasoningEffort
          ? { reasoning_effort: this.reasoningEffort }
          : {}),
        ...(this.thinkingEnabled === undefined
          ? {}
          : { thinking_enabled: this.thinkingEnabled }),
      }),
      signal,
    });
    if (!response.ok)
      throw providerErrorFromHttp({
        statusCode: response.status,
        statusText: response.statusText,
        retryAfter: response.headers.get("retry-after"),
        retryAfterMs: response.headers.get("retry-after-ms"),
        message: await safeResponseText(response),
      });
    if (!response.body) {
      const data = (await response.json()) as OpenAIChatCompletion;
      const text = data.choices?.[0]?.message?.content;
      if (text) yield { type: "content", text };
      const toolCalls = data.choices?.[0]?.message?.tool_calls?.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }));
      if (toolCalls?.length) yield { type: "tool_call", calls: toolCalls };
      if (data.usage) yield openAIUsageChunk(data.usage);
      yield {
        type: "done",
        finishReason: normalizeOpenAIFinishReason(
          data.choices?.[0]?.finish_reason,
          Boolean(toolCalls?.length),
        ),
      };
      return;
    }
    yield* streamOpenAISSE(response.body, this.streamIdleTimeoutMs);
  }

  async listModels(): Promise<
    Array<{
      id: string;
      contextWindow?: number;
      inputTokenLimit?: number;
      maxOutputTokens?: number;
    }>
  > {
    if (!this.modelMetadata) this.modelMetadata = this.fetchModelMetadata();
    return await this.modelMetadata;
  }

  private async fetchModelMetadata(): Promise<
    Array<{
      id: string;
      contextWindow?: number;
      inputTokenLimit?: number;
      maxOutputTokens?: number;
    }>
  > {
    const response = await this.fetchImpl(modelsURL(this.baseURL), {
      headers: {
        [this.authHeader]: `Bearer ${this.apiKey}`,
        ...this.customHeaders,
      },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok)
      throw providerErrorFromHttp({
        statusCode: response.status,
        statusText: response.statusText,
        retryAfter: response.headers.get("retry-after"),
        retryAfterMs: response.headers.get("retry-after-ms"),
        message: await safeResponseText(response),
      });
    const data = (await response.json()) as {
      data?: Array<{
        id?: unknown;
        context_window?: unknown;
        contextWindow?: unknown;
        input_token_limit?: unknown;
        max_input_tokens?: unknown;
        max_output_tokens?: unknown;
        output_token_limit?: unknown;
        max_tokens?: unknown;
      }>;
    };
    return (data.data ?? []).flatMap((model) =>
      typeof model.id === "string"
        ? [
            {
              id: model.id,
              contextWindow:
                typeof model.context_window === "number"
                  ? model.context_window
                  : typeof model.contextWindow === "number"
                    ? model.contextWindow
                    : undefined,
              inputTokenLimit:
                typeof model.input_token_limit === "number"
                  ? model.input_token_limit
                  : typeof model.max_input_tokens === "number"
                    ? model.max_input_tokens
                    : undefined,
              maxOutputTokens:
                typeof model.max_output_tokens === "number"
                  ? model.max_output_tokens
                  : typeof model.output_token_limit === "number"
                    ? model.output_token_limit
                    : typeof model.max_tokens === "number"
                      ? model.max_tokens
                      : undefined,
            },
          ]
        : [],
    );
  }
}

export class AnthropicProvider implements StreamingProvider {
  readonly provider: string;
  readonly model: string;
  readonly imageInput = true;
  readonly videoInput = false;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly version: string;
  private readonly timeoutMs?: number;
  private readonly maxTokens?: number;
  private readonly temperature?: number;
  private readonly reasoningEffort?: string;
  private readonly thinkingEnabled?: boolean;
  private readonly thinkingBudgetTokens?: number;
  private readonly streamIdleTimeoutMs?: number;
  private readonly log?: ProviderDebugLog;
  private readonly capabilities?: EndpointCapabilities;
  private readonly sessionID?: string;
  private readonly cacheRetention?: CacheRetention;
  private modelMetadata?: Promise<
    Array<{
      id: string;
      contextWindow?: number;
      inputTokenLimit?: number;
      maxOutputTokens?: number;
    }>
  >;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.log = options.log;
    this.model = options.model;
    this.provider = options.provider ?? "anthropic";
    this.baseURL = (options.baseURL ?? "https://api.anthropic.com/v1").replace(
      /\/+$/u,
      "",
    );
    this.fetchImpl = options.fetch ?? fetch;
    this.version = options.version ?? "2023-06-01";
    this.timeoutMs = options.timeoutMs;
    this.maxTokens = options.maxTokens;
    this.temperature = options.temperature;
    this.reasoningEffort = options.reasoningEffort;
    this.thinkingEnabled = options.thinkingEnabled;
    this.thinkingBudgetTokens = options.thinkingBudgetTokens;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs;
    this.capabilities = options.capabilities;
    this.sessionID = options.sessionID;
    this.cacheRetention = options.cacheRetention;
  }

  async *stream(
    request: ProviderStreamRequest,
  ): AsyncIterable<ProviderStreamChunk> {
    request = await materializeProviderMessages(request);

    const caps = resolveEndpointCapabilities(this.capabilities);
    const cacheControl = anthropicCacheControl({
      retention: this.cacheRetention ?? "short",
      supportsLongCacheRetention: caps.supportsLongCacheRetention,
    });
    const timeout = this.timeoutMs
      ? AbortSignal.timeout(this.timeoutMs)
      : undefined;
    const signal = timeout
      ? request.signal
        ? AbortSignal.any([request.signal, timeout])
        : timeout
      : request.signal;
    const maxTokens =
      this.maxTokens ??
      (await this.outputTokenLimit().catch(
        () => CONSERVATIVE_MODEL_LIMIT_FALLBACK,
      ));
    const thinking = this.thinkingEnabled
      ? anthropicThinkingRequest(
          this.thinkingBudgetTokens,
          this.reasoningEffort,
          maxTokens,
        )
      : undefined;
    // ADR D1/E: the static per-role system prompt and the tool schemas are
    // the stable prefix the provider caches. Emit Anthropic cache_control
    // breakpoints so the prefix is reused across turns instead of re-billed:
    // one on the system block and one on the last tool schema.
    const systemMessages = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content);
    const conversationMessages = request.messages
      .filter((message) => message.role !== "system")
      .map(toAnthropicMessage);
    // ADR D1/E: mark the end of the conversation so the whole prefix is cached,
    // not just the header. Anthropic only *writes* a cache entry at a
    // breakpoint, so without one here the conversation is re-billed in full on
    // every turn however stable it is. This is the single largest cache win on
    // this family.
    markConversationBreakpoint(conversationMessages, cacheControl);
    // `cache_control` on tool definitions is an extension the Messages spec
    // added after tool caching shipped, so a conforming endpoint is not obliged
    // to accept it. Gated on a declaration rather than assumed, and on the same
    // retention marker the system block uses.
    const toolCacheControl =
      caps.supportsCacheControlOnTools && cacheControl
        ? { cache_control: cacheControl }
        : {};
    const anthropicTools =
      request.toolChoice === "none"
        ? undefined
        : request.tools?.map((tool, index, all) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
            ...(index === all.length - 1 ? toolCacheControl : {}),
          }));
    const response = await this.fetchImpl(messagesURL(this.baseURL), {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": this.version,
        "content-type": "application/json",
        // A replica-routing endpoint needs this or requests are load-balanced
        // and the prefix cache never lands. Sent only when declared.
        ...(caps.sendSessionAffinityHeaders && this.sessionID
          ? {
              [caps.sessionAffinityFormat === "openrouter"
                ? "x-session-id"
                : "x-session-affinity"]: this.sessionID,
            }
          : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages: conversationMessages,
        system: systemMessages.length
          ? [
              {
                type: "text",
                text: systemMessages.join("\n\n"),
                ...(cacheControl ? { cache_control: cacheControl } : {}),
              },
            ]
          : undefined,
        tools: anthropicTools,
        tool_choice:
          request.toolChoice === "required"
            ? { type: "any" }
            : request.toolChoice === "auto"
              ? { type: "auto" }
              : undefined,
        max_tokens: maxTokens,
        stream: true,
        // Anthropic rejects temperature when extended thinking is enabled.
        ...(thinking || this.temperature === undefined
          ? {}
          : { temperature: this.temperature }),
        ...(thinking ? { thinking } : {}),
      }),
      signal,
    });
    if (!response.ok)
      throw providerErrorFromHttp({
        statusCode: response.status,
        statusText: response.statusText,
        retryAfter: response.headers.get("retry-after"),
        retryAfterMs: response.headers.get("retry-after-ms"),
        message: await safeResponseText(response),
      });
    if (!response.body) throw new Error("Anthropic response body unavailable");
    yield* streamAnthropicSSE(
      response.body,
      this.streamIdleTimeoutMs,
      this.log,
    );
  }

  async listModels() {
    if (!this.modelMetadata) this.modelMetadata = this.fetchModelMetadata();
    return await this.modelMetadata;
  }

  private async outputTokenLimit() {
    const model = isLocalProviderURL(this.baseURL)
      ? undefined
      : (await this.listModels().catch(() => [])).find(
          (candidate) => candidate.id === this.model,
        );
    if (model?.maxOutputTokens) return model.maxOutputTokens;
    const catalog = await modelsDevModelLimits(this.provider, this.model);
    return (
      catalog?.maxOutputTokens ??
      knownModelOutputLimit(this.model) ??
      CONSERVATIVE_MODEL_LIMIT_FALLBACK
    );
  }

  private async fetchModelMetadata() {
    const response = await this.fetchImpl(modelsURL(this.baseURL), {
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": this.version,
      },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok)
      throw providerErrorFromHttp({
        statusCode: response.status,
        statusText: response.statusText,
        retryAfter: response.headers.get("retry-after"),
        retryAfterMs: response.headers.get("retry-after-ms"),
        message: await safeResponseText(response),
      });
    const payload = (await response.json()) as {
      data?: Array<{
        id?: unknown;
        max_input_tokens?: unknown;
        max_tokens?: unknown;
        context_window?: unknown;
        max_output_tokens?: unknown;
      }>;
    };
    return (payload.data ?? []).flatMap((model) =>
      typeof model.id === "string"
        ? [
            {
              id: model.id,
              contextWindow:
                typeof model.max_input_tokens === "number"
                  ? model.max_input_tokens
                  : typeof model.context_window === "number"
                    ? model.context_window
                    : undefined,
              inputTokenLimit: undefined,
              maxOutputTokens:
                typeof model.max_tokens === "number"
                  ? model.max_tokens
                  : typeof model.max_output_tokens === "number"
                    ? model.max_output_tokens
                    : undefined,
            },
          ]
        : [],
    );
  }
}

export class GeminiProvider implements StreamingProvider {
  readonly provider: string;
  readonly model: string;
  readonly imageInput = true;
  readonly videoInput = true;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs?: number;
  private readonly temperature?: number;
  private readonly maxTokens?: number;
  private readonly streamIdleTimeoutMs?: number;

  constructor(options: GeminiProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.provider = options.provider ?? "gemini";
    this.baseURL = (
      options.baseURL ?? "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/+$/u, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs;
  }

  async *stream(
    request: ProviderStreamRequest,
  ): AsyncIterable<ProviderStreamChunk> {
    request = await materializeProviderMessages(request);

    const timeout = this.timeoutMs
      ? AbortSignal.timeout(this.timeoutMs)
      : undefined;
    const signal = timeout
      ? request.signal
        ? AbortSignal.any([request.signal, timeout])
        : timeout
      : request.signal;
    const response = await this.fetchImpl(
      `${this.baseURL}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        // Keep credentials out of request URLs so they cannot leak through
        // proxy, server, or diagnostic URL logging.
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          contents: request.messages.map(toGeminiContent),
          tools:
            request.toolChoice !== "none" && request.tools?.length
              ? [
                  {
                    functionDeclarations: request.tools.map((tool) => ({
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.parameters,
                    })),
                  },
                ]
              : undefined,
          toolConfig:
            request.toolChoice === "required"
              ? { functionCallingConfig: { mode: "ANY" } }
              : request.toolChoice === "auto"
                ? { functionCallingConfig: { mode: "AUTO" } }
                : undefined,
          generationConfig: {
            ...(this.temperature === undefined
              ? {}
              : { temperature: this.temperature }),
            ...(this.maxTokens === undefined
              ? {}
              : { maxOutputTokens: this.maxTokens }),
          },
        }),
        signal,
      },
    );
    if (!response.ok)
      throw providerErrorFromHttp({
        statusCode: response.status,
        statusText: response.statusText,
        retryAfter: response.headers.get("retry-after"),
        retryAfterMs: response.headers.get("retry-after-ms"),
        message: await safeResponseText(response),
      });
    if (!response.body) throw new Error("Gemini response body unavailable");
    yield* streamGeminiSSE(response.body, this.streamIdleTimeoutMs);
  }
}

function reasoningFromContextEntries(
  entries: ContextEntry[],
): Pick<
  ProviderMessage,
  | "reasoningContent"
  | "reasoningField"
  | "reasoningSignature"
  | "reasoningRedacted"
  | "reasoningBlocks"
  | "contentParts"
  | "providerMetadata"
  | "textSignature"
> {
  for (const entry of entries) {
    if (
      entry.reasoningContent === undefined &&
      !entry.reasoningField &&
      !entry.reasoningSignature &&
      !entry.reasoningRedacted &&
      !entry.reasoningBlocks?.length &&
      !entry.contentParts?.length &&
      !entry.providerMetadata &&
      !entry.textSignature
    )
      continue;
    return {
      ...(entry.reasoningContent !== undefined
        ? { reasoningContent: entry.reasoningContent }
        : {}),
      ...(entry.reasoningField ? { reasoningField: entry.reasoningField } : {}),
      ...(entry.reasoningSignature
        ? { reasoningSignature: entry.reasoningSignature }
        : {}),
      ...(entry.reasoningRedacted ? { reasoningRedacted: true } : {}),
      ...(entry.reasoningBlocks?.length
        ? { reasoningBlocks: entry.reasoningBlocks }
        : {}),
      ...(entry.contentParts?.length
        ? { contentParts: entry.contentParts }
        : {}),
      ...(entry.providerMetadata
        ? { providerMetadata: entry.providerMetadata }
        : {}),
      ...(entry.textSignature ? { textSignature: entry.textSignature } : {}),
    };
  }
  return {};
}

export function contextEntriesToProviderMessages(
  entries: ContextEntry[],
): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.role === "tool_call") {
      const transaction: ContextEntry[] = [];
      while (
        index < entries.length &&
        (entries[index]!.role === "tool_call" ||
          entries[index]!.role === "tool_result")
      ) {
        transaction.push(entries[index]!);
        index += 1;
      }
      index -= 1;

      const results = new Map(
        transaction
          .filter(
            (item): item is ContextEntry & { pairID: string } =>
              item.role === "tool_result" && Boolean(item.pairID),
          )
          .map((item) => [item.pairID, item]),
      );
      const seenCallIDs = new Set<string>();
      const calls = transaction
        .filter((item) => item.role === "tool_call")
        .map(parseDurableToolCall)
        .filter((call): call is ProviderToolCall => {
          if (
            call === undefined ||
            !results.has(call.id) ||
            seenCallIDs.has(call.id)
          )
            return false;
          seenCallIDs.add(call.id);
          return true;
        });
      if (!calls.length) continue;
      const preceding = entries[index - transaction.length];
      const previousMessage = messages.at(-1);
      const reasoning = reasoningFromContextEntries(transaction);
      if (
        preceding?.role === "assistant" &&
        previousMessage?.role === "assistant" &&
        previousMessage.toolCalls === undefined
      ) {
        previousMessage.toolCalls = calls;
        Object.assign(previousMessage, reasoning);
      } else {
        messages.push({
          role: "assistant",
          content: "",
          ...reasoning,
          toolCalls: calls,
        });
      }
      for (const call of calls) {
        messages.push({
          role: "tool",
          toolCallID: call.id,
          content: results.get(call.id)!.content,
        });
      }
      continue;
    }
    if (entry.role === "tool_result") continue;
    const message = contextEntryToProviderMessage(entry);
    if (message) messages.push(message);
  }
  return messages;
}

function contextEntryToProviderMessage(
  entry: ContextEntry,
): ProviderMessage | undefined {
  if (
    entry.role === "system" ||
    entry.role === "user" ||
    entry.role === "assistant"
  )
    return {
      role: entry.role,
      content: entry.content,
      ...(entry.reasoningContent !== undefined
        ? { reasoningContent: entry.reasoningContent }
        : {}),
      ...(entry.reasoningField ? { reasoningField: entry.reasoningField } : {}),
      ...(entry.reasoningSignature
        ? { reasoningSignature: entry.reasoningSignature }
        : {}),
      ...(entry.reasoningRedacted ? { reasoningRedacted: true } : {}),
      ...(entry.reasoningBlocks?.length
        ? { reasoningBlocks: entry.reasoningBlocks }
        : {}),
      ...(entry.contentParts?.length
        ? { contentParts: entry.contentParts }
        : {}),
      ...(entry.providerMetadata
        ? { providerMetadata: entry.providerMetadata }
        : {}),
      ...(entry.textSignature ? { textSignature: entry.textSignature } : {}),
    };
  // ADR D7: a compaction summary is an appended user message, not a system
  // message — mapping it to system would hoist it back to the top of the
  // Anthropic request and reset the stable prefix on every request.
  // ADR D2: `dynamic` entries are runtime context delivered as user messages
  // (providers hoist all system messages to the top, so dynamic state must
  // never travel as system).
  if (entry.role === "summary" || entry.role === "dynamic")
    return { role: "user", content: entry.content };
  return undefined;
}

function parseDurableToolCall(
  entry: ContextEntry,
): ProviderToolCall | undefined {
  const separator = entry.content.indexOf(" ");
  if (separator < 1 || !entry.pairID) return undefined;
  return {
    id: entry.pairID,
    name: entry.content.slice(0, separator),
    arguments: entry.content.slice(separator + 1),
    ...(entry.thoughtSignature
      ? { thoughtSignature: entry.thoughtSignature }
      : {}),
  };
}

export function providerFromEnvironment(env = process.env) {
  const apiKey =
    env.NATALIA_API_KEY ??
    env.NATALIA_OPENAI_API_KEY ??
    env.OPENAI_API_KEY ??
    env.ANTHROPIC_API_KEY ??
    env.GEMINI_API_KEY;
  const model =
    env.NATALIA_MODEL ??
    env.OPENAI_MODEL ??
    env.ANTHROPIC_MODEL ??
    env.GEMINI_MODEL ??
    "gpt-4o-mini";
  if (!apiKey) return undefined;
  return providerFromKind({
    apiKey,
    model,
    baseURL:
      env.NATALIA_BASE_URL ??
      env.NATALIA_OPENAI_BASE_URL ??
      env.OPENAI_BASE_URL,
    provider: env.NATALIA_PROVIDER ?? "openai-compatible",
  });
}

export function providerFromKind(
  input: OpenAICompatibleProviderOptions & {
    providerName?: string;
    thinkingBudgetTokens?: number;
    /** Declared wire format; resolved from `driver` only when absent. */
    format?: ProviderFormat;
    /** Declared optional cache extensions; absent means none are used. */
    capabilities?: EndpointCapabilities;
    /** Stable session id, sent only when a cache key is declared. */
    sessionID?: string;
    /** How long this endpoint's prompt cache should be retained. */
    cacheRetention?: CacheRetention;
    /** The T3 telemetry channel; travels into the adapter's options. */
    log?: ProviderDebugLog;
  },
) {
  const { format } = resolveEndpointProtocol({
    driver: input.providerName ?? input.provider,
    protocol: input.format ? { format: input.format } : undefined,
  });
  // Built-ins register on first use, so no caller has to arrange an import.
  ensureBuiltinProviderAdapters();
  const adapter = getProviderAdapter(format);
  // Fail loudly rather than silently falling back: an unrecognised format that
  // quietly became an OpenAI request would send the wrong shape to an endpoint
  // and fail there, far from the cause.
  if (!adapter)
    throw new Error(`no provider adapter is registered for format "${format}"`);
  return adapter.create({
    ...input,
    provider: input.providerName ?? input.provider,
  }) as StreamingProvider;
}

function interleavedReasoningFieldForModel(
  driver: string,
  model: string,
  capabilities: ModelCapabilities,
): OpenAICompatibleReasoningField | undefined {
  const interleaved = capabilities.interleaved;
  if (
    typeof interleaved === "object" &&
    interleaved !== null &&
    "field" in interleaved
  )
    return interleaved.field;
  if (interleaved === false) return undefined;
  // The fallback the compatible-OpenAI SDK applies: reasoning-style models on
  // this driver shape default to reasoning_content even when the catalog has no
  // explicit interleaved capability.
  const kind = driver.toLowerCase();
  if (
    !kind.includes("anthropic") &&
    !kind.includes("claude") &&
    !kind.includes("gemini") &&
    !kind.includes("google") &&
    model.toLowerCase().includes("deepseek")
  )
    return "reasoning_content";
  return undefined;
}

/**
 * Resolves a configured model reference into the same provider adapter used by
 * the runtime. The reference may be a canonical `"provider/model"` string or a
 * `{provider, model}` ref; unparsable refs, disabled providers and missing
 * credentials resolve to `undefined`. V3 dropped model variants, so a variant
 * name is accepted for call compatibility but never applied.
 */
export function providerForModel(
  config: ConfigV3,
  ref: ModelRef | string | null | undefined,
  _variantName?: string,
  requestOverride?: {
    reasoningEffort?: string;
    /** The T3 telemetry channel for this provider's diagnostics. */
    log?: ProviderDebugLog;
    /**
     * Stable session id, used only when the endpoint declares a cache key.
     * Per-session rather than global: each session, subagent and collaborator
     * stream needs its own key so their caches do not evict each other.
     */
    sessionID?: string;
  },
): StreamingProvider | undefined {
  if (!ref) return undefined;
  let modelRef: ModelRef;
  try {
    modelRef = typeof ref === "string" ? parseModelRef(ref) : ref;
  } catch {
    return undefined;
  }
  const status = modelSelectionStatus(config, modelRef);
  if (!status.selected) return undefined;
  const effective = resolveEffectiveModel(config, modelRef);
  const providerConfig = effective && config.providers[effective.providerID];
  if (!effective || !providerConfig?.connection?.apiKey) return undefined;
  return providerFromKind({
    // Keep the runtime provider identity stable: it is the adapter kind used
    // by runtime status, model metadata, and existing evaluator contracts.
    providerName: providerConfig.driver,
    provider: providerConfig.driver,
    // The declared wire format wins; `providerFromKind` resolves the fallback.
    format: providerConfig.protocol?.format,
    // Declared cache behaviour travels with the endpoint rather than being
    // guessed per adapter: which extensions this deployment accepts, and how
    // long its cache should be retained.
    capabilities: providerConfig.protocol?.capabilities,
    cacheRetention: providerConfig.protocol?.cacheRetention,
    sessionID: requestOverride?.sessionID,
    log: requestOverride?.log,
    apiKey: providerConfig.connection.apiKey,
    model: effective.ref.model,
    baseURL: providerConfig.connection.baseURL,
    maxTokens: effective.limits.maxOutputTokens ?? undefined,
    temperature: effective.requestDefaults.temperature ?? undefined,
    topP: effective.requestDefaults.topP ?? undefined,
    reasoningEffort:
      requestOverride?.reasoningEffort ??
      (typeof effective.requestDefaults.options.reasoningEffort === "string"
        ? effective.requestDefaults.options.reasoningEffort
        : undefined),
    thinkingEnabled: effective.capabilities.thinking
      ? effective.requestDefaults.thinkingEnabled
      : undefined,
    interleavedReasoningField: interleavedReasoningFieldForModel(
      providerConfig.driver,
      effective.ref.model,
      effective.capabilities,
    ),
    thinkingBudgetTokens:
      typeof effective.requestDefaults.options.thinkingBudgetTokens === "number"
        ? effective.requestDefaults.options.thinkingBudgetTokens
        : undefined,
    timeoutMs:
      config.runtime.timeouts.requestSec > 0
        ? config.runtime.timeouts.requestSec * 1000
        : undefined,
    streamIdleTimeoutMs:
      config.runtime.timeouts.streamIdleSec > 0
        ? config.runtime.timeouts.streamIdleSec * 1000
        : undefined,
  });
}

function chatCompletionsURL(baseURL: string) {
  return baseURL.endsWith("/chat/completions")
    ? baseURL
    : `${baseURL}/chat/completions`;
}

function messagesURL(baseURL: string) {
  return baseURL.endsWith("/messages") ? baseURL : `${baseURL}/messages`;
}

function anthropicThinkingRequest(
  requestedBudgetTokens: number | undefined,
  reasoningEffort: string | undefined,
  maxTokens: number,
) {
  // The plan's 20%-with-256-floor formula can produce invalid sub-1024 values
  // (for example, 819 for max_tokens 4096). Anthropic requires at least 1024,
  // so no-effort defaults deviate upward to 1024 whenever max_tokens permits.
  // Runtime effort is translated to a valid thinking budget, never forwarded as
  // Anthropic's unsupported reasoning_effort request field.
  const effortBudgetTokens =
    reasoningEffort === undefined
      ? 1024
      : anthropicThinkingBudgetForEffort(reasoningEffort);
  const budgetTokens =
    requestedBudgetTokens ?? Math.min(effortBudgetTokens, maxTokens - 1);
  if (
    !Number.isInteger(budgetTokens) ||
    budgetTokens < 1024 ||
    budgetTokens >= maxTokens
  )
    throw new RangeError(
      `Anthropic thinking requires an integer budget_tokens >= 1024 and < max_tokens (${maxTokens}); received ${budgetTokens}.`,
    );
  return { type: "enabled" as const, budget_tokens: budgetTokens };
}

function anthropicThinkingBudgetForEffort(reasoningEffort: string) {
  switch (reasoningEffort) {
    case "minimal":
      return 1024;
    case "low":
      return 2048;
    case "medium":
      return 4096;
    case "high":
      return 8192;
    case "xhigh":
      return 16384;
    default:
      throw new RangeError(
        `Unsupported Anthropic reasoning effort ${JSON.stringify(reasoningEffort)}.`,
      );
  }
}

function modelsURL(baseURL: string) {
  const url = new URL(baseURL);
  url.pathname =
    url.pathname
      .replace(/\/(?:chat\/completions|messages)$/u, "")
      .replace(/\/$/u, "") + "/models";
  return url.toString();
}

function isLocalProviderURL(baseURL: string) {
  try {
    const hostname = new URL(baseURL).hostname;
    return (
      hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
    );
  } catch {
    return false;
  }
}

type AnthropicStreamChunk = {
  type?: string;
  index?: number;
  delta?: {
    text?: string;
    thinking?: string;
    reasoning_content?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string | null;
    type?: string;
  };
  content_block?: {
    id?: string;
    name?: string;
    type?: string;
    thinking?: string;
    reasoning_content?: string;
    data?: string;
    signature?: string;
  };
  choices?: Array<{
    delta?: { reasoning_content?: string; content?: string };
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
};

type GeminiStreamChunk = {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        thoughtSignature?: string;
        thought_signature?: string;
        functionCall?: { name?: string; args?: Record<string, unknown> };
      }>;
    };
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

type OpenAIChatCompletion = {
  usage?: OpenAIRawUsage;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
};

/**
 * The usage fields an OpenAI-compatible endpoint reports.
 *
 * `prompt_tokens_details.cached_tokens` is the only cache signal this family
 * emits: OpenAI caches a matching prefix implicitly and bills no write, so the
 * read is the whole story and `cacheCreationInputTokens` stays absent.
 */
type OpenAIRawUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
};

/**
 * Map OpenAI-compatible usage into the provider-neutral chunk.
 *
 * Both the streaming and buffered paths go through here so they cannot drift:
 * a session whose usage is read by one path and not the other would report a
 * hit rate that depends on which code path happened to serve the request.
 */
function openAIUsageChunk(usage: OpenAIRawUsage): ProviderStreamChunk {
  const cached = usage.prompt_tokens_details?.cached_tokens;
  return {
    type: "usage",
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    ...(cached === undefined ? {} : { cacheReadInputTokens: cached }),
  };
}

type OpenAIStreamChunk = {
  usage?: OpenAIRawUsage | null;
  choices?: Array<{
    recipient?: string;
    function_call?: { name?: string; arguments?: string };
    message?: {
      recipient?: string;
      function_call?: { name?: string; arguments?: string };
    };
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      reasoning_text?: string;
      reasoning_details?: unknown;
      reasoning_opaque?: string;
      // Some OpenAI-compatible gateways use the older single-function shape
      // or the ChatGPT recipient field instead of tool_calls[].function.
      recipient?: string;
      function_call?: { name?: string; arguments?: string };
      tool_calls?: Array<{
        index: number;
        id?: string;
        name?: string;
        recipient?: string;
        tool_name?: string;
        function_name?: string;
        function?: { name?: string; arguments?: string } | string;
        function_call?: { name?: string; arguments?: string };
        tool?: { name?: string };
        arguments?: string;
        input?: string;
      }>;
    };
    finish_reason?: string | null;
  }>;
};

async function* streamOpenAISSE(
  body: ReadableStream<Uint8Array>,
  streamIdleTimeoutMs?: number,
): AsyncIterable<ProviderStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, ProviderToolCall>();
  const pendingReasoningDetails = new Map<string, string>();
  const reasoningDetails: OpenAIReasoningDetail[] = [];
  const completion: { finishReason?: ProviderFinishReason } = {};
  let buffer = "";
  while (true) {
    const next = await readWithIdleTimeout(reader, streamIdleTimeoutMs);
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      yield* parseSSEChunks(
        part,
        toolCalls,
        completion,
        pendingReasoningDetails,
        reasoningDetails,
      );
    }
  }
  if (buffer) {
    yield* parseSSEChunks(
      buffer,
      toolCalls,
      completion,
      pendingReasoningDetails,
      reasoningDetails,
    );
  }
  if (toolCalls.size)
    yield { type: "tool_call", calls: [...toolCalls.values()] };
  yield {
    type: "done",
    finishReason: completion.finishReason,
    ...(reasoningDetails.length
      ? {
          providerMetadata: {
            openrouter: { reasoning_details: reasoningDetails },
          },
        }
      : {}),
  };
}

async function* streamAnthropicSSE(
  body: ReadableStream<Uint8Array>,
  streamIdleTimeoutMs?: number,
  /** The T3 telemetry channel, threaded down to the SSE parser. */
  log?: ProviderDebugLog,
): AsyncIterable<ProviderStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: AnthropicSSEState = {
    blockTypes: new Map(),
    toolCalls: new Map(),
    nextBlockIndex: 0,
  };
  let buffer = "";
  while (true) {
    const next = await readWithIdleTimeout(reader, streamIdleTimeoutMs);
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/u);
    buffer = parts.pop() ?? "";
    for (const part of parts) yield* parseAnthropicSSEPart(part, state, log);
  }
  buffer += decoder.decode();
  if (buffer) {
    yield* parseAnthropicSSEPart(buffer, state, log);
  }
  if (state.toolCalls.size)
    yield { type: "tool_call", calls: [...state.toolCalls.values()] };
  yield { type: "done", finishReason: state.finishReason };
}

type AnthropicSSEState = {
  blockTypes: Map<number, string | undefined>;
  toolCalls: Map<number, ProviderToolCall>;
  currentBlockIndex?: number;
  nextBlockIndex: number;
  finishReason?: ProviderFinishReason;
};

function parseAnthropicSSEPart(
  part: string,
  state: AnthropicSSEState,
  /** The T3 telemetry channel, threaded to the SSE debug record. */
  log?: ProviderDebugLog,
): ProviderStreamChunk[] {
  const chunks: ProviderStreamChunk[] = [];
  for (const line of part.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    const parsed = JSON.parse(data) as AnthropicStreamChunk;
    // Was an env gate; now the log's level gate (T3).
    log?.debug("[provider]", "anthropic SSE", {
      eventType: parsed.type,
      index: parsed.index,
      contentBlockType: parsed.content_block?.type,
      contentBlockKeys: Object.keys(parsed.content_block ?? {}),
      deltaKeys: Object.keys(parsed.delta ?? {}),
      choiceDeltaKeys: Object.keys(parsed.choices?.[0]?.delta ?? {}),
      usageKeys: Object.keys(parsed.usage ?? parsed.message?.usage ?? {}),
    });
    if (parsed.delta?.stop_reason)
      state.finishReason = normalizeAnthropicFinishReason(
        parsed.delta.stop_reason,
        state.toolCalls.size > 0,
      );

    if (parsed.type === "content_block_start") {
      const index = parsed.index ?? state.nextBlockIndex;
      state.nextBlockIndex = Math.max(state.nextBlockIndex, index + 1);
      state.currentBlockIndex = index;
      const block = parsed.content_block;
      state.blockTypes.set(index, block?.type);
      if (block?.type === "tool_use")
        state.toolCalls.set(index, {
          id: block.id ?? `tool_${index}`,
          name: block.name ?? "",
          arguments: "",
        });
      const initialThinking = block?.thinking ?? block?.reasoning_content;
      if (initialThinking)
        chunks.push({
          type: "thinking",
          text: initialThinking,
          blockIndex: index,
        });
      if (block?.type === "redacted_thinking" && block.data)
        chunks.push({
          type: "thinking",
          text: "",
          signature: block.data,
          redacted: true,
          blockIndex: index,
        });
    }

    const index = parsed.index ?? state.currentBlockIndex;
    const deltaThinking =
      parsed.delta?.thinking ??
      parsed.delta?.reasoning_content ??
      parsed.choices?.[0]?.delta?.reasoning_content;
    if (deltaThinking)
      chunks.push({
        type: "thinking",
        text: deltaThinking,
        ...(index !== undefined ? { blockIndex: index } : {}),
      });
    if (parsed.delta?.signature)
      chunks.push({
        type: "thinking",
        text: "",
        signature: parsed.delta.signature,
        ...(index !== undefined ? { blockIndex: index } : {}),
      });
    if (parsed.delta?.text)
      chunks.push({ type: "content", text: parsed.delta.text });
    if (parsed.choices?.[0]?.delta?.content)
      chunks.push({ type: "content", text: parsed.choices[0].delta.content });
    // `partial_json` is meaningful only for a tool_use block. Thinking blocks
    // can emit other delta types, so never append their bytes to tool arguments.
    if (
      parsed.delta?.partial_json &&
      index !== undefined &&
      state.blockTypes.get(index) === "tool_use"
    ) {
      const current = state.toolCalls.get(index);
      if (current)
        state.toolCalls.set(index, {
          ...current,
          arguments: `${current.arguments}${parsed.delta.partial_json}`,
        });
    }

    const usage = parsed.usage ?? parsed.message?.usage;
    if (usage?.input_tokens !== undefined || usage?.output_tokens !== undefined)
      chunks.push({
        type: "usage",
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        ...(usage.cache_creation_input_tokens !== undefined
          ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
          : {}),
        ...(usage.cache_read_input_tokens !== undefined
          ? { cacheReadInputTokens: usage.cache_read_input_tokens }
          : {}),
      });
  }
  return chunks;
}

async function* streamGeminiSSE(
  body: ReadableStream<Uint8Array>,
  streamIdleTimeoutMs?: number,
): AsyncIterable<ProviderStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finishReason: ProviderFinishReason | undefined;
  while (true) {
    const next = await readWithIdleTimeout(reader, streamIdleTimeoutMs);
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice("data:".length).trim();
        if (!data || data === "[DONE]") continue;
        const parsed = JSON.parse(data) as GeminiStreamChunk;
        if (parsed.candidates?.[0]?.finishReason)
          finishReason = normalizeGeminiFinishReason(
            parsed.candidates[0].finishReason,
          );
        const calls: ProviderToolCall[] = [];
        for (const [partIndex, part] of (
          parsed.candidates?.[0]?.content?.parts ?? []
        ).entries()) {
          if (part.thought) {
            const signature = part.thoughtSignature ?? part.thought_signature;
            if (part.text || signature)
              yield {
                type: "thinking",
                text: part.text ?? "",
                ...(signature ? { signature } : {}),
                blockIndex: partIndex,
              };
            continue;
          }
          const textSignature = part.thoughtSignature ?? part.thought_signature;
          if (!part.functionCall?.name && (part.text || textSignature))
            yield {
              type: "content",
              text: part.text ?? "",
              ...(textSignature ? { textSignature } : {}),
            };
          if (part.functionCall?.name) {
            const signature = part.thoughtSignature ?? part.thought_signature;
            calls.push({
              id: `gemini_${calls.length}`,
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
              ...(signature ? { thoughtSignature: signature } : {}),
            });
          }
        }
        if (calls.length) yield { type: "tool_call", calls };
        if (parsed.usageMetadata)
          yield {
            type: "usage",
            inputTokens: parsed.usageMetadata.promptTokenCount ?? 0,
            outputTokens: parsed.usageMetadata.candidatesTokenCount ?? 0,
          };
      }
    }
  }
  if (buffer) {
    const parsed = parseGeminiSSEPart(buffer);
    for (const chunk of parsed.chunks) yield chunk;
    finishReason = parsed.finishReason ?? finishReason;
  }
  yield { type: "done", finishReason };
}

function parseGeminiSSEPart(part: string): {
  chunks: ProviderStreamChunk[];
  finishReason?: ProviderFinishReason;
} {
  const chunks: ProviderStreamChunk[] = [];
  let finishReason: ProviderFinishReason | undefined;
  for (const line of part.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    const parsed = JSON.parse(data) as GeminiStreamChunk;
    if (parsed.candidates?.[0]?.finishReason)
      finishReason = normalizeGeminiFinishReason(
        parsed.candidates[0].finishReason,
      );
    const calls: ProviderToolCall[] = [];
    for (const [partIndex, part] of (
      parsed.candidates?.[0]?.content?.parts ?? []
    ).entries()) {
      if (part.thought) {
        const signature = part.thoughtSignature ?? part.thought_signature;
        if (part.text || signature)
          chunks.push({
            type: "thinking",
            text: part.text ?? "",
            ...(signature ? { signature } : {}),
            blockIndex: partIndex,
          });
        continue;
      }
      const textSignature = part.thoughtSignature ?? part.thought_signature;
      if (!part.functionCall?.name && (part.text || textSignature))
        chunks.push({
          type: "content",
          text: part.text ?? "",
          ...(textSignature ? { textSignature } : {}),
        });
      if (part.functionCall?.name) {
        const signature = part.thoughtSignature ?? part.thought_signature;
        calls.push({
          id: `gemini_${calls.length}`,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
          ...(signature ? { thoughtSignature: signature } : {}),
        });
      }
    }
    if (calls.length) chunks.push({ type: "tool_call", calls });
    if (parsed.usageMetadata)
      chunks.push({
        type: "usage",
        inputTokens: parsed.usageMetadata.promptTokenCount ?? 0,
        outputTokens: parsed.usageMetadata.candidatesTokenCount ?? 0,
      });
  }
  return { chunks, finishReason };
}

type OpenAIReasoningDetail = Record<string, unknown> & { type?: string };

type OpenAIEncryptedReasoningDetail = OpenAIReasoningDetail & {
  type: "reasoning.encrypted";
  id: string;
  data: string;
};

function isOpenAIReasoningDetail(
  value: unknown,
): value is OpenAIReasoningDetail {
  return typeof value === "object" && value !== null;
}

function collectOpenAIReasoningDetails(
  value: unknown,
): OpenAIReasoningDetail[] {
  return Array.isArray(value) ? value.filter(isOpenAIReasoningDetail) : [];
}

function isOpenAIEncryptedReasoningDetail(
  value: unknown,
): value is OpenAIEncryptedReasoningDetail {
  if (!isOpenAIReasoningDetail(value)) return false;
  return (
    value.type === "reasoning.encrypted" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.data === "string" &&
    value.data.length > 0
  );
}

function accumulateOpenAIReasoningDetails(
  existing: OpenAIReasoningDetail[],
  incoming: OpenAIReasoningDetail[],
) {
  for (const detail of incoming) {
    if (
      detail.type === "reasoning.text" &&
      existing.at(-1)?.type === "reasoning.text"
    ) {
      const previous = existing.at(-1)!;
      previous.text = `${typeof previous.text === "string" ? previous.text : ""}${typeof detail.text === "string" ? detail.text : ""}`;
      previous.signature ??= detail.signature;
      previous.format ??= detail.format;
      continue;
    }
    existing.push({ ...detail });
  }
  return existing;
}

function applyEncryptedReasoningDetails(
  details: OpenAIEncryptedReasoningDetail[],
  toolCalls: Map<number, ProviderToolCall>,
  pendingReasoningDetails: Map<string, string>,
) {
  for (const detail of details) {
    const serialized = JSON.stringify(detail);
    let matched = false;
    for (const [index, call] of toolCalls) {
      if (call.id !== detail.id) continue;
      toolCalls.set(index, { ...call, thoughtSignature: serialized });
      matched = true;
      break;
    }
    if (!matched) pendingReasoningDetails.set(detail.id, serialized);
  }
}

function attachPendingReasoningDetail(
  call: ProviderToolCall,
  pendingReasoningDetails: Map<string, string>,
) {
  const signature = pendingReasoningDetails.get(call.id);
  if (!signature) return call;
  pendingReasoningDetails.delete(call.id);
  return { ...call, thoughtSignature: signature };
}

function parseSSEChunks(
  part: string,
  toolCalls: Map<number, ProviderToolCall>,
  completion: { finishReason?: ProviderFinishReason },
  pendingReasoningDetails: Map<string, string>,
  reasoningDetails: OpenAIReasoningDetail[],
): ProviderStreamChunk[] {
  const chunks: ProviderStreamChunk[] = [];
  for (const line of part.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    const parsed = JSON.parse(data) as OpenAIStreamChunk;
    if (parsed.usage) chunks.push(openAIUsageChunk(parsed.usage));
    const choice = parsed.choices?.[0];
    if (choice?.finish_reason)
      completion.finishReason = normalizeOpenAIFinishReason(
        choice.finish_reason,
        toolCalls.size > 0,
      );
    const delta = choice?.delta;
    const reasoningFields = [
      ["reasoning_content", delta?.reasoning_content],
      ["reasoning", delta?.reasoning],
      ["reasoning_text", delta?.reasoning_text],
    ] as const;
    const reasoning = reasoningFields.find(
      ([, value]) => typeof value === "string" && value.length > 0,
    );
    if (reasoning)
      chunks.push({
        type: "thinking",
        text: reasoning[1]!,
        field: reasoning[0],
      });
    if (delta?.reasoning_opaque)
      chunks.push({
        type: "thinking",
        text: "",
        // Copilot's reasoning_opaque is attached to the reasoning_text field
        // and must be replayed together with that text on the next request.
        field: "reasoning_text",
        signature: delta.reasoning_opaque,
      });
    const details = collectOpenAIReasoningDetails(delta?.reasoning_details);
    if (details.length) {
      accumulateOpenAIReasoningDetails(reasoningDetails, details);
      const encryptedDetails = details.filter(isOpenAIEncryptedReasoningDetail);
      if (encryptedDetails.length)
        applyEncryptedReasoningDetails(
          encryptedDetails,
          toolCalls,
          pendingReasoningDetails,
        );
    }
    const legacyRecipient =
      delta?.recipient ?? choice?.recipient ?? choice?.message?.recipient;
    const legacyFunction =
      delta?.function_call ??
      choice?.function_call ??
      choice?.message?.function_call;
    if (
      legacyRecipient ||
      legacyFunction ||
      (toolCalls.size > 0 && delta?.content)
    ) {
      const current = toolCalls.get(0) ?? {
        id: `tool_0`,
        name: "",
        arguments: "",
      };
      const recipient = normalizeToolRecipient(legacyRecipient);
      toolCalls.set(
        0,
        attachPendingReasoningDetail(
          {
            id: current.id,
            name:
              normalizeToolRecipient(legacyFunction?.name) ??
              recipient ??
              current.name,
            arguments: `${current.arguments}${legacyFunction?.arguments ?? delta?.content ?? ""}`,
          },
          pendingReasoningDetails,
        ),
      );
      if (
        (choice?.finish_reason === "tool_calls" ||
          choice?.finish_reason === "function_call") &&
        toolCalls.size
      ) {
        const calls = [...toolCalls.values()];
        toolCalls.clear();
        chunks.push({ type: "tool_call", calls });
      }
      continue;
    }
    if (delta?.tool_calls) {
      for (const call of delta.tool_calls) {
        const current = toolCalls.get(call.index) ?? {
          id: call.id ?? `tool_${call.index}`,
          name: "",
          arguments: "",
        };
        const name = toolNameFromGatewayCall(call);
        toolCalls.set(
          call.index,
          attachPendingReasoningDetail(
            {
              id: call.id ?? current.id,
              name: name ?? current.name,
              arguments: `${current.arguments}${toolArgumentsFromGatewayCall(call)}`,
            },
            pendingReasoningDetails,
          ),
        );
      }
      if (choice?.finish_reason === "tool_calls" && toolCalls.size) {
        const calls = [...toolCalls.values()];
        toolCalls.clear();
        chunks.push({ type: "tool_call", calls });
      }
      continue;
    }
    if (delta?.content) chunks.push({ type: "content", text: delta.content });
  }
  return chunks;
}

function normalizeOpenAIFinishReason(
  reason: string | null | undefined,
  hasToolCalls: boolean,
): ProviderFinishReason | undefined {
  if (hasToolCalls || reason === "tool_calls" || reason === "function_call")
    return "tool_calls";
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  if (reason === "content_filter") return "content_filter";
  return reason ? "unknown" : undefined;
}

function normalizeAnthropicFinishReason(
  reason: string,
  hasToolCalls: boolean,
): ProviderFinishReason {
  if (hasToolCalls || reason === "tool_use") return "tool_calls";
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "max_tokens") return "length";
  if (reason === "refusal") return "content_filter";
  return "unknown";
}

function normalizeGeminiFinishReason(reason: string): ProviderFinishReason {
  if (reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "SAFETY" || reason === "RECITATION") return "content_filter";
  if (reason === "MALFORMED_FUNCTION_CALL" || reason === "OTHER")
    return "error";
  return "unknown";
}

function normalizeToolRecipient(recipient: string | undefined) {
  if (!recipient) return undefined;
  for (const prefix of ["functions.", "function.", "tools."])
    if (recipient.startsWith(prefix)) return recipient.slice(prefix.length);
  return recipient;
}

function toolNameFromGatewayCall(call: {
  name?: string;
  recipient?: string;
  tool_name?: string;
  function_name?: string;
  function?: { name?: string; arguments?: string } | string;
  function_call?: { name?: string; arguments?: string };
  tool?: { name?: string };
}) {
  return (
    normalizeToolRecipient(
      typeof call.function === "object" ? call.function.name : call.function,
    ) ??
    normalizeToolRecipient(call.function_call?.name) ??
    normalizeToolRecipient(call.name) ??
    normalizeToolRecipient(call.recipient) ??
    normalizeToolRecipient(call.tool_name) ??
    normalizeToolRecipient(call.function_name) ??
    normalizeToolRecipient(call.tool?.name)
  );
}

function toolArgumentsFromGatewayCall(call: {
  function?: { arguments?: string } | string;
  function_call?: { arguments?: string };
  arguments?: string;
  input?: string;
}) {
  if (typeof call.function === "object" && call.function.arguments)
    return call.function.arguments;
  return call.function_call?.arguments ?? call.arguments ?? call.input ?? "";
}

function openAIReasoningField(
  message: ProviderMessage,
  interleavedReasoningField?: OpenAICompatibleReasoningField,
) {
  if (message.reasoningField && message.reasoningField.length > 0)
    return message.reasoningField;
  return interleavedReasoningField ?? "reasoning_content";
}

/**
 * OpenAI-compatible interleaved providers (DeepSeek is the canonical example)
 * require the reasoning field on every assistant message, even when it is
 * empty. This is deliberately separate from `reasoningContent` because an
 * absent value is not the same as an empty string to these APIs.
 */
function openAIReasoningEntry(
  message: ProviderMessage,
  interleavedReasoningField?: OpenAICompatibleReasoningField,
) {
  if (message.role !== "assistant") return {};
  if (
    message.reasoningContent === undefined &&
    !interleavedReasoningField &&
    !message.reasoningField
  )
    return {};
  return {
    [openAIReasoningField(message, interleavedReasoningField)]:
      message.reasoningContent ?? "",
  };
}

function openAIReasoningPayload(
  message: ProviderMessage,
  interleavedReasoningField?: OpenAICompatibleReasoningField,
) {
  const entry = openAIReasoningEntry(message, interleavedReasoningField);
  if (message.reasoningField === "reasoning_text" && message.reasoningSignature)
    return { ...entry, reasoning_opaque: message.reasoningSignature };
  return entry;
}

function openAIReasoningDetails(calls: ProviderToolCall[]) {
  const details: OpenAIEncryptedReasoningDetail[] = [];
  for (const call of calls) {
    if (!call.thoughtSignature) continue;
    try {
      const parsed = JSON.parse(call.thoughtSignature) as unknown;
      if (isOpenAIEncryptedReasoningDetail(parsed)) details.push(parsed);
    } catch {
      // Other providers use thoughtSignature for non-JSON opaque values.
    }
  }
  return details;
}

function openAIProviderReasoningDetails(message: ProviderMessage) {
  const metadata = message.providerMetadata as
    | { openrouter?: { reasoning_details?: unknown } }
    | undefined;
  const details = metadata?.openrouter?.reasoning_details;
  return Array.isArray(details) && details.length ? details : undefined;
}

function toOpenAIMessage(
  message: ProviderMessage,
  interleavedReasoningField?: OpenAICompatibleReasoningField,
) {
  const providerReasoningDetails = openAIProviderReasoningDetails(message);
  const reasoning = providerReasoningDetails
    ? {}
    : openAIReasoningPayload(message, interleavedReasoningField);
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallID,
      content: message.content,
    };
  }
  if (message.toolCalls?.length) {
    const reasoningDetails =
      providerReasoningDetails ?? openAIReasoningDetails(message.toolCalls);
    return {
      role: "assistant",
      content: message.content || null,
      ...reasoning,
      ...(reasoningDetails.length
        ? { reasoning_details: reasoningDetails }
        : {}),
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  if (message.images?.length)
    return {
      role: message.role,
      content: [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...(message.images ?? []).map((image) => ({
          type: "image_url",
          image_url: { url: materializedDataURL(image) },
        })),
      ],
      ...reasoning,
      ...(providerReasoningDetails
        ? { reasoning_details: providerReasoningDetails }
        : {}),
    };
  return {
    role: message.role,
    content: message.content,
    ...reasoning,
    ...(providerReasoningDetails
      ? { reasoning_details: providerReasoningDetails }
      : {}),
  };
}

function anthropicReasoningBlocks(
  message: ProviderMessage,
): Array<Record<string, unknown>> {
  if (message.reasoningBlocks?.length) {
    return message.reasoningBlocks.flatMap(
      (block): Array<Record<string, unknown>> => {
        if (block.redacted && block.signature)
          return [
            {
              type: "redacted_thinking",
              data: block.signature,
            },
          ];
        if (block.signature)
          return [
            {
              type: "thinking",
              thinking: block.text ?? "",
              signature: block.signature,
            },
          ];
        return block.text ? [{ type: "text", text: block.text }] : [];
      },
    );
  }
  if (!message.reasoningSignature) return [];
  if (message.reasoningRedacted)
    return [
      {
        type: "redacted_thinking" as const,
        data: message.reasoningSignature,
      },
    ];
  return [
    {
      type: "thinking" as const,
      thinking: message.reasoningContent ?? "",
      signature: message.reasoningSignature,
    },
  ];
}

function anthropicContentParts(
  message: ProviderMessage,
): Array<Record<string, unknown>> | undefined {
  if (!message.contentParts?.length) return undefined;
  return message.contentParts.flatMap(
    (part): Array<Record<string, unknown>> => {
      if (part.type === "text") return [{ type: "text", text: part.text }];
      if (part.type === "thinking") {
        if (part.redacted && part.signature)
          return [{ type: "redacted_thinking", data: part.signature }];
        if (part.signature)
          return [
            {
              type: "thinking",
              thinking: part.text ?? "",
              signature: part.signature,
            },
          ];
        return part.text ? [{ type: "text", text: part.text }] : [];
      }
      return [
        {
          type: "tool_use",
          id: part.id,
          name: part.name,
          input: safeJSON(part.arguments),
        },
      ];
    },
  );
}

/** Content block types an Anthropic cache breakpoint may sit on. */
const ANTHROPIC_CACHEABLE_BLOCKS = new Set([
  "text",
  "image",
  "tool_result",
  "tool_addition",
  "tool_removal",
]);

/**
 * Mark the last message of a conversation with a cache breakpoint, in place.
 *
 * Anthropic writes a cache entry only where a `cache_control` marker sits, so a
 * request whose breakpoints are all in the header caches nothing of the
 * conversation — every turn re-bills the whole history. Marking the final
 * message extends the cached prefix over it.
 *
 * Only the last message, and only on a block type the API accepts the marker on.
 * A trailing message that cannot carry one is simply left unmarked rather than
 * moved: the header breakpoints still cover the stable part.
 */
function markConversationBreakpoint(
  messages: Array<{
    role: string;
    content: unknown;
  }>,
  cacheControl: { type: "ephemeral"; ttl?: "1h" } | undefined,
): void {
  if (!cacheControl || messages.length === 0) return;
  const last = messages[messages.length - 1]!;
  if (last.role !== "user" && last.role !== "assistant") return;
  if (Array.isArray(last.content)) {
    const lastBlock = last.content[last.content.length - 1] as
      | { type?: string; cache_control?: unknown }
      | undefined;
    if (!lastBlock || !ANTHROPIC_CACHEABLE_BLOCKS.has(lastBlock.type ?? ""))
      return;
    lastBlock.cache_control = cacheControl;
    return;
  }
  // A bare string has no block to mark, so it becomes one. The conversion above
  // only yields a string when the message carried nothing else.
  last.content = [
    { type: "text", text: last.content, cache_control: cacheControl },
  ];
}

function toAnthropicMessage(message: ProviderMessage) {
  if (message.role === "tool")
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.toolCallID,
          content: message.content,
        },
      ],
    };
  const contentParts = anthropicContentParts(message);
  if (message.toolCalls?.length) {
    const reasoning = anthropicReasoningBlocks(message);
    return {
      role: "assistant",
      content: contentParts ?? [
        ...reasoning,
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...message.toolCalls.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: safeJSON(call.arguments),
        })),
      ],
    };
  }
  const reasoning = anthropicReasoningBlocks(message);
  const content = contentParts ?? [
    ...reasoning,
    ...(message.content ? [{ type: "text", text: message.content }] : []),
    ...(message.images ?? []).map((image) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mediaType,
        data: dataURLPayload(materializedDataURL(image)),
      },
    })),
  ];
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content:
      message.images?.length || content.length ? content : message.content,
  };
}

function geminiContentParts(
  message: ProviderMessage,
): Array<Record<string, unknown>> | undefined {
  if (!message.contentParts?.length) return undefined;
  return message.contentParts.map((part) => {
    if (part.type === "text")
      return {
        text: part.text,
        ...(part.textSignature ? { thoughtSignature: part.textSignature } : {}),
      };
    if (part.type === "thinking")
      return {
        thought: true,
        text: part.text ?? "",
        ...(part.signature ? { thoughtSignature: part.signature } : {}),
      };
    return {
      functionCall: { name: part.name, args: safeJSON(part.arguments) },
      ...(part.thoughtSignature
        ? { thoughtSignature: part.thoughtSignature }
        : {}),
    };
  });
}

function geminiReasoningParts(
  message: ProviderMessage,
): Array<Record<string, unknown>> {
  if (message.reasoningBlocks?.length)
    return message.reasoningBlocks
      .filter((block) => block.text !== undefined || block.signature)
      .map((block) => ({
        thought: true,
        text: block.text ?? "",
        ...(block.signature ? { thoughtSignature: block.signature } : {}),
      }));
  if (message.reasoningContent || message.reasoningSignature)
    return [
      {
        thought: true,
        text: message.reasoningContent ?? "",
        ...(message.reasoningSignature
          ? { thoughtSignature: message.reasoningSignature }
          : {}),
      },
    ];
  return [];
}

function toGeminiContent(message: ProviderMessage) {
  const role = message.role === "assistant" ? "model" : "user";
  const contentParts = geminiContentParts(message);
  if (message.toolCalls?.length)
    return {
      role: "model",
      parts: contentParts ?? [
        ...geminiReasoningParts(message),
        ...(message.content || message.textSignature
          ? [
              {
                text: message.content,
                ...(message.textSignature
                  ? { thoughtSignature: message.textSignature }
                  : {}),
              },
            ]
          : []),
        ...message.toolCalls.map((call) => ({
          functionCall: { name: call.name, args: safeJSON(call.arguments) },
          ...(call.thoughtSignature
            ? { thoughtSignature: call.thoughtSignature }
            : {}),
        })),
      ],
    };
  if (message.role === "tool")
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: message.toolName ?? message.toolCallID,
            response: { content: message.content },
          },
        },
      ],
    };
  return {
    role,
    parts: [
      ...(contentParts ?? [
        ...geminiReasoningParts(message),
        ...(message.content || message.textSignature
          ? [
              {
                text: message.content,
                ...(message.textSignature
                  ? { thoughtSignature: message.textSignature }
                  : {}),
              },
            ]
          : []),
      ]),
      ...(message.images?.map((image) => ({
        inlineData: {
          mimeType: image.mediaType,
          data: dataURLPayload(materializedDataURL(image)),
        },
      })) ?? []),
      ...(message.videos?.map((video) => ({
        inlineData: {
          mimeType: video.mediaType,
          data: dataURLPayload(materializedDataURL(video)),
        },
      })) ?? []),
    ],
  };
}

function materializedDataURL(attachment: ProviderAttachment): string {
  if (attachmentHasInlineDataURL(attachment)) return attachment.dataURL;
  throw new Error("provider attachment was not materialized");
}

function dataURLPayload(value: string) {
  const marker = ";base64,";
  const index = value.indexOf(marker);
  if (index < 0) throw new Error("attachment data URL is not base64 encoded");
  return value.slice(index + marker.length);
}

function safeJSON(input: string) {
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return { value: input };
  }
}

export async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs?: number,
) {
  if (!timeoutMs) return await reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void reader.cancel().catch(() => undefined);
          reject(
            providerError({
              kind: "timeout",
              message: `provider stream idle timeout after ${timeoutMs}ms`,
            }),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeResponseText(response: Response) {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unavailable>";
  }
}

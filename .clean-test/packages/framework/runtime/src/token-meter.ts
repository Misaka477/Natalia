/**
 * Shared request/surface token accounting used by compaction and context UI.
 *
 * The estimator is intentionally simple and deterministic: four characters per
 * token plus small structural overhead. Provider usage, when available, anchors
 * the current request; surface movement since that sample is repriced with the
 * same heuristic so compaction and context occupancy stay on one account.
 */

export const TOKEN_METER_CHARS_PER_TOKEN = 4;
export const TOKEN_METER_BLOCK_OVERHEAD = 4;
export const TOKEN_METER_ROLE_OVERHEAD = 4;

/**
 * Pixels per token for vision input, from the providers' published vision
 * accounting (Anthropic bills roughly width × height / 750). A meter that
 * ignored dimensions entirely would read a 5 MiB screenshot as zero and never
 * fire compaction, which is the bug this exists to fix.
 */
export const TOKEN_METER_IMAGE_PIXELS_PER_TOKEN = 750;

/**
 * Assumed cost of one image whose dimensions are unknown.
 *
 * Sits above the largest image that can reach the meter after admission-time
 * scaling: with the default 1568px long-edge limit the maximum area is
 * 1568² ≈ 2.46 MP, which prices at ~3.3k tokens. A constant below that would
 * price a dimension-less image cheaper than a known large one, which is the
 * under-counting this whole estimator exists to prevent. Unknown dimensions are
 * the legacy inline-attachment path; scaled attachments always carry theirs.
 */
export const TOKEN_METER_IMAGE_UNKNOWN_TOKENS = 4096;

/**
 * The dimension facts the meter needs from an image attachment.
 *
 * `mediaType` is declared only so a legacy inline attachment — which carries a
 * media type and a data URL but no dimensions — is assignable here. Without a
 * shared property TypeScript's weak-type check rejects it, and every call site
 * would need its own mapping that could later drop the dimensions by accident.
 */
export interface TokenMeterImage {
  readonly width?: number;
  readonly height?: number;
  readonly mediaType?: string;
}

/**
 * A provider-reported usage sample.
 *
 * The cache field names match the wire spelling every other layer uses
 * (`ProviderStreamChunk`, `ProviderUsage`, `SessionUsageStats`). They were once
 * `cacheReadTokens` / `cacheWriteTokens`, which made `ProviderUsage` silently
 * assignable to this type while dropping both fields — TypeScript allows it
 * because the required fields agree and these are optional, so the cache read
 * vanished at the boundary and the meter under-counted every cached request.
 * One vocabulary is the only defence against that.
 */
export interface ProviderUsageView {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface TokenMeterMessage {
  role?: string;
  content?: string | readonly unknown[];
  toolCalls?: readonly {
    id?: string;
    name?: string;
    arguments?: string;
    thoughtSignature?: string;
  }[];
  toolName?: string;
  toolCallID?: string;
  /**
   * Image and video attachments on the message. Carried separately from
   * `content` because the providers put them in their own content blocks, so a
   * meter that only reads `content` would price a screenshot at nothing.
   */
  images?: readonly TokenMeterImage[];
  videos?: readonly TokenMeterImage[];
}

/**
 * Canonical provider request envelope shared by compaction, token metering and
 * the runtime status/snapshot surfaces. The hard rule is that `system` and
 * `tools` live only in the header, never duplicated into `messages`, so the
 * three-bucket accounting (system / tools / messages) stays additive and every
 * path derives the same header key from the same envelope.
 */
export interface RequestEnvelope {
  /** Static/runtime system prompt. Counted once in the header only. */
  system?: string;
  /** Tool definitions advertised for this request. Counted once in the header. */
  tools?: unknown;
  /** Model-visible message/tool surface with the system prompt removed. */
  messages: readonly TokenMeterMessage[];
  /** Capacity of the route/model selected for this scope. */
  contextWindow?: number;
}

/**
 * Stable identity of a request header (system + tools). Both `recordUsage` and
 * `measureRequest` derive this from the same envelope so a provider usage
 * sample is only reused when the header it priced is still current, and the
 * system prompt is never double-counted between header and messages.
 */
export function requestHeaderKey(input: {
  system?: string;
  tools?: unknown;
}): string {
  return JSON.stringify({
    system: input.system ?? "",
    tools: input.tools ?? null,
  });
}

export interface TokenMeasurement {
  /** Heuristic tokens for the system prompt alone. */
  systemTokens: number;
  /** Heuristic tokens for the tool definitions alone. */
  toolsTokens: number;
  /** Heuristic tokens for the model-visible message/tool surface. */
  messageTokens: number;
  /** systemTokens + toolsTokens. */
  headerTokens: number;
  /** Conservative request total: header plus model-visible surface. */
  totalTokens: number;
  /** Provider prompt-side sample: input plus cache reads/writes. */
  pressureTokens?: number;
  /**
   * Provider sample carried forward over surface movement since it was taken.
   * Present only after a provider usage sample and a surface observation.
   */
  projectedTokens?: number;
  /** Capacity of the route/model selected for this scope. */
  contextWindow?: number;
  source: "estimate" | "provider_usage";
}

interface ScopeState {
  surfaceTokens: number;
  sampledSurfaceTokens?: number;
  sampledHeaderKey?: string;
  pressureTokens?: number;
  usage?: ProviderUsageView;
  contextWindow?: number;
  /** Last three-bucket header breakdown observed by measureRequest. */
  lastBuckets?: { systemTokens: number; toolsTokens: number };
}

export function estimateTokenText(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(Array.from(text).length / TOKEN_METER_CHARS_PER_TOKEN);
}

function estimateUnknown(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return estimateTokenText(value);
  try {
    return estimateTokenText(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}

function estimateToolCalls(calls: TokenMeterMessage["toolCalls"]): number {
  let tokens = 0;
  for (const call of calls ?? []) {
    tokens += estimateUnknown(call.id);
    tokens += estimateUnknown(call.name);
    tokens += estimateUnknown(call.arguments);
    tokens += TOKEN_METER_BLOCK_OVERHEAD;
  }
  return tokens;
}

function estimateContentBlocks(blocks: readonly unknown[]): number {
  let tokens = 0;
  for (const block of blocks) {
    if (block === null || block === undefined) continue;
    if (typeof block === "string") {
      tokens += estimateTokenText(block) + TOKEN_METER_BLOCK_OVERHEAD;
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      tokens += estimateTokenText(record.text) + TOKEN_METER_BLOCK_OVERHEAD;
      continue;
    }
    if (record.type === "reasoning" && typeof record.text === "string") {
      tokens += estimateTokenText(record.text) + TOKEN_METER_BLOCK_OVERHEAD;
      continue;
    }
    if (record.type === "tool-call") {
      tokens +=
        estimateUnknown(record.name) + estimateUnknown(record.arguments);
      tokens += TOKEN_METER_BLOCK_OVERHEAD;
      continue;
    }
    if (record.type === "tool-result") {
      tokens += estimateContentBlocks(
        Array.isArray(record.content) ? record.content : [],
      );
      tokens += TOKEN_METER_BLOCK_OVERHEAD;
      continue;
    }
    tokens += TOKEN_METER_BLOCK_OVERHEAD + estimateUnknown(record);
  }
  return tokens;
}

export function estimateMeterMessage(message: TokenMeterMessage): number {
  let tokens = TOKEN_METER_ROLE_OVERHEAD;
  if (typeof message.content === "string") {
    tokens += estimateTokenText(message.content);
  } else if (Array.isArray(message.content)) {
    tokens += estimateContentBlocks(message.content);
  }
  tokens += estimateToolCalls(message.toolCalls);
  tokens += estimateUnknown(message.toolName);
  tokens += estimateUnknown(message.toolCallID);
  tokens += estimateVisualInput(message.images);
  tokens += estimateVisualInput(message.videos);
  return tokens;
}

/**
 * Price one message's image/video attachments by their published vision
 * accounting rather than their byte length.
 *
 * Without this a message carrying attachments costs only its text: the
 * compaction trigger reads the request total, so a session that accumulates
 * screenshots never compacts and eventually exceeds the real context window.
 *
 * There is deliberately no per-image ceiling. Attachment admission already
 * bounds the pixel count, and a ceiling below that bound under-counts — a
 * 1568px image (the post-scaling maximum) is ~2k tokens, and a GIF, which is
 * never scaled, can reach the full admission budget. Under-counting is the
 * failure this function exists to prevent, so the formula is allowed to run.
 */
export function estimateVisualInput(
  attachments: readonly TokenMeterImage[] | undefined,
): number {
  if (!attachments?.length) return 0;
  let tokens = 0;
  for (const attachment of attachments) {
    tokens += TOKEN_METER_BLOCK_OVERHEAD;
    const width = attachment.width;
    const height = attachment.height;
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      width <= 0 ||
      height <= 0
    ) {
      tokens += TOKEN_METER_IMAGE_UNKNOWN_TOKENS;
      continue;
    }
    tokens += Math.ceil((width * height) / TOKEN_METER_IMAGE_PIXELS_PER_TOKEN);
  }
  return tokens;
}

function usageTotal(usage: ProviderUsageView): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadInputTokens ?? 0) +
    (usage.cacheCreationInputTokens ?? 0)
  );
}

function promptPressure(usage: ProviderUsageView): number {
  return (
    usage.inputTokens +
    (usage.cacheReadInputTokens ?? 0) +
    (usage.cacheCreationInputTokens ?? 0)
  );
}

/** Per-scope replay-aware request/surface token account. */
export class TokenMeter {
  private readonly states = new Map<string, ScopeState>();

  /** Estimate one provider message with the shared fixed heuristic. */
  estimateMessage(message: TokenMeterMessage): number {
    return estimateMeterMessage(message);
  }

  /** Estimate a complete request without mutating the scope's sampled anchor. */
  estimateRequest(input: {
    system?: string;
    tools?: unknown;
    messages: readonly TokenMeterMessage[];
  }): number {
    return (
      estimateTokenText(input.system ?? "") +
      estimateUnknown(input.tools) +
      this.estimateMessages(input.messages)
    );
  }

  /** Estimate only the model-visible message/tool surface. */
  estimateMessages(messages: readonly TokenMeterMessage[]): number {
    let tokens = 0;
    for (const message of messages) tokens += estimateMeterMessage(message);
    return tokens;
  }

  /** Record the latest observed surface without changing provider usage. */
  observeSurface(
    scope: string,
    messages: readonly TokenMeterMessage[],
  ): number {
    const state = this.state(scope);
    state.surfaceTokens = this.estimateMessages(messages);
    return state.surfaceTokens;
  }

  /** Record the current route/model capacity for one scope. */
  setContextWindow(scope: string, contextWindow: number | undefined): void {
    const state = this.state(scope);
    if (contextWindow === undefined || contextWindow <= 0) {
      state.contextWindow = undefined;
      return;
    }
    state.contextWindow = contextWindow;
  }

  /**
   * Record the exact provider usage sample of the request identified by
   * `headerKey` and `surfaceTokens`. Headers must match before usage is reused
   * by measureRequest; the projected view still carries the sample forward.
   */
  recordUsage(
    scope: string,
    usage: ProviderUsageView,
    options?: {
      headerKey?: string;
      surfaceTokens?: number;
    },
  ): void {
    const state = this.state(scope);
    state.usage = { ...usage };
    state.pressureTokens = promptPressure(usage);
    state.sampledSurfaceTokens = options?.surfaceTokens ?? state.surfaceTokens;
    state.sampledHeaderKey = options?.headerKey;
  }

  /**
   * Measure the request about to be sent for compaction.
   *
   * Exact provider usage is reused only when the sample's canonical header is
   * still current and its total is at least the current heuristic price. That
   * mirrors DSH's conservative anchor rule: stale or smaller samples never
   * make compaction believe the request is cheaper than the local estimate.
   */
  measureRequest(scope: string, envelope: RequestEnvelope): TokenMeasurement {
    const state = this.state(scope);
    state.surfaceTokens = this.estimateMessages(envelope.messages);
    if (envelope.contextWindow !== undefined)
      this.setContextWindow(scope, envelope.contextWindow);

    const systemTokens = estimateTokenText(envelope.system ?? "");
    const toolsTokens = estimateUnknown(envelope.tools);
    const headerTokens = systemTokens + toolsTokens;
    const estimatedTotal = headerTokens + state.surfaceTokens;
    const headerKey = requestHeaderKey(envelope);
    state.lastBuckets = { systemTokens, toolsTokens };
    const exact =
      state.usage !== undefined &&
      state.sampledHeaderKey !== undefined &&
      state.sampledHeaderKey === headerKey
        ? usageTotal(state.usage)
        : undefined;
    const useProviderUsage = exact !== undefined && exact >= estimatedTotal;
    return {
      systemTokens,
      toolsTokens,
      messageTokens: state.surfaceTokens,
      headerTokens,
      totalTokens: useProviderUsage ? exact : estimatedTotal,
      ...(state.pressureTokens === undefined
        ? {}
        : { pressureTokens: state.pressureTokens }),
      ...(this.projectedTokens(scope) === undefined
        ? {}
        : { projectedTokens: this.projectedTokens(scope) }),
      ...(state.contextWindow === undefined
        ? {}
        : { contextWindow: state.contextWindow }),
      source: useProviderUsage ? "provider_usage" : "estimate",
    };
  }

  /** Current UI-facing context projection for one scope. */
  project(scope: string): {
    pressureTokens?: number;
    projectedTokens?: number;
    contextWindow?: number;
    systemTokens?: number;
    toolsTokens?: number;
    messageTokens?: number;
    source: "estimate" | "provider_usage";
  } {
    const state = this.state(scope);
    return {
      ...(state.pressureTokens === undefined
        ? {}
        : { pressureTokens: state.pressureTokens }),
      ...(this.projectedTokens(scope) === undefined
        ? {}
        : { projectedTokens: this.projectedTokens(scope) }),
      ...(state.contextWindow === undefined
        ? {}
        : { contextWindow: state.contextWindow }),
      ...(state.lastBuckets === undefined
        ? {}
        : {
            systemTokens: state.lastBuckets.systemTokens,
            toolsTokens: state.lastBuckets.toolsTokens,
            messageTokens: state.surfaceTokens,
          }),
      source: state.usage === undefined ? "estimate" : "provider_usage",
    };
  }

  /** Drop all per-scope accounting, e.g. after a session rollback. */
  clear(scope?: string): void {
    if (scope === undefined) this.states.clear();
    else this.states.delete(scope);
  }

  private projectedTokens(scope: string): number | undefined {
    const state = this.state(scope);
    if (
      state.pressureTokens === undefined ||
      state.sampledSurfaceTokens === undefined
    )
      return undefined;
    return Math.max(
      0,
      state.pressureTokens + state.surfaceTokens - state.sampledSurfaceTokens,
    );
  }

  private state(scope: string): ScopeState {
    let state = this.states.get(scope);
    if (state === undefined) {
      state = { surfaceTokens: 0 };
      this.states.set(scope, state);
    }
    return state;
  }
}

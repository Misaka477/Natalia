import type {
  CompactionTrigger,
  LocalAttachment,
  ContextStatusSource,
  ProviderContentPart,
  ProviderReasoningBlock,
  RuntimeEvent,
} from "@anthelia/contracts";

export type ContextRole =
  | "system"
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "dynamic"
  | "resource"
  | "summary";

export type ContextEntry = {
  id: string;
  role: ContextRole;
  content: string;
  tokens?: number;
  pairID?: string;
  artifactRef?: string;
  attachments?: LocalAttachment[];
  reasoningContent?: string;
  reasoningField?: string;
  reasoningSignature?: string;
  reasoningRedacted?: boolean;
  /** Ordered Anthropic thinking blocks, including per-block signatures. */
  reasoningBlocks?: ProviderReasoningBlock[];
  /** Ordered provider-native assistant content parts. */
  contentParts?: ProviderContentPart[];
  /** Generic provider metadata carried across turns. */
  providerMetadata?: Record<string, unknown>;
  /** Gemini thought signature attached to a non-thought text part. */
  textSignature?: string;
  /** Gemini thought signature attached to a tool_call entry. */
  thoughtSignature?: string;
};

export type ExactUsageCheckpoint = {
  messageCount: number;
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
  source: "provider_usage" | "estimate";
};

export type ContextLedgerSnapshot = {
  entries: ContextEntry[];
  checkpoint?: ExactUsageCheckpoint;
  resources: ResourceSnapshot[];
};

export type DurableContextCheckpoint = ContextLedgerSnapshot & {
  journalOffset: number;
  step: number;
  tokenEstimate: number;
  compactionGeneration: number;
};

export type ContextStatus = {
  used: number;
  max: number;
  source: ContextStatusSource;
  thresholdPercent: number;
  reserved: number;
  trigger?: CompactionTrigger;
  /** Model-visible message/tool surface tokens (the message bucket). */
  surfaceTokens?: number;
  /** Conservative full-request tokens (header + surface, provider-anchored). */
  requestTokens?: number;
  /** systemTokens + toolsTokens. */
  headerTokens?: number;
  /** System-prompt tokens, counted once in the header only. */
  systemTokens?: number;
  /** Tool-definition tokens, counted once in the header only. */
  toolsTokens?: number;
};

export type ResourceSnapshot = {
  kind:
    | "background"
    | "process"
    | "agent"
    | "terminal"
    | "sandbox"
    | "workflow"
    | "skill";
  id: string;
  summary: string;
};

export type ToolResultPruneOptions = {
  thresholdChars: number;
  headChars: number;
  tailChars: number;
  /**
   * Number of newest entries exempt from pruning. The default keeps the most
   * recent tool result intact while old tool output is reduced.
   */
  protectRecentEntries: number;
};

export const DEFAULT_TOOL_RESULT_PRUNE_OPTIONS: ToolResultPruneOptions = {
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
  protectRecentEntries: 1,
};

export type ToolResultPruneOutcome = {
  pruned: number;
  beforeTokens: number;
  afterTokens: number;
};

export type ReservedResolverInput = {
  contextWindow: number;
  explicitMaxOutputTokens?: number | null;
  configuredReserved: number | "auto";
  providerOutputLimit?: number;
  catalogOutputLimit?: number;
};

export type ReservedResolution = {
  tokens: number;
  source:
    | "config"
    | "provider_metadata"
    | "explicit_output"
    | "catalog"
    | "fallback_formula";
  diagnostic: string;
};

export class ContextLedger {
  private entries: ContextEntry[] = [];
  private checkpoint?: ExactUsageCheckpoint;
  private resources: ResourceSnapshot[] = [];
  private journalOffset = 0;
  private compactionGeneration = 0;
  private revision = 0;

  /** Monotonic entry-surface revision used to detect concurrent appends. */
  surfaceRevision(): number {
    return this.revision;
  }

  add(entry: ContextEntry) {
    this.entries.push({
      ...entry,
      tokens: entry.tokens ?? estimateTokens(entry.content),
    });
    this.journalOffset += 1;
    this.revision += 1;
  }

  addMany(entries: ContextEntry[]) {
    for (const entry of entries) this.add(entry);
  }

  addResource(resource: ResourceSnapshot) {
    this.resources = this.resources.filter((item) => item.id !== resource.id);
    this.resources.push(resource);
    this.add({
      id: `resource:${resource.id}`,
      role: "resource",
      content: `${resource.kind}:${resource.id} ${resource.summary}`,
    });
  }

  recordProviderUsage(inputTokens: number, outputTokens: number) {
    this.checkpoint = {
      messageCount: this.entries.length,
      tokens: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      source: "provider_usage",
    };
    this.journalOffset += 1;
  }

  effectiveTokens() {
    if (!this.checkpoint)
      return this.entries.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
    const pending = this.entries
      .slice(this.checkpoint.messageCount)
      .reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
    return this.checkpoint.tokens + pending;
  }

  /**
   * Deterministically trims old large tool results in-place before a provider
   * request. Journal events remain untouched; only this live ledger surface is
   * replaced, and the exact provider checkpoint is degraded to an estimate
   * because the prior usage no longer describes this transformed surface.
   */
  pruneToolResults(
    options: Partial<ToolResultPruneOptions> = {},
  ): ToolResultPruneOutcome {
    const resolved = { ...DEFAULT_TOOL_RESULT_PRUNE_OPTIONS, ...options };
    const beforeTokens = this.effectiveTokens();
    const protect = Math.max(0, Math.floor(resolved.protectRecentEntries));
    const cutoff = Math.max(0, this.entries.length - protect);
    let pruned = 0;
    this.entries = this.entries.map((entry, index) => {
      if (index >= cutoff) return entry;
      const candidate = pruneToolResultEntry(entry, resolved);
      if (candidate !== entry) pruned += 1;
      return candidate;
    });
    if (!pruned) return { pruned: 0, beforeTokens, afterTokens: beforeTokens };
    const tokens = this.entries.reduce(
      (sum, entry) => sum + (entry.tokens ?? estimateTokens(entry.content)),
      0,
    );
    this.checkpoint = {
      messageCount: this.entries.length,
      tokens,
      source: "estimate",
    };
    this.revision += 1;
    return {
      pruned,
      beforeTokens,
      afterTokens: this.effectiveTokens(),
    };
  }

  status(input: {
    max: number;
    thresholdPercent: number;
    reserved: number;
  }): ContextStatus {
    const used = this.effectiveTokens();
    const trigger = compactionTrigger({
      used,
      max: input.max,
      thresholdPercent: input.thresholdPercent,
      reserved: input.reserved,
    });
    return {
      used,
      max: input.max,
      source:
        this.checkpoint?.source === "provider_usage" &&
        this.entries.length === this.checkpoint.messageCount
          ? "exact_checkpoint"
          : "pending_estimate",
      thresholdPercent: input.thresholdPercent,
      reserved: input.reserved,
      trigger,
    };
  }

  snapshot(): ContextLedgerSnapshot {
    return {
      entries: this.entries.map((entry) => ({ ...entry })),
      checkpoint: this.checkpoint ? { ...this.checkpoint } : undefined,
      resources: this.resources.map((resource) => ({ ...resource })),
    };
  }

  durableCheckpoint(step: number): DurableContextCheckpoint {
    return {
      ...this.snapshot(),
      journalOffset: this.journalOffset,
      step,
      tokenEstimate: this.effectiveTokens(),
      compactionGeneration: this.compactionGeneration,
    };
  }

  restore(snapshot: ContextLedgerSnapshot) {
    this.entries = snapshot.entries.map((entry) => ({ ...entry }));
    this.checkpoint = snapshot.checkpoint
      ? { ...snapshot.checkpoint }
      : undefined;
    this.resources = snapshot.resources.map((resource) => ({ ...resource }));
    if (
      "journalOffset" in snapshot &&
      typeof snapshot.journalOffset === "number"
    )
      this.journalOffset = snapshot.journalOffset;
    else this.journalOffset = this.entries.length;
    if (
      "compactionGeneration" in snapshot &&
      typeof snapshot.compactionGeneration === "number"
    )
      this.compactionGeneration = snapshot.compactionGeneration;
    this.revision += 1;
  }

  restoreDurableCheckpoint(checkpoint: DurableContextCheckpoint) {
    this.restore(checkpoint);
    this.journalOffset = checkpoint.journalOffset;
    this.compactionGeneration = checkpoint.compactionGeneration;
  }

  /**
   * Restores ONLY the exact usage anchor, leaving the entry surface the
   * caller already replayed in place.
   *
   * This is the no-compaction restart path: a durable `context.checkpoint`
   * event (JSON stores; SQLite keeps it in `context_epochs`) carries the
   * provider-anchored usage from the last turn, and the event log replay
   * rebuilds the same entry surface. Restoring just the anchor makes
   * `effectiveTokens()` report the provider's number instead of the entry
   * estimate — which against a large window rounds the context ring to 0%.
   *
   * Two refusals keep the anchor honest:
   *   - `messageCount` beyond this surface (a rolled-back or truncated journal
   *     replays fewer entries than the checkpoint covers) — the estimate wins
   *     over reporting a surface this ledger no longer has.
   *   - a surface compaction already rewrote (`compactionGeneration > 0`): the
   *     checkpoint describes the pre-compaction entries, which the replay
   *     cannot rebuild, so the compaction's own estimate stays authoritative.
   */
  restoreUsageCheckpoint(checkpoint: ExactUsageCheckpoint): boolean {
    if (this.compactionGeneration > 0) return false;
    if (checkpoint.messageCount > this.entries.length) return false;
    this.checkpoint = { ...checkpoint };
    this.revision += 1;
    return true;
  }

  journalStatus() {
    return {
      journalOffset: this.journalOffset,
      messageCount: this.entries.length,
      tokenEstimate: this.effectiveTokens(),
      compactionGeneration: this.compactionGeneration,
    };
  }

  replaceAfterCompaction(
    summary: ContextEntry,
    preserved: ContextEntry[],
    estimatedTokens?: number,
    expectedRevision?: number,
  ) {
    if (expectedRevision !== undefined && this.revision !== expectedRevision)
      throw new Error("context surface changed during compaction");
    // A leading system entry is the agent's own prompt, not conversation. The
    // main runner re-unshifts it after compaction but the subagent path rebuilds
    // straight from the ledger, so it has to survive here or the subagent loses
    // its instructions and nothing fails loudly. It is re-inserted ahead of the
    // summary unless the preserved tail already starts with it, so a tail that
    // covers the whole ledger does not gain a duplicate.
    const systemHead =
      this.entries[0]?.role === "system" &&
      preserved[0]?.role !== "system" &&
      preserved[0]?.id !== this.entries[0]!.id
        ? [this.entries[0]!]
        : [];
    this.entries = [
      ...systemHead,
      summary,
      ...preserved,
      ...this.resources.map(resourceToContextEntry),
    ];
    this.checkpoint = {
      messageCount: this.entries.length,
      tokens:
        estimatedTokens ??
        this.entries.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0),
      source: "estimate",
    };
    this.compactionGeneration += 1;
    this.journalOffset += 1;
    this.revision += 1;
  }
}

export function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(Array.from(text).length / 4));
}

export function compactionTrigger(input: {
  used: number;
  max: number;
  thresholdPercent: number;
  reserved: number;
}): CompactionTrigger | undefined {
  if (input.used >= Math.floor((input.max * input.thresholdPercent) / 100))
    return "ratio";
  if (input.used + input.reserved >= input.max) return "reserved";
  return undefined;
}

/**
 * Outcome of the identity-free preflight compaction decision. `ratio` fires on
 * full-request pressure reaching the threshold; `reserved` is the hard capacity
 * guard when the request plus the reserved output budget would not fit;
 * `nothing_to_compact` means the request is over pressure but there is no
 * compactable range, so the pipeline must stop without calling the LLM; `none`
 * means no compaction is needed.
 */
export type CompactionDecision =
  | "none"
  | "ratio"
  | "reserved"
  | "nothing_to_compact";

/**
 * Pure preflight decision shared by the main, subagent, Navi and Nia paths.
 * `requestTokens` is the measured full request (header + surface); `headerTokens`
 * and `surfaceTokens` describe the canonical three-bucket envelope. The decision
 * never re-derives a budget: it only compares against `max`, `reserved` and
 * `thresholdPercent`, and refuses to summarize when `hasCompactableRange` is
 * false instead of inventing a MIN_COMPACTABLE_TOKENS guard.
 */
export function decideCompaction(input: {
  requestTokens: number;
  headerTokens: number;
  surfaceTokens: number;
  max: number;
  reserved: number;
  thresholdPercent: number;
  hasCompactableRange: boolean;
}): CompactionDecision {
  const overRatio =
    input.requestTokens >=
    Math.floor((input.max * input.thresholdPercent) / 100);
  const overReserved = input.requestTokens + input.reserved >= input.max;
  if (!overRatio && !overReserved) return "none";
  if (!input.hasCompactableRange) return "nothing_to_compact";
  return overRatio ? "ratio" : "reserved";
}

/**
 * The runtime's context policy: the window, the compaction boundary and how much
 * recent work always survives one. Assembled from config with schema defaults
 * applied, so a partially-configured workspace still gets a complete budget.
 */
export type ContextBudget = {
  max: number;
  thresholdPercent: number;
  reserved: number;
  /** Where `reserved` came from, so a diagnostic can say so. */
  reservedSource: ReservedResolution["source"];
  preservedRecentMessages: number;
  preservedRecentTokens: number;
  maxOverflowRetries: number;
  /** Tool-result pruning policy applied before a compaction is considered. */
  prune: ToolResultPruneOptions;
};

/** The compaction boundary in tokens: the ratio of the window. */
export function contextThresholdTokens(budget: {
  max: number;
  thresholdPercent: number;
}): number {
  return Math.floor((budget.max * budget.thresholdPercent) / 100);
}

/**
 * Config-time invariant: `preservedRecentTokens` must sit below the compaction
 * threshold. Otherwise the preserved tail can never satisfy the trigger and
 * every step would compact in vain — fail fast instead of spinning.
 * `0` disables the absolute tail budget, so it is always valid.
 */
export function assertContextBudgetInvariants(budget: ContextBudget): void {
  if (budget.preservedRecentTokens <= 0) return;
  const threshold = contextThresholdTokens(budget);
  if (budget.preservedRecentTokens >= threshold)
    throw new Error(
      `invalid context budget: preservedRecentTokens (${budget.preservedRecentTokens}) ` +
        `must stay below the compaction threshold (${threshold} tokens = ` +
        `${budget.thresholdPercent}% of ${budget.max}); lower the preserved tail ` +
        `or raise context.compactionThresholdPercent`,
    );
}

export type PreserveOptions = {
  recentMessages?: number;
  recentTokens?: number;
};

export type CompactableRange = {
  preserved: ContextEntry[];
  compactable: ContextEntry[];
  /** True when there is at least one non-summary, non-resource entry to fold. */
  hasRange: boolean;
};

/**
 * Split a ledger surface into the preserved recent suffix (with tool pairs
 * closed) and the compactable prefix. This is the single source of truth for
 * "is there anything to compact", shared by the decision and the summarizer so
 * they can never disagree about the compactable range.
 */
export function selectCompactableRange(
  entries: ContextEntry[],
  options: PreserveOptions,
): CompactableRange {
  // Both constraints apply, and the tail is whichever reaches further back: a
  // message count cannot say how much context a turn holds, and a token budget
  // cannot say "always keep the last few exchanges".
  const preserved = preserveRecentTail(entries, {
    recentMessages: options.recentMessages,
    recentTokens: options.recentTokens,
  });
  const preservedIDs = new Set(preserved.map((entry) => entry.id));
  // The leading system entry is the agent's own prompt and is never compacted:
  // a compaction that could swallow it would let the next one try again on the
  // same head, which is what made an early version of this settle only after
  // several passes.
  const systemHeadID =
    entries[0]?.role === "system" ? entries[0]!.id : undefined;
  const compactable = entries.filter(
    (entry) =>
      entry.role !== "resource" &&
      !preservedIDs.has(entry.id) &&
      entry.id !== systemHeadID,
  );
  const hasRange =
    compactable.length > 0 &&
    !compactable.every((entry) => entry.role === "summary");
  return { preserved, compactable, hasRange };
}

export function resolveReservedOutputTokens(
  input: ReservedResolverInput,
): ReservedResolution {
  if (typeof input.configuredReserved === "number") {
    return {
      tokens: input.configuredReserved,
      source: "config",
      diagnostic: "explicit context.reservedOutputTokens",
    };
  }
  if (input.explicitMaxOutputTokens && input.explicitMaxOutputTokens > 0) {
    return {
      tokens: input.explicitMaxOutputTokens,
      source: "explicit_output",
      diagnostic: "explicit model.maxOutputTokens",
    };
  }
  if (input.providerOutputLimit && input.providerOutputLimit > 0) {
    return {
      tokens: input.providerOutputLimit,
      source: "provider_metadata",
      diagnostic: "provider output metadata",
    };
  }
  if (input.catalogOutputLimit && input.catalogOutputLimit > 0) {
    return {
      tokens: input.catalogOutputLimit,
      source: "catalog",
      diagnostic: "known model output catalog",
    };
  }
  const tokens = Math.min(
    20_000,
    Math.max(4_096, Math.floor(input.contextWindow * 0.1)),
  );
  return {
    tokens,
    source: "fallback_formula",
    diagnostic: "conservative formula min(20000,max(4096,context*0.1))",
  };
}

export function contextStatusEvent(status: ContextStatus): RuntimeEvent {
  return { type: "context.status", ...status };
}

/**
 * Builds the three-bucket view for a context.status event from a TokenMeter
 * projection, so `used` stays the legacy message face while `surfaceTokens`,
 * `requestTokens`, `headerTokens`, `systemTokens` and `toolsTokens` expose the
 * canonical system / tools / messages accounting. Returns undefined until the
 * request envelope has been measured at least once for that scope.
 */
export function contextStatusBuckets(projection: {
  systemTokens?: number;
  toolsTokens?: number;
  messageTokens?: number;
}):
  | Pick<
      ContextStatus,
      | "surfaceTokens"
      | "requestTokens"
      | "headerTokens"
      | "systemTokens"
      | "toolsTokens"
    >
  | undefined {
  const { systemTokens, toolsTokens, messageTokens } = projection;
  if (
    systemTokens === undefined ||
    toolsTokens === undefined ||
    messageTokens === undefined
  )
    return undefined;
  const headerTokens = systemTokens + toolsTokens;
  return {
    surfaceTokens: messageTokens,
    requestTokens: headerTokens + messageTokens,
    headerTokens,
    systemTokens,
    toolsTokens,
  };
}

function closeToolPairs(
  entries: ContextEntry[],
  preserved: ContextEntry[],
): ContextEntry[] {
  const pairIDs = new Set(
    preserved.map((entry) => entry.pairID).filter(Boolean) as string[],
  );
  const seenPairRoles = new Set<string>();
  const missingPairs = entries.filter((entry) => {
    if (!entry.pairID || !pairIDs.has(entry.pairID)) return false;
    if (preserved.some((item) => item.id === entry.id)) return false;
    // A malformed ledger can contain two calls or two results for one pair.
    // Close each side at most once so the rebuilt provider request never has a
    // duplicate tool_call_id.
    const key = `${entry.pairID}:${entry.role}`;
    if (seenPairRoles.has(key)) return false;
    seenPairRoles.add(key);
    return true;
  });
  return [...missingPairs, ...preserved];
}

export function preserveRecentWithToolPairs(
  entries: ContextEntry[],
  recentCount: number,
) {
  return closeToolPairs(
    entries,
    entries.slice(Math.max(0, entries.length - recentCount)),
  );
}

/** Index of the first entry a count-based tail would keep. */
function countBasedStart(entries: ContextEntry[], recentCount: number): number {
  return Math.max(0, entries.length - Math.max(0, recentCount));
}

/**
 * Index of the first entry a token-budget tail would keep.
 *
 * At least the newest entry is always kept, even when it alone exceeds the
 * budget, so compaction never drops the context of the step being prepared.
 */
function tokenBasedStart(entries: ContextEntry[], tokenBudget: number): number {
  if (tokenBudget <= 0) return entries.length;
  let start = entries.length;
  let tokens = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const entryTokens = entry.tokens ?? estimateTokens(entry.content);
    if (start < entries.length && tokens + entryTokens > tokenBudget) break;
    tokens += entryTokens;
    start = index;
  }
  return start;
}

/**
 * Index of the first entry to keep so the tail ends with a user message.
 *
 * A tail made only of assistant replies and tool exchanges leaves the model
 * with no statement of what the user currently wants, and Anthropic accepts
 * such a request, so nothing fails loudly — the work simply drifts. Reaching
 * back to the last user message costs a bounded number of older entries.
 *
 * Only ever moves the start earlier, never trims a tail the other constraints
 * already produced.
 */
function userMessageStart(entries: ContextEntry[], from: number): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.role !== "user") continue;
    // Already inside the tail: leave the count and token constraints alone.
    // Only a tail with no user message reaches further back.
    return index >= from ? from : index;
  }
  // The ledger holds no user message at all, so there is nothing to reach.
  return from;
}

/**
 * Retain the newest suffix that satisfies every constraint, keeping whichever
 * reaches furthest back.
 *
 * A count and a token budget are **unions, not alternatives**: a message count
 * cannot express how much context a turn holds, and a token budget cannot
 * express "always keep the last few exchanges". Taking the earlier of the two
 * start indices means each constraint is a floor, and the tail is whichever the
 * two imply.
 */
export function preserveRecentTail(
  entries: ContextEntry[],
  options: { recentMessages?: number; recentTokens?: number },
): ContextEntry[] {
  const base = Math.min(
    countBasedStart(entries, options.recentMessages ?? 0),
    tokenBasedStart(entries, options.recentTokens ?? 0),
  );
  const withUser = userMessageStart(entries, base);
  // Reaching back must not consume the whole compactable range: compaction that
  // never fires grows the context without bound, which is the failure this tail
  // exists to prevent. When the tail would have to swallow everything to gain a
  // user message, it goes without — the summary replacing the compacted region
  // carries the user's intent, so the tail is not left without it.
  const start = withUser > 0 ? withUser : base;
  return closeToolPairs(entries, entries.slice(start));
}

/**
 * Retains the newest suffix that fits a token budget. At least the newest
 * entry is retained even when it alone exceeds the budget, so compaction never
 * drops the current step's context. Tool-call/result pairs are closed after the
 * budget cut, which may add a bounded number of older entries.
 */
export function preserveRecentWithToolPairsByTokens(
  entries: ContextEntry[],
  tokenBudget: number,
): ContextEntry[] {
  if (tokenBudget <= 0) return [];
  return closeToolPairs(
    entries,
    entries.slice(tokenBasedStart(entries, tokenBudget)),
  );
}

const TOOL_RESULT_PRUNE_MARKER = "tool result truncated for context";

export function pruneToolResultEntry(
  entry: ContextEntry,
  options: ToolResultPruneOptions = DEFAULT_TOOL_RESULT_PRUNE_OPTIONS,
): ContextEntry {
  if (
    entry.role !== "tool_result" ||
    entry.content.length <= options.thresholdChars ||
    entry.content.includes(TOOL_RESULT_PRUNE_MARKER)
  )
    return entry;
  const head = entry.content.slice(0, options.headChars);
  const tail = entry.content.slice(-options.tailChars);
  const omittedChars = entry.content.length - head.length - tail.length;
  const content = `${head}\n\n[${TOOL_RESULT_PRUNE_MARKER}; originalChars=${entry.content.length}; omittedChars=${omittedChars}]\n\n${tail}`;
  if (content.length >= entry.content.length) return entry;
  return { ...entry, content, tokens: undefined };
}

export function largeToolResultContext(
  entry: ContextEntry,
  maxInlineChars = 2000,
): ContextEntry {
  if (entry.role !== "tool_result" || entry.content.length <= maxInlineChars)
    return entry;
  const head = entry.content.slice(0, Math.floor(maxInlineChars / 2));
  const tail = entry.content.slice(-Math.floor(maxInlineChars / 2));
  return {
    ...entry,
    content: `${head}\n\n[tool result stored as artifact ${entry.artifactRef ?? entry.id}; totalChars=${entry.content.length}]\n\n${tail}`,
    tokens: undefined,
  };
}

function resourceToContextEntry(resource: ResourceSnapshot): ContextEntry {
  return {
    id: `resource:${resource.id}`,
    role: "resource",
    content: `${resource.kind}:${resource.id} ${resource.summary}`,
  };
}

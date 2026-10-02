import type { RuntimeEvent } from "@anthelia/contracts";
import type { RetryRunnerOptions } from "@anthelia/runtime";
import {
  compactContext,
  decideCompaction,
  providerCompactor,
  selectCompactableRange,
  type CompactionDecision,
  type ContextEntry,
  type ContextLedger,
  type ProviderMessage,
  type RequestEnvelope,
  type StreamingProvider,
  type TokenMeasurement,
  type TokenMeter,
  type ToolResultPruneOptions,
} from "@anthelia/runtime";

/**
 * Identity-free preflight pipeline shared by the main, subagent, Navi and Nia
 * request paths. It owns the canonical order:
 *
 *   construct envelope -> measure -> decide -> (prune -> rebuild -> remeasure ->
 *   decide) -> (summarize -> rebuild -> remeasure) -> emit context surface.
 *
 * The path supplies only what is genuinely path-shaped: the outbound messages,
 * a `rebuildOutbound` that re-derives them from the (possibly rewritten) ledger,
 * and the event sink. No channel/stream identity is threaded through, and no
 * path re-derives its own trigger budget or hand-stitches `usedTokens`.
 */
export type PrepareContextRequestInput = {
  /** Stable id prefix for compaction / checkpoint events. */
  id: string;
  /** Current step index, used only to keep the compaction event id unique. */
  step?: number;
  ledger: ContextLedger;
  meter: TokenMeter;
  /** TokenMeter scope; distinct per stream, never a shared channel. */
  scope: string;
  /** Canonical request envelope header (system + tools). */
  system: string | undefined;
  tools: unknown;
  /** Capacity of the route/model for this request. */
  contextWindow: number;
  /**
   * The resolved context budget. The three window fields are required; the
   * policy fields (preserved tail, prune options) are read from here when the
   * caller does not pass explicit overrides, so the pipeline defaults to the
   * same centralized budget every other stream uses (plan §2.3).
   */
  budget: {
    max: number;
    thresholdPercent: number;
    reserved: number;
    preservedRecentMessages?: number;
    preservedRecentTokens?: number;
    prune?: ToolResultPruneOptions;
  };
  /** Explicit preserved-tail overrides; otherwise the budget policy applies. */
  preserve?: { recentMessages?: number; recentTokens?: number };
  /** The user's standing instruction, layered onto the compaction prompt. */
  userInstruction?: string;
  /**
   * The outbound provider messages about to be sent. The pipeline measures
   * this first, then replaces it via `rebuildOutbound` after prune/compaction.
   */
  outbound: ProviderMessage[];
  /**
   * Re-derive the outbound messages from the (possibly rewritten) ledger. The
   * path closes over whatever stateful restoration it needs (reasoning fields,
   * runtime-context re-injection, live user turns). `phase` distinguishes the
   * model-free prune rebuild from the post-summarization rebuild.
   */
  rebuildOutbound: (
    entries: ContextEntry[],
    phase: "prune" | "compact",
  ) => ProviderMessage[];
  /** Tool-result prune configuration; ignored unless {@link prune} is true. */
  pruneOptions?: Partial<ToolResultPruneOptions>;
  /**
   * Whether this request runs the model-free tool-result prune.
   *
   * Pruning rewrites live ledger entries, and every provider request writes a
   * prefix-cache breakpoint at the end of its stable region. A rewrite between
   * two requests of the same turn therefore invalidates everything after the
   * rewritten entry for the rest of that turn, so the prune must run **once per
   * turn, on the turn's first provider request** — never once per step.
   *
   * The caller owns the turn boundary, so this is required rather than
   * inferred: the three shipped paths pass `step === 1`. There is no default
   * that preserves the old per-step behaviour, because a path that forgot to
   * opt out would silently pay for a full context re-bill on every step.
   */
  prune: boolean;
  /** Active provider used to build the summarizer for this request. */
  provider: StreamingProvider;
  prefixMessages?: ProviderMessage[];
  instruction?: string;
  compactionEnabled?: boolean;
  signal?: AbortSignal;
  /** Retry policy for the summarizer; the service supplies it when wired. */
  retry?: RetryRunnerOptions;
  /** Event sink for compaction.begin/end events. */
  publish: (event: RuntimeEvent) => void;
  /**
   * Emit the stream-namespaced context.status surface after each measurement.
   * The pipeline calls this with the fresh three-bucket measurement; the path
   * decides whether and how to publish (main emits context.status, subagent
   * emits nothing here).
   */
  emitStatus: (measured: TokenMeasurement) => void;
  /** Emit the stream-namespaced context.snapshot surface after each measurement. */
  emitSnapshot: (measured: TokenMeasurement) => void;
  /** Invoked after a successful summarization (e.g. to emit a durable checkpoint). */
  onCompacted?: () => void;
  now?: () => Date;
};

export type PrepareContextRequestResult = {
  /** Outbound messages to send to the provider (post prune/compaction). */
  outbound: ProviderMessage[];
  decision: CompactionDecision;
  compacted: boolean;
  pruned: number;
  /** Final measured full-request tokens. */
  used: number;
};

export async function prepareContextRequest(
  input: PrepareContextRequestInput,
): Promise<PrepareContextRequestResult> {
  const { ledger, meter, scope, budget } = input;
  // Centralized budget policy: an explicit caller override wins, then the
  // resolved budget, then the historical pipeline default (plan §2.3).
  const preserve = {
    recentMessages:
      input.preserve?.recentMessages ?? budget.preservedRecentMessages ?? 10,
    recentTokens: input.preserve?.recentTokens ?? budget.preservedRecentTokens,
  };
  const pruneOptions = input.prune
    ? (input.pruneOptions ?? budget.prune)
    : undefined;
  let outbound = input.outbound;

  const measure = (): TokenMeasurement =>
    meter.measureRequest(scope, {
      system: input.system,
      tools: input.tools,
      messages: outbound,
      contextWindow: input.contextWindow,
    });

  const hasCompactableRange = () =>
    selectCompactableRange(ledger.snapshot().entries, preserve).hasRange;

  const decide = (measured: TokenMeasurement): CompactionDecision =>
    decideCompaction({
      requestTokens: measured.totalTokens,
      headerTokens: measured.headerTokens,
      surfaceTokens: measured.messageTokens,
      max: budget.max,
      reserved: budget.reserved,
      thresholdPercent: budget.thresholdPercent,
      hasCompactableRange: hasCompactableRange(),
    });

  const publishSurface = (measured: TokenMeasurement) => {
    input.emitStatus(measured);
    input.emitSnapshot(measured);
  };

  let pruned = 0;

  // Model-free prune is cheap and keeps old tool results bounded; it runs on
  // the turn's first request only (see {@link PrepareContextRequestInput.prune}).
  // Only the expensive LLM summarize stays gated behind the decision below.
  if (pruneOptions) {
    const outcome = ledger.pruneToolResults(pruneOptions);
    pruned = outcome.pruned;
    if (pruned > 0)
      outbound = input.rebuildOutbound(ledger.snapshot().entries, "prune");
  }

  let measured = measure();
  let decision = decide(measured);

  publishSurface(measured);

  if (decision === "none" || decision === "nothing_to_compact") {
    return {
      outbound,
      decision,
      compacted: false,
      pruned,
      used: measured.totalTokens,
    };
  }

  const outcome = await compactContext(
    ledger,
    providerCompactor(input.provider, input.signal),
    {
      id: `${input.id}:preflight:${input.step ?? 0}`,
      trigger: decision === "ratio" ? "ratio" : "reserved",
      maxTokens: budget.max,
      thresholdPercent: budget.thresholdPercent,
      reservedTokens: budget.reserved,
      preservedRecentMessages: preserve.recentMessages ?? 10,
      ...(preserve.recentTokens === undefined
        ? {}
        : { preservedRecentTokens: preserve.recentTokens }),
      ...(input.prefixMessages ? { prefixMessages: input.prefixMessages } : {}),
      ...(input.instruction ? { instruction: input.instruction } : {}),
      ...(input.userInstruction
        ? { userInstruction: input.userInstruction }
        : {}),
      ...(input.compactionEnabled === undefined
        ? {}
        : { enabled: input.compactionEnabled }),
      beforeTokens: measured.totalTokens,
      retry: { ...(input.retry ?? {}), signal: input.signal },
      onEvent: input.publish,
      now: input.now,
    },
  );

  if (outcome.compacted) {
    // The provider usage anchor described the pre-compaction surface; drop it
    // so the re-measure prices the rewritten request instead of reusing a
    // stale (now-too-large) sample.
    meter.clear(scope);
    outbound = input.rebuildOutbound(ledger.snapshot().entries, "compact");
    measured = measure();
    input.onCompacted?.();
    publishSurface(measured);
  }

  return {
    outbound,
    decision,
    compacted: outcome.compacted,
    pruned,
    used: measured.totalTokens,
  };
}

/** Exported for tests and callers that build the envelope shape directly. */
export type { RequestEnvelope };

import type { CompactionTrigger, RuntimeEvent } from "@anthelia/contracts";
import { providerError, type ProviderError } from "./errors";
import {
  ContextLedger,
  estimateTokens,
  largeToolResultContext,
  selectCompactableRange,
  type ContextEntry,
} from "./context";
import { runWithRetry, type RetryRunnerOptions } from "./retry";
import {
  contextEntriesToProviderMessages,
  type ProviderMessage,
  type StreamingProvider,
} from "./provider";

const COMPACTION_SUMMARY_TEMPLATE = `Use exactly this Markdown structure and keep every section:
## Objective
- The user's current goal.

## Important Details
- Constraints, decisions and reasons, exact identifiers, and facts needed to continue.

## Work State
### Completed
- Finished and verified work.

### Active
- Work currently in progress.

### Blocked
- Blockers, failures, and unresolved unknowns.

## Next Move
1. The immediate concrete action.

## Relevant Files
- Exact path: why it matters.

Use terse bullets. Write "(none)" when a section has no content.`;

export type CompactionInput = {
  /**
   * The user's own instruction, layered onto the compaction prompt.
   *
   * Distinct from `instruction`, which is the caller's operational direction for
   * this compaction. This one is the workspace's standing preference, so it
   * rides alongside rather than replacing it.
   */
  userInstruction?: string;
  /**
   * The span to condense, as provider messages.
   *
   * Messages rather than ledger entries so the summarization call can replay the
   * span verbatim: the routed request sent these same bytes, so the provider's
   * warm prefix cache covers them and the auxiliary call reads it instead of
   * re-billing the whole span. A flattened text dump cannot match anything.
   */
  messages: ProviderMessage[];
  instruction?: string;
  resources: string[];
  /**
   * Optional prefix from the routed request. The system prompt is reused so a
   * provider that supports prefix caching can avoid paying to re-read it.
   */
  prefixMessages?: ProviderMessage[];
};

export type CompactionResult = {
  summary: string;
  /** Optional estimate of the compacted summary itself, never API request usage. */
  tokens?: number;
};

export type Compactor = {
  compact(input: CompactionInput): Promise<CompactionResult>;
};

/**
 * The section headings a compaction summary must carry.
 *
 * The template asks for them and tells the model to write "(none)" rather than
 * drop one, but a request is not a guarantee. A summary missing `Next Move` or
 * `Active` still parses as markdown and still commits, and the work then resumes
 * with no statement of what was in progress — which is the whole reason
 * compaction exists. Checking the headings is the only part of the contract that
 * is cheap enough to verify on every compaction.
 */
const REQUIRED_SUMMARY_SECTIONS = [
  "## Objective",
  "## Important Details",
  "## Work State",
  "### Completed",
  "### Active",
  "### Blocked",
  "## Next Move",
  "## Relevant Files",
] as const;

/** The required sections a summary is missing, in template order. */
export function missingSummarySections(summary: string): string[] {
  return REQUIRED_SUMMARY_SECTIONS.filter(
    (heading) => !summary.includes(heading),
  );
}

/**
 * Below this a summary is treated as a failed generation rather than a
 * successful one.
 *
 * A one-line summary of a hundred-thousand-token span throws away everything
 * compaction was supposed to preserve, and nothing downstream can tell it apart
 * from a good one — the context is simply gone.
 */
export const MIN_SUMMARY_CHARS = 200;

/**
 * How many times a summary that fails the contract is regenerated.
 *
 * Exported because it bounds the cost of a compaction: a summary that cannot be
 * made valid costs this many provider calls before the compaction fails.
 */
export const SUMMARY_ATTEMPTS = 2;

function assertSummaryContract(summary: string): void {
  const missing = missingSummarySections(summary);
  if (missing.length > 0)
    throw new Error(
      `compaction summary is missing required sections: ${missing.join(", ")}`,
    );
  if (summary.length < MIN_SUMMARY_CHARS)
    throw new Error(
      `compaction summary is too short to carry the compacted span ` +
        `(${summary.length} chars, minimum ${MIN_SUMMARY_CHARS})`,
    );
}

export function providerCompactor(
  provider: StreamingProvider,
  signal?: AbortSignal,
): Compactor {
  return {
    async compact(input) {
      // The instruction rides as the final user message, after the replayed
      // span, so everything before it is byte-identical to the request that
      // carried the same context — which is what makes the prefix cache hit.
      const instruction = [
        "Summarize this Natalia agent session for durable context compaction.",
        "Keep user goals, decisions, file/tool facts, unresolved tasks, and rollback-relevant state.",
        "If the entries contain an earlier summary, update that anchor: retain still-true details, remove stale details, and merge newer facts.",
        "When combining a prior summary with newer entries:",
        "- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the prior summary even when the newer entries do not mention them. Drop only what is finished and no longer needed.",
        "- The newer entries are more recent than the prior summary. Where they conflict, the newer entries win: state the corrected fact and drop the old claim.",
        "- Move completed work from Active to Completed.",
        "- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue.",
        "- Update Objective and Next Move to reflect the current work state.",
        "Preserve exact file paths, symbols, commands, errors, URLs, and identifiers. Do not invent facts or mention the compaction process.",
        COMPACTION_SUMMARY_TEMPLATE,
        input.instruction
          ? `Extra instruction: ${input.instruction}`
          : undefined,
        // The workspace's standing preference, after the caller's direction and
        // before the span: it qualifies what to keep, not what to summarize.
        input.userInstruction
          ? `The user of this workspace also requires: ${input.userInstruction}`
          : undefined,
        input.resources.length
          ? `Active resources:\n${input.resources.join("\n")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n\n");
      const systemContent =
        input.prefixMessages?.find((message) => message.role === "system")
          ?.content ??
        "You compact long coding-agent context into a faithful, concise operational summary. Do not invent facts.";
      // The replayed span first, then the instruction: an empty span still needs
      // the instruction, and a span that already ends in a user message still
      // needs its own, because this one is the request rather than context.
      const requestMessages: ProviderMessage[] = [
        ...(input.prefixMessages ?? []),
        ...input.messages,
        { role: "user", content: instruction },
      ];
      let lastError: unknown;
      for (let attempt = 1; attempt <= SUMMARY_ATTEMPTS; attempt += 1) {
        signal?.throwIfAborted();
        let summary = "";
        for await (const chunk of provider.stream({
          messages: requestMessages,
          signal,
        })) {
          if (chunk.type === "content") summary += chunk.text;
        }
        const trimmed = summary.trim();
        if (!trimmed) {
          lastError = new Error("provider compactor returned empty summary");
          continue;
        }
        try {
          assertSummaryContract(trimmed);
          return { summary: trimmed };
        } catch (error) {
          // A summary that drops a required section or is too short to carry
          // the span is a failed generation, so it is regenerated rather than
          // committed: the context it replaces cannot be recovered.
          lastError = error;
        }
      }
      throw lastError;
    },
  };
}

export type CompactionOptions = {
  id: string;
  trigger: CompactionTrigger;
  maxTokens: number;
  thresholdPercent: number;
  reservedTokens: number;
  preservedRecentMessages: number;
  preservedRecentTokens?: number;
  prefixMessages?: ProviderMessage[];
  beforeTokens?: number;
  instruction?: string;
  enabled?: boolean;
  force?: boolean;
  now?: () => Date;
  onEvent?: (event: RuntimeEvent) => void;
  retry?: RetryRunnerOptions;
};

export async function compactContext(
  ledger: ContextLedger,
  compactor: Compactor,
  options: CompactionOptions,
) {
  if (
    options.enabled === false &&
    !options.force &&
    options.trigger !== "manual"
  ) {
    return { compacted: false, skipped: "disabled" as const };
  }
  const snapshot = ledger.snapshot();
  const expectedRevision = ledger.surfaceRevision();
  const {
    preserved,
    compactable: compactedEntries,
    hasRange,
  } = selectCompactableRange(snapshot.entries, {
    ...(options.preservedRecentTokens === undefined
      ? {}
      : { recentTokens: options.preservedRecentTokens }),
    recentMessages: options.preservedRecentMessages,
  });
  if (!hasRange)
    return { compacted: false, skipped: "nothing_to_compact" as const };
  const retained = preserved.filter((entry) => entry.role !== "resource");
  const beforeTokens = options.beforeTokens ?? ledger.effectiveTokens();
  const started = options.now?.() ?? new Date();
  options.onEvent?.({
    type: "compaction.begin",
    id: options.id,
    trigger: options.trigger,
    beforeTokens,
    maxTokens: options.maxTokens,
    thresholdPercent: options.thresholdPercent,
    reservedTokens: options.reservedTokens,
    instruction: options.instruction,
    attempt: 1,
    startedAt: started.toISOString(),
  });
  let attempts = 1;
  const onEvent = (event: RuntimeEvent) => {
    if (event.type === "step.retry" && event.operation === "compaction")
      attempts = event.attempt;
    options.onEvent?.(event);
  };
  try {
    const result = await runWithRetry(
      { id: options.id, operation: "compaction", step: 0 },
      async () =>
        compactor.compact({
          // The span as the provider will see it, with oversized tool results
          // bounded first so the summarizer is not handed a span the request
          // never carried.
          messages: contextEntriesToProviderMessages(
            compactedEntries.map((entry) => largeToolResultContext(entry)),
          ),
          instruction: options.instruction,
          ...(options.prefixMessages
            ? { prefixMessages: options.prefixMessages }
            : {}),
          // Active resources are re-injected as live entries after compaction;
          // summarizing them too would show the model stale duplicate state.
          resources: [],
        }),
      { ...options.retry, onEvent },
    );
    if (ledger.surfaceRevision() !== expectedRevision) {
      options.onEvent?.({
        type: "compaction.end",
        id: options.id,
        trigger: options.trigger,
        success: false,
        beforeTokens,
        durationMs: Math.max(
          0,
          (options.now?.() ?? new Date()).getTime() - started.getTime(),
        ),
        attempts,
        error: "surface_changed",
      });
      return { compacted: false, skipped: "surface_changed" as const };
    }
    const content = buildCompactionPrompt(result.summary, options.instruction);
    // A compaction that does not shrink anything has spent a provider call to
    // arrive where it started, and the failure is silent from here on: the
    // context is unchanged, the threshold is still exceeded, and the next step
    // compacts again. Compare the framed summary against exactly the span it
    // replaces — not the whole ledger, whose preserved tail is untouched.
    const shadowedTokens = compactedEntries.reduce(
      (sum, entry) => sum + (entry.tokens ?? estimateTokens(entry.content)),
      0,
    );
    const summaryTokens = result.tokens ?? estimateTokens(content);
    if (summaryTokens >= shadowedTokens) {
      // Reported rather than thrown: the caller's next step still has to go out,
      // and an oversized request fails there with a context-limit error that
      // names the real problem. Throwing instead would take the turn down
      // without that diagnostic. The begin already went out, so the end has to
      // pair with it.
      options.onEvent?.({
        type: "compaction.end",
        id: options.id,
        trigger: options.trigger,
        success: false,
        beforeTokens,
        durationMs: Math.max(
          0,
          (options.now?.() ?? new Date()).getTime() - started.getTime(),
        ),
        attempts,
        error: `summary is not smaller than the span it replaces (${summaryTokens} >= ${shadowedTokens} tokens)`,
      });
      return {
        compacted: false,
        skipped: "no_shrink" as const,
        shadowedTokens,
        summaryTokens,
      };
    }
    const summary: ContextEntry = {
      id: `${options.id}:summary`,
      role: "summary",
      content,
      tokens: summaryTokens,
    };
    ledger.replaceAfterCompaction(
      summary,
      retained,
      undefined,
      expectedRevision,
    );
    const afterTokens = ledger.effectiveTokens();
    options.onEvent?.({
      type: "compaction.end",
      id: options.id,
      trigger: options.trigger,
      success: true,
      beforeTokens,
      afterTokens,
      durationMs: Math.max(
        0,
        (options.now?.() ?? new Date()).getTime() - started.getTime(),
      ),
      attempts,
    });
    return { compacted: true, beforeTokens, afterTokens };
  } catch (error) {
    ledger.restore(snapshot);
    const provider = error as ProviderError;
    options.onEvent?.({
      type: "compaction.end",
      id: options.id,
      trigger: options.trigger,
      success: false,
      beforeTokens,
      durationMs: Math.max(
        0,
        (options.now?.() ?? new Date()).getTime() - started.getTime(),
      ),
      attempts,
      error: provider.kind ?? "compaction_failed",
    });
    throw error;
  }
}

export async function recoverContextLimitOnce<T>(input: {
  id: string;
  step: number;
  ledger: ContextLedger;
  compactor: Compactor;
  compact: Omit<CompactionOptions, "trigger" | "force">;
  maxOverflowRetries?: number;
  runStep: () => Promise<T>;
  onEvent?: (event: RuntimeEvent) => void;
}) {
  const maxRetries = Math.max(0, Math.floor(input.maxOverflowRetries ?? 1));
  let retries = 0;
  while (true) {
    try {
      return await input.runStep();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        (error as ProviderError).kind !== "context_limit"
      )
        throw error;
      if (retries >= maxRetries)
        throw providerError({
          kind: "context_limit",
          message: `context-limit recovery retries exhausted (${retries})`,
          cause: error,
        });
      retries += 1;
      input.onEvent?.({
        type: "context.limit.recovery",
        id: input.id,
        step: input.step,
        attempted: true,
        compacted: false,
        reason: "context_limit",
      });
      const compacted = await compactContext(input.ledger, input.compactor, {
        ...input.compact,
        trigger: "context_limit",
        force: true,
        onEvent: input.onEvent,
      });
      input.onEvent?.({
        type: "context.limit.recovery",
        id: input.id,
        step: input.step,
        attempted: true,
        compacted: compacted.compacted,
        reason: "context_limit",
      });
    }
  }
}

export function buildCompactionPrompt(summary: string, instruction?: string) {
  return [
    "Natalia compacted context summary:",
    instruction ? `User compaction instruction: ${instruction}` : undefined,
    summary,
  ]
    .filter(Boolean)
    .join("\n\n");
}

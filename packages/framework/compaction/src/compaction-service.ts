import type { CompactionTrigger, RuntimeEvent } from "@anthelia/contracts";
import type { CompactionBudget } from "@anthelia/runtime-services";
import {
  compactContext,
  compactionTrigger,
  providerError,
  providerCompactor,
  type ProviderMessage,
  type StreamingProvider,
} from "@anthelia/runtime";
import { prepareContextRequest } from "./prepare-context-request";
import type { CompactionService, RetryService } from "@anthelia/runtime";
import type { ContextLedger } from "@anthelia/runtime";

export type CompactionOutcome = Awaited<ReturnType<typeof compactContext>>;

type CompactionOperation = {
  compactionID: string;
  ledger: ContextLedger;
  provider: StreamingProvider;
  budget: CompactionBudget;
  preservedRecentMessages: number;
  preservedRecentTokens?: number;
  maxOverflowRetries?: number;
  prefixMessages?: ProviderMessage[];
  instruction: string;
  signal?: AbortSignal;
  onEvent?: (event: RuntimeEvent) => void;
};

export function createCompactionService(input: {
  retry: RetryService;
}): CompactionService {
  const compact = (
    operation: CompactionOperation,
    trigger: CompactionTrigger,
    options?: {
      enabled?: boolean;
      force?: boolean;
      overflow?: boolean;
      beforeTokens?: number;
    },
  ) =>
    compactContext(
      operation.ledger,
      providerCompactor(operation.provider, operation.signal),
      {
        id: operation.compactionID,
        trigger,
        maxTokens: operation.budget.max,
        thresholdPercent: operation.budget.thresholdPercent,
        reservedTokens: operation.budget.reserved,
        preservedRecentMessages: operation.preservedRecentMessages,
        ...(operation.preservedRecentTokens === undefined
          ? {}
          : { preservedRecentTokens: operation.preservedRecentTokens }),
        ...(operation.prefixMessages
          ? { prefixMessages: operation.prefixMessages }
          : {}),
        instruction: operation.instruction,
        onEvent: operation.onEvent,
        retry: { policy: input.retry.policy(), signal: operation.signal },
        // The overflow relief path reaches the retained tail: the provider
        // already refused the request WITH the tail preserved, so a
        // pressure-shaped reduction cannot fix what it is being asked to
        // fix. Declared after the operation's own policy so it wins.
        ...(options?.overflow
          ? {
              overflow: true,
              preservedRecentMessages: 0,
              preservedRecentTokens: 0,
            }
          : {}),
        ...options,
      },
    );

  return {
    async compactBeforeProviderStep(operation) {
      const trigger = compactionTrigger({
        used: operation.usedTokens,
        max: operation.budget.max,
        thresholdPercent: operation.budget.thresholdPercent,
        reserved: operation.budget.reserved,
      });
      if (!trigger)
        return { compacted: false, skipped: "nothing_to_compact" as const };
      return {
        ...(await compact(operation, trigger, {
          enabled: operation.enabled,
          beforeTokens: operation.usedTokens,
        })),
        trigger,
      };
    },
    async prepareContextRequest(request) {
      return prepareContextRequest({
        ...request,
        retry: {
          policy: request.retry?.policy ?? input.retry.policy(),
          signal: request.signal,
        },
      });
    },
    async runWithContextLimitRecovery(operation) {
      const maxRetries = Math.max(
        0,
        Math.floor(operation.maxOverflowRetries ?? 1),
      );
      let retries = 0;
      while (true) {
        try {
          return await operation.runStep();
        } catch (error) {
          if ((error as { kind?: string }).kind !== "context_limit")
            throw error;
          if (retries >= maxRetries)
            throw providerError({
              kind: "context_limit",
              message: `context-limit recovery retries exhausted (${retries})`,
              cause: error,
            });
          retries += 1;
          operation.onEvent?.({
            type: "context.limit.recovery",
            id: operation.id,
            step: operation.step,
            attempted: true,
            compacted: false,
            reason: "context_limit",
          });
          // A compaction that FAILS is reported, not fatal: the provider
          // refused the request, the relief attempt could not be made, and
          // the retry is still worth one more request — the refusal may be
          // transient, and the retry's own failure is the error the turn
          // should end on. Letting the compaction's throw escape here used
          // to take the turn down with the auxiliary call's error while the
          // real one (the provider's refusal) went unreported.
          let compacted = false;
          try {
            const outcome = await compact(operation, "context_limit", {
              force: true,
              overflow: true,
            });
            compacted = outcome.compacted === true;
            if (compacted) await operation.onCompacted?.(outcome);
          } catch (compactionError) {
            operation.onEvent?.({
              type: "compaction.end",
              id: operation.id,
              trigger: "context_limit",
              success: false,
              error:
                compactionError instanceof Error
                  ? compactionError.message
                  : String(compactionError),
            });
          }
          operation.onEvent?.({
            type: "context.limit.recovery",
            id: operation.id,
            step: operation.step,
            attempted: true,
            compacted,
            reason: "context_limit",
          });
          await operation.beforeRetry?.({ compacted });
        }
      }
    },
  };
}

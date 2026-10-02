import type { RuntimeEvent, StepRetryOperation } from "@anthelia/contracts";
import {
  asProviderError,
  providerError,
  redactedProviderMessage,
  type ProviderError,
} from "./errors";

export type RetryTimer = (ms: number) => Promise<void>;
export type RetryRandom = () => number;

export type RetryPolicy = {
  /** Null keeps transient provider failures alive until success or cancellation. */
  maxAttemptsPerStep: number | null;
  initialBackoffMs: number;
  maxBackoffMs: number;
  jitterMs: number;
  maxRetryAfterMs: number;
};

export type RetryContext = {
  id: string;
  operation: StepRetryOperation;
  step: number;
};

export type RetryRunnerOptions = {
  policy?: Partial<RetryPolicy>;
  timer?: RetryTimer;
  random?: RetryRandom;
  onEvent?: (event: RuntimeEvent) => void;
  signal?: AbortSignal;
};

export type RetryAttemptContext = {
  attempt: number;
  maxAttempts: number | null;
};

export const defaultRetryPolicy: RetryPolicy = {
  maxAttemptsPerStep: null,
  initialBackoffMs: 300,
  maxBackoffMs: 5000,
  jitterMs: 500,
  maxRetryAfterMs: 5000,
};

export function shouldRetryProviderError(error: ProviderError) {
  if (error.kind === "timeout") return true;
  if (error.kind === "connection") return true;
  if (error.kind === "empty_response") return true;
  if (error.kind === "rate_limit") return true;
  if (error.kind === "server") return true;
  return false;
}

export function retryDelayMs(
  error: ProviderError,
  retryIndex: number,
  policy: RetryPolicy = defaultRetryPolicy,
  random: RetryRandom = Math.random,
) {
  const retryAfter = error.retryAfterMs;
  if (retryAfter !== undefined)
    return Math.min(retryAfter, policy.maxRetryAfterMs);
  const exponential =
    policy.initialBackoffMs * 2 ** Math.max(0, retryIndex - 1);
  const base = Math.min(exponential, policy.maxBackoffMs);
  const jitter =
    policy.jitterMs > 0 ? Math.floor(random() * (policy.jitterMs + 1)) : 0;
  return Math.min(base + jitter, policy.maxBackoffMs);
}

export async function runWithRetry<T>(
  context: RetryContext,
  fn: (attempt: RetryAttemptContext) => Promise<T>,
  options: RetryRunnerOptions = {},
) {
  const policy = { ...defaultRetryPolicy, ...options.policy };
  const timer = options.timer ?? ((ms) => Bun.sleep(ms));
  const random = options.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      throwIfAborted(options.signal);
      const result = await fn({
        attempt,
        maxAttempts: policy.maxAttemptsPerStep,
      });
      if (attempt > 1) {
        options.onEvent?.({
          type: "step.retry.cleared",
          id: context.id,
          operation: context.operation,
          step: context.step,
          attempts: attempt,
        });
      }
      return result;
    } catch (error) {
      if (options.signal?.aborted) {
        const cancelled = cancellationError(options.signal);
        if (attempt > 1)
          options.onEvent?.({
            type: "step.retry.exhausted",
            id: context.id,
            operation: context.operation,
            step: context.step,
            attempts: attempt,
            maxAttempts: policy.maxAttemptsPerStep,
            reason: cancelled.kind,
            retryable: false,
            message: redactedProviderMessage(cancelled),
          });
        throw cancelled;
      }
      const providerError = asProviderError(error);
      const canRetry = shouldRetryProviderError(providerError);
      const exhausted =
        policy.maxAttemptsPerStep !== null &&
        attempt >= policy.maxAttemptsPerStep;
      if (!canRetry || exhausted) {
        options.onEvent?.({
          type: "step.retry.exhausted",
          id: context.id,
          operation: context.operation,
          step: context.step,
          attempts: attempt,
          maxAttempts: policy.maxAttemptsPerStep,
          reason: providerError.kind,
          retryable: canRetry,
          statusCode: providerError.statusCode,
          message: redactedProviderMessage(providerError),
        });
        throw providerError;
      }
      const waitMs = retryDelayMs(providerError, attempt, policy, random);
      options.onEvent?.({
        type: "step.retry",
        id: context.id,
        operation: context.operation,
        step: context.step,
        attempt: attempt + 1,
        maxAttempts: policy.maxAttemptsPerStep,
        waitMs,
        reason: providerError.kind,
        statusCode: providerError.statusCode,
      });
      try {
        await waitForRetry(waitMs, timer, options.signal);
      } catch (error) {
        const cancelled = asProviderError(error);
        options.onEvent?.({
          type: "step.retry.exhausted",
          id: context.id,
          operation: context.operation,
          step: context.step,
          attempts: attempt,
          maxAttempts: policy.maxAttemptsPerStep,
          reason: cancelled.kind,
          retryable: false,
          statusCode: cancelled.statusCode,
          message: redactedProviderMessage(cancelled),
        });
        throw cancelled;
      }
    }
  }
}

async function waitForRetry(
  waitMs: number,
  timer: RetryTimer,
  signal?: AbortSignal,
) {
  if (!signal) return await timer(waitMs);
  throwIfAborted(signal);
  let abort: (() => void) | undefined;
  try {
    await Promise.race([
      timer(waitMs),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(cancellationError(signal));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw cancellationError(signal);
}

function cancellationError(signal: AbortSignal) {
  return providerError({
    kind: "cancel",
    message: "provider request cancelled",
    cause: signal.reason,
  });
}

export async function runStreamingWithRetry(
  context: RetryContext,
  fn: (
    attempt: RetryAttemptContext,
    emitTransient: (chunk: string) => void,
  ) => Promise<string[]>,
  options: RetryRunnerOptions & {
    onCommit?: (chunk: string, attempt: number) => void;
  } = {},
) {
  return runWithRetry(
    context,
    async (attempt) => {
      const transient: string[] = [];
      const committed = await fn(attempt, (chunk) => transient.push(chunk));
      const output = committed.length ? committed : transient;
      for (const chunk of output) options.onCommit?.(chunk, attempt.attempt);
      return output;
    },
    options,
  );
}

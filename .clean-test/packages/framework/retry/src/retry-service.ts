import { runWithRetry, type RetryRunnerOptions } from "@anthelia/runtime";
import type { RetryService } from "@anthelia/runtime";

export function createRetryService(input: {
  policy(): RetryRunnerOptions["policy"];
}): RetryService {
  return {
    policy: input.policy,
    run: (context, fn, options = {}) =>
      runWithRetry(context, fn, { ...options, policy: input.policy() }),
  };
}

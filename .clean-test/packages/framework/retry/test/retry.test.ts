import { expect, test } from "bun:test";
import type { RetryService } from "@anthelia/runtime";
import { retryService } from "../src";
import { createRetryService } from "../src";

test("retry service is provided under the shared service key", () => {
  const service = createRetryService({ policy: () => undefined });
  expect(retryService.id).toBe("retry.service");
  expect(service.policy).toBeTypeOf("function");
  expect(service.run).toBeTypeOf("function");
});

test("retry service reads the current policy for every execution", async () => {
  let maxAttemptsPerStep = 1;
  let policyReads = 0;
  const service: RetryService = createRetryService({
    policy: () => {
      policyReads += 1;
      return { maxAttemptsPerStep };
    },
  });

  const context = {
    id: "turn-retry-policy",
    operation: "llm_step",
    step: 1,
  } as const;
  expect(
    await service.run(context, async (attempt) => attempt.maxAttempts),
  ).toBe(1);
  maxAttemptsPerStep = 3;
  expect(
    await service.run(context, async (attempt) => attempt.maxAttempts),
  ).toBe(3);
  expect(policyReads).toBe(2);
});

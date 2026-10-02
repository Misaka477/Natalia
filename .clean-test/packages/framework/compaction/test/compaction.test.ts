import { expect, test } from "bun:test";
import { createContextLedgerFactory } from "@natalia/context-ledger";
import { createRetryService } from "@anthelia/retry";
import type { CompactionService } from "@anthelia/runtime";
import { createCompactionService } from "../src";

test("compaction service is constructed from retry and context-ledger dependencies", () => {
  const retry = createRetryService({ policy: () => undefined });
  const contextLedgerFactory = createContextLedgerFactory();
  const service = createCompactionService({ retry });
  expect(service).toBeDefined();
  expect(contextLedgerFactory.create()).toBeDefined();
});

test("overflow recovery surfaces exhaustion when maxOverflowRetries is zero", async () => {
  const retry = createRetryService({ policy: () => undefined });
  const service: CompactionService = createCompactionService({ retry });
  const ledger = createContextLedgerFactory().create();
  ledger.add({ id: "old", role: "assistant", content: "old context" });
  let calls = 0;
  await expect(
    service.runWithContextLimitRecovery({
      id: "turn-overflow",
      step: 1,
      compactionID: "compact-overflow",
      ledger,
      provider: {
        provider: "fixture",
        model: "fixture",
        async *stream() {
          yield { type: "content" as const, text: "summary" };
        },
      },
      budget: { max: 100, thresholdPercent: 80, reserved: 10 },
      preservedRecentMessages: 0,
      maxOverflowRetries: 0,
      instruction: "",
      async runStep() {
        calls += 1;
        throw { kind: "context_limit", message: "too long" };
      },
    }),
  ).rejects.toMatchObject({
    kind: "context_limit",
    message: expect.stringContaining("retries exhausted (0)"),
  });
  expect(calls).toBe(1);
});

test("compaction skips provider work below the configured threshold", async () => {
  const retry = createRetryService({ policy: () => undefined });
  const service: CompactionService = createCompactionService({ retry });
  let providerCalls = 0;
  const outcome = await service.compactBeforeProviderStep({
    compactionID: "compact-1",
    ledger: createContextLedgerFactory().create(),
    provider: {
      provider: "fixture",
      model: "fixture",
      async *stream() {
        providerCalls += 1;
      },
    },
    budget: { max: 1000, thresholdPercent: 80, reserved: 100 },
    preservedRecentMessages: 4,
    instruction: "",
    usedTokens: 10,
    enabled: true,
  });
  expect(outcome).toEqual({ compacted: false, skipped: "nothing_to_compact" });
  expect(providerCalls).toBe(0);
});

import { expect, test } from "bun:test";
import {
  assertContextBudgetInvariants,
  contextThresholdTokens,
} from "@anthelia/runtime";
import { defaultContextStatusConfig } from "../src/runtime/provider-selection";

test("the default context config is a complete ContextBudget", () => {
  const budget = defaultContextStatusConfig();
  // Every field the plan §2.3 budget promises is resolved up front, so no
  // reader has to fall back to raw config with its own default.
  expect(budget.max).toBeGreaterThan(0);
  expect(budget.thresholdPercent).toBeGreaterThan(0);
  expect(budget.reserved).toBeGreaterThan(0);
  expect(budget.reservedSource).toBeTruthy();
  expect(budget.preservedRecentMessages).toBeGreaterThan(0);
  expect(budget.preservedRecentTokens).toBe(0);
  expect(budget.maxOverflowRetries).toBeGreaterThanOrEqual(0);
  expect(budget.prune.thresholdChars).toBeGreaterThan(0);
  // The default must itself satisfy the config-time invariant.
  expect(() => assertContextBudgetInvariants(budget)).not.toThrow();
});

test("the default budget derives the threshold from its window and percent", () => {
  const budget = defaultContextStatusConfig();
  expect(contextThresholdTokens(budget)).toBe(
    Math.floor((budget.max * budget.thresholdPercent) / 100),
  );
});

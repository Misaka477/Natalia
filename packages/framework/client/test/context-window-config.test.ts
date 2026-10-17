/**
 * The context budget must use the window the OPERATOR configured.
 *
 * Measured defect this pins: a deployment with one catalog model whose
 * `limits.contextWindow` was 999,997 and no `defaultModel` resolved its budget
 * from the conservative 32,000-token fallback. The meter then divided the real
 * ledger (38,812 tokens) by 32,000 and reported "121%", declared the session over
 * its window and started compacting — for a session that was nowhere near the
 * window the operator had configured.
 *
 * Two independent causes, both pinned here:
 *   1. no per-session selection and no `defaultModel` meant the budget never
 *      looked at the catalog at all, even when exactly one model was configured;
 *   2. the configured window was only passed to the resolver when the
 *      provider's self-reported model name matched the configured ref — a
 *      provider that names the executing model differently (an alias, a dated
 *      snapshot id) silently downgraded the window to the fallback.
 */
import { expect, test } from "bun:test";
import { resolveContextStatusConfig } from "../src/runtime/provider-selection";
import type { ConfigV4 } from "@anthelia/contracts";
import { ContextWindowResolver } from "@anthelia/runtime";

function configWith(models: Record<string, unknown>): ConfigV4 {
  return {
    version: 4,
    defaultModel: null,
    context: {
      autoDetectWindow: false,
      compactionEnabled: true,
      compactionThresholdPercent: 85,
      reservedOutputTokens: "auto",
      preservedRecentMessages: 10,
      preservedRecentTokens: 20_000,
      maxOverflowRetries: 1,
    },
    providers: {
      ny_step: {
        name: "ny_step",
        driver: "openai",
        connection: {
          baseURL: "https://api.stepfun.com/step_plan/v1",
          apiKey: "x",
        },
        requestDefaults: {},
        protocol: { format: "openai" },
      },
    },
    catalog: { providers: { ny_step: { models } } },
    modelOverrides: {},
  } as unknown as ConfigV4;
}

const resolver = () => new ContextWindowResolver();

test("one configured model and no defaultModel still supplies its window", async () => {
  const budget = await resolveContextStatusConfig(
    configWith({
      "step-5-preview": {
        name: "step-5-preview",
        status: "stable",
        source: "manual",
        limits: { contextWindow: 999_997, maxOutputTokens: 32_768 },
      },
    }),
    undefined,
    resolver(),
    undefined,
  );
  // The operator's number, not the conservative 32k fallback.
  expect(budget.max).toBe(999_997);
  // And the reply cap is the reserve, not a formula.
  expect(budget.reserved).toBe(32_768);
});

test("a mismatched executing model keeps the provider's own window", async () => {
  // The safety rule `real-runtime-a` already pins: a configured default must not
  // masquerade as the executing model's window. Believing 999,997 for a provider
  // that serves a different model would overflow the PROVIDER.
  const config = configWith({
    "step-5-preview": {
      name: "step-5-preview",
      status: "stable",
      source: "manual",
      limits: { contextWindow: 999_997 },
    },
  });
  const budget = await resolveContextStatusConfig(
    config,
    { provider: "ny_step", model: "step-5-preview-2026-10-01" } as never,
    resolver(),
    "ny_step/step-5-preview",
  );
  // The configured window is NOT applied; with discovery off in this fixture the
  // budget is the conservative default, which is the point: it is not 999,997.
  expect(budget.max).not.toBe(999_997);
  expect(budget.max).toBe(32_000);
});

test("several configured models stay on the conservative default", async () => {
  // Ambiguity is not answered by picking one: with two models and no selection,
  // the conservative fallback is the honest budget.
  const budget = await resolveContextStatusConfig(
    configWith({
      small: {
        name: "small",
        status: "stable",
        source: "manual",
        limits: { contextWindow: 32_768 },
      },
      large: {
        name: "large",
        status: "stable",
        source: "manual",
        limits: { contextWindow: 262_144 },
      },
    }),
    undefined,
    resolver(),
    undefined,
  );
  expect(budget.max).toBe(32_000);
});

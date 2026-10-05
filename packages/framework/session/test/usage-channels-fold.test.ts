// Does per-channel usage survive the fold that a restarting UI starts from?
//
// The user's report: the usage bar has numbers for `main` but navi / nia /
// subagent read 0 on every start, so the data "never lands". The bar's static
// value after a restart comes from folding the durable journal
// (packages/framework/session/src/projector.ts), so this pins that fold for all
// three channels — if a channel is absent here, it is absent in the bar.
import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  emptySessionUsageTotals,
  foldSessionUsageInto,
} from "../src/projector.ts";

function stepUsage(
  type: string,
  inputTokens: number,
): Extract<RuntimeEvent, { type: "runtime.step_usage" }> {
  return {
    type,
    id: `${type}:1`,
    inputTokens,
    outputTokens: 10,
  } as unknown as Extract<RuntimeEvent, { type: "runtime.step_usage" }>;
}

test("the durable fold attributes usage to main, navi and nia", () => {
  const totals = emptySessionUsageTotals();
  foldSessionUsageInto(totals, stepUsage("runtime.step_usage", 1_000));
  foldSessionUsageInto(totals, stepUsage("navi.runtime.step_usage", 20));
  foldSessionUsageInto(totals, stepUsage("nia.runtime.step_usage", 3));

  expect(totals.main.inputTokens).toBe(1_000);
  expect(totals.navi.inputTokens).toBe(20);
  expect(totals.nia.inputTokens).toBe(3);
});

test("an explicitly tagged event beats the legacy default", () => {
  // A `runtime.step_usage` carrying channel:"navi" is a channel-tagged step on
  // the un-namespaced type — the form the main provider runner uses for a
  // channel run. It must not be counted as main.
  const totals = emptySessionUsageTotals();
  foldSessionUsageInto(totals, {
    ...stepUsage("runtime.step_usage", 500),
    channel: "navi",
  } as unknown as RuntimeEvent);

  expect(totals.navi.inputTokens).toBe(500);
  expect(totals.main.inputTokens).toBe(0);
});

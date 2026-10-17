/**
 * The step figure is ONE number: provider steps, counted the same way the
 * session usage bar counts them.
 *
 * Measured defect this pins: `status.snapshot.step` carried the journal's
 * entry count (`context.journalStatus().messageCount`), and `/status` printed
 * it as `steps:`. A live session therefore read 422 steps on `/status` while
 * the usage bar — counting `runtime.step_usage`, one per provider step — read
 * 140 for the same run. Two numbers under one word, so neither could be
 * trusted.
 *
 * The snapshot now carries the provider-step figure separately, and `/status`
 * reads THAT. `step` stays the journal count as an internal stamp (the
 * checkpoints and work-graph nodes use the same measure) but is no longer
 * printed as a step count.
 */
import { expect, test } from "bun:test";
import {
  emptySessionUsageTotals,
  foldSessionUsageInto,
} from "@anthelia/session";
import { statusSnapshot } from "../src/status-controller";
import type { RuntimeEvent } from "@anthelia/contracts";

const ledger = {
  journalStatus: () => ({ tokenEstimate: 4242, messageCount: 422 }),
};

function snapshotFor(
  steps?: number,
): Extract<RuntimeEvent, { type: "status.snapshot" }> {
  return statusSnapshot(
    { provider: "openai-compatible", model: "step-5-preview" },
    ledger,
    "E:\\ws",
    "auto",
    0,
    steps,
    "win32",
  );
}

test("the snapshot carries the caller's provider-step figure", () => {
  const event = snapshotFor(140);
  expect(event.steps).toBe(140);
  // The journal count stays available as its own field: an internal stamp,
  // never the number a face prints as "steps".
  expect(event.step).toBe("422");
});

test("a session nobody counted reports no steps rather than the journal count", () => {
  const event = snapshotFor(undefined);
  expect(event.steps).toBeUndefined();
  expect(event.step).toBe("422");
});

test("the step figure is the same one the usage bar counts", () => {
  const totals = emptySessionUsageTotals();
  for (let index = 0; index < 140; index += 1) {
    foldSessionUsageInto(totals, {
      type: "runtime.step_usage",
      id: `turn_1:usage:${index}`,
    } as RuntimeEvent);
  }
  // One `runtime.step_usage` per provider step is the authority both the bar
  // and the snapshot read, so the two faces cannot drift apart again.
  expect(totals.main.steps).toBe(140);
  expect(snapshotFor(totals.main.steps).steps).toBe(totals.main.steps);
});

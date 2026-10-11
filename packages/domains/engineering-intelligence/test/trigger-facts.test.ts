import { expect, test } from "bun:test";
import {
  holdoutDeltaFromRuns,
  topPotentialFromTriggers,
} from "../src/trigger-facts";

/**
 * S8's trigger inputs, read from where they live. "No data" is never a
 * signal: absence refuses, which is the safe direction.
 */

test("the top-ranked trigger's potential is the ranking's first row", () => {
  // The triage already sorts, so reading the first row is the whole read —
  // a second ranking would be a second thing to keep honest.
  expect(
    topPotentialFromTriggers([{ score: 0.8 }, { score: 0.3 }, { score: 0.1 }]),
  ).toBe(0.8);
  expect(topPotentialFromTriggers([])).toBe(0);
});

test("the holdout delta is the last two rounds' movement", () => {
  expect(
    holdoutDeltaFromRuns([{ holdout: 0.5 }, { holdout: 0.42 }]),
  ).toBeCloseTo(-0.08, 6);
  // Rounds without a holdout score are skipped, not read as zero.
  expect(
    holdoutDeltaFromRuns([{ holdout: 0.5 }, {}, { holdout: 0.45 }]),
  ).toBeCloseTo(-0.05, 6);
});

test("no history is a flat delta — absence is never a signal", () => {
  // The safe direction: a loop that reads absence as urgency spends on
  // nothing.
  expect(holdoutDeltaFromRuns([])).toBe(0);
  expect(holdoutDeltaFromRuns([{ holdout: 0.5 }])).toBe(0);
  expect(holdoutDeltaFromRuns([{}, {}])).toBe(0);
});

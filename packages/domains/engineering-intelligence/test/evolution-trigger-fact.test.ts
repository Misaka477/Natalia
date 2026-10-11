import { expect, test } from "bun:test";
import { triggerFactFrom } from "../src/evolution-trigger";

/**
 * The trigger's fact: the system noticing, on the record, that a round is
 * due. A gate that refuses produces nothing; an already-announced gap
 * produces nothing (the same gap once per turn is noise).
 */

const triggers = [{ capability: "retry backoff", score: 0.6 }];
const runs = [{ holdout: 0.5 }, { holdout: 0.42 }];

test("the gates passing produces a durable fact carrying the reason", () => {
  const out = triggerFactFrom({
    triggers,
    runs,
    activeEvolutions: 0,
    alreadyTriggered: [],
  });
  expect("fact" in out).toBe(true);
  if (!("fact" in out)) return;
  expect(out.fact.capability).toBe("retry backoff");
  expect(out.fact.holdoutDelta).toBeCloseTo(-0.08, 6);
  // The reason rides, so a reader sees WHY a round was announced.
  expect(out.fact.reason).toContain("run a round");
});

test("a refusing gate produces nothing, and says which gate", () => {
  const busy = triggerFactFrom({
    triggers,
    runs,
    activeEvolutions: 2,
    alreadyTriggered: [],
  });
  expect("none" in busy).toBe(true);
  if (!("none" in busy)) return;
  expect(busy.reason).toContain("concurrency budget");
});

test("the same gap is announced once", () => {
  const again = triggerFactFrom({
    triggers,
    runs,
    activeEvolutions: 0,
    alreadyTriggered: ["retry backoff"],
  });
  expect("none" in again).toBe(true);
  if (!("none" in again)) return;
  expect(again.reason).toContain("already announced");
});

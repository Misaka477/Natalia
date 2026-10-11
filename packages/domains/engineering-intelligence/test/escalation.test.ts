import { expect, test } from "bun:test";
import { escalationAdvice, plasticityIndex } from "../src/escalation";

/**
 * W8: the ladder. A failed phase gate used to stop with a shrug; now it
 * names the rung, and the FIRST suspicion is always the measurement — a
 * cheap judge cannot see what it cannot score.
 */

test("a beaten floor gets no advice", () => {
  const advice = escalationAdvice({
    beatFloor: true,
    plasticity: plasticityIndex({ acquisitions: 3, rollbacks: 1 }),
    consecutiveFailures: 0,
    evaluated: 5,
  });
  expect(advice.step).toBeUndefined();
  expect(advice.reason).toContain("nothing to escalate");
});

test("the first suspicion is the measurement, not the artifact", () => {
  // Too few candidates: the sample is the problem, and saying so is more
  // honest than a diagnosis.
  const thin = escalationAdvice({
    beatFloor: false,
    plasticity: plasticityIndex({ acquisitions: 0, rollbacks: 0 }),
    consecutiveFailures: 1,
    evaluated: 2,
  });
  expect(thin.step).toBe("retry-with-a-stronger-judge");
  expect(thin.reason).toContain("too few to distinguish");

  // A fair chance, one stall: still the judge (its UNJUDGED dimensions
  // are named).
  const judge = escalationAdvice({
    beatFloor: false,
    plasticity: plasticityIndex({ acquisitions: 0, rollbacks: 2 }),
    consecutiveFailures: 1,
    evaluated: 6,
  });
  expect(judge.step).toBe("retry-with-a-stronger-judge");
  expect(judge.reason).toContain("UNJUDGED");
});

test("an exhausted neighbourhood escalates to same-domain replacement", () => {
  const advice = escalationAdvice({
    beatFloor: false,
    plasticity: plasticityIndex({ acquisitions: 4, rollbacks: 1 }),
    consecutiveFailures: 3,
    evaluated: 8,
  });
  expect(advice.step).toBe("supersede-same-domain");
  expect(advice.reason).toContain("neighbourhood is exhausted");
});

test("a falling plasticity index escalates to a framework change, through the four faces", () => {
  const advice = escalationAdvice({
    beatFloor: false,
    plasticity: plasticityIndex({ acquisitions: 1, rollbacks: 6 }),
    consecutiveFailures: 4,
    evaluated: 9,
  });
  expect(advice.step).toBe("propose-generation");
  expect(advice.reason).toContain("plasticity 0.17");
  expect(advice.reason).toContain("apply_generation");
  // The advice NEVER performs the migration — it names the path.
  expect(advice.reason).toContain("never by hand");
});

test("the plasticity index is acquisitions over rollbacks, zero-safe", () => {
  expect(plasticityIndex({ acquisitions: 3, rollbacks: 1 }).value).toBe(3);
  expect(plasticityIndex({ acquisitions: 0, rollbacks: 0 }).value).toBe(0);
  expect(plasticityIndex({ acquisitions: 2, rollbacks: 0 }).value).toBe(2);
});

import { expect, test } from "bun:test";
import {
  acceptCandidate,
  checkGrowth,
  compositeFitness,
  createEvaluationFace,
  evaluateBaseline,
  keywordOverlapJudge,
  lengthPenalty,
  samplesFromPairs,
  type EvaluationSample,
  type FitnessDimensions,
} from "../src/evaluation";
import { splitDataset, type DatasetPair } from "../src/dataset-miner";

/**
 * L3's evaluation layer: the holdout's purity, the composite formula, the
 * continuous length penalty, the growth cap, and the strict acceptance
 * rule.
 *
 * The purity test is the one that matters most: it injects an optimizer
 * that TRIES to read the holdout and proves the attempt is refused. A
 * holdout kept apart by convention is a holdout that leaks the first time
 * somebody is in a hurry.
 */

const dims = (
  correctness: number,
  procedureFollowing = 1,
  conciseness = 1,
): FitnessDimensions => ({ correctness, procedureFollowing, conciseness });

const sample = (id: string, feedback?: string): EvaluationSample => ({
  id,
  input: `task ${id}`,
  output: `reference ${id}`,
  ...(feedback ? { feedback } : {}),
});

/** A judge that scores every sample full marks except the named ones. */
function judge(failures: Record<string, number> = {}) {
  return (candidate: EvaluationSample) =>
    dims(
      failures[candidate.id] ?? 1,
      failures[candidate.id] === undefined ? 1 : 0.5,
    );
}

const CANDIDATE = { id: "c1", artifactSize: 1_000, maxSize: 10_000 };

test("the holdout is physically absent from the evaluation face", () => {
  // The pool the face evaluates carries train + val only. The holdout
  // enters through the constructor and leaves as a number.
  const face = createEvaluationFace({
    pool: {
      samples: [sample("train:a", "missed the rollback step"), sample("val:b")],
    },
    holdout: [sample("holdout:secret", "the sealed failure detail")],
    judge: judge({ "train:a": 0.5, "holdout:secret": 0 }),
  });
  const result = face.evaluate(CANDIDATE);
  // The trainable bucket is readable and carries its feedback.
  expect(result.trainableFailureCases).toEqual([
    {
      sampleID: "train:a",
      failureType: "correctness",
      detail: "missed the rollback step",
    },
  ]);
  // The holdout's failure is COUNTED in the bucket…
  expect(result.holdoutFailureCases).toHaveLength(1);
  expect(result.holdoutFailureCases[0]).toMatchObject({
    sampleID: "holdout:secret",
  });
  // …and the holdout's detail never rides the mutator-visible answer.
  expect(JSON.stringify(result.trainableFailureCases)).not.toContain("sealed");
  // The score blends both pools: being great on the visible pool cannot
  // buy fitness while the sealed one fails.
  expect(result.score).toBeLessThan(1);
  expect(result.score).toBeGreaterThan(0);
  // The only holdout door returns a number, never cases.
  expect(typeof face.scoreHoldout(CANDIDATE)).toBe("number");
});

test("an optimizer that reaches for the holdout is refused, not served", () => {
  const face = createEvaluationFace({
    pool: { samples: [sample("train:a")] },
    holdout: [sample("holdout:x", "sealed detail")],
    judge: judge(),
  });
  // The split argument's type is train|val; a cast that smuggles the
  // holdout in meets a refusal, not an empty list that reads as "nothing
  // to see".
  expect(() => face.trainableCases("holdout" as unknown as "train")).toThrow(
    /unknown split: holdout/,
  );
  expect(() => face.trainableCases("test" as unknown as "train")).toThrow(
    /the visible splits are train, val/,
  );
  // The face exposes no other holdout surface: the doors are evaluate,
  // scoreHoldout and trainableCases, and none of them returns a holdout
  // case.
  expect(Object.keys(face).sort()).toEqual([
    "evaluate",
    "scoreHoldout",
    "trainableCases",
  ]);
});

test("the composite is the weighted dimensions minus the length penalty", () => {
  // 0.5*1 + 0.3*1 + 0.2*1 = 1.0 with no penalty.
  expect(
    compositeFitness(dims(1, 1, 1), { artifactSize: 1, maxSize: 100 }),
  ).toBe(1);
  // 0.5*0.8 + 0.3*0.6 + 0.2*0.5 = 0.68.
  expect(
    compositeFitness(dims(0.8, 0.6, 0.5), { artifactSize: 1, maxSize: 100 }),
  ).toBeCloseTo(0.68, 10);
  // The weights order the dimensions: the same 0.2 gap moves the
  // composite 0.10 through correctness, 0.06 through procedure and 0.04
  // through conciseness — correctness is the dimension a judge argues
  // about, the other two are refinements.
  const base = dims(0.8, 0.5, 0.5);
  const sizes = { artifactSize: 1, maxSize: 100 };
  expect(
    compositeFitness(dims(1, 0.5, 0.5), sizes) - compositeFitness(base, sizes),
  ).toBeCloseTo(0.1, 10);
  expect(
    compositeFitness(dims(0.8, 0.7, 0.5), sizes) -
      compositeFitness(base, sizes),
  ).toBeCloseTo(0.06, 10);
  expect(
    compositeFitness(dims(0.8, 0.5, 0.7), sizes) -
      compositeFitness(base, sizes),
  ).toBeCloseTo(0.04, 10);
  // Out-of-range dimensions clamp rather than inflate.
  expect(
    compositeFitness(dims(4, -2, 1), { artifactSize: 1, maxSize: 100 }),
  ).toBeCloseTo(0.7, 10);
});

test("the length penalty is continuous: 89% costs nothing, 95% costs 0.15, 100% costs 0.3", () => {
  expect(lengthPenalty(8_900, 10_000)).toBe(0);
  expect(lengthPenalty(9_500, 10_000)).toBeCloseTo(0.15, 6);
  expect(lengthPenalty(10_000, 10_000)).toBeCloseTo(0.3, 6);
  // Over the cap the penalty saturates rather than growing without bound.
  expect(lengthPenalty(20_000, 10_000)).toBe(0.3);
  // A zero or absurd cap is not a division hazard.
  expect(lengthPenalty(100, 0)).toBe(0);
  expect(lengthPenalty(0, 10_000)).toBe(0);
});

test("the growth cap refuses past +20% and admits up to it", () => {
  // +19% passes.
  expect(checkGrowth(1_000, 1_190)).toEqual({ ok: true, ratio: 1.19 });
  // Exactly +20% passes — the cap is inclusive.
  expect(checkGrowth(1_000, 1_200).ok).toBe(true);
  // +21% is refused, and the reason names the overshoot.
  const refused = checkGrowth(1_000, 1_210);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.reason).toContain("21% over baseline");
  // A shrink is always fine (the cap is about growth).
  expect(checkGrowth(1_000, 400).ok).toBe(true);
});

test("acceptance is strict improvement; a tie is a rejection", () => {
  const result = (score: number) => ({
    score,
    trainableFailureCases: [],
    holdoutFailureCases: [],
    isViable: true,
  });
  expect(
    acceptCandidate({ baseline: result(0.5), candidate: result(0.6) }),
  ).toEqual({ accepted: true, reason: "strict improvement" });
  const tie = acceptCandidate({
    baseline: result(0.5),
    candidate: result(0.5),
  });
  expect(tie.accepted).toBe(false);
  expect(tie.reason).toContain("a tie is not an improvement");
  // Equal-move exploration is an explicit opt-in.
  expect(
    acceptCandidate({
      baseline: result(0.5),
      candidate: result(0.5),
      allowEqual: true,
    }).accepted,
  ).toBe(true);
  // A regression is refused with both numbers on the table.
  const worse = acceptCandidate({
    baseline: result(0.5),
    candidate: result(0.4),
  });
  expect(worse.accepted).toBe(false);
  expect(worse.reason).toContain("0.4000");
  expect(worse.reason).toContain("0.5000");
});

test("a candidate with no trainable failure case is not viable as a parent", () => {
  // The reference evolver's rule: an artifact that never failed anywhere
  // has nothing to evolve FROM, so it may not reproduce.
  const face = createEvaluationFace({
    pool: { samples: [sample("train:a"), sample("val:b")] },
    holdout: [sample("holdout:c")],
    judge: judge(),
  });
  expect(face.evaluate(CANDIDATE).isViable).toBe(false);
  const failing = createEvaluationFace({
    pool: { samples: [sample("train:a")] },
    holdout: [],
    judge: judge({ "train:a": 0.2 }),
  });
  expect(failing.evaluate(CANDIDATE).isViable).toBe(true);
});

test("a mined dataset feeds the face, and the holdout's pairs stay sealed", () => {
  const pairs: DatasetPair[] = Array.from({ length: 8 }, (_, index) => ({
    sessionID: "s1",
    turnID: `t${index}`,
    task: `task ${index}`,
    response: `response ${index}`,
  }));
  const grouped = splitDataset(pairs);
  const visible = [
    ...samplesFromPairs(grouped.train, () => "train" as const),
    ...samplesFromPairs(grouped.val, () => "val" as const),
  ];
  const sealed = samplesFromPairs(grouped.holdout, () => "holdout" as const);
  // The pool never contains a holdout sample: the split rides the id, so
  // the leak would be visible in the answer.
  const face = createEvaluationFace({
    pool: { samples: visible },
    holdout: sealed,
    judge: judge(),
  });
  const result = face.evaluate(CANDIDATE);
  expect(result.trainableFailureCases).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("holdout:");
  // The trainable cases door answers per split, from the pool alone.
  expect(face.trainableCases("train").length).toBe(grouped.train.length);
  expect(face.trainableCases("val").length).toBe(grouped.val.length);
});

test("the cheap judge scores overlap and reports what it could not judge", () => {
  // Full overlap scores full: the baseline evaluated against itself is
  // the floor, and it must be a real 1.0 rather than a default.
  const same = keywordOverlapJudge(
    "rotate the key and restart the unit",
    "rotate the key and restart the unit",
  );
  expect(same.dimensions.correctness).toBe(1);
  // The unjudged dimensions are REPORTED, not invented: a caller that
  // prints this score must be able to say which half of it was measured.
  expect(same.unjudged).toEqual(["procedureFollowing", "conciseness"]);
  // Partial overlap lands between the floor and 1.
  const partial = keywordOverlapJudge(
    "rotate the key and restart the unit",
    "rotate the key",
  );
  expect(partial.dimensions.correctness).toBeGreaterThan(0.3);
  expect(partial.dimensions.correctness).toBeLessThan(1);
  // No overlap at all still scores the floor, not zero — the heuristic's
  // documented shape.
  expect(
    keywordOverlapJudge("alpha beta gamma", "delta epsilon").dimensions
      .correctness,
  ).toBeCloseTo(0.3, 10);
});

test("the baseline evaluation is a real floor, and the holdout's door is a number", () => {
  const { baseline, holdoutScore } = evaluateBaseline({
    pool: {
      samples: [sample("train:a", "missed the rollback step"), sample("val:b")],
    },
    holdout: [sample("holdout:c")],
  });
  // Every recorded response scores full against itself, so the floor is
  // 1.0 — a candidate that cannot beat this is not a candidate.
  expect(baseline.score).toBe(1);
  expect(baseline.isViable).toBe(false);
  // The holdout's score came back as a number; its cases did not come
  // back at all.
  expect(holdoutScore).toBe(1);
  expect(JSON.stringify(baseline)).not.toContain("holdout:c");
});

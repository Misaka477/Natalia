import { expect, test } from "bun:test";
import { contentTokens as tokens } from "../src/text-tokens";
import {
  EVALUATION_PROTOCOL,
  acceptCandidate,
  answerAgreement,
  answerGroundedness,
  checkGrowth,
  compositeFitness,
  createEvaluationFace,
  evaluateBaseline,
  keywordOverlapJudge,
  lengthPenalty,
  meanStability,
  samplesFromPairs,
  scoreUnderProtocol,
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
    perExample: {},
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

test("the judge reads the instruction: the same answer scores differently under two", () => {
  // W1: the reference harness's judge takes the artifact text as a fourth
  // input because procedure following is unjudgeable without it. Before
  // this the dimension was a constant 1 — half the composite formula was
  // dead weight.
  const answer = "I recorded the rollback step and ran the guards.";
  const underA = keywordOverlapJudge(
    "record the rollback step then run the guards",
    answer,
    "Always record the rollback step, then run the guards.",
  );
  const underB = keywordOverlapJudge(
    "record the rollback step then run the guards",
    answer,
    "Compose a sonnet about the moon in iambic pentameter.",
  );
  // The answer engages A's procedure (half its steps, by the word-level
  // proxy) and not B's — a 3.5× separation, which is the whole point.
  expect(underA.dimensions.procedureFollowing).toBeGreaterThanOrEqual(0.5);
  expect(underB.dimensions.procedureFollowing).toBeLessThan(0.2);
  // Correctness is the reference comparison and does not move.
  expect(underA.dimensions.correctness).toBe(underB.dimensions.correctness);
  // The judged dimension is no longer reported as unjudged.
  expect(underA.unjudged).toEqual(["conciseness"]);
  // Without an instruction the dimension stays honestly unjudged.
  expect(
    keywordOverlapJudge("record the rollback step", answer).unjudged,
  ).toEqual(["procedureFollowing", "conciseness"]);
});

test("the face substitutes the candidate's instruction for the judge", () => {
  // The same wiring as the output: the candidate's text becomes the
  // instruction each sample was produced under.
  const seen: Array<string | undefined> = [];
  const face = createEvaluationFace({
    pool: { samples: [sample("train:a"), sample("val:b")] },
    holdout: [sample("holdout:c")],
    judge: (candidate) => {
      seen.push(candidate.instruction);
      return dims(1);
    },
  });
  face.evaluate({
    id: "c1",
    artifactSize: 1,
    maxSize: 100,
    instruction: "the candidate text",
  });
  expect(seen).toEqual([
    "the candidate text",
    "the candidate text",
    "the candidate text",
  ]);
  // The baseline (no candidate text) leaves the samples' own state alone.
  seen.length = 0;
  face.evaluate({ id: "baseline", artifactSize: 1, maxSize: 100 });
  expect(seen).toEqual([undefined, undefined, undefined]);
});

test("the protocol is one score function: the same text, the same number, either engine's shape", () => {
  // W10: BestOfN used to report a raw correctness and the reflective engine
  // a composite — two scales, so "beat the floor" compared incomparable
  // things. Both engines now call this function.
  const samples = [
    sample("train:a", "record the rollback step"),
    sample("val:b", "run the guards"),
    sample("holdout:c", "rotate the key"),
  ];
  const answer = "I recorded the rollback step and ran the guards.";

  // The BestOfN shape: ONE output judged across every sample's reference.
  const asAnswer = scoreUnderProtocol({ outputs: answer, samples });
  // The reflective shape: per-sample outputs (here the same text, so the
  // two paths must agree exactly — that agreement is the protocol).
  const asPerSample = scoreUnderProtocol({
    outputs: samples.map(() => answer),
    samples,
  });
  expect(asPerSample.score).toBe(asAnswer.score);
  expect(asPerSample.perExample).toEqual(asAnswer.perExample);

  // The sealed sample counts toward the score but not toward the
  // trainable bucket (the same seal as the face's).
  expect(
    asAnswer.trainableFailureCases.every(
      (c) => !c.sampleID.startsWith("holdout:"),
    ),
  ).toBe(true);
  expect(asAnswer.perExample["holdout:c"]).toBeUndefined();
  expect(asAnswer.perExample["train:a"]).toBeGreaterThan(0);

  // A perfect match on every sample is the floor a weak candidate cannot
  // beat — which is the documented ceiling of the cheap judge.
  const perfect = scoreUnderProtocol({
    outputs: samples.map((s) => s.output),
    samples,
  });
  expect(perfect.score).toBe(1);
});

test("the protocol's id is stamped so a run says which yardstick it used", () => {
  expect(EVALUATION_PROTOCOL).toBe("keyword-overlap/v1");
});

test("the stability dimension sees what keyword overlap cannot: phrasing sensitivity", () => {
  // W2: two phrasings of one task share no keywords with each other, so
  // the cheap judge cannot tell a candidate that answers the TASK from
  // one that pattern-matches the PHRASING. Agreement does.
  const grounded = answerAgreement(
    "the retry helper pins the clock so the test passes on every run",
    "pinning the clock in the retry helper makes the test pass every run",
  );
  const phrasingMatched = answerAgreement(
    "the retry helper pins the clock so the test passes on every run",
    "a sourdough poolish gives an open crumb and a blistered crust",
  );
  expect(grounded).toBeGreaterThan(0.3);
  expect(phrasingMatched).toBe(0);
  // Symmetric, and the degenerate cases are defined rather than NaN.
  expect(answerAgreement("a b c", "c b a")).toBe(1);
  expect(answerAgreement("", "")).toBe(1);
  expect(answerAgreement("something", "")).toBe(0);
  // The mean over a run is undefined when nothing was observed — a report
  // must not invent a stability number.
  expect(meanStability([])).toBeUndefined();
  expect(
    meanStability([
      { sampleID: "a", agreement: 1 },
      { sampleID: "b", agreement: 0.5 },
    ]),
  ).toBe(0.75);
});

test("groundedness is precision where correctness is coverage — the invention signal", () => {
  // W2: an answer that hits every point of the reference AND invents a
  // paragraph scores well on correctness and badly on groundedness.
  const source =
    "the retry helper pins the clock so the flaky test passes on every run of the suite";
  const grounded =
    "pinning the clock in the retry helper makes the test pass on every run";
  const inventive =
    "pinning the clock in the retry helper makes the test pass on every run; " +
    "furthermore the scheduler quantum should be retuned and the allocator replaced with a slab design";
  // A 2x separation: the inventive answer carries a third of its content
  // with no support in the source, and that third is what a self-evolving
  // loop must not select for.
  expect(answerGroundedness(grounded, source)).toBeGreaterThan(0.6);
  expect(answerGroundedness(inventive, source)).toBeLessThan(0.45);
  // And it is NOT correctness: the inventive answer covers the reference
  // just as well as the grounded one does.
  const coverage = (answer: string) => {
    const expected = tokens(source);
    const got = tokens(answer);
    return (
      [...expected].filter((token) => got.has(token)).length / expected.size
    );
  };
  expect(coverage(inventive)).toBe(coverage(grounded));
  // Degenerate cases are defined.
  expect(answerGroundedness("", source)).toBe(0);
  expect(answerGroundedness("nothing shared here at all", source)).toBe(0);
});

test("the protocol takes pre-judged dimensions, and falls back per sample", () => {
  // S9's eval judge: Nia's three scores reach the protocol through this
  // seam. A sample she declined falls back to the cheap judge rather than
  // zeroing the run — and a judge that never ran at all keeps the cheap
  // path (the default).
  const samples = [sample("train:a"), sample("train:b")];
  const hers = scoreUnderProtocol({
    outputs: ["answer one", "answer two"],
    samples,
    dimensions: [
      { correctness: 0.9, procedureFollowing: 0.5, conciseness: 0.8 },
      undefined,
    ],
  });
  // Her scored sample is scored by HER numbers.
  expect(hers.perExample["train:a"]).toBeCloseTo(
    0.5 * 0.9 + 0.3 * 0.5 + 0.2 * 0.8,
    6,
  );
  // The declined sample fell back (the cheap judge's number, whatever it
  // is, is not hers).
  expect(hers.perExample["train:b"]).not.toBeCloseTo(0.9, 6);
  // And with no dimensions at all the cheap judge still runs (the default).
  const cheap = scoreUnderProtocol({
    outputs: ["answer one", "answer two"],
    samples,
  });
  expect(cheap.perExample["train:a"]).not.toBeCloseTo(0.9, 6);
});

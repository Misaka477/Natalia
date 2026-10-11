import type { DatasetPair, DatasetSplit } from "./dataset-miner";

/**
 * L3's evaluation layer: the fitness a candidate is scored on, and the
 * holdout it can never see.
 *
 * The design is taken from two reference engines and corrected by their
 * own source:
 *
 * 1. **The holdout is physically absent from the evaluation face, not
 *    forbidden by discipline.** The visible pool carries train + val; the
 *    holdout lives in a closure the face never hands out, and its score is
 *    returned as a NUMBER — never as cases. Peeking is not prohibited,
 *    it has no entrance.
 * 2. **One result, two buckets.** A candidate's evaluation produces
 *    `trainableFailureCases` (what the mutator may read) and
 *    `holdoutFailureCases` (what still counts toward the score but is
 *    never shown). "Another copy of the dataset kept apart by convention"
 *    is the shape this replaces.
 * 3. **Scores order candidates; feedback gives them direction.** A loop
 *    with scores and no natural-language feedback is a random walk, so
 *    the feedback rides the sample the mutator reads.
 *
 * The judging itself is a SEAM (an injected per-sample scorer, the same
 * shape the external benchmark runner injects its submitter through): this
 * module owns the arithmetic, the buckets, the caps and the acceptance
 * rule — never a provider call.
 */

/** The reflection dataset's atom: three fields, nothing else. */
export type EvaluationSample = {
  id: string;
  /** The task input. */
  input: string;
  /** The candidate's output for it. */
  output: string;
  /**
   * Natural-language feedback on the output — the direction signal for
   * the mutator. Scores order; this steers.
   */
  feedback?: string;
  /**
   * The instruction the output was produced UNDER — the artifact text a
   * candidate is evolving. Procedure following ("did it follow the
   * artifact's own procedure") is unjudgeable without it: a judge that
   * cannot see the instruction can score the answer but not the
   * following. The evaluation face substitutes the candidate's
   * instruction here, exactly as it substitutes the candidate's output.
   */
  instruction?: string;
};

/** The judge's per-sample dimensions, each 0..1. */
export type FitnessDimensions = {
  /** Did it do the task right? */
  correctness: number;
  /** Did it follow the artifact's own procedure? */
  procedureFollowing: number;
  /** Is it free of padding? */
  conciseness: number;
};

/**
 * The composite's weights: correctness dominates, procedure is the
 * artifact's own contract, conciseness is the tiebreaker that keeps
 * evolution from drifting verbose.
 */
export const FITNESS_WEIGHTS = {
  correctness: 0.5,
  procedureFollowing: 0.3,
  conciseness: 0.2,
} as const;

/**
 * The continuous length penalty: nothing happens until 90% of the cap,
 * then it ramps to 0.3 at 100%. Continuous rather than a cliff because a
 * cliff produces a stable population of variants sitting exactly on the
 * line — the penalty makes verbosity cost something BEFORE the rejection.
 */
export const LENGTH_PENALTY_ONSET = 0.9;
export const LENGTH_PENALTY_SLOPE = 3.0;
export const LENGTH_PENALTY_MAX = 0.3;

export function lengthPenalty(artifactSize: number, maxSize: number): number {
  if (!(maxSize > 0) || !(artifactSize > 0)) return 0;
  const ratio = artifactSize / maxSize;
  if (ratio <= LENGTH_PENALTY_ONSET) return 0;
  return Math.min(
    LENGTH_PENALTY_MAX,
    (ratio - LENGTH_PENALTY_ONSET) * LENGTH_PENALTY_SLOPE,
  );
}

/**
 * The composite fitness: the weighted dimensions minus the length
 * penalty. Bounded below at 0 — a candidate cannot go negative and thereby
 * look "further from done" than one that scored zero on everything.
 */
export function compositeFitness(
  dimensions: FitnessDimensions,
  sizes: { artifactSize: number; maxSize: number },
): number {
  const raw =
    FITNESS_WEIGHTS.correctness * clamp01(dimensions.correctness) +
    FITNESS_WEIGHTS.procedureFollowing *
      clamp01(dimensions.procedureFollowing) +
    FITNESS_WEIGHTS.conciseness * clamp01(dimensions.conciseness) -
    lengthPenalty(sizes.artifactSize, sizes.maxSize);
  return Math.max(0, raw);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A failure the mutator may read, or one it may not. */
export type EvaluationCase = {
  sampleID: string;
  /** The failure's class (the judge's taxonomy, never free-form prose). */
  failureType: string;
  /** What went wrong, for the reflection dataset. */
  detail: string;
};

/**
 * One evaluation, two buckets. The holdout bucket still moves the score;
 * it is simply never handed to the mutator.
 */
export type EvaluationResult = {
  score: number;
  /**
   * Each sample's composite, keyed by sample id. The Pareto fronts' axes:
   * a candidate that is extraordinary on one kind of example and ordinary
   * elsewhere owns the front it wins, which is how it stays selectable.
   */
  perExample: Record<string, number>;
  /** Failures on the visible pool — the mutator's reading material. */
  trainableFailureCases: EvaluationCase[];
  /** Failures on the holdout — counted, never shown. */
  holdoutFailureCases: EvaluationCase[];
  /**
   * Whether the candidate is worth considering at all. An unviable
   * candidate cannot be a parent (the reference evolver's rule: no
   * trainable failure case, no reproduction — an artifact that never
   * failed anywhere has nothing to evolve FROM).
   */
  isViable: boolean;
};

/** One sample's judged outcome, as the assembler reads it. */
export type JudgedSample = {
  sampleID: string;
  dimensions: FitnessDimensions;
  /**
   * Whether this sample belongs to the sealed holdout. A sealed sample's
   * failure still counts toward the score; it never reaches the trainable
   * bucket, so it never reaches the mutator.
   */
  sealed: boolean;
  /** The feedback text the mutator would read for this sample. */
  feedback?: string;
};

/**
 * Assemble one evaluation result from judged samples: the two failure
 * buckets, the per-example map, the blended score and the viability.
 *
 * Shared by the synchronous face and by a caller whose judge is async (a
 * real run per sample — the reference harness's SkillModule pattern), so
 * both paths produce the SAME shape and the engine cannot tell them apart.
 */
export function assembleResult(input: {
  judged: readonly JudgedSample[];
  sizes: { artifactSize: number; maxSize: number };
}): EvaluationResult {
  const perExample: Record<string, number> = {};
  const trainableFailureCases: EvaluationCase[] = [];
  const holdoutFailureCases: EvaluationCase[] = [];
  let total = 0;
  for (const entry of input.judged) {
    const composite = compositeFitness(entry.dimensions, input.sizes);
    // The holdout contributes to the blended score and its own bucket —
    // never to the per-example map, which feeds the Pareto fronts and the
    // mutator. A sealed sample's per-example number in a mutator-facing
    // structure is the leak the seal exists to prevent.
    if (!entry.sealed) perExample[entry.sampleID] = composite;
    total += composite;
    if (entry.dimensions.correctness >= 1) continue;
    const failure: EvaluationCase = {
      sampleID: entry.sampleID,
      failureType: "correctness",
      detail: entry.feedback ?? "the judge scored it below full",
    };
    if (entry.sealed) holdoutFailureCases.push(failure);
    else trainableFailureCases.push(failure);
  }
  return {
    score: input.judged.length ? total / input.judged.length : 0,
    perExample,
    trainableFailureCases,
    holdoutFailureCases,
    isViable: trainableFailureCases.length > 0,
  };
}

/**
 * The growth cap: a variant more than 20% longer than its baseline is
 * REFUSED, not penalized. A penalty would make "long and good" beat
 * "short and good" often enough to drift; a refusal makes the boundary
 * absolute. Exactly at the cap passes (+20% is allowed, +21% is not).
 */
export const GROWTH_CAP = 1.2;

export type GrowthVerdict =
  | { ok: true; ratio: number }
  | { ok: false; ratio: number; reason: string };

export function checkGrowth(
  baselineSize: number,
  variantSize: number,
): GrowthVerdict {
  if (!(baselineSize > 0))
    return { ok: true, ratio: baselineSize === variantSize ? 1 : 0 };
  const ratio = variantSize / baselineSize;
  if (ratio > GROWTH_CAP)
    return {
      ok: false,
      ratio,
      reason:
        `variant is ${Math.round((ratio - 1) * 100)}% over baseline ` +
        `(cap ${Math.round((GROWTH_CAP - 1) * 100)}%) — refused, not penalized`,
    };
  return { ok: true, ratio };
}

/**
 * The acceptance rule, strict by default: the candidate's total must be
 * STRICTLY greater than the baseline's. A tie is a rejection — an engine
 * that accepts ties fills its population with lateral moves and stops
 * improving. Equal-move exploration is an explicit opt-in, not a default.
 */
export function acceptCandidate(input: {
  baseline: EvaluationResult;
  candidate: EvaluationResult;
  /** Opt into accepting a tie (lateral exploration). Off by default. */
  allowEqual?: boolean;
}): { accepted: boolean; reason: string } {
  const { baseline, candidate } = input;
  if (candidate.score > baseline.score)
    return { accepted: true, reason: "strict improvement" };
  if (input.allowEqual === true && candidate.score === baseline.score)
    return { accepted: true, reason: "equal-move exploration (opted in)" };
  return {
    accepted: false,
    reason: `candidate scored ${candidate.score.toFixed(4)} against baseline ${baseline.score.toFixed(4)} — a tie is not an improvement`,
  };
}

/** The judge seam: one sample in, its dimensions (and feedback) out. */
export type SampleJudge = (sample: EvaluationSample) => FitnessDimensions;

/** The splits the evaluation face will name. The holdout is not one. */
export type VisibleSplit = "train" | "val";

export type EvaluationPool = {
  /**
   * The agent-visible pool: train + val, as samples the judge can score.
   * The holdout is deliberately NOT a field here — an evaluation face
   * built from this pool has nothing to leak.
   */
  samples: EvaluationSample[];
};

export type Candidate = {
  id: string;
  /** The artifact's own size in bytes (the length penalty's numerator). */
  artifactSize: number;
  /** The artifact's size cap (its denominator). */
  maxSize: number;
  /**
   * The candidate's output for each sample, substituted for the sample's
   * own recorded output when judging. Present when a real candidate is
   * being evaluated (a run per sample); absent for the baseline, where the
   * recorded responses ARE the outputs being scored.
   */
  output?: string;
  /**
   * The candidate's own text — the instruction the output was produced
   * under. Substituted into each sample as `instruction`, so the judge
   * can score procedure following against the artifact it is evolving.
   */
  instruction?: string;
};

export type EvaluationFace = {
  /**
   * Score the candidate on the VISIBLE pool. The result's trainable
   * bucket is what a mutator may read; nothing here touches the holdout.
   */
  evaluate(candidate: Candidate): EvaluationResult;
  /**
   * The holdout's score — a NUMBER. The cases stay behind the closure:
   * this is the only holdout door, and it carries no reading material.
   */
  scoreHoldout(candidate: Candidate): number;
  /**
   * The trainable failure cases, for the reflection dataset. The split
   * argument cannot name the holdout (the type refuses it), and a cast
   * that smuggles one in is refused here rather than served.
   */
  trainableCases(split: VisibleSplit): EvaluationCase[];
};

/**
 * Build the evaluation face over a visible pool and a sealed holdout.
 *
 * The holdout enters through the constructor and leaves as a number. The
 * injection this design defends against — an optimizer that reads the
 * holdout — has no API to stand on: `evaluate` sees only the pool,
 * `scoreHoldout` returns a score, and `trainableCases` refuses any split
 * it does not own.
 */
export function createEvaluationFace(input: {
  pool: EvaluationPool;
  holdout: readonly EvaluationSample[];
  judge: SampleJudge;
}): EvaluationFace {
  const holdout = [...input.holdout];
  /**
   * The sample as the judge reads it for one candidate: the candidate's
   * output substituted for the recorded one, and the candidate's own text
   * substituted as the instruction that output was produced under. The
   * second substitution is what makes procedure following judgeable at
   * all — the reference harness's judge takes the skill text as a fourth
   * input for exactly this reason.
   */
  const forCandidate = (
    sample: EvaluationSample,
    candidate: Candidate,
  ): EvaluationSample => {
    if (candidate.output === undefined && candidate.instruction === undefined)
      return sample;
    return {
      ...sample,
      ...(candidate.output === undefined ? {} : { output: candidate.output }),
      ...(candidate.instruction === undefined
        ? {}
        : { instruction: candidate.instruction }),
    };
  };
  return {
    evaluate(candidate) {
      // A candidate's own output substitutes for each sample's recorded
      // one; the baseline (no output) scores the recorded responses.
      const judged = [
        ...input.pool.samples.map((sample) => ({
          sampleID: sample.id,
          dimensions: input.judge(forCandidate(sample, candidate)),
          sealed: false,
          ...(sample.feedback ? { feedback: sample.feedback } : {}),
        })),
        ...holdout.map((sample) => ({
          sampleID: sample.id,
          dimensions: input.judge(forCandidate(sample, candidate)),
          sealed: true,
          ...(sample.feedback ? { feedback: sample.feedback } : {}),
        })),
      ];
      // The holdout's failures still count toward the score — they are
      // simply never handed out. Both pools blend into one number so a
      // candidate cannot buy fitness by being great on the visible pool
      // and terrible on the sealed one.
      return assembleResult({
        judged,
        sizes: {
          artifactSize: candidate.artifactSize,
          maxSize: candidate.maxSize,
        },
      });
    },
    scoreHoldout(candidate) {
      // A number, never the cases — the sealed door's only opening.
      return assembleResult({
        judged: holdout.map((sample) => ({
          sampleID: sample.id,
          dimensions: input.judge(forCandidate(sample, candidate)),
          sealed: true,
          ...(sample.feedback ? { feedback: sample.feedback } : {}),
        })),
        sizes: {
          artifactSize: candidate.artifactSize,
          maxSize: candidate.maxSize,
        },
      }).score;
    },
    trainableCases(split) {
      // A split the face does not own is refused, not silently emptied:
      // a mutator that smuggles "holdout" in through a cast learns here
      // that the door does not open, rather than reading an empty list
      // and concluding there was nothing to see.
      if (split !== "train" && split !== "val")
        throw new Error(
          `unknown split: ${String(split)} (the visible splits are train, val)`,
        );
      return input.pool.samples
        .filter((sample) => sample.id.startsWith(`${split}:`))
        .map((sample) => ({
          sampleID: sample.id,
          failureType: "unscored",
          detail: sample.feedback ?? "",
        }));
    },
  };
}

/**
 * Mine a dataset's pairs into evaluation samples, each carrying its split
 * in the id so the face can answer "which split is this from" without a
 * side table. The pair's task is the input and its recorded response is
 * the reference output; a candidate's own output is scored by the judge at
 * evaluation time, so the sample is per pair, not per candidate.
 *
 * The caller decides which pairs go where: `splitDataset` already
 * assigned them deterministically, and the holdout's pairs are handed to
 * the face's sealed constructor argument — never to the pool.
 */
export function samplesFromPairs(
  pairs: readonly DatasetPair[],
  splitOf: (pair: DatasetPair) => DatasetSplit,
): EvaluationSample[] {
  return pairs.map((pair) => ({
    id: `${splitOf(pair)}:${pair.sessionID}:${pair.turnID}`,
    input: pair.task,
    output: pair.response,
    ...(pair.feedback ? { feedback: pair.feedback } : {}),
  }));
}

/**
 * The cheap judge: keyword overlap between the reference output and the
 * candidate's, scored `0.3 + 0.7 × |expected∩output| / |expected|`.
 *
 * This is the documented proxy path — a full LLM judge is expensive, so
 * the cheap one runs the volume and the expensive one is spent
 * selectively. It is honest about what it cannot see: procedure and
 * conciseness have no overlap signal, so a judge built on it reports
 * `unjudged` dimensions rather than inventing numbers for them.
 */
export const KEYWORD_OVERLAP_FLOOR = 0.3;

export type KeywordJudgeReport = {
  dimensions: FitnessDimensions;
  /** Dimensions the heuristic could not judge (defaulted, not measured). */
  unjudged: Array<keyof FitnessDimensions>;
};

export function keywordOverlapJudge(
  expected: string,
  output: string,
  instruction?: string,
): KeywordJudgeReport {
  const expectedTokens = contentTokens(expected);
  const outputTokens = contentTokens(output);
  // Procedure following: the fraction of the instruction's own content the
  // answer actually engages. A word-level proxy — it cannot tell "followed
  // the step" from "mentioned the step", and the report says the dimension
  // is a proxy. What it CAN do is separate an answer produced under
  // instruction A from the same answer under instruction B, which is the
  // whole point: without an instruction this dimension has no criterion at
  // all and half the composite formula is dead weight.
  const instructionTokens = instruction
    ? contentTokens(instruction)
    : new Set<string>();
  let procedureFollowing = 1;
  let procedureJudged = false;
  if (instructionTokens.size) {
    const engaged = [...instructionTokens].filter((token) =>
      outputTokens.has(token),
    ).length;
    procedureFollowing = engaged / instructionTokens.size;
    procedureJudged = true;
  }
  // The canonical dimension order (the weights' order), with the unjudged
  // ones reported in it — a consumer printing the score reads one order.
  const unjudged: Array<keyof FitnessDimensions> = [
    ...(procedureJudged ? [] : (["procedureFollowing"] as const)),
    "conciseness",
  ];
  if (!expectedTokens.size)
    return {
      dimensions: {
        correctness: 0,
        procedureFollowing,
        conciseness: 1,
      },
      unjudged,
    };
  const hits = [...expectedTokens].filter((token) =>
    outputTokens.has(token),
  ).length;
  const correctness = Math.min(
    1,
    KEYWORD_OVERLAP_FLOOR +
      (1 - KEYWORD_OVERLAP_FLOOR) * (hits / expectedTokens.size),
  );
  return {
    dimensions: { correctness, procedureFollowing, conciseness: 1 },
    unjudged,
  };
}

function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 2),
  );
}

/**
 * The baseline evaluation: the dataset's own recorded responses scored
 * against themselves through the cheap judge — the floor every later
 * candidate must beat, and the first real consumer of the sealed face.
 *
 * Scoring the baseline is not a tautology: it proves the face works end
 * to end (pool + sealed holdout + the number-only door), it produces the
 * number `acceptCandidate` will compare against, and it costs no provider
 * call. A candidate evaluated the same way must then beat this score by
 * the strict-improvement rule.
 */
export function evaluateBaseline(input: {
  pool: EvaluationPool;
  holdout: readonly EvaluationSample[];
}): { baseline: EvaluationResult; holdoutScore: number } {
  const face = createEvaluationFace({
    pool: input.pool,
    holdout: input.holdout,
    judge: (sample) =>
      keywordOverlapJudge(sample.output, sample.output).dimensions,
  });
  return {
    baseline: face.evaluate({
      id: "baseline",
      artifactSize: input.pool.samples.reduce(
        (sum, sample) => sum + sample.output.length,
        0,
      ),
      maxSize: Number.MAX_SAFE_INTEGER,
    }),
    holdoutScore: face.scoreHoldout({
      id: "baseline",
      artifactSize: 0,
      maxSize: Number.MAX_SAFE_INTEGER,
    }),
  };
}

/**
 * The evaluation protocol: ONE score function both engines are measured
 * by.
 *
 * Before this, BestOfN reported a raw correctness and the reflective engine
 * a composite — two numbers on two scales, so the phase gate's "beat the
 * floor" compared incomparable things and a report could manufacture a win.
 * The reference harness's holdout comparison runs the SAME metric over
 * baseline and evolved for exactly this reason.
 *
 * The protocol: the candidate's output(s) are judged against each sample's
 * own recorded reference by the keyword judge (with the instruction in hand
 * when there is one), assembled into the composite with the two buckets and
 * the per-example map. A sample whose id carries the `holdout:` prefix is
 * sealed: it counts toward the score and never toward the trainable bucket.
 */
export const EVALUATION_PROTOCOL = "keyword-overlap/v1";

export function scoreUnderProtocol(input: {
  /**
   * The candidate's output per sample, or ONE output judged against every
   * sample's reference (the BestOfN shape: one sampled answer, scored
   * across the pool so the engines stay comparable).
   */
  outputs: readonly string[] | string;
  samples: readonly EvaluationSample[];
  /** The instruction the outputs were produced under (procedure's criterion). */
  instruction?: string;
  sizes?: { artifactSize: number; maxSize: number };
}): EvaluationResult {
  const outputs =
    typeof input.outputs === "string"
      ? input.samples.map(() => input.outputs as string)
      : input.outputs;
  const judged = input.samples.map((sample, index) => ({
    sampleID: sample.id,
    dimensions: keywordOverlapJudge(
      sample.output,
      outputs[index] ?? "",
      input.instruction ?? sample.instruction,
    ).dimensions,
    sealed: sample.id.startsWith("holdout:"),
    ...(sample.feedback ? { feedback: sample.feedback } : {}),
  }));
  const size =
    input.sizes ??
    (typeof input.outputs === "string"
      ? {
          artifactSize: Buffer.byteLength(input.outputs, "utf8"),
          maxSize: Number.MAX_SAFE_INTEGER,
        }
      : {
          artifactSize: outputs.reduce(
            (sum, text) => sum + Buffer.byteLength(text ?? "", "utf8"),
            0,
          ),
          maxSize: Number.MAX_SAFE_INTEGER,
        });
  return assembleResult({ judged, sizes: size });
}

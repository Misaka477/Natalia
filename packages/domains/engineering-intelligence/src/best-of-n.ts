/**
 * L4a's floor engine: N independent samples, keep the best.
 *
 * This is deliberately the DUMBEST engine that can still be called an
 * engine — no proposer engineering, no parent selection, no reflection.
 * Each attempt is one independent call that sees the base prompt and its
 * own attempt number and NOTHING else: not the previous attempts, not
 * their scores, not any feedback. That isolation is the whole point — it
 * is what makes this a FLOOR. A later reflective engine must beat this
 * number to prove the reflection is worth its cost, and it can only prove
 * that against an engine whose samples are genuinely independent.
 *
 * The seams are injected, exactly like the external benchmark runner's
 * submitter: `sampler` is one model call, `score` is one scoring pass (L3's
 * face, the cheap judge, or an LLM judge — the engine does not care). The
 * engine owns the loop, the selection and the honesty rules.
 */

/** One independent sampling call. The input carries no history — see above. */
export type Sampler = (input: {
  /** The base prompt, verbatim, every attempt. */
  prompt: string;
  /** 1-based attempt index (the only thing that differs between calls). */
  attempt: number;
}) => Promise<string>;

/** One scoring pass over a sample's text. */
export type Scorer = (text: string) => number;

export type BestOfNAttempt = {
  attempt: number;
  text: string;
  score: number;
  chars: number;
};

export type BestOfNFailure = {
  attempt: number;
  reason: string;
};

export type BestOfNResult = {
  /** The best attempt seen, or undefined when every attempt failed. */
  best?: BestOfNAttempt;
  attempts: BestOfNAttempt[];
  /** Per-attempt failures (a failed sample is an answer, never a crash). */
  failures: BestOfNFailure[];
  /** The baseline the best attempt was measured against. */
  baselineScore: number;
  /**
   * Strict improvement over the baseline (L3's acceptance rule): a tie is
   * not a win. False when there is no best attempt at all.
   */
  beatBaseline: boolean;
};

/**
 * Run the floor engine. Sequential by design: the attempts are independent,
 * so there is nothing to parallelize that would not also couple them (a
 * shared counter is fine; a shared anything-else is not).
 */
export async function runBestOfN(input: {
  prompt: string;
  /** How many independent samples to draw. Must be ≥ 1. */
  n: number;
  sampler: Sampler;
  score: Scorer;
  /** The current artifact's score (the acceptance rule's denominator). */
  baselineScore: number;
}): Promise<BestOfNResult> {
  if (!Number.isInteger(input.n) || input.n < 1)
    throw new Error(`best-of-n needs a positive attempt count, got ${input.n}`);
  const attempts: BestOfNAttempt[] = [];
  const failures: BestOfNFailure[] = [];
  for (let attempt = 1; attempt <= input.n; attempt += 1) {
    let text: string;
    try {
      text = await input.sampler({ prompt: input.prompt, attempt });
    } catch (error) {
      // A failed sample is a per-attempt answer: the loop continues and
      // the reason rides the result, exactly like the benchmark batch's
      // per-task honesty.
      failures.push({
        attempt,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    attempts.push({
      attempt,
      text,
      score: input.score(text),
      chars: text.length,
    });
  }
  const best = pickBest(attempts);
  return {
    ...(best ? { best } : {}),
    attempts,
    failures,
    baselineScore: input.baselineScore,
    beatBaseline: best ? best.score > input.baselineScore : false,
  };
}

/**
 * Best-of selection: highest score wins; a tie goes to the SHORTER text
 * (the plan's rule — between two equally-good candidates the one that
 * costs fewer tokens is the better artifact); a further tie goes to the
 * earlier attempt, so the result is stable across runs.
 */
export function pickBest(
  attempts: readonly BestOfNAttempt[],
): BestOfNAttempt | undefined {
  let best: BestOfNAttempt | undefined;
  for (const attempt of attempts) {
    if (!best) {
      best = attempt;
      continue;
    }
    if (attempt.score > best.score) {
      best = attempt;
      continue;
    }
    if (attempt.score === best.score && attempt.chars < best.chars)
      best = attempt;
  }
  return best;
}

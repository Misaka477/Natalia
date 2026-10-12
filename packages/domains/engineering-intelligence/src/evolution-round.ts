/**
 * S8's step 2: the round that runs when the trigger fires.
 *
 * Until now the loop's engine lived in the CLI — which is why the system
 * was a tool chain: a human typed a command, and everything downstream was
 * shaped by that. The trigger (S8 step 1) notices and journals; THIS is the
 * part that acts on it, and it lives in the domain package so the daemon's
 * scheduler and the CLI's `optimize` call the same code rather than two
 * copies that drift.
 *
 * It composes the pieces that already exist — it does not write a new
 * engine: the evaluation protocol, the reflective proposer, the seven
 * gates, the summary serializer. What it adds is the ORDER and the
 * refusals, which is the part nobody owned.
 *
 * The provider call is INJECTED as a sampler, so the daemon's scheduler can
 * hand it the session's own provider and the CLI can hand it the RPC
 * proxy. That is the whole trick: the loop was never CLI-shaped, only its
 * wiring was.
 *
 * The disk stays the caller's (the house pattern): this returns the summary
 * entry, and the caller writes it. A round that wrote its own state would
 * be a round nobody could audit.
 */

import { gateCandidate, type GateInput, type GateReport } from "./gates";
import {
  scoreUnderProtocol,
  samplesFromPairs,
  type EvaluationSample,
} from "./evaluation";
import {
  proposeReflective,
  type ReflectionSampler,
  type TriedCandidate,
} from "./reflective-mutator";
import { summaryLine, type EvolutionSummaryEntry } from "./evolution-state";

/**
 * The three splits' own scores, derived from the per-example map: the
 * sealed samples' ids carry the `holdout:` prefix (the protocol's own
 * marking), and the visible ones carry their split. A reviewer approving a
 * candidate needs to see WHICH split moved — a blended number hides a
 * holdout regression behind a train gain, which is exactly the leak the
 * sealed face exists to prevent.
 */
export function splitScores(result: { perExample: Record<string, number> }): {
  train?: number;
  val?: number;
  holdout?: number;
} {
  const mean = (values: number[]) =>
    values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : undefined;
  const train: number[] = [];
  const val: number[] = [];
  const holdout: number[] = [];
  for (const [id, score] of Object.entries(result.perExample)) {
    if (id.startsWith("holdout:")) holdout.push(score);
    else if (id.startsWith("val:")) val.push(score);
    else train.push(score);
  }
  return {
    ...(train.length ? { train: mean(train) } : {}),
    ...(val.length ? { val: mean(val) } : {}),
    ...(holdout.length ? { holdout: mean(holdout) } : {}),
  };
}

export type RoundCandidate = {
  name: string;
  description: string;
  /** The artifact text the candidate would install. */
  body: string;
  hypothesis?: string;
  axis?: "exploitation" | "exploration";
  score: number;
  holdoutScore?: number;
  /**
   * The three splits' own scores. A reviewer approving this needs to see
   * which split moved — a blended number hides a holdout regression
   * behind a train gain.
   */
  splits?: { train?: number; val?: number; holdout?: number };
  /** The seven gates, one result each (the refusals are the failures'). */
  gateResults?: Array<{ gate: string; ok: boolean; detail: string }>;
  /** What the candidate changed against the artifact it came from. */
  diff?: { baseline: string; candidate: string };
  /**
   * The round's own cost: how many provider calls it spent. A reviewer
   * deciding whether to land a 0.03 gain needs to know what it cost.
   */
  sampleCount?: number;
};

export async function runEvolutionRound(input: {
  /** The visible pool (train + val). */
  pool: readonly EvaluationSample[];
  /** The sealed holdout — never in the pool, only ever scored. */
  holdout: readonly EvaluationSample[];
  /** The artifact's current text (the `<curr_param>` the proposal edits). */
  currentInstruction: string;
  /** One prompt in, one answer out. */
  sampler: ReflectionSampler;
  /** The iteration this round is (the summary's own numbering). */
  iteration: number;
  /** What has already been tried (the loop's memory). */
  history?: readonly TriedCandidate[];
  /** The controller's axis suggestion for this round. */
  axisHint?: "exploitation" | "exploration";
  /** G1's verdict — the caller ran the suite (this never runs one). */
  suite: GateInput["suite"];
  /**
   * G7's verdict — the benchmark seam. Absent means UNVERIFIED, which the
   * gate refuses (an absent check is not a passing check): a round that
   * could pass G7 by not answering it would be a round that graded itself.
   */
  benchmark?: GateInput["benchmark"];
  /** The candidate's name (the caller owns naming). */
  name: string;
}): Promise<
  | {
      ok: true;
      entry: EvolutionSummaryEntry;
      candidate: RoundCandidate;
      gate: GateReport;
    }
  | { ok: false; reason: string }
> {
  const visible = input.pool;
  const all = [...visible, ...input.holdout];

  // 1. The parent's own result — the reflective proposer needs an evaluated
  //    parent to find the TRAINABLE failures in.
  let sampleCount = 0;
  const call = async (prompt: string, component: string) => {
    sampleCount += 1;
    return input.sampler({ prompt, component });
  };
  const parentAnswers: string[] = [];
  for (const sample of visible) {
    const prompt = `${input.currentInstruction}\n\n${sample.input}`;
    parentAnswers.push(await call(prompt, input.currentInstruction));
  }
  const parentResult = scoreUnderProtocol({
    outputs: parentAnswers,
    samples: all,
    instruction: input.currentInstruction,
  });
  if (
    !parentResult.perExample ||
    Object.keys(parentResult.perExample).length === 0
  )
    return { ok: false, reason: "the pool is empty — nothing to evaluate" };

  // 2. The proposal. A refusal here is the loop saying it has nothing to
  //    answer, which is a legitimate stop and not a failure.
  const proposal = await proposeReflective({
    components: [input.currentInstruction],
    currentParam: input.currentInstruction,
    result: parentResult,
    pool: visible,
    sampler: input.sampler,
    ...(input.history ? { history: input.history } : {}),
    ...(input.axisHint ? { axisHint: input.axisHint } : {}),
  });
  if (!proposal.ok) return { ok: false, reason: proposal.reason };

  // 3. The candidate's own result, scored the same way (one sampler call
  //    per visible sample; the holdout is scored from the same answers).
  const candidateAnswers: string[] = [];
  for (const sample of visible) {
    const prompt = `${proposal.candidate.text}\n\n${sample.input}`;
    candidateAnswers.push(await call(prompt, proposal.candidate.text));
  }
  const candidateResult = scoreUnderProtocol({
    outputs: candidateAnswers,
    samples: all,
    instruction: proposal.candidate.text,
  });

  // 4. The seven gates. The candidate is REPORTED either way — a refused
  //    candidate is evidence about what the loop wanted, and W9 keeps it.
  const gate = gateCandidate({
    // A prompt-segment target: the artifact under evolution IS a prompt
    // segment (the instruction the answers were produced under).
    target: { kind: "prompt-segment", name: input.name },
    baseline: input.currentInstruction,
    candidate: proposal.candidate.text,
    suite: input.suite,
    ...(input.benchmark ? { benchmark: input.benchmark } : {}),
  });

  const candidate: RoundCandidate = {
    name: input.name,
    description: proposal.candidate.hypothesis ?? "no hypothesis recorded",
    body: proposal.candidate.text,
    ...(proposal.candidate.hypothesis
      ? { hypothesis: proposal.candidate.hypothesis }
      : {}),
    ...(proposal.candidate.axis ? { axis: proposal.candidate.axis } : {}),
    score: candidateResult.score,
    // The holdout's own number is the sealed bucket's contribution; the
    // face does not hand it out, so the candidate reports the blended
    // score and the queue's row says so rather than inventing a split.
    holdoutScore: candidateResult.score,
    // The decision fields a reviewer actually needs: which split moved,
    // which gates answered what, what changed, and what it cost.
    splits: splitScores(candidateResult),
    gateResults: gate.gates,
    diff: {
      baseline: input.currentInstruction,
      candidate: proposal.candidate.text,
    },
    sampleCount,
  };

  // 5. The summary entry. PURE (string in, string out) — the caller writes
  //    it, so the run's own record is auditable rather than implied.
  const entry: EvolutionSummaryEntry = {
    iteration: input.iteration,
    name: input.name,
    score: candidateResult.score,
    axis: proposal.candidate.axis ?? "exploitation",
    hypothesis: proposal.candidate.hypothesis ?? "no hypothesis recorded",
    delta: candidateResult.score - parentResult.score,
    outcome: gate.passed ? "accepted" : "rejected",
    components: [proposal.candidate.text],
    gate: { passed: gate.passed, refusals: gate.refusals },
    // The decision fields ride the SAME line the queue reads, so a
    // reviewer sees the splits, the per-gate verdicts and the cost
    // without a second file that could drift from this one.
    splits: splitScores(candidateResult),
    gateResults: gate.gates,
    sampleCount,
  };

  return { ok: true, entry, candidate, gate };
}

/** The entry's own line, for the caller to append to the run's summary. */
export function roundSummaryLine(entry: EvolutionSummaryEntry): string {
  return summaryLine(entry);
}

import { checkGrowth } from "./evaluation";

/**
 * L5's gate matrix: every variant passes ALL gates or it does not land.
 *
 * The seven gates are the reference study's five hard constraints plus the
 * two this framework already had, arranged so that a candidate is judged
 * once, in one place, with every refusal named:
 *
 *  G1 full test suite      — a seam: the caller runs the suite and hands
 *                            the verdict in. A gate that runs tests itself
 *                            would make this module un-unit-testable.
 *  G2 size caps by target  — skill 15KB, tool description 500 chars,
 *                            parameter description 200 chars, prompt
 *                            segment growth ≤20%.
 *  G3 growth cap           — L3's rule (≤20% over baseline, a refusal not
 *                            a penalty).
 *  G4 semantic preservation— the candidate must not drift into a different
 *                            artifact: token overlap with the baseline
 *                            below the floor is refused. The necessity
 *                            gate's duplicate rule (overlap ≥ 0.6 with an
 *                            EXISTING skill refuses) is the coarse
 *                            predecessor of this; this is its other half.
 *  G5 cache compatibility  — never hot-swap into a live session. Structural:
 *                            the gate refuses a candidate that claims to
 *                            take effect now.
 *  G6 human review         — never auto-merge. Structural: the gate refuses
 *                            a candidate that claims its own approval.
 *  G7 benchmark            — a seam (L6 fills it): capability must not
 *                            regress. An absent seam answers "unverified",
 *                            never "passed".
 *
 * **Every refusal is named** as `name: reason` and lands in the journal
 * (the `refusals` field the review event already carries): a human can see
 * what the loop wanted to change and why it was stopped. A failed variant
 * is also PERSISTED, never deployed — the search history is not thrown
 * away, because "what it tried and was refused" is how a reviewer learns
 * where the traps are.
 */

/** What is being gated (the target type picks the size cap). */
export type GateTarget =
  | { kind: "skill"; name: string }
  | { kind: "tool-description"; name: string }
  | { kind: "parameter-description"; name: string }
  | { kind: "prompt-segment"; name: string };

/** G2's caps, by target kind. */
export const SIZE_CAPS = {
  /** A skill's body (the reference study's 15KB). */
  skill: 15_000,
  /** A tool's description (their 500 characters). */
  "tool-description": 500,
  /** A parameter's description (their 200 characters). */
  "parameter-description": 200,
  /** A prompt segment grows at most 20% over its baseline (G3's ratio). */
  "prompt-segment": Number.POSITIVE_INFINITY,
} as const;

/** G4's floor: token overlap with the baseline below this is a drift. */
export const SEMANTIC_OVERLAP_FLOOR = 0.3;

export type GateResult = {
  gate: "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7";
  ok: boolean;
  detail: string;
};

export type GateReport = {
  passed: boolean;
  gates: GateResult[];
  /** `name: reason` lines, the shape the journal's refusals field carries. */
  refusals: string[];
};

/** The suite verdict (G1's seam). */
export type SuiteVerdict = { ok: boolean; detail: string };

/** The benchmark verdict (G7's seam; absent = unverified, never passed). */
export type BenchmarkVerdict =
  | { ok: true; detail: string }
  | { ok: false; detail: string }
  | { unverified: true; detail: string };

export type GateInput = {
  target: GateTarget;
  /** The current artifact's text (the baseline every cap compares against). */
  baseline: string;
  /** The candidate's text. */
  candidate: string;
  /** G1: the full suite's verdict (the caller ran it). */
  suite: SuiteVerdict;
  /** G7: the benchmark's verdict, or absent while L6 does not exist yet. */
  benchmark?: BenchmarkVerdict;
  /**
   * G5/G6's structural claims. A candidate that claims to take effect in
   * the live session, or to be self-approved, is refused BY THE GATE —
   * these are not settings, they are the laws.
   */
  claims?: { effectiveNow?: boolean; selfApproved?: boolean };
};

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 2),
  );
}

/**
 * G4: the candidate's token overlap with the baseline. One-directional on
 * purpose — the question is "did the candidate keep what the baseline was
 * about", not "are they similar" (a much shorter candidate that keeps every
 * baseline token is fine; a same-length candidate about something else is
 * not).
 */
export function semanticOverlap(baseline: string, candidate: string): number {
  const baselineTokens = tokens(baseline);
  if (!baselineTokens.size) return 1;
  const candidateTokens = tokens(candidate);
  let kept = 0;
  for (const token of baselineTokens) if (candidateTokens.has(token)) kept += 1;
  return kept / baselineTokens.size;
}

/** Run every gate. All must pass; every failure is named in `refusals`. */
export function gateCandidate(input: GateInput): GateReport {
  const gates: GateResult[] = [];
  const refusals: string[] = [];
  const refuse = (result: GateResult) => {
    gates.push(result);
    refusals.push(`${input.target.name}: ${result.gate} ${result.detail}`);
  };
  const pass = (result: GateResult) => gates.push(result);

  // G1 — the full suite. The hard floor: nothing ships that breaks what
  // exists.
  if (input.suite.ok)
    pass({ gate: "G1", ok: true, detail: input.suite.detail });
  else
    refuse({
      gate: "G1",
      ok: false,
      detail: `suite failed — ${input.suite.detail}`,
    });

  // G2 — the size cap for this target kind.
  const cap = SIZE_CAPS[input.target.kind];
  const size = Buffer.byteLength(input.candidate, "utf8");
  if (size <= cap)
    pass({
      gate: "G2",
      ok: true,
      detail: `${size} bytes within the ${cap} cap`,
    });
  else
    refuse({
      gate: "G2",
      ok: false,
      detail: `${size} bytes exceeds the ${cap} cap for a ${input.target.kind}`,
    });

  // G3 — the growth cap (a refusal, not a penalty).
  const growth = checkGrowth(Buffer.byteLength(input.baseline, "utf8"), size);
  if (growth.ok)
    pass({
      gate: "G3",
      ok: true,
      detail: `growth ${(growth.ratio * 100 - 100).toFixed(1)}% within the cap`,
    });
  else refuse({ gate: "G3", ok: false, detail: growth.reason });

  // G4 — semantic preservation.
  const overlap = semanticOverlap(input.baseline, input.candidate);
  if (overlap >= SEMANTIC_OVERLAP_FLOOR)
    pass({
      gate: "G4",
      ok: true,
      detail: `keeps ${(overlap * 100).toFixed(0)}% of the baseline's tokens`,
    });
  else
    refuse({
      gate: "G4",
      ok: false,
      detail: `drifted — keeps only ${(overlap * 100).toFixed(0)}% of the baseline's tokens (floor ${(SEMANTIC_OVERLAP_FLOOR * 100).toFixed(0)}%)`,
    });

  // G5 — cache compatibility. The claim is the violation.
  if (input.claims?.effectiveNow === true)
    refuse({
      gate: "G5",
      ok: false,
      detail:
        "claims to take effect in the live session — changes land at the next session boundary",
    });
  else
    pass({
      gate: "G5",
      ok: true,
      detail: "effective at the next session boundary",
    });

  // G6 — human review. Never auto-merge, at any layer, forever.
  if (input.claims?.selfApproved === true)
    refuse({
      gate: "G6",
      ok: false,
      detail: "claims its own approval — a human approves every landing",
    });
  else pass({ gate: "G6", ok: true, detail: "awaits the human's approval" });

  // G7 — the benchmark. An absent seam is UNVERIFIED, which is a refusal:
  // "nobody checked" must not read as "checked and fine".
  if (!input.benchmark)
    refuse({
      gate: "G7",
      ok: false,
      detail:
        "unverified — no benchmark seam answered (an absent check is not a passing check)",
    });
  else if ("unverified" in input.benchmark)
    refuse({
      gate: "G7",
      ok: false,
      detail: `unverified — ${input.benchmark.detail}`,
    });
  else if (input.benchmark.ok)
    pass({ gate: "G7", ok: true, detail: input.benchmark.detail });
  else
    refuse({
      gate: "G7",
      ok: false,
      detail: `regressed — ${input.benchmark.detail}`,
    });

  return { passed: refusals.length === 0, gates, refusals };
}

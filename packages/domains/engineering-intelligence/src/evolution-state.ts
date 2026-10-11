import type { CandidateAxis } from "./reflective-mutator";

/**
 * L4c's state files: the loop's memory, as four files a mutator can read
 * and a human can diff.
 *
 * The reference engine's whole optimization round is organized as files —
 * the objective, the history of what was tried, the frontier, and the
 * candidates themselves. The shapes here are deliberately the same, because
 * the point of the files is that a fresh process (or a fresh agent) can
 * pick the loop up from them alone:
 *
 *  - `task.md` — the objective, the background, the evaluation model;
 *  - `evolution_summary.jsonl` — one line per EVALUATED candidate:
 *    iteration, name, score, axis, hypothesis, delta, outcome, components;
 *  - `frontier.json` — the global best plus `per_example`: which candidate
 *    owns each example. That per-example map is the strongest signal for
 *    COMBINATION candidates — when different candidates win different
 *    examples, the next candidate fuses their mechanisms;
 *  - the candidates themselves — the seed is read-only.
 *
 * All three serializers are pure (string in, string out); the caller owns
 * the disk. A round-trip test proves each one reads back exactly what it
 * wrote, because a state file that silently drops a field is a loop that
 * forgets what it already tried.
 */

/** The objective file's shape (rendered as markdown by the caller). */
export type EvolutionTask = {
  objective: string;
  background: string;
  /** What the evaluation model is (the judge's identity, in words). */
  evaluationModel: string;
};

/** One evaluated candidate's line in the summary. */
export type EvolutionSummaryEntry = {
  iteration: number;
  name: string;
  score: number;
  axis: CandidateAxis;
  hypothesis: string;
  /** The score delta against this candidate's parent (negative = worse). */
  delta: number;
  outcome: "accepted" | "rejected";
  components: string[];
  /**
   * The unified diff against this candidate's PARENT — "what actually
   * changed", readable without re-deriving it from two artifacts. A score
   * without its diff is a number nobody can learn from.
   */
  parentDiff?: string;
  /**
   * The conditions this score was measured under: the round, the judge,
   * the dataset. Two scores measured under different conditions are not
   * comparable, and a history that quietly mixes them is worse than no
   * history — it manufactures false trends.
   */
  provenance?: string;
  /**
   * The seven gates' verdict on this candidate: which passed, and the
   * refusals verbatim. A candidate that scored well and was refused is
   * the most instructive line in the whole history — it is where the loop
   * learned what fitness cannot see — so the verdict rides the line
   * rather than living in a separate file nobody opens.
   */
  gate?: { passed: boolean; refusals: string[] };
};

export function renderTaskFile(task: EvolutionTask): string {
  return [
    `# ${task.objective}`,
    "",
    "## Background",
    task.background,
    "",
    "## Evaluation model",
    task.evaluationModel,
    "",
  ].join("\n");
}

/** One summary line per candidate (append-only; replay reads the file). */
export function summaryLine(entry: EvolutionSummaryEntry): string {
  return JSON.stringify({
    iteration: entry.iteration,
    name: entry.name,
    score: entry.score,
    axis: entry.axis,
    hypothesis: entry.hypothesis,
    delta: entry.delta,
    outcome: entry.outcome,
    components: entry.components,
    ...(entry.parentDiff === undefined ? {} : { parentDiff: entry.parentDiff }),
    ...(entry.provenance === undefined ? {} : { provenance: entry.provenance }),
    ...(entry.gate === undefined ? {} : { gate: entry.gate }),
  });
}

export function parseSummary(
  body: string,
): Array<Partial<EvolutionSummaryEntry> & { name?: string }> {
  return body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Partial<EvolutionSummaryEntry>);
}

/** The frontier: the global best, and the owner of each example. */
export type FrontierFile = {
  /** The best candidate by aggregate score. */
  best: { name: string; score: number } | null;
  /** Per example: the candidate that owns it (the combination signal). */
  perExample: Record<string, { name: string; score: number }>;
};

export function renderFrontier(frontier: FrontierFile): string {
  return `${JSON.stringify(
    {
      best: frontier.best,
      per_example: frontier.perExample,
    },
    null,
    2,
  )}\n`;
}

export function parseFrontier(body: string): FrontierFile {
  const parsed = JSON.parse(body) as {
    best: FrontierFile["best"];
    per_example: FrontierFile["perExample"];
  };
  return { best: parsed.best, perExample: parsed.per_example };
}

/**
 * The candidate metadata contract: every candidate carries a falsifiable
 * hypothesis, its axis, what it builds on, and its component tags — the
 * same shape the reference engine's `pending_eval.json` carries, because a
 * candidate without them cannot be judged or combined later.
 */
export type CandidateMetadata = {
  iteration: number;
  candidates: Array<{
    name: string;
    file: string;
    hypothesis: string;
    axis: CandidateAxis;
    base: string;
    components: string[];
  }>;
};

export function renderCandidateMetadata(metadata: CandidateMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

export function parseCandidateMetadata(body: string): CandidateMetadata {
  return JSON.parse(body) as CandidateMetadata;
}

/** Where a target's evolution state lives (the workspace's own directory). */
export function evolutionStateDir(
  workspaceRoot: string,
  target: string,
): string {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(target))
    throw new Error(`invalid evolution target: ${target}`);
  return `${workspaceRoot}/.natalia/evolution/${target}`;
}

/**
 * The diff against the parent, through the maintained differ (never a
 * hand-rolled one): the summary line's "what changed" field. Returns the
 * patch plus the line counts, so a reader sees the size of the change
 * before opening it.
 */
export async function parentDiff(
  parentText: string,
  candidateText: string,
): Promise<{ patch: string; additions: number; deletions: number }> {
  const { diffWasm } = await import("@anthelia/diff-wasm");
  const result = await diffWasm(parentText, candidateText);
  return {
    patch: result.patch ?? "",
    additions: result.additions,
    deletions: result.deletions,
  };
}

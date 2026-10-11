import type { CandidateAxis } from "./reflective-mutator";

/**
 * L4c's engine loop: the population, the parent selection, the Pareto
 * front, the merge channel, and the round structure that keeps a round's
 * own variants invisible to itself.
 *
 * Every rule here is taken from the two reference engines' source and
 * corrected by it:
 *
 * 1. **Parent selection is sigmoid(score) × novelty, not a sort.** A
 *    ranked parent takes the same few strong candidates every round and
 *    the population converges; the novelty term (fewer children → higher
 *    weight) actively maintains diversity. `midpoint` defaults to the
 *    population's own p75, so the scale adapts as scores improve.
 * 2. **No trainable failure case, no reproduction.** An individual that
 *    never failed anywhere has nothing to evolve FROM — it is excluded
 *    from parenting entirely, however good it looks.
 * 3. **Selection from the Pareto front is frequency-weighted, not
 *    max-score.** Each validation example owns a front; a candidate's
 *    weight is how many fronts it appears on. A candidate that is
 *    extraordinary on one kind of example and ordinary elsewhere still
 *    gets picked — through the front it owns.
 * 4. **Merging is free.** Two non-kin candidates with a common ancestor
 *    are combined component-by-component without spending an evaluation:
 *    where the ancestor matches one child, the other child's value is the
 *    clear improvement; where both differ, the higher score wins.
 * 5. **A round's variants are invisible to that round.** All evaluations
 *    are collected before the population updates, so a mutator can never
 *    breed with the siblings it just produced (including their learning
 *    logs).
 *
 * The proposer and the evaluator are injected seams; this module owns the
 * population semantics, the selection arithmetic and the round structure.
 */

/** One member of the population. */
export type PopulationMember = {
  id: string;
  /** The artifact's components (the merge channel's unit of choice). */
  components: Record<string, string>;
  /** The aggregate score (L3's composite). */
  score: number;
  /** Per-example scores — the Pareto fronts' axes. */
  perExample: Record<string, number>;
  /** How many trainable failure cases it carries (0 ⇒ cannot parent). */
  trainableFailures: number;
  /** L3's viability (a failed candidate is not a parent either). */
  isViable: boolean;
  /** How many children this member has already produced (novelty's input). */
  children: number;
  /**
   * The population's SEED — the baseline the loop was started from. The
   * reference evolver's `exclude_untrainable` gates the POPULATION's
   * parents; it is not a rule that the seed may not breed. A baseline whose
   * answers already match the recorded responses (the same model on the
   * same task makes that likely) carries no trainable failure case, and
   * under a blanket viability gate the loop could not take its first step.
   * The exemption is the seed's alone and is never inherited: a mutated
   * child with nothing to learn from still may not parent.
   */
  seed?: boolean;
  lineage: {
    parent?: string;
    additionalParents?: string[];
  };
  hypothesis?: string;
  axis?: CandidateAxis;
  /** The learning log: what the mutation attempted, and what was observed. */
  learningLog?: { attemptedChange: string; observedOutcome: string };
};

export type Population = {
  members: PopulationMember[];
};

/** The randomness seam (a deterministic fake in tests). */
export type Random = () => number;

// --- parent selection --------------------------------------------------------

/** The sigmoid's sharpness (the reference evolver's default). */
export const PARENT_SHARPNESS = 10;
/** How strongly child count discounts a parent (the novelty reward). */
export const PARENT_NOVELTY_WEIGHT = 1;

/** The population's p75 score (the dynamic midpoint's default). */
export function scoreMidpoint(population: Population): number {
  const scores = population.members
    .map((member) => member.score)
    .sort((left, right) => left - right);
  if (!scores.length) return 0;
  const index = Math.min(
    scores.length - 1,
    Math.floor(0.75 * (scores.length - 1)),
  );
  return scores[index]!;
}

/**
 * One member's parenting weight: zero when it may not parent at all
 * (unviable, or no trainable failure case), otherwise
 * `sigmoid(sharpness × (score − midpoint)) × 1/(1 + novelty × children)`.
 *
 * The seed is exempt from the viability gate only — it keeps the score and
 * novelty weights like any member, so a strong population still outbreeds
 * it. Everything else about the gate stands: a mutated member with no
 * trainable failure case cannot parent.
 */
export function parentWeight(
  member: PopulationMember,
  population: Population,
  options: { midpoint?: number } = {},
): number {
  if (!member.seed && (!member.isViable || member.trainableFailures === 0))
    return 0;
  const midpoint = options.midpoint ?? scoreMidpoint(population);
  const sharp =
    1 / (1 + Math.exp(-PARENT_SHARPNESS * (member.score - midpoint)));
  const novelty = 1 / (1 + PARENT_NOVELTY_WEIGHT * member.children);
  return sharp * novelty;
}

/**
 * Weighted sampling over the parentable members. Returns undefined when
 * nobody may parent (an all-unviable population has no next round — the
 * loop stops rather than inventing a parent).
 */
export function selectParent(
  population: Population,
  random: Random,
  options: { midpoint?: number } = {},
): PopulationMember | undefined {
  const weights = population.members.map((member) => ({
    member,
    weight: parentWeight(member, population, options),
  }));
  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(total > 0)) return undefined;
  // A strict `< 0` walk with zero-weight entries skipped: a ticket that
  // lands exactly on a boundary must not hand the draw to a member with no
  // weight at all (the barren-first ordering used to return it), and a
  // floating-point ticket that undershoots a boundary by 1e-16 must not
  // silently fall through to the last entry either.
  let ticket = random() * total;
  for (const entry of weights) {
    if (entry.weight <= 0) continue;
    ticket -= entry.weight;
    if (ticket < 0) return entry.member;
  }
  return weights.find((entry) => entry.weight > 0)!.member;
}

// --- the Pareto front ----------------------------------------------------------

/**
 * Instance-type fronts: one front per example, holding every member that
 * no other member beats on that example (ties share the front). A member
 * with no per-example scores owns no front and is invisible to this
 * selection — the front reads measured examples only.
 */
export function paretoFronts(population: Population): string[][] {
  const exampleIDs = [
    ...new Set(
      population.members.flatMap((member) => Object.keys(member.perExample)),
    ),
  ].sort();
  const fronts: string[][] = [];
  for (const exampleID of exampleIDs) {
    const scored = population.members
      .map((member) => ({ id: member.id, value: member.perExample[exampleID] }))
      .filter(
        (entry): entry is { id: string; value: number } =>
          typeof entry.value === "number",
      );
    if (!scored.length) continue;
    const best = Math.max(...scored.map((entry) => entry.value));
    fronts.push(
      scored.filter((entry) => entry.value === best).map((entry) => entry.id),
    );
  }
  return fronts;
}

/**
 * Frequency-weighted selection from the fronts: each member's weight is
 * the number of fronts it appears on. This is the reference engine's
 * `select_program_candidate_from_pareto_front` — a specialist that owns
 * one front is picked as often as a generalist that owns them all, which
 * a max-score sort would never do.
 */
export function selectFromParetoFront(
  population: Population,
  random: Random,
): PopulationMember | undefined {
  const fronts = paretoFronts(population);
  const counts = new Map<string, number>();
  for (const front of fronts)
    for (const id of front) counts.set(id, (counts.get(id) ?? 0) + 1);
  const entries = [...counts.entries()].map(([id, count]) => ({
    member: population.members.find((member) => member.id === id)!,
    weight: count,
  }));
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(total > 0)) return undefined;
  // The same strict walk as the parent draw (a boundary ticket belongs to
  // the member it lands ON, and a zero-count member is never in the map).
  let ticket = random() * total;
  for (const entry of entries) {
    ticket -= entry.weight;
    if (ticket < 0) return entry.member;
  }
  return entries.at(-1)!.member;
}

// --- lineage and the merge channel ---------------------------------------------

/** Walk a member's ancestor chain (parents first, then additional parents). */
export function ancestorsOf(
  member: PopulationMember,
  population: Population,
): PopulationMember[] {
  const byID = new Map(population.members.map((entry) => [entry.id, entry]));
  const seen = new Set<string>([member.id]);
  const chain: PopulationMember[] = [];
  const queue = [
    ...(member.lineage.additionalParents ?? []),
    ...(member.lineage.parent ? [member.lineage.parent] : []),
  ];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const ancestor = byID.get(id);
    if (!ancestor) continue;
    chain.push(ancestor);
    queue.push(
      ...(ancestor.lineage.additionalParents ?? []),
      ...(ancestor.lineage.parent ? [ancestor.lineage.parent] : []),
    );
  }
  return chain;
}

/** Whether `candidate` is an ancestor of `member` (kin detection). */
export function isAncestorOf(
  candidate: PopulationMember,
  member: PopulationMember,
  population: Population,
): boolean {
  return ancestorsOf(member, population).some(
    (ancestor) => ancestor.id === candidate.id,
  );
}

/**
 * The two candidates' nearest common ancestor, or undefined when they are
 * kin or share no recorded ancestor. Only non-kin pairs merge: merging
 * close relatives recombines what evolution just separated.
 */
export function commonAncestor(
  left: PopulationMember,
  right: PopulationMember,
  population: Population,
): PopulationMember | undefined {
  if (left.id === right.id) return undefined;
  if (
    isAncestorOf(left, right, population) ||
    isAncestorOf(right, left, population)
  )
    return undefined;
  const rightAncestors = new Set(
    ancestorsOf(right, population).map((ancestor) => ancestor.id),
  );
  return ancestorsOf(left, population).find((ancestor) =>
    rightAncestors.has(ancestor.id),
  );
}

export type MergeResult =
  | { ok: true; components: Record<string, string>; id: string }
  | { ok: false; reason: string };

/**
 * Merge two non-kin candidates over their common ancestor, component by
 * component:
 *  - the ancestor matches one child → take the OTHER child's value (a
 *    clear improvement, whichever side it came from);
 *  - both children differ from the ancestor → take the higher score's;
 *  - the children agree → either.
 *
 * The merge is FREE (no evaluation is spent). It is refused when there is
 * no common ancestor (kin or unrelated), and when the triplet has nothing
 * to improve — a merge that reproduces the ancestor exactly is not a
 * candidate.
 */
export function mergeCandidates(input: {
  left: PopulationMember;
  right: PopulationMember;
  ancestor: PopulationMember;
  id: string;
}): MergeResult {
  const { left, right, ancestor } = input;
  const keys = [
    ...new Set([
      ...Object.keys(left.components),
      ...Object.keys(right.components),
      ...Object.keys(ancestor.components),
    ]),
  ];
  const merged: Record<string, string> = {};
  let improvements = 0;
  for (const key of keys) {
    const base = ancestor.components[key];
    const fromLeft = left.components[key];
    const fromRight = right.components[key];
    if (fromLeft === undefined && fromRight === undefined) {
      merged[key] = base ?? "";
      continue;
    }
    if (fromLeft === fromRight) {
      merged[key] = fromLeft!;
      if (base !== undefined && base !== fromLeft) improvements += 1;
      continue;
    }
    if (base !== undefined && fromLeft === base) {
      merged[key] = fromRight!;
      improvements += 1;
      continue;
    }
    if (base !== undefined && fromRight === base) {
      merged[key] = fromLeft!;
      improvements += 1;
      continue;
    }
    // Both children differ from the ancestor: the higher score's value.
    merged[key] = left.score >= right.score ? fromLeft! : fromRight!;
    improvements += 1;
  }
  if (!improvements)
    return {
      ok: false,
      reason: "the triplet improves nothing over the ancestor",
    };
  return { ok: true, components: merged, id: input.id };
}

// --- the round ------------------------------------------------------------------

/** What one round's proposer produces for a parent (before evaluation). */
export type RoundProposal = {
  id: string;
  components: Record<string, string>;
  hypothesis?: string;
  axis?: CandidateAxis;
};

/** What one round's evaluator answers for a proposal. */
export type RoundEvaluation = {
  score: number;
  perExample: Record<string, number>;
  trainableFailures: number;
  isViable: boolean;
};

export type RoundHooks = {
  /** The mutator: one parent in, one proposal out (P4b's proposer). */
  propose: (parent: PopulationMember) => Promise<RoundProposal>;
  /** The evaluator: one proposal in, its measured facts out (L3's face). */
  evaluate: (proposal: RoundProposal) => Promise<RoundEvaluation>;
};

export type RoundResult = {
  population: Population;
  /** The members this round added (empty when nothing was proposed). */
  added: PopulationMember[];
  /** Why the round produced nothing, when it did. */
  stopped?: string;
};

/**
 * Run one round: propose from each selected parent, evaluate EVERY
 * proposal, and only then update the population.
 *
 * The atomic update is the same-round invisibility rule: the proposals are
 * produced against the population as it was when the round opened, so a
 * mutator can never see — or breed with — the siblings this round is
 * producing, and their learning logs are equally invisible.
 */
export async function runRound(input: {
  population: Population;
  hooks: RoundHooks;
  random: Random;
  /** How many parents to draw this round (default 1). */
  parents?: number;
}): Promise<RoundResult> {
  const opening = input.population;
  const parents: PopulationMember[] = [];
  for (let index = 0; index < (input.parents ?? 1); index += 1) {
    const parent = selectParent(opening, input.random);
    if (!parent)
      return {
        population: opening,
        added: [],
        stopped:
          "no member may parent (every candidate is unviable or has no trainable failure case) — " +
          "the dataset is too easy for the current judge: mine harder samples or switch to a stronger judge",
      };
    parents.push(parent);
  }
  const evaluated: PopulationMember[] = [];
  for (const parent of parents) {
    const proposal = await input.hooks.propose(parent);
    const facts = await input.hooks.evaluate(proposal);
    evaluated.push({
      id: proposal.id,
      components: proposal.components,
      score: facts.score,
      perExample: facts.perExample,
      trainableFailures: facts.trainableFailures,
      isViable: facts.isViable,
      children: 0,
      lineage: { parent: parent.id },
      ...(proposal.hypothesis ? { hypothesis: proposal.hypothesis } : {}),
      ...(proposal.axis ? { axis: proposal.axis } : {}),
      learningLog: {
        attemptedChange: proposal.hypothesis ?? "(unstated)",
        observedOutcome: `scored ${facts.score.toFixed(4)} against parent ${parent.id} at ${parent.score.toFixed(4)}`,
      },
    });
  }
  // The atomic update: the parents' child counts move and the new members
  // land together, after every evaluation settled.
  const childCounts = new Map<string, number>();
  for (const parent of parents)
    childCounts.set(parent.id, (childCounts.get(parent.id) ?? 0) + 1);
  const members = opening.members.map((member) => {
    const extra = childCounts.get(member.id) ?? 0;
    return extra ? { ...member, children: member.children + extra } : member;
  });
  return {
    population: { members: [...members, ...evaluated] },
    added: evaluated,
  };
}

/**
 * The phase gate: an engine generation must STRICTLY beat the BestOfN
 * floor or the loop stops. A tie is not an improvement (L3's acceptance
 * rule, applied to whole generations).
 */
export function beatsFloor(input: {
  best: PopulationMember | undefined;
  floorScore: number;
}): { ok: boolean; reason: string } {
  if (!input.best)
    return { ok: false, reason: "no candidate to compare against the floor" };
  if (input.best.score > input.floorScore)
    return {
      ok: true,
      reason: `best ${input.best.score.toFixed(4)} beats the floor ${input.floorScore.toFixed(4)}`,
    };
  return {
    ok: false,
    reason: `best ${input.best.score.toFixed(4)} does not beat the floor ${input.floorScore.toFixed(4)} — stop and reassess before the next engine`,
  };
}

/** The population's best member by aggregate score (the generation's result). */
/**
 * The population's REPORTED best: a draw from the Pareto front with
 * frequency weighting, falling back to the max score when the front is
 * empty (a one-member population, or one where every member is dominated).
 *
 * This is the selection the loop's report and phase gate read. The
 * max-score pick alone would let one well-rounded average bury every
 * specialist: a candidate that is extraordinary on one kind of example and
 * ordinary elsewhere OWNS the front it wins, which is how it stays
 * selectable — and a loop that can only ever report the average has no
 * reason to keep specialists around.
 */
export function selectReportedBest(
  population: Population,
  random: Random,
): PopulationMember | undefined {
  return selectFromParetoFront(population, random) ?? bestMember(population);
}

export function bestMember(
  population: Population,
): PopulationMember | undefined {
  return population.members.reduce<PopulationMember | undefined>(
    (best, member) => (!best || member.score > best.score ? member : best),
    undefined,
  );
}

// --- the curiosity controller -------------------------------------------------

/**
 * The exploration/exploitation controller.
 *
 * Without it the loop's axis labels are decoration: nothing decides
 * whether the next round should mine the neighbourhood of what worked or
 * reach somewhere new, so the mix is whatever the sampler happened to
 * produce. A trader does not decide on one price — the decision is a
 * function of the recent trend, the idle capacity, and how long the
 * current approach has been failing.
 *
 * The law (the user's design note): the curiosity value drifts toward the
 * idle ratio, rises with recent gain, and falls with consecutive
 * failures, clamped to [0, 1]. High curiosity reaches; low curiosity
 * mines. The four weights are named so a tuning run changes a constant,
 * not a formula.
 */
export const CURIOSITY_STEP = 0.5;
export const CURIOSITY_DECAY = 0.3;
export const CURIOSITY_GAIN_WEIGHT = 0.2;
export const CURIOSITY_FAILURE_WEIGHT = 0.15;
/** At or above this value the controller asks for an exploring mutation. */
export const CURIOSITY_EXPLORE_THRESHOLD = 0.5;

export type CuriosityState = {
  /** The clamped curiosity value in [0, 1]. */
  value: number;
  /** Consecutive rounds without a strict improvement (the failure term). */
  failures: number;
};

export const INITIAL_CURIOSITY: CuriosityState = { value: 0.5, failures: 0 };

export function updateCuriosity(
  state: CuriosityState,
  input: {
    /** How idle the machine was this round (0..1) — capacity to explore. */
    idleRatio: number;
    /** The round's gain: the best score's improvement (0 = none). */
    gain: number;
  },
): CuriosityState {
  const idle = clamp01(input.idleRatio);
  const gain = Math.max(0, input.gain);
  const raw =
    state.value +
    CURIOSITY_STEP * (idle - CURIOSITY_DECAY * state.value) +
    CURIOSITY_GAIN_WEIGHT * gain -
    CURIOSITY_FAILURE_WEIGHT * state.failures;
  return {
    value: clamp01(raw),
    // A strict improvement resets the failure count; anything else adds
    // one. The count is what pulls curiosity down when a direction stops
    // paying.
    failures: gain > 0 ? 0 : state.failures + 1,
  };
}

/** The axis the controller asks for this round. */
export function curiosityAxis(
  state: CuriosityState,
): "exploitation" | "exploration" {
  return state.value >= CURIOSITY_EXPLORE_THRESHOLD
    ? "exploration"
    : "exploitation";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

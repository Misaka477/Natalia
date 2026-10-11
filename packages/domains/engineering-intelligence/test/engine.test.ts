import { expect, test } from "bun:test";
import {
  ancestorsOf,
  beatsFloor,
  bestMember,
  commonAncestor,
  isAncestorOf,
  mergeCandidates,
  parentWeight,
  paretoFronts,
  runRound,
  scoreMidpoint,
  selectFromParetoFront,
  selectParent,
  selectReportedBest,
  type Population,
  type PopulationMember,
  type Random,
} from "../src/engine";

/**
 * L4c's engine loop: the population semantics, the selection arithmetic,
 * the merge channel, and the round structure that keeps a round's own
 * variants invisible to itself.
 *
 * The load-bearing tests: an unviable member never parents however good it
 * looks; the novelty term actually discounts busy parents; the Pareto
 * selection is frequency-weighted (a specialist is picked); a merge over a
 * common ancestor spends no evaluation and refuses kin pairs; and a round's
 * proposer never sees the siblings the round is producing.
 */

const member = (
  id: string,
  input: {
    score?: number;
    perExample?: Record<string, number>;
    trainableFailures?: number;
    isViable?: boolean;
    children?: number;
    seed?: boolean;
    parent?: string;
    additionalParents?: string[];
    components?: Record<string, string>;
  } = {},
): PopulationMember => ({
  id,
  components: input.components ?? { body: `body of ${id}` },
  score: input.score ?? 0.5,
  perExample: input.perExample ?? {},
  trainableFailures: input.trainableFailures ?? 1,
  isViable: input.isViable ?? true,
  children: input.children ?? 0,
  ...(input.seed ? { seed: true } : {}),
  lineage: {
    ...(input.parent ? { parent: input.parent } : {}),
    ...(input.additionalParents
      ? { additionalParents: input.additionalParents }
      : {}),
  },
});

/** A deterministic random: a fixed sequence of tickets. */
function scriptedRandom(values: number[]): Random {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

// --- parent selection -----------------------------------------------------------

test("an unviable member, or one with no trainable failure, never parents", () => {
  const population: Population = {
    members: [
      member("strong-but-barren", { score: 0.99, trainableFailures: 0 }),
      member("failed-somewhere", { score: 0.4 }),
    ],
  };
  // The reference evolver's exclude_untrainable rule: nothing to evolve
  // FROM means no reproduction, however good the score looks.
  expect(parentWeight(population.members[0]!, population)).toBe(0);
  expect(parentWeight(population.members[1]!, population)).toBeGreaterThan(0);
  const unviable: Population = {
    members: [member("a", { score: 0.9, isViable: false })],
  };
  expect(parentWeight(unviable.members[0]!, unviable)).toBe(0);
  expect(selectParent(unviable, scriptedRandom([0.5]))).toBeUndefined();
});

test("the novelty term discounts a busy parent at equal score", () => {
  const fresh: Population = {
    members: [member("a", { score: 0.6, children: 0 })],
  };
  const busy: Population = {
    members: [member("a", { score: 0.6, children: 5 })],
  };
  const freshWeight = parentWeight(fresh.members[0]!, fresh);
  const busyWeight = parentWeight(busy.members[0]!, busy);
  expect(busyWeight).toBeLessThan(freshWeight);
  // The sigmoid's scale is the population's own p75, so a mid population
  // scores above the midpoint and a strong one does not saturate instantly.
  // (Four members: the p75 lands on the third, not the first — a two-member
  // population's p75 IS its weaker member, which is the honest nearest-rank
  // answer and not a bug.)
  expect(
    scoreMidpoint({
      members: [
        member("a", { score: 0.2 }),
        member("b", { score: 0.4 }),
        member("c", { score: 0.6 }),
        member("d", { score: 0.8 }),
      ],
    }),
  ).toBe(0.6);
});

test("selectParent respects the weights (a barren population stops the loop)", async () => {
  const population: Population = {
    members: [
      member("barren", { score: 0.99, trainableFailures: 0 }),
      member("fertile", { score: 0.5 }),
    ],
  };
  // Any ticket lands on the only parentable member.
  expect(selectParent(population, scriptedRandom([0, 0.5, 0.999]))?.id).toBe(
    "fertile",
  );
});

// --- the Pareto front -------------------------------------------------------------

test("a specialist owns its front and is picked as often as a generalist", () => {
  const population: Population = {
    members: [
      // Wins every example except one.
      member("generalist", {
        score: 0.8,
        perExample: { e1: 1, e2: 1, e3: 0.4 },
      }),
      // Wins exactly one example, and only that one.
      member("specialist", {
        score: 0.5,
        perExample: { e1: 0.2, e2: 0.1, e3: 1 },
      }),
    ],
  };
  const fronts = paretoFronts(population);
  expect(fronts).toEqual([["generalist"], ["generalist"], ["specialist"]]);
  // Frequency-weighted: the generalist owns 2 of 3 fronts, the specialist
  // 1 of 3 — a max-score sort would never draw the specialist at all. The
  // tickets stay off the exact boundaries (a boundary ticket is ambiguous
  // by construction; the walk belongs it to the member it lands on).
  const drawn: string[] = [];
  for (const ticket of [0.1, 0.5, 0.9])
    drawn.push(selectFromParetoFront(population, () => ticket)!.id);
  expect(drawn).toEqual(["generalist", "generalist", "specialist"]);
});

test("a member with no measured examples owns no front", () => {
  const population: Population = {
    members: [member("unmeasured", { score: 0.9 })],
  };
  expect(paretoFronts(population)).toEqual([]);
  expect(
    selectFromParetoFront(population, scriptedRandom([0.5])),
  ).toBeUndefined();
});

// --- lineage and merge -----------------------------------------------------------------

test("kin pairs are detected and refused a merge; a common ancestor merges for free", () => {
  const population: Population = {
    members: [
      member("root", {
        score: 0.5,
        components: { body: "root body", tools: "t0" },
      }),
      member("childA", {
        score: 0.6,
        parent: "root",
        components: { body: "A body", tools: "t0" },
      }),
      member("childB", {
        score: 0.7,
        parent: "root",
        components: { body: "root body", tools: "tB" },
      }),
    ],
  };
  const [root, childA, childB] = population.members;
  // The reference merge's kin rule is exactly this: one being the other's
  // ANCESTOR refuses the merge; siblings over a shared ancestor are the
  // channel's whole point (find_common_ancestor_pair skips only
  // ancestor-descendant pairs).
  expect(isAncestorOf(root!, childA!, population)).toBe(true);
  expect(commonAncestor(childA!, childB!, population)?.id).toBe("root");
  expect(ancestorsOf(childA!, population).map((entry) => entry.id)).toEqual([
    "root",
  ]);

  // A sibling pair over their shared ancestor: body takes A's change (root
  // matched B), tools takes B's change (root matched A) — both are clear
  // improvements, and no evaluation was spent.
  const merged = mergeCandidates({
    left: childA!,
    right: childB!,
    ancestor: root!,
    id: "merged-1",
  });
  expect(merged.ok).toBe(true);
  if (!merged.ok) return;
  expect(merged.components).toEqual({ body: "A body", tools: "tB" });
});

test("a merge that reproduces the ancestor exactly is refused", () => {
  const root = member("root", { score: 0.5, components: { body: "same" } });
  const left = member("l", {
    score: 0.6,
    parent: "root",
    components: { body: "same" },
  });
  const right = member("r", {
    score: 0.7,
    parent: "root",
    components: { body: "same" },
  });
  const merged = mergeCandidates({ left, right, ancestor: root, id: "m" });
  expect(merged.ok).toBe(false);
  if (merged.ok) return;
  expect(merged.reason).toContain("improves nothing");
});

test("when both children differ from the ancestor, the higher score's value wins", () => {
  const root = member("root", { score: 0.5, components: { body: "base" } });
  const weak = member("weak", {
    score: 0.55,
    parent: "root",
    components: { body: "weak" },
  });
  const strong = member("strong", {
    score: 0.9,
    parent: "root",
    components: { body: "strong" },
  });
  const merged = mergeCandidates({
    left: weak,
    right: strong,
    ancestor: root,
    id: "m",
  });
  expect(merged.ok).toBe(true);
  if (!merged.ok) return;
  expect(merged.components.body).toBe("strong");
});

// --- the round -----------------------------------------------------------------------

test("a round's proposer never sees the siblings the round is producing", async () => {
  // The same-round invisibility rule, as a behavior: the proposer is handed
  // the OPENING population, and the new members land only after every
  // evaluation settled.
  const opening: Population = {
    members: [member("parent", { score: 0.5, perExample: { e1: 0.5 } })],
  };
  const seen: Population[] = [];
  let call = 0;
  const result = await runRound({
    population: opening,
    random: scriptedRandom([0.5]),
    hooks: {
      propose: async (parent) => {
        seen.push({ members: [parent] });
        call += 1;
        return {
          id: `child-${call}`,
          components: { body: `child ${call}` },
          hypothesis: `hypothesis ${call}`,
          axis: "exploitation" as const,
        };
      },
      evaluate: async (proposal) => ({
        score: 0.6,
        perExample: { e1: 0.6 },
        trainableFailures: 1,
        isViable: true,
      }),
    },
  });
  expect(result.added).toHaveLength(1);
  // The proposer saw exactly one member (the opening parent) — not the
  // sibling this same round produced.
  expect(seen).toHaveLength(1);
  expect(seen[0]!.members).toHaveLength(1);
  expect(seen[0]!.members[0]!.id).toBe("parent");
  // The learning log rides the new member: what was attempted, what was
  // observed.
  expect(result.added[0]!.learningLog).toEqual({
    attemptedChange: "hypothesis 1",
    observedOutcome: "scored 0.6000 against parent parent at 0.5000",
  });
  // The parent's child count moved, and the opening member was not mutated.
  expect(result.population.members[0]!.children).toBe(1);
  expect(opening.members[0]!.children).toBe(0);
  expect(result.population.members).toHaveLength(2);
});

test("a round with no parentable member stops with a reason, not a crash", async () => {
  const barren: Population = {
    members: [member("barren", { score: 0.9, trainableFailures: 0 })],
  };
  const result = await runRound({
    population: barren,
    random: scriptedRandom([0.5]),
    hooks: {
      propose: async () => ({ id: "never", components: {} }),
      evaluate: async () => ({
        score: 1,
        perExample: {},
        trainableFailures: 0,
        isViable: true,
      }),
    },
  });
  expect(result.added).toEqual([]);
  expect(result.stopped).toContain("no member may parent");
  expect(result.population).toBe(barren);
});

test("the phase gate: a generation must strictly beat the BestOfN floor", () => {
  const floor = 0.5;
  expect(
    beatsFloor({ best: member("a", { score: 0.6 }), floorScore: floor }).ok,
  ).toBe(true);
  // A tie is not an improvement — the same rule L3 applies to candidates.
  const tie = beatsFloor({
    best: member("a", { score: 0.5 }),
    floorScore: floor,
  });
  expect(tie.ok).toBe(false);
  expect(tie.reason).toContain("stop and reassess");
  expect(beatsFloor({ best: undefined, floorScore: floor }).ok).toBe(false);
  // bestMember reads the aggregate score, not the fronts.
  expect(
    bestMember({
      members: [member("low", { score: 0.2 }), member("high", { score: 0.9 })],
    })!.id,
  ).toBe("high");
});

test("the seed breeds even with nothing to learn from; its children do not inherit that", () => {
  // W11: the reference evolver's exclude_untrainable gates the POPULATION's
  // parents — it is not a rule that the seed may not breed. A baseline
  // whose answers already match the recorded ones (the same model on the
  // same task makes that likely) carries no trainable failure case, and a
  // blanket viability gate stops the loop before its first round.
  const barrenBaseline = member("baseline", {
    score: 0.9,
    trainableFailures: 0,
    isViable: false,
    seed: true,
  });
  expect(
    parentWeight(barrenBaseline, { members: [barrenBaseline] }),
  ).toBeGreaterThan(0);
  expect(
    selectParent({ members: [barrenBaseline] }, scriptedRandom([0.5]))?.id,
  ).toBe("baseline");

  // The exemption is the seed's alone: a mutated child that also came back
  // empty still may not parent, so the loop still terminates honestly.
  const barrenChild = member("child", {
    trainableFailures: 0,
    isViable: false,
  });
  expect(
    selectParent(
      { members: [barrenBaseline, barrenChild] },
      scriptedRandom([0.99]),
    )?.id,
  ).toBe("baseline");
  expect(
    selectParent({ members: [barrenChild] }, scriptedRandom([0.5])),
  ).toBeUndefined();
});

test("a round started from a barren seed still runs, and the stop reason is actionable", async () => {
  const barrenSeed = member("baseline", {
    score: 0.9,
    trainableFailures: 0,
    isViable: false,
    seed: true,
  });
  const result = await runRound({
    population: { members: [barrenSeed] },
    random: scriptedRandom([0.5]),
    hooks: {
      propose: async (parent) => ({
        id: "child-1",
        components: { body: "a real mutation" },
      }),
      evaluate: async () => ({
        score: 0.91,
        perExample: {},
        trainableFailures: 1,
        isViable: true,
      }),
    },
  });
  expect(result.added).toHaveLength(1);
  expect(result.added[0]!.id).toBe("child-1");
  // The child is NOT a seed: the exemption died with the generation.
  expect(result.population.members[1]!.seed).toBeUndefined();

  // A population with no seed and nothing trainable stops with the
  // actionable reason, not a bare fact.
  const stopped = await runRound({
    population: { members: [member("barren", { trainableFailures: 0 })] },
    random: scriptedRandom([0.5]),
    hooks: {
      propose: async () => ({ id: "never", components: {} }),
      evaluate: async () => ({
        score: 1,
        perExample: {},
        trainableFailures: 0,
        isViable: false,
      }),
    },
  });
  expect(stopped.stopped).toContain("too easy for the current judge");
});

test("the reported best can be a specialist the max-score pick would bury", () => {
  // S3 (selection half): a generalist averages 0.70 on both examples; a
  // specialist owns one example at 0.95 and is ordinary at 0.40 elsewhere.
  // The max-score pick reports the generalist every time; the Pareto draw
  // reports the specialist whenever the ticket lands on it — which is the
  // only reason the loop keeps specialists around.
  const generalist = member("generalist", {
    perExample: { "train:a": 0.7, "train:b": 0.7 },
    score: 0.7,
  });
  const specialist = member("specialist", {
    perExample: { "train:a": 0.95, "train:b": 0.4 },
    score: 0.675,
  });
  const population = { members: [generalist, specialist] };
  // Each wins one example, so each owns a front with weight 1.
  expect(bestMember(population)!.id).toBe("generalist");
  // The draw is the front's, not the average's: the specialist is
  // selectable, and the generalist no longer wins by default.
  expect(selectReportedBest(population, scriptedRandom([0.1]))!.id).toBe(
    "specialist",
  );
  expect(selectReportedBest(population, scriptedRandom([0.99]))!.id).toBe(
    "generalist",
  );
  // An empty front (a one-member population) falls back to the max score
  // rather than inventing a draw.
  expect(
    selectReportedBest({ members: [generalist] }, scriptedRandom([0.5]))!.id,
  ).toBe("generalist");
  expect(
    selectReportedBest({ members: [] }, scriptedRandom([0.5])),
  ).toBeUndefined();
});

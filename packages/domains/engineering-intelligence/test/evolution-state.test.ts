import { expect, test } from "bun:test";
import {
  evolutionStateDir,
  parentDiff,
  parseCandidateMetadata,
  parseFrontier,
  parseSummary,
  renderCandidateMetadata,
  renderFrontier,
  renderTaskFile,
  summaryLine,
  type EvolutionSummaryEntry,
} from "../src/evolution-state";

/**
 * L4c's state files: the loop's memory. Each serializer round-trips —
 * a state file that silently drops a field is a loop that forgets what it
 * already tried, and the forgetting would show up as a repeated candidate
 * three rounds later.
 */

const entry = (
  overrides: Partial<EvolutionSummaryEntry> = {},
): EvolutionSummaryEntry => ({
  iteration: 3,
  name: "iter3_fuse",
  score: 0.6123,
  axis: "exploration",
  hypothesis: "fusing the two mechanisms beats either alone",
  delta: 0.0412,
  outcome: "accepted",
  components: ["body", "procedure"],
  ...overrides,
});

test("the task file renders the objective, the background and the evaluation model", () => {
  const rendered = renderTaskFile({
    objective: "Improve the release skill",
    background: "Three completions named the same gap.",
    evaluationModel: "keyword overlap over the mined dataset",
  });
  expect(rendered).toContain("# Improve the release skill");
  expect(rendered).toContain("Three completions named the same gap.");
  expect(rendered).toContain("keyword overlap");
});

test("the summary round-trips one line per evaluated candidate", () => {
  const lines = [
    summaryLine(entry()),
    summaryLine(
      entry({
        iteration: 4,
        name: "iter4_tune",
        score: 0.61,
        delta: -0.0023,
        outcome: "rejected",
      }),
    ),
  ].join("\n");
  const parsed = parseSummary(`${lines}\n`);
  expect(parsed).toHaveLength(2);
  expect(parsed[0]).toEqual(entry());
  expect(parsed[1]).toMatchObject({
    iteration: 4,
    outcome: "rejected",
    delta: -0.0023,
  });
  // An empty body is an empty history, not an error.
  expect(parseSummary("")).toEqual([]);
});

test("the frontier round-trips the best and the per-example owners", () => {
  const frontier = {
    best: { name: "iter3_fuse", score: 0.6123 },
    perExample: {
      "train:s1:t1": { name: "iter2_sharpen", score: 0.9 },
      "val:s1:t2": { name: "iter3_fuse", score: 0.8 },
    },
  };
  const parsed = parseFrontier(renderFrontier(frontier));
  expect(parsed).toEqual(frontier);
  // The per-example map is the combination signal: different candidates
  // owning different examples is exactly when the next candidate should
  // fuse their mechanisms.
  expect(Object.keys(parsed.perExample)).toHaveLength(2);
  expect(
    new Set(Object.values(parsed.perExample).map((owner) => owner.name)).size,
  ).toBe(2);
});

test("the candidate metadata round-trips with its hypothesis and axis", () => {
  const metadata = {
    iteration: 3,
    candidates: [
      {
        name: "iter3_fuse",
        file: "agents/iter3_fuse.txt",
        hypothesis: "fusing the two mechanisms beats either alone",
        axis: "exploration" as const,
        base: "iter2_sharpen",
        components: ["body", "procedure"],
      },
    ],
  };
  const parsed = parseCandidateMetadata(renderCandidateMetadata(metadata));
  expect(parsed).toEqual(metadata);
});

test("the state dir refuses an escaping target before anything is written", () => {
  expect(() => evolutionStateDir("/ws", "../escape")).toThrow(
    /invalid evolution target/u,
  );
  expect(evolutionStateDir("/ws", "release-skill")).toBe(
    "/ws/.natalia/evolution/release-skill",
  );
});

test("the summary line carries what changed and under what conditions", async () => {
  // S7: a score without its diff is a number nobody can learn from, and a
  // history that mixes incomparable conditions manufactures false trends.
  const line = summaryLine({
    iteration: 2,
    name: "iter2_exploration",
    score: 0.6123,
    axis: "exploration",
    hypothesis: "fusing the two mechanisms beats either alone",
    delta: 0.0412,
    outcome: "accepted",
    components: ["instruction"],
    parentDiff: "--- parent\n+++ candidate\n@@ -1 +1 @@\n-old\n+new",
    provenance: "round=2 judge=keyword dataset=release-skill@sha-abc",
  });
  const [parsed] = parseSummary(line);
  expect(parsed.parentDiff).toContain("-old");
  expect(parsed.parentDiff).toContain("+new");
  expect(parsed.provenance).toContain("judge=keyword");
  expect(parsed.provenance).toContain("dataset=release-skill@sha-abc");
  // A line without them stays absent (not empty strings).
  const [bare] = parseSummary(
    summaryLine({
      iteration: 1,
      name: "iter1",
      score: 0.5,
      axis: "exploitation",
      hypothesis: "h",
      delta: 0,
      outcome: "accepted",
      components: ["instruction"],
    }),
  );
  expect(bare.parentDiff).toBeUndefined();
  expect(bare.provenance).toBeUndefined();
});

test("parentDiff produces a real patch through the maintained differ", async () => {
  const diff = await parentDiff(
    "Answer directly.",
    "Answer directly, then record the rollback step.",
  );
  expect(diff.additions).toBeGreaterThan(0);
  expect(diff.deletions).toBeGreaterThanOrEqual(0);
  expect(diff.patch).toContain("record the rollback step");
  // Identical texts produce no change.
  const same = await parentDiff("same", "same");
  expect(same.additions).toBe(0);
  expect(same.deletions).toBe(0);
});

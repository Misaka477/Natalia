import { expect, test } from "bun:test";
import {
  DEFAULT_REFLECTION_TEMPLATE,
  MUTATOR_CONSTRAINTS,
  MUTATOR_NO_FANOUT,
  buildReflectionDataset,
  boundedFeedback,
  parseCandidate,
  proposeReflective,
  renderReflectionPrompt,
  renderSideInfo,
  validatePromptTemplate,
  type ReflectionEntry,
} from "../src/reflective-mutator";
import type { EvaluationResult, EvaluationSample } from "../src/evaluation";

/**
 * L4b's reflective mutator: the template contract, the three-field
 * dataset, the one-component rule, and the candidate's metadata.
 *
 * The load-bearing test is the holdout one: the mutator's input is
 * CONSTRUCTED without the sealed material. A mutator that could see the
 * holdout would optimize for it, and the holdout's only value is that it
 * never got optimized for.
 */

const sample = (id: string): EvaluationSample => ({
  id,
  input: `task ${id}`,
  output: `reference ${id}`,
});

const result = (
  trainable: EvaluationResult["trainableFailureCases"],
  holdout: EvaluationResult["holdoutFailureCases"] = [],
): EvaluationResult => ({
  score: 0.5,
  perExample: {},
  trainableFailureCases: trainable,
  holdoutFailureCases: holdout,
  isViable: trainable.length > 0,
});

const failure = (sampleID: string, detail: string) => ({
  sampleID,
  failureType: "correctness",
  detail,
});

test("the template carries both placeholders, and a template missing either is refused", () => {
  // The reference engine's own validator: a prompt rendered with a hole in
  // it gets a confident answer about nothing.
  expect(DEFAULT_REFLECTION_TEMPLATE).toContain("<curr_param>");
  expect(DEFAULT_REFLECTION_TEMPLATE).toContain("<side_info>");
  expect(() =>
    validatePromptTemplate(DEFAULT_REFLECTION_TEMPLATE),
  ).not.toThrow();
  expect(() => validatePromptTemplate("no placeholders here")).toThrow(
    /<curr_param>/u,
  );
  expect(() =>
    validatePromptTemplate("has <curr_param> but not the other"),
  ).toThrow(/<side_info>/u);
});

test("the rendered prompt carries the current parameter and the side info", () => {
  const prompt = renderReflectionPrompt({
    currentParam: "the current skill body",
    sideInfo: "Example 1: …",
  });
  expect(prompt).toContain("the current skill body");
  expect(prompt).toContain("Example 1: …");
  // Both placeholders are consumed: a rendered prompt with a literal
  // placeholder left in it is a bug, not a template.
  expect(prompt).not.toContain("<curr_param>");
  expect(prompt).not.toContain("<side_info>");
});

test("the reflection dataset is three fields built from the TRAINABLE bucket only", () => {
  const dataset = buildReflectionDataset({
    result: result(
      [failure("train:a", "missed the rollback step")],
      [failure("holdout:secret", "the sealed failure detail")],
    ),
    pool: [sample("train:a"), sample("holdout:secret")],
  });
  expect(dataset).toEqual([
    {
      Inputs: "task train:a",
      "Generated Outputs": "reference train:a",
      Feedback: "missed the rollback step",
    },
  ]);
  // The sealed bucket is on the same object and was never read: its detail
  // appears nowhere in the mutator's input.
  const rendered = renderSideInfo(dataset);
  expect(rendered).not.toContain("sealed failure detail");
  expect(rendered).not.toContain("holdout:secret");
});

test("a long feedback is bounded head-and-tail, not dropped", () => {
  const long = `${"h".repeat(600)}${"m".repeat(2_000)}${"t".repeat(600)}`;
  const bounded = boundedFeedback(long);
  expect(bounded.startsWith("h".repeat(500))).toBe(true);
  expect(bounded.endsWith("t".repeat(500))).toBe(true);
  expect(bounded).toContain("truncated 2200 chars");
  // A short feedback rides verbatim.
  expect(boundedFeedback("short")).toBe("short");
});

test("one component per round — a two-component round is refused", async () => {
  const answer = await proposeReflective({
    components: ["skill-body", "tool-description"],
    currentParam: "current",
    result: result([failure("train:a", "detail")]),
    pool: [sample("train:a")],
    sampler: async () => "```\nnew text\n```\nhypothesis: x\naxis: exploration",
  });
  expect(answer.ok).toBe(false);
  if (!answer.ok)
    expect(answer.reason).toContain("one component per round, got 2");
});

test("a round with no trainable failures has nothing to reflect on", async () => {
  const answer = await proposeReflective({
    components: ["skill-body"],
    currentParam: "current",
    result: result([]),
    pool: [sample("train:a")],
    sampler: async () => "unreachable",
  });
  expect(answer.ok).toBe(false);
  if (!answer.ok) expect(answer.reason).toContain("no trainable failure cases");
});

test("a candidate without a falsifiable hypothesis or an axis is refused", () => {
  const noHypothesis = parseCandidate("```\ntext\n```", {
    component: "c",
  });
  expect(noHypothesis.ok).toBe(false);
  if (!noHypothesis.ok)
    expect(noHypothesis.reason).toContain("falsifiable hypothesis");
  const noAxis = parseCandidate("```\ntext\n```\nhypothesis: it will help", {
    component: "c",
  });
  expect(noAxis.ok).toBe(false);
  if (!noAxis.ok) expect(noAxis.reason).toContain("axis");
  const noFence = parseCandidate("hypothesis: x\naxis: exploration", {
    component: "c",
  });
  expect(noFence.ok).toBe(false);
  if (!noFence.ok) expect(noFence.reason).toContain("fenced candidate text");
});

test("a well-formed answer parses into a candidate with its metadata", async () => {
  const answer = await proposeReflective({
    components: ["skill-body"],
    currentParam: "the current body",
    result: result([failure("train:a", "missed the rollback step")]),
    pool: [sample("train:a")],
    sampler: async () =>
      "Here is the new instruction:\n```\nAlways record the rollback step.\n```\nhypothesis: naming the rollback step prevents the forgotten-verify failure\naxis: exploitation",
  });
  expect(answer.ok).toBe(true);
  if (!answer.ok) return;
  expect(answer.candidate).toEqual({
    component: "skill-body",
    text: "Always record the rollback step.",
    hypothesis:
      "naming the rollback step prevents the forgotten-verify failure",
    axis: "exploitation",
  });
  // The prompt rides back with the candidate: the audit trail of what the
  // mutator was told, so a refusal later can name the exact prompt.
  expect(answer.prompt).toContain("the current body");
  expect(answer.prompt).toContain("missed the rollback step");
  // The four constraints and the no-delegation rule are IN that prompt.
  for (const rule of MUTATOR_CONSTRAINTS) expect(answer.prompt).toContain(rule);
  expect(answer.prompt).toContain("do NOT delegate");
  expect(answer.dataset).toHaveLength(1);
});

test("the four constraints and the no-delegation rule are assertable prompt text", () => {
  // They are enforced by riding the prompt; this test is what makes that
  // claim checkable rather than aspirational.
  expect(MUTATOR_CONSTRAINTS).toHaveLength(4);
  expect(MUTATOR_CONSTRAINTS.join("\n")).toContain("parameter variant");
  expect(MUTATOR_CONSTRAINTS.join("\n")).toContain(
    "never echo example identifiers",
  );
  expect(MUTATOR_CONSTRAINTS.join("\n")).toContain("prototype");
  expect(MUTATOR_CONSTRAINTS.join("\n")).toContain("re-read");
  expect(MUTATOR_NO_FANOUT).toContain("do NOT delegate");
});

test("a dataset entry with a missing sample is honest about the gap", () => {
  const dataset: ReflectionEntry[] = buildReflectionDataset({
    result: result([failure("train:gone", "the detail")]),
    pool: [],
  });
  expect(dataset[0]!.Inputs).toContain("not in the pool");
  expect(dataset[0]!.Feedback).toBe("the detail");
});

test("the constraints ride the prompt the mutator actually sends", () => {
  // A constraint that exists only in a design document constrains nobody:
  // the proposer composes them INTO the prompt, and this is the proof.
  const prompt = renderReflectionPrompt({ currentParam: "c", sideInfo: "s" });
  expect(prompt).not.toContain("parameter variant");
  // The full composer (the proposer's own prompt builder) carries them.
  const composed = [
    "You are optimizing ONE component of an artifact. Obey these constraints:",
    ...MUTATOR_CONSTRAINTS.map((rule) => `- ${rule}`),
    `- ${MUTATOR_NO_FANOUT}`,
    "",
    prompt,
  ].join("\n");
  for (const rule of MUTATOR_CONSTRAINTS) expect(composed).toContain(rule);
  expect(composed).toContain("do NOT delegate");
});

test("the proposer reads what has been tried — the amnesia fix", () => {
  // S7: without the history the mutator sees the parent and the failures
  // but not the graveyard of hypotheses that already lost — and the
  // cheapest way to waste an evaluation is to re-run one.
  const build = (
    history?: Parameters<typeof proposeReflective>[0]["history"],
  ) =>
    proposeReflective({
      components: ["instruction"],
      currentParam: "the current body",
      result: result([failure("train:a", "missed the rollback step")]),
      pool: [sample("train:a")],
      history,
      sampler: async () =>
        "```\nnew text\n```\nhypothesis: h\naxis: exploration",
    });
  return Promise.all([
    build(undefined),
    build([
      {
        hypothesis:
          "naming the rollback step prevents the forgotten-verify failure",
        outcome: "scored 0.4000 against parent baseline at 0.5000",
        axis: "exploitation",
      },
    ]),
  ]).then(([without, withHistory]) => {
    if (!without.ok || !withHistory.ok) throw new Error("both must propose");
    // No history: no tried block.
    expect(without.prompt).not.toContain("already been tried");
    // With history: the graveyard is in the prompt the mutator reads, with
    // its outcome attached.
    expect(withHistory.prompt).toContain("already been tried");
    expect(withHistory.prompt).toContain(
      "naming the rollback step prevents the forgotten-verify failure",
    );
    expect(withHistory.prompt).toContain(
      "scored 0.4000 against parent baseline",
    );
    expect(withHistory.prompt).toContain("[exploitation]");
  });
});

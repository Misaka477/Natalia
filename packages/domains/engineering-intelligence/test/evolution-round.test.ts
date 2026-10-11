import { expect, test } from "bun:test";
import { runEvolutionRound, roundSummaryLine } from "../src/evolution-round";
import type { EvaluationSample } from "../src/evaluation";

/**
 * S8's step 2: the round that runs when the trigger fires. It composes the
 * pieces that exist — it does not write a new engine. What it adds is the
 * ORDER and the refusals, which is the part nobody owned.
 */

const pool: EvaluationSample[] = [
  {
    id: "train:a",
    input: "how should I handle a flaky test?",
    output: "Re-run it in isolation first, then pin the nondeterminism.",
    expected_behavior: "re-runs isolation pins nondeterminism",
  },
  {
    id: "train:b",
    input: "what belongs in a commit message?",
    output: "An imperative subject plus a body that explains why.",
    expected_behavior: "imperative subject explains why",
  },
];

/** A sampler that answers every prompt with the same text. */
const fixed =
  (text: string) =>
  async ({ prompt }: { prompt: string; component: string }) =>
    prompt.includes("VERDICT") ? "" : text;

test("a round composes: evaluate the parent, propose, evaluate, gate, summarize", async () => {
  const out = await runEvolutionRound({
    pool,
    holdout: [],
    currentInstruction:
      "Answer the question directly and record what you verified before acting.",
    sampler: fixed(
      "```\nAnswer the question directly and record what you verified before acting now.\n```\nhypothesis: naming the verify step prevents the forgotten check\naxis: exploitation",
    ),
    iteration: 1,
    name: "live-001-evolved",
    suite: { ok: true, detail: "all green" },
    benchmark: { ok: true, detail: "no regression" },
  });
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  // The candidate rides whole, so the queue can render it.
  expect(out.candidate.name).toBe("live-001-evolved");
  expect(out.candidate.body).toContain("before acting now");
  expect(out.candidate.axis).toBe("exploitation");
  // The summary entry is pure and round-trips through its own serializer.
  expect(out.entry.iteration).toBe(1);
  expect(out.entry.outcome).toBe("accepted");
  const line = roundSummaryLine(out.entry);
  expect(JSON.parse(line).name).toBe("live-001-evolved");
});

test("a suite failure is REPORTED, not hidden — the refused candidate is evidence", async () => {
  // W9: a failed variant is persisted, never deployed. The round returns it
  // with its refusals so the queue can show the human what was stopped.
  const out = await runEvolutionRound({
    pool,
    holdout: [],
    currentInstruction:
      "Answer the question directly and record what you verified before acting.",
    sampler: fixed(
      "```\nverify before destructive\n```\nhypothesis: naming the verify step\naxis: exploitation",
    ),
    iteration: 2,
    name: "live-002-evolved",
    suite: { ok: false, detail: "2 failing" },
  });
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.gate.passed).toBe(false);
  expect(out.gate.refusals.join(" ")).toContain("G1");
  // And the summary says REJECTED — the record does not pretend it passed.
  expect(out.entry.outcome).toBe("rejected");
  expect(out.entry.gate?.passed).toBe(false);
});

test("an empty pool refuses with a reason rather than an empty round", async () => {
  const out = await runEvolutionRound({
    pool: [],
    holdout: [],
    currentInstruction:
      "Answer the question directly and record what you verified before acting.",
    sampler: fixed("```\nanything\n```\nhypothesis: h\naxis: exploitation"),
    iteration: 1,
    name: "live-003-evolved",
    suite: { ok: true, detail: "all green" },
    benchmark: { ok: true, detail: "no regression" },
  });
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.reason).toContain("pool is empty");
});

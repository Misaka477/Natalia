import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { applyEvent, initialState, type AppState } from "../src";

/**
 * The self-iteration observation slices (L1): every fact the self-iteration
 * audit found invisible now folds into the projected state, one case per
 * event. These are the consumer-side floor — the governance panel's Growth
 * and Eval tabs read these slices, and before they existed a client had to
 * re-read the journal itself to answer "what does the system think it is
 * missing".
 *
 * The audit's nine dead links all died the same way: implemented, contracted,
 * routed, and folded by nobody. A fold is the smallest thing that makes a
 * fact renderable, so each event gets one.
 */

function fresh(): AppState {
  return initialState();
}

const proposed = (
  id: string,
): Extract<RuntimeEvent, { type: "growth.proposed" }> => ({
  type: "growth.proposed",
  id,
  at: "2026-10-11T00:00:00.000Z",
  suggestions: [
    {
      kind: "tool",
      capability: "release-evidence",
      observations: 3,
      sources: ["completion:known_gap"],
      reason: "three completions named the same gap",
    },
  ],
  considered: { tasks: 4, gaps: 1 },
});

const promoted = (
  id: string,
): Extract<RuntimeEvent, { type: "growth.promoted" }> => ({
  type: "growth.promoted",
  id,
  at: "2026-10-11T00:01:00.000Z",
  trigger: {
    rule: "capability_gap",
    capability: "release-evidence",
    evidence: { observations: 3 },
    reason: "the gap kept costing the release",
  },
  destination: "skill",
  approval: "human",
  appliedBy: "skills.upsert",
  next: "a human reviews the candidate",
  reason: "class policy: a skill may auto-apply, the write still validates",
});

const externalRun = (
  id: string,
  taskID: string,
): Extract<RuntimeEvent, { type: "external_run.recorded" }> => ({
  type: "external_run.recorded",
  id,
  at: "2026-10-11T00:02:00.000Z",
  externalTaskID: taskID,
  benchmark: "terminal-bench",
  turnID: "turn-1",
  success: true,
  durationMs: 4200,
  baselineSuccessRate: 0.31,
});

const reviewCompleted = (
  at: string,
): Extract<RuntimeEvent, { type: "self_review.completed" }> => ({
  type: "self_review.completed",
  at,
  skillsCreated: ["release-checklist"],
  skillsUpdated: [],
  rejected: 1,
  refusals: ['vague-skill: restates the existing skill "release-checklist"'],
  proposals: 2,
  deficiencies: 1,
  aspirations: 1,
});

const feedback = (
  id: string,
  verdict: "up" | "down",
): Extract<RuntimeEvent, { type: "feedback.recorded" }> => ({
  type: "feedback.recorded",
  id,
  at: "2026-10-11T00:03:00.000Z",
  scope: "session",
  verdict,
  category: "helpful",
  note: "the rollback step was the useful part",
});

test("a growth proposal folds once, and a replay of it is not a second proposal", () => {
  const state = fresh();
  applyEvent(state, proposed("growth:1"));
  expect(state.growthProposals).toHaveLength(1);
  expect(state.growthProposals[0]).toMatchObject({
    id: "growth:1",
    suggestions: [{ capability: "release-evidence", kind: "tool" }],
    considered: { tasks: 4, gaps: 1 },
  });
  // The writer is idempotent, but the stream is replayed verbatim: one fact
  // shown twice reads as two proposals.
  applyEvent(state, proposed("growth:1"));
  expect(state.growthProposals).toHaveLength(1);
});

test("a growth promotion folds once and carries its destination and approval", () => {
  const state = fresh();
  applyEvent(state, promoted("promo:1"));
  applyEvent(state, promoted("promo:1"));
  expect(state.growthPromotions).toHaveLength(1);
  expect(state.growthPromotions[0]).toMatchObject({
    destination: "skill",
    approval: "human",
    appliedBy: "skills.upsert",
    trigger: { rule: "capability_gap", capability: "release-evidence" },
  });
});

test("an external run folds per task and keeps the baseline it was scored against", () => {
  const state = fresh();
  applyEvent(state, externalRun("xrun:1", "terminal-bench/x"));
  applyEvent(state, externalRun("xrun:1", "terminal-bench/x"));
  applyEvent(state, externalRun("xrun:2", "terminal-bench/y"));
  expect(state.externalRuns.map((entry) => entry.externalTaskID)).toEqual([
    "terminal-bench/x",
    "terminal-bench/y",
  ]);
  expect(state.externalRuns[0]).toMatchObject({
    success: true,
    baselineSuccessRate: 0.31,
    durationMs: 4200,
  });
});

test("a finished self-review folds with its refusals — the loop's own audit trail", () => {
  const state = fresh();
  applyEvent(state, reviewCompleted("2026-10-11T00:04:00.000Z"));
  applyEvent(state, reviewCompleted("2026-10-11T00:05:00.000Z"));
  // No id on this event (each review is its own fact), so both land; the
  // slice is bounded like every other list here.
  expect(state.selfReview).toHaveLength(2);
  expect(state.selfReview[0]).toMatchObject({
    skillsCreated: ["release-checklist"],
    rejected: 1,
    refusals: ['vague-skill: restates the existing skill "release-checklist"'],
    proposals: 2,
  });
});

test("human feedback folds once per record and keeps its verdict", () => {
  const state = fresh();
  applyEvent(state, feedback("fb:1", "up"));
  applyEvent(state, feedback("fb:1", "up"));
  applyEvent(state, feedback("fb:2", "down"));
  expect(state.feedback.map((entry) => entry.verdict)).toEqual(["up", "down"]);
  expect(state.feedback[0]).toMatchObject({
    scope: "session",
    category: "helpful",
  });
});

test("the observation slices survive a state clone, so a replay rehydrates them", () => {
  // The clone is what a rehydrating client applies the durable stream onto;
  // a slice the clone dropped would render empty after every reload.
  const state = fresh();
  applyEvent(state, proposed("growth:1"));
  applyEvent(state, promoted("promo:1"));
  applyEvent(state, externalRun("xrun:1", "terminal-bench/x"));
  applyEvent(state, reviewCompleted("2026-10-11T00:04:00.000Z"));
  applyEvent(state, feedback("fb:1", "up"));
  const reopened = initialState();
  Object.assign(reopened, {
    growthProposals: [...state.growthProposals],
    growthPromotions: [...state.growthPromotions],
    externalRuns: [...state.externalRuns],
    selfReview: [...state.selfReview],
    feedback: [...state.feedback],
  });
  const clone = structuredClone(reopened);
  expect(clone.growthProposals).toHaveLength(1);
  expect(clone.growthPromotions).toHaveLength(1);
  expect(clone.externalRuns).toHaveLength(1);
  expect(clone.selfReview).toHaveLength(1);
  expect(clone.feedback).toHaveLength(1);
});

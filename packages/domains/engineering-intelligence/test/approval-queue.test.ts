import { expect, test } from "bun:test";
import {
  approvalItemFrom,
  applyDecision,
  pendingItems,
  queueItemsFromSummary,
  rejectionReason,
  type ApprovalCandidate,
  type StoredDecision,
} from "../src/approval-queue";

/**
 * S8's approval queue: the human appears ONLY here. The item carries the
 * reference harness's PR-body shape; the module never performs the write.
 */

const candidate: ApprovalCandidate = {
  name: "live-001-evolved",
  description: "naming the rollback step prevents the forgotten-verify failure",
  body: "Answer directly, then record the rollback step.",
  hypothesis: "naming the rollback step prevents the forgotten-verify failure",
  axis: "exploitation",
  score: 0.6123,
  holdoutScore: 0.58,
  splits: { train: 0.6, val: 0.5, holdout: 0.58 },
  sampleCount: 4,
};

test("the item carries the PR-body shape: scores, axis, and the refusals verbatim", () => {
  const item = approvalItemFrom({
    candidate,
    gate: {
      passed: false,
      refusals: [
        "live-001-evolved: G7 unverified — the benchmark seam is not filled",
      ],
    },
  });
  expect(item.summary).toContain("0.6123");
  // The SPLITS ride separately: the holdout is the number that was NOT
  // optimized, and a reviewer's first question is "did it move".
  expect(item.summary).toContain("train 0.6000");
  expect(item.summary).toContain("val 0.5000");
  expect(item.summary).toContain("holdout 0.5800");
  // And what the round cost.
  expect(item.summary).toContain("4 calls");
  expect(item.summary).toContain("exploitation");
  // The refusals are verbatim — a human reading the item reads HER words,
  // not a paraphrase.
  expect(item.gate.refusals[0]).toContain("G7 unverified");
  // A gate-refused candidate is still approvable (that is what a human gate
  // is for) — but the queue never pretends it passed.
  expect(item.approvable).toBe(true);
  expect(item.gate.passed).toBe(false);
});

test("approving hands the candidate to the boundary; rejecting keeps it", () => {
  const item = approvalItemFrom({
    candidate,
    gate: { passed: true, refusals: [] },
  });
  const approved = applyDecision(item, { decision: "approve" });
  expect(approved.kind).toBe("land");
  if (approved.kind === "land")
    // The candidate rides WHOLE — the boundary validates it, not this.
    expect(approved.candidate.body).toContain("rollback step");
  const rejected = applyDecision(item, {
    decision: "reject",
    reason: "the wording would confuse a new reader",
  });
  expect(rejected.kind).toBe("rejected");
  if (rejected.kind === "rejected")
    expect(rejected.reason).toContain("confuse a new reader");
});

test("a decided item leaves the queue either way — attention is the scarce thing", () => {
  // The decision is durable, so the panel's list is a fold of items and
  // decisions, not a local guess: a refresh or a second tab sees the same
  // queue.
  const item = approvalItemFrom({
    candidate,
    gate: { passed: true, refusals: [] },
  });
  const other = approvalItemFrom({
    candidate: { ...candidate, name: "live-002-evolved" },
    gate: { passed: true, refusals: [] },
  });
  const decided: StoredDecision[] = [
    {
      item: "live-001-evolved",
      decision: "approve",
      at: "2026-10-13T12:00:00.000Z",
    },
  ];
  const pending = pendingItems({ items: [item, other], decisions: decided });
  expect(pending.map((row) => row.candidate.name)).toEqual([
    "live-002-evolved",
  ]);
  // A REJECTED item also leaves — re-asking an answered question spends the
  // human's attention, which is the scarcest resource in the loop.
  const rejected = pendingItems({
    items: [item, other],
    decisions: [
      {
        item: "live-001-evolved",
        decision: "reject",
        reason: "too wordy",
        at: "2026-10-13T12:00:00.000Z",
      },
    ],
  });
  expect(rejected.map((row) => row.candidate.name)).toEqual([
    "live-002-evolved",
  ]);
  // And the reason stays readable for the record.
  expect(rejectionReason(decided, "live-001-evolved")).toBeUndefined();
  expect(
    rejectionReason(
      [
        {
          item: "live-001-evolved",
          decision: "reject",
          reason: "too wordy",
          at: "x",
        },
      ],
      "live-001-evolved",
    ),
  ).toBe("too wordy");
});

test("the panel's rows come from the run's own record, and a corrupt line is counted", () => {
  // The panel reads the SAME durable record the loop wrote — a second copy
  // could drift from it.
  const summary = [
    JSON.stringify({
      name: "live-001-evolved",
      score: 0.6123,
      axis: "exploitation",
      hypothesis:
        "naming the rollback step prevents the forgotten-verify failure",
      gate: {
        passed: false,
        refusals: [
          "live-001-evolved: G7 unverified — the benchmark seam is not filled",
        ],
      },
    }),
    "not json at all",
    JSON.stringify({ name: "live-002-evolved", score: 0.4 }),
  ].join("\n");
  const first = queueItemsFromSummary({ summary, decisions: "" });
  expect(first.items).toHaveLength(2);
  // The corrupt line is counted, not silently dropped.
  expect(first.skipped).toBe(1);
  // The gate's verdict rides the row verbatim.
  expect(first.items[0]!.gate.refusals[0]).toContain("G7 unverified");
  expect(first.items[0]!.gate.passed).toBe(false);
  // A decided item leaves the queue through the same fold.
  const second = queueItemsFromSummary({
    summary,
    decisions: JSON.stringify({
      item: "live-001-evolved",
      decision: "approve",
      at: "2026-10-13T12:00:00.000Z",
    }),
  });
  expect(second.items.map((row) => row.candidate.name)).toEqual([
    "live-002-evolved",
  ]);
});

test("the queue's row carries the decision fields a reviewer needs", () => {
  // A row that shows only a blended score asks the human to approve on
  // faith — which is the thing this queue exists to end.
  const summary = JSON.stringify({
    name: "live-009-evolved",
    score: 0.61,
    axis: "exploitation",
    hypothesis:
      "naming the rollback step prevents the forgotten-verify failure",
    splits: { train: 0.7, val: 0.55, holdout: 0.42 },
    gateResults: [
      { gate: "G1", ok: true, detail: "all green" },
      { gate: "G3", ok: false, detail: "variant is 35% over baseline" },
    ],
    sampleCount: 6,
    gate: {
      passed: false,
      refusals: ["live-009-evolved: G3 variant is 35% over baseline"],
    },
  });
  const out = queueItemsFromSummary({ summary, decisions: "" });
  expect(out.items).toHaveLength(1);
  const item = out.items[0]!;
  // Which split moved — the holdout's number is the one that was NOT
  // optimized, and it is the one a reviewer asks about first.
  expect(item.candidate.splits).toEqual({
    train: 0.7,
    val: 0.55,
    holdout: 0.42,
  });
  expect(item.summary).toContain("holdout 0.4200");
  // Which gate said what, per gate (not only the refusals).
  expect(item.candidate.gateResults).toHaveLength(2);
  expect(item.candidate.gateResults?.[1]?.gate).toBe("G3");
  // And what it cost.
  expect(item.candidate.sampleCount).toBe(6);
});

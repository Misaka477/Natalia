import { expect, test } from "bun:test";
import {
  approvalItemFrom,
  applyDecision,
  type ApprovalCandidate,
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
  // The holdout rides separately: it is the number that was NOT optimized.
  expect(item.summary).toContain("holdout 0.5800");
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

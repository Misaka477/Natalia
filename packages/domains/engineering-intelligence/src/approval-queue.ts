/**
 * S8's approval queue: the item the human sees, and what each decision
 * means.
 *
 * The loop used to end at a report — a candidate could be produced and
 * approved by nobody. The queue is where the human appears, and ONLY here
 * (the reference design's rule: it automates detection and optimization,
 * never deployment). The item carries the reference harness's PR-body
 * shape: the scores on all three splits, the full diff, the cost, and —
 * the most instructive part — the constraint violations that were caught
 * and rejected during the run.
 *
 * This module decides what the item CARRIES and what each decision MEANS.
 * It never performs the write: approving hands the candidate to the
 * validated boundary (`upsertSkill`), which is the only autonomous write
 * path and whose refusal is the answer. A queue that could write around
 * the boundary would be the failure this whole design exists to prevent.
 */

/** The candidate as the queue reads it. */
export type ApprovalCandidate = {
  name: string;
  description: string;
  body: string;
  hypothesis?: string;
  axis?: "exploitation" | "exploration";
  score: number;
  /** The score on the sealed holdout — the number that is not optimized. */
  holdoutScore?: number;
};

/** The gate's verdict on the candidate, as the item carries it. */
export type ApprovalGate = {
  passed: boolean;
  refusals: string[];
};

/** What the human is shown. */
export type ApprovalItem = {
  candidate: ApprovalCandidate;
  gate: ApprovalGate;
  /** The verdict line: what was asked, what it scored, what was refused. */
  summary: string;
  /** Whether approving is even offered (a gate-refused candidate is not). */
  approvable: boolean;
};

export function approvalItemFrom(input: {
  candidate: ApprovalCandidate;
  gate: ApprovalGate;
}): ApprovalItem {
  const { candidate, gate } = input;
  const parts = [
    `${candidate.name} scored ${candidate.score.toFixed(4)}`,
    ...(candidate.holdoutScore === undefined
      ? []
      : [`holdout ${candidate.holdoutScore.toFixed(4)}`]),
    ...(candidate.axis ? [candidate.axis] : []),
  ];
  return {
    candidate,
    gate,
    summary: parts.join(" · "),
    // A candidate the gates refused is shown WITH its refusals — the human
    // may still choose to land it (that is what a human gate is for) — but
    // the queue never pretends it passed.
    approvable: true,
  };
}

export type ApprovalDecision =
  | { decision: "approve" }
  | { decision: "reject"; reason: string };

export type ApprovalOutcome =
  /** Approved: hand the candidate to the boundary (the caller invokes it). */
  | { kind: "land"; candidate: ApprovalCandidate }
  /** Rejected: the candidate stays on disk with the human's reason. */
  | { kind: "rejected"; reason: string };

/**
 * What a decision means. The write itself is the boundary's — this decides
 * which path the caller takes, and a rejection keeps the artifact (the
 * search history is not thrown away: a rejected candidate is evidence
 * about what the human does not want).
 */
export function applyDecision(
  item: ApprovalItem,
  decision: ApprovalDecision,
): ApprovalOutcome {
  if (decision.decision === "approve")
    return { kind: "land", candidate: item.candidate };
  return { kind: "rejected", reason: decision.reason };
}

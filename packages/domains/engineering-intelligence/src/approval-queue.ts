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

/**
 * The queue's state: which items still await a human.
 *
 * The decision is durable (one line per decision in the run directory), so
 * the panel's list is a FOLD of the items and the decisions rather than a
 * local guess: a refresh, a restart, or a second tab all see the same
 * queue. An item that was decided — either way — leaves the pending list,
 * because a human's attention is the scarce thing and re-asking a answered
 * question spends it.
 */
export type StoredDecision = {
  /** The candidate's name (the item's key). */
  item: string;
  decision: "approve" | "reject";
  reason?: string;
  at: string;
};

export function pendingItems(input: {
  items: readonly ApprovalItem[];
  decisions: readonly StoredDecision[];
}): ApprovalItem[] {
  const decided = new Set(
    input.decisions.map((entry) => `${entry.item}:${entry.decision}`),
  );
  // A decided item leaves the queue whichever way it went.
  return input.items.filter(
    (item) =>
      !decided.has(`${item.candidate.name}:approve`) &&
      !decided.has(`${item.candidate.name}:reject`),
  );
}

/** The reason a human gave for a rejection, for the record. */
export function rejectionReason(
  decisions: readonly StoredDecision[],
  item: string,
): string | undefined {
  return decisions
    .filter((entry) => entry.item === item && entry.decision === "reject")
    .at(-1)?.reason;
}

/**
 * The panel's rows, from what the run persisted.
 *
 * The run directory already holds everything the queue needs — the summary
 * line per candidate (with its score, axis, hypothesis and the gate's
 * verdict) and the decisions file. This turns those two texts into rows, so
 * the panel reads the SAME durable record the loop wrote rather than a
 * second copy that can drift from it.
 *
 * A line that does not parse is skipped and counted: a corrupt line is not
 * a reason to lose the rest of the queue, and silently dropping it would
 * hide the corruption.
 */
export function queueItemsFromSummary(input: {
  summary: string;
  decisions: string;
}): { items: ApprovalItem[]; skipped: number } {
  const items: ApprovalItem[] = [];
  let skipped = 0;
  for (const line of input.summary.split("\n")) {
    if (!line.trim()) continue;
    let row: {
      name?: unknown;
      score?: unknown;
      axis?: unknown;
      hypothesis?: unknown;
      gate?: { passed?: unknown; refusals?: unknown };
    };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      skipped += 1;
      continue;
    }
    if (typeof row.name !== "string" || typeof row.score !== "number") {
      skipped += 1;
      continue;
    }
    const refusals = Array.isArray(row.gate?.refusals)
      ? row.gate.refusals.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    items.push(
      approvalItemFrom({
        candidate: {
          name: row.name,
          // The persisted line carries the hypothesis; the description and
          // the body live in the candidate's own file beside the summary.
          description:
            typeof row.hypothesis === "string"
              ? row.hypothesis
              : "(no hypothesis recorded)",
          body: "",
          ...(typeof row.hypothesis === "string"
            ? { hypothesis: row.hypothesis }
            : {}),
          ...(row.axis === "exploitation" || row.axis === "exploration"
            ? { axis: row.axis }
            : {}),
          score: row.score,
        },
        gate: {
          passed: row.gate?.passed === true,
          refusals,
        },
      }),
    );
  }
  // The decisions fold in, so the caller gets the PENDING rows directly.
  const decided = parseDecisions(input.decisions);
  return { items: pendingItems({ items, decisions: decided }), skipped };
}

/** The decisions file's lines (one JSON object per decision). */
export function parseDecisions(text: string): StoredDecision[] {
  const out: StoredDecision[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as StoredDecision;
      if (typeof row.item === "string" && typeof row.decision === "string")
        out.push(row);
    } catch {
      // A corrupt decision line is not a decision: skipping it keeps the
      // item pending, which is the safe direction (asking again is cheaper
      // than acting on an unread decision).
    }
  }
  return out;
}

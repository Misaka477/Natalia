/**
 * Auto-inject a drift finding into the Main Agent's next step — runtime/
 * drift-inject.ts (EI §3.5 / Phase 2 B3).
 *
 * A warning/high finding is admitted as an internal next-step input so the
 * next provider request must respond to it: drift_acknowledge (explain or
 * dispute), correct the work, or detour_declare a sanctioned detour. advisory
 * findings are noise-level and are not injected. The text carries only the
 * findingID, severity and the rules that fired — never chain-of-thought,
 * objective prose or evidence payloads.
 *
 * Three writers share this: the boundary reconcile and the `evaluateDrift`
 * surface (a fresh `finding_opened`), and `reopenDriftFinding` (a user reopens
 * a terminal finding — a warning/high reopen is re-injected so the main agent
 * re-reviews it, EI §3.5 "reopen 后 warning/high 自动复审").
 */
import { admitInput, buildInputAdmission } from "@anthelia/session";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";

/** The minimal finding facts an injection needs (an opened event or a projection). */
export type DriftFindingSummary = {
  findingID: string;
  severity: "advisory" | "warning" | "high";
  ruleHits?: Array<{ rule: string; confidence: number }>;
};

export function injectFindingIntoMainAgent(
  ctx: RuntimeContext,
  target: SessionExecutionState,
  finding: DriftFindingSummary,
  options: { reviewNote?: string; idSuffix?: string } = {},
): void {
  if (finding.severity !== "warning" && finding.severity !== "high") return;
  const rules = (finding.ruleHits ?? []).map((hit) => hit.rule).join(", ");
  // A reopen reuses the findingID, so its admission needs a distinct id (the
  // original finding_opened injection already claimed `turn_drift_<findingID>`).
  const suffix = options.idSuffix
    ? `_${options.idSuffix.replace(/[^a-zA-Z0-9]/gu, "_")}`
    : "";
  const id = `turn_drift_${finding.findingID.replace(/[^a-zA-Z0-9]/gu, "_")}${suffix}`;
  const reviewNote = options.reviewNote ? ` ${options.reviewNote}` : "";
  const text =
    `(internal drift finding ${finding.findingID} [${finding.severity}]` +
    `${rules ? ` fired: ${rules}` : ""}.${reviewNote} In your next step you ` +
    `must respond to it: call drift_acknowledge to explain or dispute it (with ` +
    `a rationale), correct the work, or detour_declare a sanctioned detour. ` +
    `This is not a user message.)`;
  let admitted;
  try {
    admitted = admitInput(target.session, {
      id,
      text,
      delivery: "next-step",
      internal: true,
    });
  } catch {
    // A conflicting admission for the same id already exists; do not duplicate.
    return;
  }
  ctx.ports.publishForSession(
    target,
    buildInputAdmission({
      id: admitted.id,
      text: admitted.text,
      internal: true,
      delivery: admitted.delivery,
      admittedAt: admitted.admittedAt,
      admittedSeq: admitted.admittedSeq,
    }),
  );
}

/**
 * Inject a prose-relevance 问通道 prompt (EI Phase 2, 机制 3) — the "ask" that
 * replaces the objective_activity_mismatch finding. When there is no accepted
 * contract and the recent activity barely relates to the goal, ask the main
 * agent to confirm it is on track. It is a question, not a finding: not
 * journaled, shown for the current turn, and it does not force a
 * drift_acknowledge. Carries only the (clipped) activity and objective prose.
 */
export function injectProseQuestion(
  ctx: RuntimeContext,
  target: SessionExecutionState,
  question: string,
  turnID?: string,
): void {
  const id = `turn_prose_${(turnID ?? target.activeTurnID ?? "session").replace(
    /[^a-zA-Z0-9]/gu,
    "_",
  )}`;
  let admitted;
  try {
    admitted = admitInput(target.session, {
      id,
      text: `(internal check, not a user message) ${question}`,
      delivery: "next-step",
      internal: true,
    });
  } catch {
    // A conflicting admission for the same id already exists; do not duplicate.
    return;
  }
  ctx.ports.publishForSession(
    target,
    buildInputAdmission({
      id: admitted.id,
      text: admitted.text,
      internal: true,
      delivery: admitted.delivery,
      admittedAt: admitted.admittedAt,
      admittedSeq: admitted.admittedSeq,
    }),
  );
}

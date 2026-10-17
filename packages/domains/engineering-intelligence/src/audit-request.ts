import { workLedgerController } from "@natalia/work-ledger";
import type { RuntimeEvent } from "@anthelia/contracts";
import { scanAuditRequestFacts } from "@anthelia/substrate";
import { sessionFactEvidenceRecords } from "@anthelia/session";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import type { WorkLedgerController } from "@natalia/work-ledger";

/**
 * EI §3.9: completion.recorded is a durable audit trigger. The request is
 * written before waking Nia so restart/dedup have a journal shadow, and both
 * the model tool and the SDK surface go through this one path.
 *
 * The dedupe/round facts are paged from the durable log (the shared scan): a
 * fast attach holds only the post-epoch tail, where an older audit.requested
 * for this plan is invisible — the request would republish or its round would
 * restart.
 */
export async function requestAuditAfterCompletion(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
  completion: Extract<RuntimeEvent, { type: "completion.recorded" }>,
): Promise<{ requested: boolean; reason?: string }> {
  const auditFacts = await scanAuditRequestFacts(ctx, exec, completion.taskID);
  if (auditFacts.triggerEventIDs.includes(completion.id))
    return {
      requested: false,
      reason: "already requested for this completion",
    };
  const ledger = ctx.state.serviceDirectory.getOptional(workLedgerController);
  if (!ledger) return { requested: false, reason: "no work-ledger service" };
  // A completion whose task has NO REGISTERED PLAN triggers nothing.
  //
  // This used to fire anyway ("there is just no lifecycle to project"), and the
  // cost was measured: four `audit.requested` for a task whose plan index was
  // empty, four wake-ups of an auditor with nothing to read, and no line in the
  // record saying why. An audit is a review of a plan's claim; without the plan
  // it is a ritual, and a ritual that wakes another agent is worse than silence —
  // so this refuses and SAYS SO instead.
  const plans = await ctx.ports.planDocRuntime
    ?.planDocList?.(exec.session.id)
    .catch(() => undefined);
  const registered = plans?.some((plan) => plan.planID === completion.taskID);
  if (!registered)
    return {
      requested: false,
      reason: `no registered plan for ${completion.taskID}: call plan_doc_write (which registers the plan document) before claiming the task complete, or record the completion with a taskKind and knownGaps so the claim stands on its own`,
    };
  const round = auditFacts.count + 1;
  ctx.ports.publishForSession(
    exec,
    ledger.buildAuditRequested({
      id: `audit:${completion.taskID}:${ctx.ports.nextPlanSequence()}`,
      planID: completion.taskID,
      planVersion: 1,
      triggerEventID: completion.id,
      round,
      scope: "completion_recorded",
      at: completion.recordedAt,
    }),
  );
  // The plan-status projection (the 2026-09-25 convergence): the same
  // producer that owns the ONE audit trigger also projects the
  // lifecycle's opening state, so the plan panel shows 待审计 from the
  // moment the audit is requested — BEFORE the wake, because her turn's
  // first act is to read the plan's status (her auditing projection is
  // gated on the pre-verdict states). Best-effort: a completion whose
  // taskID has no plan document (work outside any plan) still triggers
  // the audit — there is just no lifecycle to project. The write is a
  // pure projection: the status line's own trigger was deleted in this
  // convergence, so it cannot fire a second wake from here.
  const planDocRuntime = ctx.ports.planDocRuntime;
  if (planDocRuntime?.planDocUpdateStatus)
    await planDocRuntime
      .planDocUpdateStatus({
        planID: completion.taskID,
        status: "awaiting_audit",
        ...(exec.session.id ? { sessionID: exec.session.id } : {}),
      })
      .catch(() => {
        // A projection failure must never fail the audit trigger.
      });
  // THE BRIEF. The auditor is woken with the facts she is judging, stated as
  // facts and not as a recommendation: what the completion claims, which
  // evidence it cites, and — the second ruler — which of those runs were the
  // author's own. She may answer that a green does not count; saying so needs the
  // roles to be in front of her rather than inferred from prose.
  const cited = completion.evidenceIDs ?? [];
  const roles = (
    exec.factState ? sessionFactEvidenceRecords(exec.factState) : []
  )
    .filter((record) => cited.includes(record.id))
    .map((record) => {
      const validations = record.validations ?? [];
      return {
        id: record.id,
        selfReportedOnly:
          validations.length > 0 &&
          validations.every(
            (validation) => validation.assayRole === "self-reported",
          ),
      };
    });
  const selfReported = roles.filter((entry) => entry.selfReportedOnly).length;
  exec.context.add({
    id: `audit_brief:${completion.id}`,
    role: "dynamic",
    content: [
      `<runtime_context source="audit_brief" trust="runtime" plan_id="${completion.taskID}">`,
      `A completion was recorded for ${completion.taskID} (round ${round}).`,
      `It declares ${completion.validations.length} validation(s): ${
        completion.validations
          .map((validation) => `${validation.result} — ${validation.command}`)
          .join("; ") || "none"
      }.`,
      `It cites ${cited.length} evidence record(s)${selfReported > 0 ? `, ${selfReported} of which were SELF-REPORTED by the author (not an independent re-run)` : ""}.`,
      ...(completion.knownGaps?.length
        ? [`It declares these gaps: ${completion.knownGaps.join("; ")}.`]
        : []),
      "You judge the claim, not the person who made it.",
      "A self-reported green is a statement about intent; you may decide it does not count, name what would (re_assay re-runs a recorded command and reports whether its verdict still holds), and say so in your audit report.",
      `</runtime_context>`,
    ].join("\n"),
  });
  ctx.ports.requestNiaWake(exec);
  return { requested: true };
}

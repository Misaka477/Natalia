import { workLedgerController } from "@natalia/work-ledger";
import type { RuntimeEvent } from "@anthelia/contracts";
import { scanAuditRequestFacts } from "@anthelia/substrate";
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
): Promise<void> {
  const auditFacts = await scanAuditRequestFacts(ctx, exec, completion.taskID);
  if (auditFacts.triggerEventIDs.includes(completion.id)) return;
  const ledger = ctx.state.serviceDirectory.getOptional(workLedgerController);
  if (!ledger) return;
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
  ctx.ports.requestNiaWake(exec);
}

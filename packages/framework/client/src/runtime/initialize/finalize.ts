import {
  appendInstanceEvent,
  loadInstanceGovernance,
  resolveGovernanceRoot,
} from "@natalia/governance-ledger";
import type { RuntimeEvent } from "@anthelia/contracts";
import type { InitializeOptions, RuntimeContext } from "@anthelia/substrate";
import { ensureSessionFullEvents } from "@anthelia/substrate";
import { createInitializeRuntime } from "./runtime";
import { perfLog } from "@anthelia/runtime-services";
import { workLedgerController as workLedgerControllerToken } from "@natalia/work-ledger";
import { governanceLedgerController as governanceLedgerControllerToken } from "@natalia/governance-ledger";
import type { GovernanceLedgerController } from "@natalia/governance-ledger";
import type { WorkLedgerController } from "@natalia/work-ledger";
import { logOf } from "@anthelia/operation-log";

/**
 * The plan statuses that mean an audit is in flight and has not reached a
 * verdict. Everything else (`executing`, `paused`, `handed_off`, `marked`,
 * `audit_gaps`, `completed`, …) is either not awaiting an audit or already
 * answered one, and re-waking Nia for it would restart work that finished or
 * never started.
 */
const AUDIT_IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set([
  "awaiting_audit",
  "auditing",
  "audit_pending",
]);

/**
 * Process-level guard for the restart audit re-wake: one wake per plan+round
 * per process. `finalizeInitialize` runs once per runtime start, but one
 * process can host several runtimes (re-initialization, tests), and each of
 * them would otherwise stack another wake for the same in-flight audit.
 */
const reWokenAuditsThisProcess = new Set<string>();

/**
 * The plans whose audit a restart must re-wake Nia for (EI §3.9).
 *
 * A plan qualifies when it has a durable `audit.requested` AND its CURRENT
 * status is still pre-verdict. "Current" is the last `plan.doc.status` folded
 * over the whole log — the old scan instead asked "was an `audit_gaps` or
 * `completed` event ever seen", which (a) re-woke Nia on every boot for a
 * plan that was paused, handed off or still executing, and (b) under
 * `NATALIA_FAST_EXECUTION_LOAD` read a post-epoch tail that hid the early
 * events: an already-closed audit looked unclosed (a false re-wake) and an
 * early `audit.requested` looked like it never happened (a missed one).
 *
 * The dedup key is the plan plus the round of its latest request: a new audit
 * round is a new in-flight audit and earns its own wake, while the same round
 * never wakes twice in one process. `alreadyWoken` is the caller's guard set;
 * every key this function wakes is claimed in it.
 */
export function unclosedAuditPlanIDs(
  events: readonly RuntimeEvent[],
  alreadyWoken: Set<string> = new Set<string>(),
): string[] {
  const statusByPlan = new Map<string, string>();
  const latestRoundByPlan = new Map<string, number>();
  for (const event of events) {
    if (event.type === "plan.doc.status")
      statusByPlan.set(event.planID, event.status);
    else if (event.type === "audit.requested")
      latestRoundByPlan.set(
        event.planID,
        Math.max(latestRoundByPlan.get(event.planID) ?? 0, event.round),
      );
  }
  const planIDs: string[] = [];
  for (const [planID, round] of latestRoundByPlan) {
    const status = statusByPlan.get(planID);
    // A requested audit whose plan has no lifecycle projection at all (work
    // outside any plan document — the request's own status write is
    // best-effort) still needs its wake; a plan WITH a status line is
    // governed by that line's current state.
    if (status !== undefined && !AUDIT_IN_FLIGHT_STATUSES.has(status)) continue;
    const key = `${planID}#${round}`;
    if (alreadyWoken.has(key)) continue;
    alreadyWoken.add(key);
    planIDs.push(planID);
  }
  return planIDs;
}

export async function finalizeInitialize(
  ctx: RuntimeContext,
  _options: InitializeOptions,
  {
    interrupted,
    sqliteRecovery,
  }: Awaited<ReturnType<typeof import("./session-recovery").recoverSession>>,
) {
  const scope = createInitializeRuntime(ctx);
  const start = performance.now();
  const mark = (name: string) =>
    perfLog(
      `[perf] finalizeInitialize.${name} +${(performance.now() - start).toFixed(1)}ms`,
    );
  const governanceLedgerController = scope.serviceDirectory.get(
    governanceLedgerControllerToken,
  );
  const workLedgerController = scope.serviceDirectory.get(
    workLedgerControllerToken,
  );
  const session = scope.session;
  if (!session) throw new Error("session initialization did not complete");
  // Warm the collaboration snapshot in the background so the first
  // providerRunnerInput/chat-prompt read does not run the full event
  // projection synchronously on the runtime thread.
  if (scope.activeExec) ctx.ports.scheduleCollabSnapshot?.(scope.activeExec);
  mark("pre");
  scope.publish({
    type: "session.created",
    sessionID: scope.sessionID,
    title: session.title,
  });
  if (scope.replayMode === "all")
    for (const event of session.events) scope.sink?.(event);
  mark("replay");
  if (sqliteRecovery)
    scope.interactive.restoreRecoveredInteractiveState(
      sqliteRecovery.approvals.filter(
        (request) =>
          !interrupted.some(
            (event) =>
              event.type === "approval.response" && event.id === request.id,
          ),
      ),
      sqliteRecovery.questions.filter(
        (request) =>
          !interrupted.some(
            (event) =>
              event.type === "question.response" && event.id === request.id,
          ),
      ),
      sqliteRecovery.interactives.filter(
        (request) =>
          !interrupted.some(
            (event) =>
              event.type === "interactive.response" && event.id === request.id,
          ),
      ),
    );
  else scope.interactive.restoreInteractiveState(session.events);
  mark("interactive");
  if (scope.replayMode === "none") {
    const pending = sqliteRecovery
      ? {
          approvals: sqliteRecovery.approvals.filter(
            (request) =>
              !interrupted.some(
                (event) =>
                  event.type === "approval.response" && event.id === request.id,
              ),
          ),
          questions: sqliteRecovery.questions.filter(
            (request) =>
              !interrupted.some(
                (event) =>
                  event.type === "question.response" && event.id === request.id,
              ),
          ),
        }
      : scope.projectInteractiveRequests(session.events);
    for (const request of pending.approvals) scope.sink?.(request);
    for (const request of pending.questions) scope.sink?.(request);
  }
  mark("pendingInteractive");
  if (scope.activeExec)
    await scope.initializeCheckpointController(scope.activeExec);
  mark("checkpoint");
  // The exec is the turn's view of agent/model state; the closures were the
  // source of truth during init, so mirror them before any turn can run.
  if (scope.activeExec) {
    scope.activeExec.selectedAgent = scope.selectedAgent;
    scope.activeExec.selectedModel = scope.selectedModel;
    scope.activeExec.activeSkill = scope.activeSkill;
    scope.activeExec.permissionMode = scope.permissionMode;
    scope.activeExec.permissionProfile = scope.selectedPermissionProfile;
    scope.applyAgentProvider(scope.activeExec);
  }
  mark("exec");
  scope.publish({ type: "session.ready", sessionID: scope.sessionID });
  mark("ready");
  const governanceRoot = resolveGovernanceRoot(ctx.ports.getWorkspaceRoot());
  const instance = loadInstanceGovernance(governanceRoot);
  if (instance.degraded)
    scope.publish({
      type: "diagnostic",
      level: "warning",
      message: "governance_store_unavailable",
    });
  for (const event of instance.events) {
    if (
      session.events.some(
        (existing) =>
          existing.type === event.type &&
          "id" in existing &&
          "id" in event &&
          existing.id === event.id,
      )
    )
      continue;
    scope.publish(event);
    if (event.type === "constitution.rule_added")
      scope.publish(
        workLedgerController.constitutionRuleNode({
          ruleID: event.ruleID,
          statement: event.statement,
          scope: event.scope,
          sessionID: scope.sessionID,
        }),
      );
  }
  // The self-protection rules are the first constitution facts: migrate them
  // into the durable journal on every boot (idempotent — replay already holds
  // them) so `constitutionRules()` and the /constitution UI answer real rules,
  // not the empty projection CST1 shipped.
  for (const rule of governanceLedgerController.seedConstitutionRules([
    ...instance.events,
    ...session.events,
  ])) {
    appendInstanceEvent(governanceRoot, "constitution.jsonl", rule);
    scope.publish(rule);
    // CST4 Work Graph linkage: each seeded rule is a `constraint` node, so
    // tool calls and drift findings can relate to it in the graph.
    scope.publish(
      workLedgerController.constitutionRuleNode({
        ruleID: rule.ruleID,
        statement: rule.statement,
        scope: rule.scope,
        sessionID: scope.sessionID,
      }),
    );
  }
  mark("governance");
  // Overrides are visible, not silent: a plugin that replaced a built-in
  // tool shows up in diagnostics so nobody discovers it by surprise.
  for (const override of scope.capabilityRegistry.overrides())
    scope.publish({
      type: "diagnostic",
      level: "warning",
      message: `capability "${override.winner}" (precedence ${override.winnerPrecedence}) replaced "${override.loser}" (precedence ${override.loserPrecedence}) for ${override.kind} "${override.name}"`,
    });
  mark("overrides");
  scope.publishRuntimeCapabilities();
  scope.publishRegisteredTools();
  scope.publish(
    scope.contextStatusEvent(
      scope.runtimeContext.status(scope.runtimeContextConfig),
    ),
  );
  mark("tools");
  scope.publish(await scope.runtimeStatusSnapshot());
  mark("statusSnapshot");
  // EI §3.9 重启恢复: the Nia audit wake is in-memory, so a restart would drop
  // an in-flight audit. Scan for audit.requested events whose plan never closed
  // (no audit_gaps / completed status) and re-wake Nia so the
  // audit is not lost across a restart.
  if (scope.activeExec && ctx.ports.requestNiaWake) {
    // The scan needs the WHOLE log, not the fast-attach tail: the tail alone
    // both misses early `audit.requested` events and misses the
    // `plan.doc.status` events that closed them. A consumer without a store
    // has no full log to load, and a startup must not die because the history
    // could not be widened — the scan then runs over the exec's window.
    try {
      await ensureSessionFullEvents(ctx, scope.activeExec);
    } catch (error) {
      logOf(ctx.state.serviceDirectory).warn(
        "audit-recovery",
        "full event load failed; the unclosed-audit scan uses the exec window",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
    for (const planID of unclosedAuditPlanIDs(
      scope.activeExec.session.events,
      reWokenAuditsThisProcess,
    )) {
      logOf(ctx.state.serviceDirectory).info(
        "audit-recovery",
        "re-waking Nia for an unclosed audit",
        {
          planID,
        },
      );
      ctx.ports.requestNiaWake(scope.activeExec);
    }
  }
}

import {
  appendInstanceEvent,
  loadInstanceGovernance,
  resolveGovernanceRoot,
} from "@natalia/governance-ledger";
import type { InitializeOptions, RuntimeContext } from "@anthelia/substrate";
import { createInitializeRuntime } from "./runtime";
import { perfLog } from "@anthelia/runtime-services";
import { workLedgerController as workLedgerControllerToken } from "@natalia/work-ledger";
import { governanceLedgerController as governanceLedgerControllerToken } from "@natalia/governance-ledger";
import type { GovernanceLedgerController } from "@natalia/governance-ledger";
import type { WorkLedgerController } from "@natalia/work-ledger";
import { logOf } from "@anthelia/operation-log";

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
    const closedPlans = new Set<string>();
    for (const event of session.events) {
      if (
        event.type === "plan.doc.status" &&
        (event.status === "audit_gaps" || event.status === "completed")
      )
        closedPlans.add(event.planID);
    }
    const unclosed = new Set<string>();
    for (const event of session.events) {
      if (event.type === "audit.requested" && !closedPlans.has(event.planID))
        unclosed.add(event.planID);
    }
    for (const planID of unclosed) {
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

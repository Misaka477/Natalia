import {
  appendInstanceEvent,
  loadInstanceGovernance,
  mergeGovernanceEvents,
  resolveGovernanceRoot,
} from "@natalia/governance-ledger";
import type { InitializeOptions, RuntimeContext } from "@anthelia/substrate";
import { createInitializeRuntime } from "./runtime";
import { perfLog } from "@anthelia/runtime-services";
import { workLedgerController as workLedgerControllerToken } from "@natalia/work-ledger";
import { governanceLedgerController as governanceLedgerControllerToken } from "@natalia/governance-ledger";
import type { GovernanceLedgerController } from "@natalia/governance-ledger";
import type { WorkLedgerController } from "@natalia/work-ledger";

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
    // THE EXEC'S OWN RUNG OUTRANKS THE PROCESS-GLOBAL VALUE.
    //
    // This mirror used to stamp `scope.permissionMode` — the deployment
    // default — unconditionally, which undid the recovery coordinator's
    // adoption of the session's durable rung a few lines later in the same
    // startup. Measured: a session whose journal AND recovery row both said
    // `ask` came back reporting `read_only` on every restart, and the mode read
    // as locked on the default no matter what the human had chosen.
    //
    // `permissionModeOverride` is set exactly when something adopted a rung for
    // this session (the recovery coordinator, an attach, the selector), so it is
    // the "this session chose" marker — the same precedence
    // `reloadPermissionSettings` and `config-reload` already apply.
    scope.activeExec.permissionMode =
      scope.activeExec.permissionModeOverride ?? scope.permissionMode;
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
  for (const rule of governanceLedgerController.seedConstitutionRules(
    // One journal, two copies: the merge dedupes by id, so a rule the
    // instance store already carries is not seeded a second time.
    mergeGovernanceEvents(instance.events, session.events),
  )) {
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
  // A RESTART NEVER STARTS AN AUDIT. That is the whole law here, and the
  // scan that used to live at this point is gone rather than tuned.
  //
  // It scanned the journal for `audit.requested` events whose plan had not
  // reached a verdict and re-woke Nia for each one — the intent was to recover
  // an audit killed mid-flight (the wake is in-memory, so a restart drops it).
  // The implementation could not tell "interrupted by this restart" from
  // "already failed, or never going to close", because both look identical in
  // the journal: `audit.requested` stays, and `plan.doc.status` stays on
  // `awaiting_audit`. The dedup key lived in a PROCESS-level set, so every boot
  // got a fresh one and re-woke her again — a plan stuck in `awaiting_audit`
  // started an audit on EVERY start, forever, with no cap and no terminal
  // state. Reported from use: "重启的时候就不能去自动审计".
  //
  // An audit is now ONLY started by a live trigger (a recorded completion over
  // a registered plan, an explicit collaboration message to her, or a turn
  // verdict). If one was interrupted, the plan's own status line says so and
  // the next completion round asks again — a reviewer that wakes herself on
  // boot is not reviewing anything the human asked for.
}

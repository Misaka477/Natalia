import type { RuntimeEvent } from "@anthelia/contracts";
import { ContextLedger, TokenMeter, memoryTrace } from "@anthelia/runtime";
import type { SessionProjection } from "@anthelia/session";
import { announcedTurnIDsFrom } from "@anthelia/substrate";
import { reseedSessionFactState } from "@anthelia/substrate";
import type {
  InitializeOptions,
  SandboxService,
  SessionExecutionState,
} from "@anthelia/substrate";
import {
  prepareSessionRecoveryContextInWorker,
  projectSessionInWorker,
  type RecoveryContextPlan,
} from "@anthelia/substrate";
import type { InitializeScope } from "./runtime";
import {
  mcpService,
  sandboxService,
  terminalController,
} from "@anthelia/runtime-services";
import { sessionStoreController } from "@anthelia/session-store";
import { attachmentService as attachmentServiceToken } from "@anthelia/attachments";
import { perfLog } from "@anthelia/runtime-services";
import { today } from "@anthelia/runtime";
import { contextLedgerFactory } from "@natalia/context-ledger";
import type { AttachmentService } from "@anthelia/runtime";
import type { SessionStoreController } from "@anthelia/session-store";
import type { ContextLedgerFactory } from "@natalia/context-ledger";
import { logOf } from "@anthelia/operation-log";

type LoadedSession = Awaited<ReturnType<SessionStoreController["load"]>>;
type RecoveryView = NonNullable<LoadedSession["recovery"]>;
type ContextEpoch = NonNullable<LoadedSession["contextEpoch"]>;

export type SessionRecoveryResult = {
  interrupted: RuntimeEvent[];
  sqliteRecovery?: RecoveryView;
};

/**
 * Session recovery split into a small state machine.
 *
 * The heavyweight projection/event-selection work lives in the session worker;
 * this coordinator only owns:
 *   - service calls (SQLite, sandbox, terminal, attachment, context ledger)
 *   - runtime state writes (diagnostics, attachment references, active exec)
 *   - phase scheduling and fallback to the main thread
 */
export class SessionRecoveryCoordinator {
  private readonly scope: InitializeScope;
  private readonly options: InitializeOptions;
  private readonly sessionStore: SessionStoreController;
  private readonly attachmentService: AttachmentService;
  private readonly contextLedgerFactory: ContextLedgerFactory;
  private session!: import("@anthelia/session").SessionRecord;

  private sqliteRecovery?: RecoveryView;
  private sqliteEpoch?: ContextEpoch;
  private projection?: SessionProjection;
  private preparedContext?: RecoveryContextPlan;
  private interrupted: RuntimeEvent[] = [];

  constructor(options: InitializeOptions, scope: InitializeScope) {
    this.scope = scope;
    this.options = options;
    const sessionStore = scope.serviceDirectory.getOptional(
      sessionStoreController,
    );
    if (!sessionStore)
      throw new Error("session store unavailable (natalia-session-store)");
    this.sessionStore = sessionStore;
    // Resolution is fail-fast by construction.
    this.attachmentService = scope.serviceDirectory.get(attachmentServiceToken);
    this.contextLedgerFactory =
      scope.serviceDirectory.get(contextLedgerFactory);
  }

  async run(): Promise<SessionRecoveryResult> {
    const start = performance.now();
    const mark = (name: string) =>
      perfLog(
        `[perf] recovery.${name} +${(performance.now() - start).toFixed(1)}ms`,
      );
    await this.phase0Load();
    mark("phase0.load");
    await this.phase1Projection();
    mark("phase1.projection");
    await this.phase2ApplyProjection();
    mark("phase2.applyProjection");
    await this.phase3PrepareContext();
    mark("phase3.prepareContext");
    await this.phase4ApplyServices();
    mark("phase4.applyServices");
    await this.phase5Publish();
    mark("phase5.publish");
    return {
      interrupted: this.interrupted,
      sqliteRecovery: this.sqliteRecovery,
    };
  }

  /**
   * Phase 0 — Load.
   *
   * All work here is host-owned service initialization/read. No heavy
   * projection or event filtering happens on the runtime thread.
   */
  private async phase0Load() {
    const scope = this.scope;
    memoryTrace("recovery.phase0.start", { sessionID: scope.sessionID });
    if (scope.tsRuntimeConfig && scope.extensionEnabled("mcp")) {
      scope.serviceDirectory.getOptional(mcpService)?.reload();
    }
    const terminal = scope.serviceDirectory.getOptional(terminalController);
    await terminal?.init();
    terminal?.setActiveSession(scope.sessionID);

    await scope.serviceDirectory.getOptional(sandboxService)?.init();

    const fastPathEnabled = process.env.NATALIA_FAST_EXECUTION_LOAD === "1";
    memoryTrace("recovery.load.start", { sessionID: scope.sessionID });
    const storedSession = await this.sessionStore.load(scope.sessionID, {
      title: this.options.title,
      create: true,
      indexedRecovery: fastPathEnabled || scope.replayMode === "none",
      runtimeEvents: true,
    });
    scope.session = storedSession?.session;
    memoryTrace("recovery.load.done", {
      sessionID: scope.sessionID,
      events: scope.session?.events.length,
    });
    const session = scope.session;
    if (!session) throw new Error("session initialization did not complete");
    this.session = session;
    if (this.options.title && !session.metadata?.titleSource) {
      session.metadata = {
        ...session.metadata,
        titleSource: "manual",
      };
      await this.sessionStore.updateMetadata(session, {
        titleSource: "manual",
      });
    }

    const durableEventCount = await this.sessionStore
      .eventCount(scope.sessionID)
      .catch(() => session.events.length);
    // Same snapshot rule as the main path: the date is taken once, when the
    // state is built, and reused rather than re-read on every request.
    const sessionDate = today();
    const initialExec: SessionExecutionState = {
      session,
      context: scope.runtimeContext,
      sessionStartedAt: sessionDate,
      currentDate: sessionDate,
      attachmentReferences: scope.attachmentReferences,
      toolCalls: scope.toolCalls,
      provider: scope.provider,
      runtimeContextConfig: scope.runtimeContextConfig,
      permissionMode: scope.permissionMode,
      permissionProfile: scope.selectedPermissionProfile,
      paused: false,
      pauseWaiters: [],
      injectedMailboxIDs: new Set(),
      announcedTurnIDs: announcedTurnIDsFrom(session),
      naviChatLedger: new ContextLedger(),
      niaChatLedger: new ContextLedger(),
      tokenMeter: new TokenMeter(),
      naviTokenMeter: new TokenMeter(),
      niaTokenMeter: new TokenMeter(),
      naviPendingQueue: [],
      niaPendingQueue: [],
      naviAbortWakePending: false,
      eventCount: durableEventCount,
      nextSessionSeq: durableEventCount + 1,
      niaAbortWakePending: false,
    };
    scope.activeExec = initialExec;
    scope.executionBySession.set(scope.sessionID, initialExec);

    this.sqliteRecovery = storedSession.recovery;
    this.sqliteEpoch = storedSession.contextEpoch;

    // The startup exec was created before durable recovery replaced the
    // scope.session record. Point it at the recovered record, or per-scope
    // session reads through the exec would see the pre-recovery shell.
    if (scope.activeExec) scope.activeExec.session = session;

    // Fast recovery: when NATALIA_FAST_EXECUTION_LOAD is enabled and a context
    // epoch exists, the store already returned a recovery projection without
    // loading the full event log. Keep the post-epoch tail as the normal
    // window; a consumer that genuinely needs the full journal calls
    // ensureSessionFullEvents(), the single explicit escape hatch.
    const restoreEvents = fastPathEnabled
      ? this.sessionStore.contextEventsAfter(
          scope.sessionID,
          storedSession.contextEpoch,
        )
      : undefined;
    if (restoreEvents && storedSession.contextEpoch) {
      session.events = restoreEvents;
      if (scope.activeExec) {
        scope.activeExec.session.events = restoreEvents;
        // The base log is now the post-epoch tail, so a fact state seeded from
        // the earlier record is stale; re-seed and mark it incomplete.
        reseedSessionFactState(scope.activeExec, false);
      }
    }
    if (fastPathEnabled) {
      // Prewarm the message index in a worker thread so the first
      // session.messages RPC does not build it on the critical path.
      void this.sessionStore
        .ensureMessageIndexAsync(scope.sessionID)
        .catch((error) => {
          logOf(scope.serviceDirectory).warn(
            "perf",
            `recovery message-index prewarm failed session=${scope.sessionID}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      void this.sessionStore
        .prewarmMessagePage(scope.sessionID)
        .catch((error) => {
          logOf(scope.serviceDirectory).warn(
            "perf",
            `recovery message-page prewarm failed session=${scope.sessionID}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      // Prewarm the latest message page for every session so the UI can
      // attach to any recent session without paying the projection cost on
      // the first messages RPC.
      void this.sessionStore
        .list()
        .then((sessions) => {
          for (const session of sessions) {
            void this.sessionStore
              .prewarmMessagePage(
                session.id as import("@anthelia/contracts").SessionID,
              )
              .catch((error) => {
                logOf(scope.serviceDirectory).warn(
                  "perf",
                  `recovery message-page prewarm failed session=${session.id}: ${error instanceof Error ? error.message : String(error)}`,
                );
              });
          }
        })
        .catch(() => undefined);
    }

    await this.attachmentService
      .cleanup(await this.sessionStore.referencedAttachments())
      .catch((error) =>
        scope.publish({
          type: "diagnostic",
          level: "warning",
          message: `attachment cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
  }

  /**
   * Phase 1 — Pure Projection.
   *
   * The runtime serializes the session record into the worker, gets back the
   * projected durable events, and stores the projection in memory. Interrupted
   * turn settlement is intentionally kept here because it must be persisted
   * before the runtime publishes the diagnosis; the expensive event scanning
   * still happens on the worker.
   */
  private async phase1Projection() {
    const scope = this.scope;
    const interruptedOperation = this.session.metadata?.inFlightOperation;

    const interrupted = this.sqliteRecovery
      ? scope.settleInterruptedTurnIDs(
          this.sqliteRecovery.activeTurnIDs,
          this.sqliteRecovery.approvals.map((request) => request.id),
          this.sqliteRecovery.questions.map((request) => request.id),
        )
      : scope.settleInterruptedTurns(this.session);
    this.interrupted = interrupted;

    const operationTurnWasInterrupted = Boolean(
      interruptedOperation &&
        interrupted.some(
          (event) =>
            event.type === "turn.finished" &&
            event.id === interruptedOperation.turnID,
        ),
    );
    if (interruptedOperation) {
      delete this.session.metadata?.inFlightOperation;
      await this.sessionStore.updateMetadata(this.session, {
        inFlightOperation: undefined,
      });
    }
    if (interrupted.length || interruptedOperation) {
      await this.sessionStore.appendEvents(this.session, interrupted);
      scope.publish({
        type: "diagnostic",
        level: "warning",
        message: operationTurnWasInterrupted
          ? `previous process stopped during ${interruptedOperation!.kind === "provider_dispatch" ? "provider dispatch" : "tool execution"}; the operation was safely settled as an error and cannot be replayed without an idempotency contract`
          : // R4(d): the requests are NOT rejected — they stay pending and
            // answerable. What cannot be replayed is the interrupted turn's
            // provider work, so the turn closes and the human's later answer
            // is recorded against a request nothing is waiting on.
            `previous process stopped during ${interrupted.filter((event) => event.type === "turn.finished").length} active turn(s); the turns are closed and their unresolved interactive requests stay pending — answer them and the decision is recorded`,
      });
    }

    this.projection =
      (await projectSessionInWorker(this.session).catch(() => undefined)) ??
      scope.projectSession(this.session);
  }

  /**
   * Phase 2 — Apply projection snapshot to the runtime memory.
   *
   * Still cheap: diagnostics, attachment references and the agent/model flags
   * are plain state writes. Any expensive reconstruction has already been done
   * by the worker.
   */
  private async phase2ApplyProjection() {
    const scope = this.scope;
    const projection = this.projection;
    if (!projection) throw new Error("session projection was not computed");

    const initialDiagnostics =
      scope.runtimeDiagnosticsBySession.get(this.session.id) ?? [];
    for (const event of this.sqliteRecovery?.diagnostics ?? [])
      initialDiagnostics.push({
        ...event,
        at: event.at ?? this.session.createdAt,
      });
    for (const event of projection.replayableEvents)
      if (event.type === "diagnostic")
        initialDiagnostics.push({
          ...event,
          at: event.at ?? this.session.createdAt,
        });
    scope.runtimeDiagnosticsBySession.set(this.session.id, initialDiagnostics);
    for (const event of projection.replayableEvents)
      if (event.type === "turn.submitted" && event.attachments?.length)
        scope.attachmentReferences.set(`${event.id}:user`, event.attachments);

    const selectedAgentName =
      this.sqliteRecovery?.selectedAgent ?? projection.selectedAgent;
    if (selectedAgentName) {
      const restored = scope.agentRegistry?.select(selectedAgentName);
      if (restored) {
        scope.selectedAgent = restored;
        scope.applyAgentPolicy();
        scope.applyAgentProvider(scope.activeExec);
      } else {
        scope.publish({
          type: "diagnostic",
          level: "warning",
          message: `persisted agent is no longer configured: ${selectedAgentName}`,
        });
      }
    }

    const recoveredModel =
      this.sqliteRecovery?.selectedModel ?? projection.selectedModel;
    if (recoveredModel) {
      scope.selectedModel = recoveredModel;
      scope.applyAgentProvider(scope.activeExec);
    }

    const recoveredReasoning =
      this.sqliteRecovery?.reasoningEffort ?? projection.reasoningEffort;
    if (recoveredReasoning && scope.activeExec)
      scope.activeExec.reasoningEffort = recoveredReasoning;

    const recoveredChatProfile =
      this.sqliteRecovery?.chatModelProfile ?? projection.chatModelProfile;
    if (recoveredChatProfile && scope.activeExec) {
      scope.activeExec.naviChatModelProfile = recoveredChatProfile.navi;
      scope.activeExec.niaChatModelProfile = recoveredChatProfile.nia;
    }

    const recoveredPermissionMode =
      this.sqliteRecovery?.permissionMode ?? projection.permissionMode;
    if (recoveredPermissionMode && scope.activeExec)
      scope.activeExec.permissionMode = recoveredPermissionMode;
  }

  /**
   * Phase 3 — Context event preparation (pure event filtering).
   *
   * The worker computes the latest checkpoint, whether it has a summary, and
   * the model-visible restore list. SQLite `contextEventsAfter` is a service
   * read and remains in Phase 4, where the context ledger is restored.
   */
  private async phase3PrepareContext() {
    const projection = this.projection;
    if (!projection) throw new Error("session projection was not computed");

    this.preparedContext =
      (await prepareSessionRecoveryContextInWorker(
        projection.replayableEvents,
      ).catch(() => undefined)) ??
      computeRecoveryContextFallback(
        projection.replayableEvents,
        this.scope.modelVisibleEvents,
      );
  }

  /**
   * Phase 4 — Apply services.
   *
   * Everything that touches a runtime service (checkpoint restore, context
   * ledger, tool output cleanup) stays on this thread.
   */
  private async phase4ApplyServices() {
    const scope = this.scope;
    const projection = this.projection;
    const prepared = this.preparedContext;
    if (!projection || !prepared)
      throw new Error("session recovery context was not prepared");

    await scope.cleanupToolOutput(scope.workspaceRoot).catch((error) =>
      scope.publish({
        type: "diagnostic",
        level: "warning",
        message: `tool output cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );

    if (this.sqliteEpoch)
      scope.runtimeContext.restoreDurableCheckpoint(this.sqliteEpoch.snapshot);
    else if (prepared.checkpointHasSummary && prepared.latestContextCheckpoint)
      scope.runtimeContext.restoreDurableCheckpoint(
        prepared.latestContextCheckpoint.snapshot,
      );

    const recoveryRestoreEvents = this.sqliteEpoch
      ? this.sessionStore.contextEventsAfter(scope.sessionID, this.sqliteEpoch)!
      : prepared.restoreEvents;

    this.contextLedgerFactory.restore(
      scope.runtimeContext,
      recoveryRestoreEvents,
    );

    // The no-compaction counterpart of the restore above: the replayed events
    // rebuild exactly the surface the durable checkpoint describes, so its
    // usage anchor can be restored on top. Without it the ring and the
    // compaction budget read the entry estimate (7 tokens against a 32k
    // window: a 0% ring) until the next provider step.
    const durableUsageCheckpoint =
      !this.sqliteEpoch &&
      !prepared.checkpointHasSummary &&
      prepared.latestContextCheckpoint?.type === "context.checkpoint"
        ? prepared.latestContextCheckpoint.snapshot.checkpoint
        : undefined;
    if (durableUsageCheckpoint) {
      const applied = scope.runtimeContext.restoreUsageCheckpoint(
        durableUsageCheckpoint,
      );
      logOf(scope.serviceDirectory).warn(
        "context-restore",
        "session-recovery",
        {
          sessionID: scope.sessionID,
          checkpointApplied: applied,
          checkpointTokens: durableUsageCheckpoint.tokens,
        },
      );
    }

    logOf(scope.serviceDirectory).warn("context-restore", "session-recovery", {
      sessionID: scope.sessionID,
      replayableEvents: projection.replayableEvents.length,
      restoreEvents: recoveryRestoreEvents.length,
      contextEntries: scope.runtimeContext.snapshot().entries.length,
      hasEpoch: this.sqliteEpoch !== undefined,
      checkpointHasSummary: prepared.checkpointHasSummary,
    });
  }

  /**
   * Phase 5 — Publish remaining durable references and wake queued work.
   */
  private async phase5Publish() {
    const scope = this.scope;
    const projection = this.projection;
    if (!projection) throw new Error("session projection was not computed");

    for (const [turnID, attachments] of this.sqliteRecovery?.attachments ?? [])
      scope.attachmentReferences.set(`${turnID}:user`, attachments);

    const [queued] = projection.pendingInputs.filter(
      (input) => input.delivery === "next-turn",
    );
    if (queued) void scope.turnCoordinator().wake(scope.drainSession);

    const activeSkillEntry = [...scope.runtimeContext.snapshot().entries]
      .reverse()
      .find(
        (entry) => entry.role === "system" && entry.id.startsWith("skill:"),
      );
    const qualifiedName = activeSkillEntry?.id.match(
      /^skill:((?:project|remote|user):[^:]+):/u,
    )?.[1];
    if (qualifiedName && scope.skillService()) {
      try {
        scope.activeSkill = scope.skillService()!.resolve(qualifiedName);
      } catch {
        // A removed skill must not prevent durable scope.session recovery.
      }
    }
  }
}

function computeRecoveryContextFallback(
  events: RuntimeEvent[],
  modelVisibleEvents: (events: RuntimeEvent[]) => RuntimeEvent[],
): RecoveryContextPlan {
  let latestContextCheckpoint:
    | Extract<RuntimeEvent, { type: "context.checkpoint" }>
    | undefined;
  let checkpointHasSummary = false;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === "context.checkpoint") {
      latestContextCheckpoint = event;
      checkpointHasSummary = event.snapshot.entries.some(
        (entry) => entry.role === "summary",
      );
      break;
    }
  }
  return {
    latestContextCheckpoint,
    checkpointHasSummary,
    restoreEvents:
      checkpointHasSummary && latestContextCheckpoint
        ? modelVisibleEvents(events)
        : events,
  };
}

/**
 * Session execution state — runtime/session-execution/index.ts.
 *
 * `ensureExecution` creates a session's execution state lazily (its record,
 * context ledger and in-flight markers) and the drain/admit/persist/load
 * helpers that drive the turn controller for a session. Reads host state
 * through `RuntimeContext` at call time.
 */
import {
  ContextLedger,
  TokenMeter,
  memoryTrace,
  providerForModel,
} from "@anthelia/runtime";
import { projectSession } from "@anthelia/session";
import {} from "@anthelia/runtime-services";
import { sessionStoreController } from "@anthelia/session-store";
import { turnController } from "@anthelia/turn-orchestration";
import { contextLedgerFactory as contextLedgerFactoryToken } from "@natalia/context-ledger";
import type { SessionRecord } from "@anthelia/session";
import type { SessionID } from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";
import { filterRuntimeRetainedEvents } from "@anthelia/substrate";
import { perfLog } from "@anthelia/runtime-services";
import { today } from "@anthelia/runtime";
import type { SessionStoreController } from "@anthelia/session-store";
import type { TurnController } from "@anthelia/turn-orchestration";
import type { ContextLedgerFactory } from "@natalia/context-ledger";
import { logOf } from "@anthelia/operation-log";

const MAX_IDLE_SESSION_EXECUTIONS = Math.max(
  64,
  Number(process.env.NATALIA_MAX_IDLE_SESSIONS ?? 512),
);

/**
 * Per-session event-count guard. An idle execution that accumulated a very
 * large journal is the main long-session memory holder; it can be re-created
 * lazily on the next attach/read. Busy sessions are never evicted.
 */
const MAX_IDLE_SESSION_EVENTS = Math.max(
  5_000,
  Number(process.env.NATALIA_MAX_IDLE_SESSION_EVENTS ?? 20_000),
);

/**
 * Total event-count budget across idle executions. The count is an upper
 * bound on object count; it intentionally avoids walking every event just to
 * estimate bytes during a hot prune check.
 */
const MAX_TOTAL_IDLE_EVENT_COUNT = Math.max(
  MAX_IDLE_SESSION_EVENTS,
  Number(process.env.NATALIA_MAX_TOTAL_IDLE_EVENTS ?? 60_000),
);

function isIdleExecution(
  active: SessionExecutionState | undefined,
  exec: SessionExecutionState,
) {
  return (
    exec !== active &&
    !exec.activeAbort &&
    !exec.activeTurnID &&
    !exec.paused &&
    !exec.endTurnWaitingHuman
  );
}

function pruneIdleSessionExecutions(ctx: RuntimeContext) {
  const { executionBySession } = ctx.state;
  const active = ctx.ports.getActiveExec();
  const idle = [...executionBySession.entries()].filter(([, exec]) =>
    isIdleExecution(active, exec),
  );

  // First drop any single idle execution that is already over the per-session
  // event guard. This is the common case after attaching to a very old session.
  for (const [sessionID, exec] of idle) {
    if (exec.session.events.length <= MAX_IDLE_SESSION_EVENTS) continue;
    executionBySession.delete(sessionID);
    ctx.state.sessionPersistenceBySession.delete(sessionID);
  }

  const remainingIdleEventCount = [...executionBySession.values()]
    .filter((exec) => isIdleExecution(active, exec))
    .reduce((sum, exec) => sum + exec.session.events.length, 0);
  if (
    executionBySession.size <= MAX_IDLE_SESSION_EXECUTIONS &&
    remainingIdleEventCount <= MAX_TOTAL_IDLE_EVENT_COUNT
  )
    return;

  // Then evict the largest idle executions until both budgets are satisfied.
  const evictionOrder = [...executionBySession.entries()]
    .filter(([, exec]) => isIdleExecution(active, exec))
    .sort(
      (left, right) =>
        right[1].session.events.length - left[1].session.events.length,
    );
  let eventCount = remainingIdleEventCount;
  for (const [sessionID, exec] of evictionOrder) {
    if (
      executionBySession.size <= MAX_IDLE_SESSION_EXECUTIONS &&
      eventCount <= MAX_TOTAL_IDLE_EVENT_COUNT
    )
      break;
    executionBySession.delete(sessionID);
    ctx.state.sessionPersistenceBySession.delete(sessionID);
    eventCount -= exec.session.events.length;
  }
}

export function createSessionExecution(
  ctx: RuntimeContext,
  options: RealRuntimeClientOptions,
) {
  return {
    drainSessionFor,
    drainPendingQueue,
    runAdmittedInput,
    persistInboxPromotion,
    loadSessionForAttach,
    ensureExecution,
  };

  function drainSessionFor(sessionID: SessionID) {
    return async (signal: AbortSignal) => {
      await ensureExecution(sessionID);
      const controller = ctx.state.serviceDirectory.get(turnController);
      await controller.drain(signal, sessionID);
    };
  }

  async function drainPendingQueue(signal?: AbortSignal) {
    const controller = ctx.state.serviceDirectory.get(turnController);
    await controller.drainQueue(signal, ctx.ports.getSessionID());
  }

  async function runAdmittedInput(
    id: string,
    text: string,
    attachments: import("@anthelia/contracts").LocalAttachment[] = [],
    resources: import("@anthelia/contracts").PromptResourceMention[] = [],
    agents: import("@anthelia/contracts").PromptAgentMention[] = [],
  ) {
    const controller = ctx.state.serviceDirectory.get(turnController);
    await controller.admit(
      ctx.ports.getSessionID(),
      id,
      text,
      attachments,
      resources,
      agents,
    );
  }

  async function persistInboxPromotion(
    targetSessionID = ctx.ports.getSessionID(),
  ) {
    const controller = ctx.state.serviceDirectory.get(turnController);
    await controller.persistPromotion(targetSessionID);
  }

  async function loadSessionForAttach(id: SessionID): Promise<SessionRecord> {
    const sessionStore = ctx.state.serviceDirectory.getOptional(
      sessionStoreController,
    );
    if (!sessionStore)
      throw new Error("session store unavailable (natalia-session-store)");
    return (await sessionStore.load(id)).session;
  }

  /**
   * D2: the execution state for a session — its record, its context ledger and
   * its in-flight turn markers. Created lazily the first time the session runs
   * work (init, attach or a background submission) and kept for the client's
   * life, so a background turn of A survives attaching to B and back.
   */
  async function ensureExecution(
    sessionID: SessionID,
  ): Promise<SessionExecutionState> {
    const start = performance.now();
    const mark = (name: string) =>
      perfLog(
        `[perf] ensureExecution.${name} session=${sessionID} +${(performance.now() - start).toFixed(1)}ms`,
      );
    perfLog(`[perf] ensureExecution start session=${sessionID}`);
    const {
      getProviderSource,
      getProvider,
      getRuntimeContextConfig,
      getDefaultPermissionMode,
      getDefaultPermissionProfile,
      getAgentRegistry,
      applyAgentProvider,
      refreshExecutionContextConfig,
    } = ctx.ports;
    const { executionBySession } = ctx.state;
    const existing = executionBySession.get(sessionID);
    if (existing) {
      // Log cache hits distinctly: logging `ensure.start` before this check made
      // every hit look like a fresh (expensive) execution rebuild in the trace.
      memoryTrace("execution.ensure.hit", { sessionID });
      perfLog(
        `[perf] ensureExecution hit session=${sessionID} +${(performance.now() - start).toFixed(1)}ms`,
      );
      return existing;
    }
    memoryTrace("execution.ensure.start", { sessionID });
    const sessionStore = ctx.state.serviceDirectory.getOptional(
      sessionStoreController,
    );
    if (!sessionStore)
      throw new Error("session store unavailable (natalia-session-store)");
    const contextLedgerFactory = ctx.state.serviceDirectory.get(
      contextLedgerFactoryToken,
    );
    const fastPathEnabled = process.env.NATALIA_FAST_EXECUTION_LOAD === "1";
    const durableEventCount = await sessionStore.eventCount(sessionID);
    const stored = await sessionStore.load(
      sessionID,
      fastPathEnabled
        ? { indexedRecovery: true, runtimeEvents: true }
        : { runtimeEvents: true },
    );
    mark("load");
    const loaded = stored.session;
    const recovery = stored.recovery;
    const epoch = stored.contextEpoch;
    const storeMode = sessionStore.status().mode;
    loaded.events = filterRuntimeRetainedEvents(
      loaded.events,
      storeMode,
      Boolean(epoch),
    );
    const execContext = contextLedgerFactory.create();
    mark("createLedger");
    const projection = projectSession(loaded);
    mark("project");
    const latestContextCheckpoint = [...projection.replayableEvents]
      .reverse()
      .find((event) => event.type === "context.checkpoint");
    const checkpointIndex = latestContextCheckpoint
      ? projection.replayableEvents.indexOf(latestContextCheckpoint)
      : -1;
    const checkpointHasSummary =
      latestContextCheckpoint?.type === "context.checkpoint" &&
      latestContextCheckpoint.snapshot.entries.some(
        (entry) => entry.role === "summary",
      );
    if (epoch) execContext.restoreDurableCheckpoint(epoch.snapshot);
    else if (checkpointHasSummary && latestContextCheckpoint)
      execContext.restoreDurableCheckpoint(latestContextCheckpoint.snapshot);
    mark("checkpointRestore");
    const restoreEvents = epoch
      ? sessionStore.contextEventsAfter(sessionID, epoch)!
      : checkpointHasSummary && latestContextCheckpoint
        ? projection.replayableEvents.slice(checkpointIndex + 1)
        : projection.replayableEvents;
    const runtimeRestoreEvents = filterRuntimeRetainedEvents(
      restoreEvents,
      storeMode,
      Boolean(epoch),
    );
    contextLedgerFactory.restore(execContext, runtimeRestoreEvents);
    // No summary means no compaction rewrote the surface, so the replayed
    // events rebuild exactly the entries the durable checkpoint describes.
    // Restoring its usage anchor on top is what keeps the context ring and the
    // compaction budget on the provider's number after a restart instead of
    // the entry estimate — which against a large window reads as 0%.
    const durableUsageCheckpoint =
      latestContextCheckpoint?.type === "context.checkpoint"
        ? latestContextCheckpoint.snapshot.checkpoint
        : undefined;
    if (!epoch && !checkpointHasSummary && durableUsageCheckpoint) {
      const applied = execContext.restoreUsageCheckpoint(
        durableUsageCheckpoint,
      );
      logOf(ctx.state.serviceDirectory).warn(
        "context-restore",
        "ensureExecution",
        {
          sessionID,
          checkpointApplied: applied,
          checkpointTokens: durableUsageCheckpoint.tokens,
        },
      );
    }
    mark("restore");
    const fastPath = fastPathEnabled && Boolean(epoch);
    if (fastPath) {
      projection.replayableEvents = runtimeRestoreEvents;
      if (recovery) {
        projection.selectedAgent =
          recovery.selectedAgent ?? projection.selectedAgent;
        projection.selectedModel =
          recovery.selectedModel ?? projection.selectedModel;
        projection.reasoningEffort =
          recovery.reasoningEffort ?? projection.reasoningEffort;
        projection.chatModelProfile =
          recovery.chatModelProfile ?? projection.chatModelProfile;
        projection.permissionMode =
          recovery.permissionMode ?? projection.permissionMode;
        projection.permissionProfile =
          recovery.permissionProfile ?? projection.permissionProfile;
      }
      loaded.events = runtimeRestoreEvents;
    }
    logOf(ctx.state.serviceDirectory).warn(
      "context-restore",
      "ensureExecution",
      {
        sessionID,
        replayableEvents: projection.replayableEvents.length,
        restoreEvents: runtimeRestoreEvents.length,
        contextEntries: execContext.snapshot().entries.length,
        hasEpoch: epoch !== undefined,
        checkpointHasSummary,
        fastPath,
      },
    );
    // Snapshotted before the state is built so the restore path below can reuse
    // it for the resumed session rather than re-reading the clock.
    const sessionDate = today();
    const exec: SessionExecutionState = {
      session: loaded,
      context: execContext,
      // The session's date is snapshotted here, on the one path that builds the
      // state, so a later session-resume reuses the value its history was
      // recorded against rather than re-reading the clock.
      sessionStartedAt: sessionDate,
      currentDate: sessionDate,
      attachmentReferences: new Map(
        projection.replayableEvents.flatMap((event) =>
          event.type === "turn.submitted" && event.attachments?.length
            ? [[`${event.id}:user`, event.attachments] as const]
            : [],
        ),
      ),
      toolCalls: new Map(),
      provider:
        options.provider ??
        (getProviderSource() === "environment" ? getProvider() : undefined) ??
        (() => {
          const config = ctx.ports.getTsRuntimeConfig();
          return config?.defaultModel
            ? providerForModel(config, config.defaultModel, undefined, {
                // T3: the adapter's diagnostics ride the operation log.
                log: logOf(ctx.state.serviceDirectory),
              })
            : undefined;
        })(),
      runtimeContextConfig: getRuntimeContextConfig(),
      permissionMode:
        recovery?.permissionMode ??
        projection.permissionMode ??
        getDefaultPermissionMode(),
      permissionProfile: getDefaultPermissionProfile(),
      selectedAgent: projection.selectedAgent
        ? getAgentRegistry()?.select(projection.selectedAgent)
        : undefined,
      selectedModel: recovery?.selectedModel ?? projection.selectedModel,
      reasoningEffort: recovery?.reasoningEffort ?? projection.reasoningEffort,
      naviChatLedger: new ContextLedger(),
      niaChatLedger: new ContextLedger(),
      tokenMeter: new TokenMeter(),
      naviTokenMeter: new TokenMeter(),
      niaTokenMeter: new TokenMeter(),
      naviChatModelProfile: (
        recovery?.chatModelProfile ?? projection.chatModelProfile
      )?.navi,
      niaChatModelProfile: (
        recovery?.chatModelProfile ?? projection.chatModelProfile
      )?.nia,
      paused: false,
      pauseWaiters: [],
      injectedMailboxIDs: new Set(),
      // `projectSession` already computed every submitted id; reuse its two
      // sets instead of scanning the journal again.
      announcedTurnIDs: new Set([
        ...projection.activeTurnIDs,
        ...projection.completedTurnIDs,
      ]),
      naviPendingQueue: [],
      niaPendingQueue: [],
      naviAbortWakePending: false,
      niaAbortWakePending: false,
      eventCount: durableEventCount,
      nextSessionSeq: durableEventCount + 1,
      fullEventsLoaded: !fastPath,
    };
    executionBySession.set(sessionID, exec);
    pruneIdleSessionExecutions(ctx);
    applyAgentProvider(exec);
    mark("apply");
    // Prewarm the default latest-100 message page for any session we attach.
    // This overlaps with full-event background loading and makes the first
    // session.messages RPC a cache hit when the prewarm finishes first.
    void sessionStore.prewarmMessagePage(sessionID).catch((error) => {
      logOf(ctx.state.serviceDirectory).warn(
        "perf",
        `ensureExecution message-page prewarm failed session=${sessionID}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    // Never eagerly replace the window with the full durable log. A consumer
    // that genuinely needs the whole journal calls ensureSessionFullEvents(),
    // which remains the one explicit escape hatch. Keeping the fast path
    // windowed is what bounds long-session memory.
    try {
      sessionStore.ensureMessageIndex(sessionID);
    } catch {
      // Index rebuild is best-effort; the first messages RPC can retry.
    }
    ctx.ports.scheduleCollabSnapshot?.(exec);
    await refreshExecutionContextConfig(exec);
    mark("refresh");
    perfLog(
      `[perf] ensureExecution done session=${sessionID} events=${exec.session.events.length} fast=${fastPath} +${(performance.now() - start).toFixed(1)}ms`,
    );
    memoryTrace("execution.ensure.done", {
      sessionID,
      events: exec.session.events.length,
      eventCount: exec.eventCount,
      fastPath,
    });
    return exec;
  }
}

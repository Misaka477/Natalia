/**
 * Session attachment — runtime/session-attach.ts.
 *
 * `attachSession` switches which session the UI is attached to: it flushes and
 * ensures the target session's execution state, then rewires the activity
 * closures to that exec while a background turn of the previous session keeps
 * running. Reads and writes host state through `RuntimeContext` ports.
 */
import { contextStatusEvent, type TokenMeterMessage } from "@anthelia/runtime";
import {
  applyProjection,
  initProjection,
  restoreProjection,
  serializeProjectionState,
  type SessionUsageTotals,
} from "@anthelia/session";
import { RuntimeRefusal } from "@anthelia/contracts";
import {
  terminalController,
  type TerminalController,
} from "@anthelia/runtime-services";
import { sessionStoreController } from "@anthelia/session-store";
import { statusSnapshotController } from "@anthelia/runtime-status";
import type { SessionID } from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";
import {
  naviChatProviderMessagesFromHistory,
  niaChatProviderMessagesFromHistory,
} from "@natalia/collab";
import { perfLog } from "@anthelia/runtime-services";
import { logOf } from "@anthelia/operation-log";
import type { StatusSnapshotController } from "@anthelia/runtime-status";
import type { SessionStoreController } from "@anthelia/session-store";

export function createSessionAttach(ctx: RuntimeContext) {
  return {
    attachSession,
  };

  async function seedStreamContextSnapshots(
    exec: import("@anthelia/substrate").SessionExecutionState,
  ) {
    // Seed stream meters from the current session window. A consumer that
    // truly needs older snapshots must call the shared full-event escape hatch
    // explicitly; attach must not force a full journal load on every switch.
    const meter = exec.tokenMeter;
    type SnapshotRecord = {
      agentID?: string;
      usedTokens: number;
      pressureTokens?: number;
      projectedTokens?: number;
      contextWindow?: number;
      systemTokens?: number;
      toolsTokens?: number;
      messageTokens?: number;
      source: "estimate" | "provider_usage";
    };
    /** The stream-owned event type a stream publishes; `undefined` is the main lane. */
    const snapshotEventType = (stream: "navi" | "nia" | undefined) =>
      stream === "navi"
        ? "navi.context.snapshot"
        : stream === "nia"
          ? "nia.context.snapshot"
          : "context.snapshot";
    const latestSnapshot = (
      stream: "navi" | "nia" | undefined,
      agentID?: string,
    ): SnapshotRecord | undefined => {
      for (let index = exec.session.events.length - 1; index >= 0; index -= 1) {
        const event = exec.session.events[index];
        if (!event) continue;
        const streamMatches =
          stream === undefined
            ? event.type === "context.snapshot" &&
              (event as { channel?: string }).channel === undefined
            : event.type === snapshotEventType(stream) ||
              // Legacy journals wrote one shared event with a channel tag.
              (event.type === "context.snapshot" &&
                (event as { channel?: string }).channel === stream);
        if (
          streamMatches &&
          "usedTokens" in event &&
          "source" in event &&
          (event as { agentID?: string }).agentID === agentID
        )
          return event as SnapshotRecord;
      }
      return undefined;
    };
    const publishSnapshot = (
      stream: "navi" | "nia" | undefined,
      data: {
        agentID?: string;
        usedTokens: number;
        pressureTokens?: number;
        projectedTokens?: number;
        contextWindow?: number;
        systemTokens?: number;
        toolsTokens?: number;
        messageTokens?: number;
        source: "estimate" | "provider_usage";
      },
    ) => {
      const at = new Date().toISOString();
      ctx.ports.publishForSession(exec, {
        type: snapshotEventType(stream),
        ...data,
        at,
      });
    };
    const publishExistingSnapshot = (
      stream: "navi" | "nia" | undefined,
      snapshot: SnapshotRecord,
    ) =>
      publishSnapshot(stream, {
        ...(snapshot.agentID ? { agentID: snapshot.agentID } : {}),
        usedTokens: snapshot.usedTokens,
        ...(snapshot.pressureTokens === undefined
          ? {}
          : { pressureTokens: snapshot.pressureTokens }),
        ...(snapshot.projectedTokens === undefined
          ? {}
          : { projectedTokens: snapshot.projectedTokens }),
        ...(snapshot.contextWindow === undefined
          ? {}
          : { contextWindow: snapshot.contextWindow }),
        ...(snapshot.systemTokens === undefined
          ? {}
          : { systemTokens: snapshot.systemTokens }),
        ...(snapshot.toolsTokens === undefined
          ? {}
          : { toolsTokens: snapshot.toolsTokens }),
        ...(snapshot.messageTokens === undefined
          ? {}
          : { messageTokens: snapshot.messageTokens }),
        source: snapshot.source,
      });
    /**
     * One stream's meter surface, named by its own event type rather than a
     * shared channel identity: both streams run the identical publish path,
     * each publishing its snapshot to its own event (three-stream P1 — no
     * `for (const channel of ["navi", "nia"])` fork in attach).
     */
    const seedStream = async (stream: "navi" | "nia") => {
      const existing = latestSnapshot(stream);
      // Attach no longer replays the full durable log, so an existing durable
      // snapshot must be re-published to the live sink or the UI would never
      // see it after a restart. Republish it verbatim instead of inventing a
      // fresh estimate; if it lacks a context window the meter cannot render,
      // so fall through and compute a usable one below.
      if (existing && (existing.contextWindow ?? 0) > 0) {
        publishExistingSnapshot(stream, existing);
        return;
      }
      const messages =
        stream === "navi"
          ? naviChatProviderMessagesFromHistory(exec)
          : niaChatProviderMessagesFromHistory(exec);
      if (!messages.length) return;
      const streamMeter =
        stream === "navi" ? exec.naviTokenMeter : exec.niaTokenMeter;
      const profile =
        stream === "navi"
          ? exec.naviChatModelProfile?.normal
          : exec.niaChatModelProfile?.normal;
      const config = ctx.ports.getTsRuntimeConfig();
      let contextWindow = exec.runtimeContextConfig.max;
      if (config && exec.provider) {
        try {
          const budget = await ctx.ports.resolveContextStatusConfig(
            config,
            exec.provider,
            ctx.ports.getContextWindowResolver(),
            ctx.ports.modelRefKeyForSelection(undefined, profile),
          );
          contextWindow = budget.max;
        } catch {
          contextWindow = exec.runtimeContextConfig.max;
        }
      }
      streamMeter.measureRequest("stream", {
        tools: undefined,
        messages,
        contextWindow,
      });
      const projection = streamMeter.project("stream");
      publishSnapshot(stream, {
        usedTokens:
          projection.projectedTokens ??
          projection.pressureTokens ??
          streamMeter.estimateMessages(messages),
        ...(projection.pressureTokens === undefined
          ? {}
          : { pressureTokens: projection.pressureTokens }),
        ...(projection.projectedTokens === undefined
          ? {}
          : { projectedTokens: projection.projectedTokens }),
        contextWindow,
        source: projection.source,
      });
    };
    await seedStream("navi");
    await seedStream("nia");

    const byAgent = new Map<string, TokenMeterMessage[]>();
    for (const event of exec.session.events) {
      if (!event.agentID) continue;
      const messages = byAgent.get(event.agentID) ?? [];
      byAgent.set(event.agentID, messages);
      if (
        (event.type === "content.done" || event.type === "thinking.done") &&
        event.text
      ) {
        messages.push({ role: "assistant", content: event.text });
      } else if (event.type === "tool.update") {
        messages.push({
          role: "assistant",
          content: [
            event.name,
            event.summary,
            event.argumentsDelta ?? "",
            event.result ?? "",
          ]
            .filter(Boolean)
            .join("\n"),
        });
      }
    }
    for (const [agentID, messages] of byAgent) {
      // Subagents publish to the main lane's event, distinguished by agentID —
      // never by a stream channel.
      const existing = latestSnapshot(undefined, agentID);
      if (existing && (existing.contextWindow ?? 0) > 0) {
        publishExistingSnapshot(undefined, existing);
        continue;
      }
      if (!messages.length) continue;
      const scope = `subagent:${agentID}`;
      meter.observeSurface(scope, messages);
      meter.measureRequest(scope, {
        messages,
        contextWindow: exec.runtimeContextConfig.max,
      });
      const projection = meter.project(scope);
      publishSnapshot(undefined, {
        agentID,
        usedTokens:
          projection.projectedTokens ??
          projection.pressureTokens ??
          meter.estimateMessages(messages),
        ...(projection.pressureTokens === undefined
          ? {}
          : { pressureTokens: projection.pressureTokens }),
        ...(projection.projectedTokens === undefined
          ? {}
          : { projectedTokens: projection.projectedTokens }),
        contextWindow: exec.runtimeContextConfig.max,
        source: projection.source,
      });
    }
  }

  /**
   * The session's whole-log usage, from the durable projection.
   *
   * Cold-read ladder, cheapest first: a usable checkpoint replays only its
   * tail. A checkpoint written by an older fold version (or none at all) is
   * discarded by the store, and the fallback would then fold `exec.session` —
   * which the fast path truncates to the post-epoch tail, i.e. nothing. So
   * when the restored projection carries no events, fold the durable log from
   * the store instead and rewrite the checkpoint: a one-time migration that
   * leaves every later attach paying only the tail.
   */
  /** Reader shape `restoreProjection` needs when no store is wired. */
  const emptyProjectionStore = {
    loadProjectionCheckpoint: () => undefined,
    eventsAfter: () => [],
  };

  function usageSnapshotFor(
    id: SessionID,
    session: import("@anthelia/substrate").SessionExecutionState["session"],
  ): SessionUsageTotals {
    const store = ctx.state.serviceDirectory.getOptional(
      sessionStoreController,
    );
    if (!store)
      return restoreProjection(id, session, emptyProjectionStore).usage;
    // A JSON store has no checkpoint table; its exec surface is the full log,
    // so the projection's own fallback already folds it correctly. Only the
    // sqlite case needs the store-log fold below — and there the checkpoint's
    // presence is the usable signal, because the store itself discards a row
    // written by an older fold version. (Checking the restored projection for
    // emptiness does NOT work: an indexed-recovery exec surface carries the
    // runtime's bootstrap events, so it is never empty while holding none of
    // the session's turns — and folding it yields zeros.)
    if (store.status().mode !== "sqlite" || store.loadProjectionCheckpoint(id))
      return restoreProjection(id, session, store).usage;
    // Fold the durable log from the store and rewrite the checkpoint: a
    // one-time migration, after which every attach replays only the tail.
    const state = initProjection();
    for (const event of store.eventsAfter(id, 0)) applyProjection(state, event);
    store.saveProjectionCheckpoint(id, serializeProjectionState(state));
    return state.usage;
  }

  async function attachSession(id: string) {
    const start = performance.now();
    const mark = (name: string) =>
      perfLog(
        `[perf] attachSession.${name} target=${id} +${(performance.now() - start).toFixed(1)}ms`,
      );
    perfLog(`[perf] attachSession start target=${id}`);
    const {
      getReady,
      getSessionID,
      setSessionID,
      setSession,
      setRuntimeContext,
      setActiveExec,
      setAttachmentReferences,
      setToolCalls,
      getSessionPersistence,
      ensureExecution,
      setLastSubmitted,
      setActiveAbort,
      setActiveTurnID,
      setPaused,
      setPauseWaiters,
      setActiveSkill,
      setSelectedAgent,
      setSelectedModel,
      setPendingAgent,
      setLastProviderUsage,
      clearRuntimeDiagnostics,
      getRuntimeDiagnosticsBySession,
      setPermissionMode,
      setSelectedPermissionProfile,
      setProvider,
      getProvider,
      applyAgentPolicy,
      applyAgentProvider,
      initializeCheckpointController,
      publishForSession,
      syncGoalStatus,
    } = ctx.ports;
    await getReady();
    mark("ready");
    // D2: a running turn is no longer a reason to refuse. The turn belongs to
    // its own session's exec and keeps running in the background; attach only
    // switches which session the UI is attached to.
    const sessionStore = ctx.state.serviceDirectory.getOptional(
      sessionStoreController,
    );
    if (!sessionStore)
      throw new Error("session store unavailable (natalia-session-store)");
    const terminal = ctx.state.serviceDirectory.getOptional(terminalController);
    const status = ctx.state.serviceDirectory.get(statusSnapshotController);
    const sessionID = getSessionID();
    const nextID = id as SessionID;
    if (nextID === sessionID) {
      // Startup restores the runtime's already-selected session by attaching to
      // the same id. Do not skip context seeding just because the id is already
      // active: legacy journals have no stream context snapshots yet, and the
      // UI mounts after the runtime was initialized with this session.
      let exec: import("@anthelia/substrate").SessionExecutionState;
      const activeExec = ctx.ports.getActiveExec();
      if (activeExec?.session.id === nextID) {
        exec = activeExec;
      } else {
        exec = await ensureExecution(nextID);
        if (exec.session.metadata?.archived)
          throw new RuntimeRefusal("cannot attach an archived session");
      }
      void seedStreamContextSnapshots(exec).catch(() => undefined);
      // A same-session startup attach skips `ensureExecution`, so the durable
      // goal is never replayed here; re-seed the live projection explicitly or
      // the status bar stays empty until the next goal mutation.
      await syncGoalStatus?.(nextID).catch(() => undefined);
      // The ring's only data source: `context.status` carries no `id`, so it
      // never enters the message-page projection and a replayed journal never
      // carries it. A UI that attaches to the already-active session mounts
      // after initialization published its status, so republish it here or the
      // meter stays empty until the next provider step — which is exactly the
      // "ring reads 0% after a restart" the UI reports.
      publishForSession(
        exec,
        contextStatusEvent(exec.context.status(exec.runtimeContextConfig)),
      );
      // Same cold-read ladder as the full path below (checkpoint + tail), so
      // the usage snapshot costs a tail fold rather than a history load.
      const usageChannels = usageSnapshotFor(nextID, exec.session);
      logOf(ctx.state.serviceDirectory).warn("usage-snapshot", "attach", {
        sessionID: nextID,
        steps: usageChannels.main.steps,
        turns: usageChannels.main.turns,
        inputTokens: usageChannels.main.inputTokens,
      });
      publishForSession(exec, {
        type: "session.usage",
        channels: usageChannels,
      });
      perfLog(
        `[perf] attachSession same target=${id} +${(performance.now() - start).toFixed(1)}ms`,
      );
      return { sessionID: nextID };
    }

    // A replacement runtime can open the old session as soon as attach returns.
    await getSessionPersistence();
    await sessionStore.flush(sessionID);
    mark("flush");
    // D2: the attached session becomes the activity exec. Its ledger is its
    // own — restoring into the shared one would clobber the previous session's
    // ledger, which a background turn may still be writing to.
    const exec = await ensureExecution(nextID);
    mark("ensureExecution");
    if (exec.session.metadata?.archived)
      throw new RuntimeRefusal("cannot attach an archived session");
    setSessionID(nextID);
    setSession(exec.session);
    setRuntimeContext(exec.context);
    setActiveExec(exec);
    setAttachmentReferences(exec.attachmentReferences);
    setToolCalls(exec.toolCalls);
    terminal?.setActiveSession(nextID);
    setLastSubmitted(exec.lastSubmitted);
    setActiveAbort(exec.activeAbort);
    setActiveTurnID(exec.activeTurnID);
    setPaused(exec.paused);
    setPauseWaiters(exec.pauseWaiters);
    setActiveSkill(undefined);
    setSelectedAgent(undefined);
    setSelectedModel(undefined);
    setPendingAgent(undefined);
    setLastProviderUsage(undefined);
    clearRuntimeDiagnostics();
    applyAgentPolicy();
    applyAgentProvider(exec);

    // Cold-read ladder: prefer a persisted projection checkpoint replayed
    // over the durable tail, and fail soft to a full projection when no
    // usable checkpoint exists.
    const projection = restoreProjection(
      exec.session.id,
      exec.session,
      sessionStore,
    );
    const diagnostics =
      getRuntimeDiagnosticsBySession().get(exec.session.id) ?? [];
    for (const event of projection.replayableEvents) {
      if (event.type === "diagnostic")
        diagnostics.push({
          ...event,
          at: event.at ?? exec.session.createdAt,
        });
    }
    getRuntimeDiagnosticsBySession().set(exec.session.id, diagnostics);
    mark("projection");
    // The exec already restored its own ledger, agent and model selection
    // (`ensureExecution`); here the activity closures take the same values so
    // UI reads and the next attach start from them.
    setSelectedAgent(exec.selectedAgent);
    setSelectedModel(exec.selectedModel);
    setActiveSkill(exec.activeSkill);
    setPermissionMode(exec.permissionMode);
    setSelectedPermissionProfile(exec.permissionProfile);
    setProvider(exec.provider ?? getProvider());
    if (exec.selectedAgent) {
      applyAgentPolicy();
      applyAgentProvider(exec);
    } else if (exec.selectedModel) {
      applyAgentProvider(exec);
    }
    mark("apply");
    // Re-seed the goal status for the session we just switched to; its exec may
    // already have existed (ensureExecution returns the cache) or its journal
    // tail may not carry the durable goal.
    await syncGoalStatus?.(nextID).catch(() => undefined);
    // Checkpoint store initialization scans the workspace and may write a
    // baseline; it must not block the first visible attach. Let it run in the
    // background; checkpoint operations lazy-init again when actually needed.
    void initializeCheckpointController(exec).catch((error) => {
      publishForSession(exec, {
        type: "diagnostic",
        level: "warning",
        message: `checkpoint controller init deferred/failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
    mark("checkpoint");
    publishForSession(exec, {
      type: "session.ready",
      sessionID: exec.session.id,
    });
    mark("ready");
    publishForSession(
      exec,
      contextStatusEvent(exec.context.status(exec.runtimeContextConfig)),
    );
    // The usage bar's static value: the projection's whole-session totals,
    // accumulated per event and resumed from the durable checkpoint above —
    // not a page fold, so paging, compaction and the fast path's truncated
    // exec surface cannot change them. Live step_usage events keep adding.
    publishForSession(exec, {
      type: "session.usage",
      channels: usageSnapshotFor(exec.session.id, exec.session),
    });
    void seedStreamContextSnapshots(exec).catch(() => undefined);
    mark("context");
    publishForSession(
      exec,
      await status.snapshotFor({
        provider: exec.provider,
        context: exec.context,
        permissionMode: exec.permissionMode,
      }),
    );
    mark("status");
    perfLog(
      `[perf] attachSession done target=${id} events=${exec.session.events.length} +${(performance.now() - start).toFixed(1)}ms`,
    );
    return { sessionID: exec.session.id };
  }
}

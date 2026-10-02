/**
 * Event publishing choke point — runtime/event-sink module.
 *
 * `publish` and `publishForSession` are the single writers of the runtime event
 * stream: they stamp episode/session ids, bucket diagnostics, track live output
 * and active tools, dispatch to plugins, push to the sink, persist durable
 * events, and trigger session snapshots and safe-boundary settlement. Reads
 * everything it needs from `RuntimeContext` at call time.
 */
import { rinaVault } from "@anthelia/rina";
import {
  appendSessionEvent,
  projectedNiaChatMessages,
} from "@anthelia/session";
import {
  markRuntimeEventSessionSeq,
  runtimeEventDurability,
} from "@anthelia/contracts";
import {
  createCollabSnapshotScheduler,
  isCollabSnapshotRelevantEvent,
} from "@natalia/collab";
import { activePlanForExec } from "@natalia/collab";
import { createGoalRuntime } from "@natalia/goal-runtime";
import type { SessionStoreController } from "@anthelia/session-store";
import { sessionStoreController as sessionStoreControllerToken } from "@anthelia/session-store";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { feedSessionEventWindow } from "@anthelia/substrate";
import { feedSessionFactState } from "@anthelia/substrate";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";
import { perfLog } from "@anthelia/runtime-services";
import { logOf } from "@anthelia/operation-log";

type RuntimeDiagnostic = Extract<RuntimeEvent, { type: "diagnostic" }> & {
  at: string;
};

const INFRASTRUCTURE_ERROR_KINDS = new Set([
  "timeout",
  "connection",
  "rate_limit",
  "server",
  "auth",
  "invalid_request",
  "empty_response",
  "context_limit",
  "quota",
  "unknown",
  "cancel",
]);

export function mainTurnHasInfrastructureError(
  exec: SessionExecutionState,
  turnID: string,
): boolean {
  const events = exec.session.events;
  const start = events.findIndex(
    (event) => event.type === "turn.submitted" && event.id === turnID,
  );
  const end = events.findIndex(
    (event) => event.type === "turn.finished" && event.id === turnID,
  );
  if (start < 0 || end < 0 || end <= start) return false;
  return events
    .slice(start, end)
    .some(
      (event) =>
        event.type === "step.retry.exhausted" &&
        (event.id === turnID || event.id.startsWith(`${turnID}:`)) &&
        INFRASTRUCTURE_ERROR_KINDS.has(event.reason),
    );
}

export function createEventSink(
  ctx: RuntimeContext,
  options: RealRuntimeClientOptions,
) {
  const collabSnapshotScheduler = createCollabSnapshotScheduler(ctx);
  ctx.ports.scheduleCollabSnapshot = collabSnapshotScheduler.schedule;
  const goalRuntime = createGoalRuntime(ctx);
  // The goal tools ride in the main tool registry alongside the other framework
  // tools (sandbox, subagents, collaboration).
  for (const tool of goalRuntime.tools) {
    if (ctx.state.tools.get(tool.name))
      throw new Error(`framework tool already registered: ${tool.name}`);
    ctx.state.tools.set(tool.name, tool);
  }
  ctx.ports.goalControl = (action, sessionID) => {
    const id = sessionID ?? ctx.ports.getSessionID();
    if (!id)
      return Promise.resolve({
        ok: false,
        action,
        message: "no active session",
      });
    return goalRuntime.control(action, id);
  };
  ctx.ports.goalEdit = (input, sessionID) => {
    const id = sessionID ?? ctx.ports.getSessionID();
    if (!id)
      return Promise.resolve({
        ok: false,
        action: "edit",
        message: "no active session",
      });
    return goalRuntime.edit(input, id);
  };
  ctx.ports.syncGoalStatus = (sessionID) => goalRuntime.refresh(sessionID);

  // `content.delta` is live-only: one durable event per provider chunk would
  // bloat the journal. Coalesce the deltas into throttled durable
  // `content.partial` batches instead, so an abrupt death keeps the text that
  // was already generated. The batches concatenate to the step's final text.
  const PARTIAL_FLUSH_MS = Math.max(
    100,
    Number(process.env.NATALIA_PARTIAL_FLUSH_MS ?? 1_000),
  );
  const PARTIAL_FLUSH_CHARS = Math.max(
    256,
    Number(process.env.NATALIA_PARTIAL_FLUSH_CHARS ?? 4_000),
  );
  const pendingPartialByTurn = new Map<
    string,
    {
      exec: SessionExecutionState;
      text: string;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  function flushPartial(turnID: string): void {
    const pending = pendingPartialByTurn.get(turnID);
    if (!pending) return;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    const text = pending.text;
    pending.text = "";
    const { exec } = pending;
    if (!text || !exec.session) return;
    const partial: RuntimeEvent = {
      type: "content.partial",
      id: turnID,
      text,
      at: new Date().toISOString(),
    };
    const partialSeq = exec.nextSessionSeq++;
    markRuntimeEventSessionSeq(partial, partialSeq);
    feedSessionEventWindow(exec, partialSeq, partial);
    appendSessionEvent(exec.session, partial);
    feedSessionFactState(exec, partial);
    const sessionStoreController = ctx.state.serviceDirectory.getOptional(
      sessionStoreControllerToken,
    );
    if (!sessionStoreController) return;
    // Partials are durable events like any other and must go through the same
    // per-session persistence chain. Writing them directly let a timer-flushed
    // partial jump ahead of a previously published `thinking.done`, so replay
    // rendered the answer before its reasoning.
    const sessionPersistence = ctx.ports.getSessionPersistenceForSession(
      exec.session.id,
    );
    const next = sessionPersistence
      .then(() => {
        if (sessionStoreController.status().initialized)
          return sessionStoreController.appendEvent(
            { ...exec.session },
            partial,
          );
      })
      .catch((error) => {
        ctx.ports.getSink()?.({
          type: "diagnostic",
          level: "warning",
          message: `partial persistence deferred/failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });
    ctx.ports.setSessionPersistenceForSession(exec.session.id, next);
    ctx.ports.setSessionPersistence(
      Promise.allSettled([ctx.ports.getSessionPersistence(), next]).then(
        () => undefined,
      ),
    );
  }

  function schedulePartialFlush(exec: SessionExecutionState, turnID: string) {
    const pending = pendingPartialByTurn.get(turnID) ?? {
      exec,
      text: "",
    };
    pending.exec = exec;
    pendingPartialByTurn.set(turnID, pending);
    if (pending.text.length >= PARTIAL_FLUSH_CHARS) {
      flushPartial(turnID);
      return;
    }
    pending.timer ??= setTimeout(() => {
      const current = pendingPartialByTurn.get(turnID);
      if (current) current.timer = undefined;
      flushPartial(turnID);
    }, PARTIAL_FLUSH_MS);
    pending.timer.unref?.();
  }

  // Release any in-flight stream buffer before the store closes, so a graceful
  // shutdown keeps the last <1s of generated text too.
  ctx.ports.flushPendingPartialOutput = () => {
    for (const turnID of [...pendingPartialByTurn.keys()]) flushPartial(turnID);
  };

  const CONTEXT_EPOCH_WRITE_EVERY = 100;
  const CONTEXT_EPOCH_WRITE_INTERVAL_MS = 5_000;
  const contextEpochDirty = new Map<
    SessionID,
    { pending: number; timer?: ReturnType<typeof setTimeout> }
  >();

  async function writeContextEpoch(
    exec: SessionExecutionState,
    trigger: "boundary" | "count" | "interval",
  ) {
    const sessionStore = ctx.state.serviceDirectory.getOptional(
      sessionStoreControllerToken,
    );
    if (!sessionStore || !exec.context) return;
    try {
      // Flush queued appends before taking the checkpoint. The epoch baseline
      // is the current max journal seq, so snapshot and baseline must observe
      // the same persisted prefix.
      await sessionStore.flush(exec.session.id).catch(() => undefined);
      const step = exec.context.journalStatus().messageCount;
      const snapshot = exec.context.durableCheckpoint(step);
      sessionStore.writeContextEpoch(exec.session.id, snapshot);
      perfLog(
        `[perf] contextEpoch.write session=${exec.session.id} trigger=${trigger} step=${step} +0ms`,
      );
    } catch (error) {
      // A failed context epoch must never break event publishing.
      const message = error instanceof Error ? error.message : String(error);
      ctx.ports.publish?.({
        type: "diagnostic",
        level: "warning",
        message: `context epoch write failed: ${message}`,
      });
    }
  }

  function scheduleContextEpochWrite(
    exec: SessionExecutionState,
    event: RuntimeEvent,
  ) {
    const sessionID = exec.session.id;
    const dirty = contextEpochDirty.get(sessionID) ?? {
      pending: 0,
      timer: undefined,
    };
    contextEpochDirty.set(sessionID, dirty);
    if (
      event.type === "turn.finished" ||
      event.type === "turn.cancelled" ||
      event.type === "session.ready"
    ) {
      dirty.pending = 0;
      if (dirty.timer) {
        clearTimeout(dirty.timer);
        dirty.timer = undefined;
      }
      void writeContextEpoch(exec, "boundary");
      return;
    }
    dirty.pending += 1;
    if (dirty.pending >= CONTEXT_EPOCH_WRITE_EVERY) {
      dirty.pending = 0;
      if (dirty.timer) {
        clearTimeout(dirty.timer);
        dirty.timer = undefined;
      }
      void writeContextEpoch(exec, "count");
      return;
    }
    dirty.timer ??= setTimeout(() => {
      dirty.timer = undefined;
      const current = ctx.ports.getExecutionBySession().get(sessionID);
      if (!current) return;
      if (dirty.pending > 0) {
        dirty.pending = 0;
        void writeContextEpoch(current, "interval");
      }
    }, CONTEXT_EPOCH_WRITE_INTERVAL_MS);
  }

  return {
    publish,
    publishForSession,
  };

  function publish(event: RuntimeEvent) {
    publishForSession(ctx.ports.getActiveExec(), event);
  }

  function publishForSession(
    exec: SessionExecutionState | undefined,
    event: RuntimeEvent,
  ) {
    const {
      getSink,
      getSessionPersistence,
      setSessionPersistence,
      setPendingHumanTerminal,
      maybeContinueAfterHumanInput,
      settleMailboxAtBoundary,
      reconcileWorkspaceObservation,
      toolEventTurnID,
      isSessionSnapshotTrigger,
      publishSessionSnapshot,
      getPluginsController,
    } = ctx.ports;
    const {
      runtimeDiagnosticsBySession,
      runtimeDiagnostics,
      liveMainOutputByTurn,
      turnSession,
      activeToolByTurn,
      performanceTrace,
    } = ctx.state;
    const sink = getSink();
    const publishStartedAt = performance.now();
    if (options.episodeID && !event.episodeID)
      event = { ...event, episodeID: options.episodeID };
    // D6: while a session is active every event belongs to it. Events that
    // already carry a session id keep their own; events published before the
    // session exists are runtime-level and reach every subscriber. The stamp
    // follows the exec the event is published for — a background turn stamps
    // its own session even when the UI is attached to another.
    if (exec?.session && event.sessionID === undefined)
      event = { ...event, sessionID: exec.session.id };
    if (event.type === "diagnostic")
      event = { ...event, at: event.at ?? new Date().toISOString() };
    if (event.type === "diagnostic") {
      const diagnostic = {
        ...event,
        at: event.at ?? new Date().toISOString(),
      } as RuntimeDiagnostic;
      const bucketID = exec?.session.id ?? event.sessionID;
      if (bucketID) {
        const bucket = runtimeDiagnosticsBySession.get(bucketID) ?? [];
        bucket.push(diagnostic);
        if (bucket.length > 500) bucket.splice(0, 1);
        runtimeDiagnosticsBySession.set(bucketID, bucket);
      } else {
        runtimeDiagnostics.push(diagnostic);
        if (runtimeDiagnostics.length > 500) runtimeDiagnostics.splice(0, 1);
      }
    }
    if (!event.agentID && event.type === "content.delta") {
      const current = liveMainOutputByTurn.get(event.id) ?? "";
      liveMainOutputByTurn.set(
        event.id,
        `${current}${event.text}`.slice(-8000),
      );
      if (exec?.session && event.text) {
        const pending = pendingPartialByTurn.get(event.id) ?? {
          exec,
          text: "",
        };
        pending.text += event.text;
        pendingPartialByTurn.set(event.id, pending);
        schedulePartialFlush(exec, event.id);
      }
    }
    // The durable partial batches must cover the step's full text before the
    // final `content.done` lands, or replay would render a truncated answer.
    if (!event.agentID && event.type === "content.done") flushPartial(event.id);
    // TERM-M.3 (c): a turn that ended as waiting_human persists the typed
    // pending-human state and clears the turn-level marker.
    if (
      !event.agentID &&
      event.type === "turn.finished" &&
      event.stopReason === "waiting_human"
    ) {
      const pending = exec?.endTurnWaitingHuman;
      if (exec) exec.endTurnWaitingHuman = undefined;
      turnSession.delete(event.id);
      if (pending && exec?.session)
        void setPendingHumanTerminal(exec.session.id, pending);
    } else if (!event.agentID && event.type === "turn.finished") {
      // Any other settlement discards a stale marker: a request_human call
      // from a turn that later failed must not bleed into the next turn.
      if (exec) exec.endTurnWaitingHuman = undefined;
      turnSession.delete(event.id);
    }
    // Goal round driver: classify a finished goal round, then continue an
    // active, armed goal on the next idle edge (human work always outranks it).
    if (!event.agentID && event.type === "turn.finished" && exec?.session)
      goalRuntime.onTurnFinished(exec, event);
    // TERM-M.3 (c): when the human releases the requested pane, the runtime
    // starts the continuation turn automatically. Replay never passes through
    // publish, so a replayed detach cannot double-resume.
    if (
      !event.agentID &&
      event.type === "terminal.timeline" &&
      event.actor === "user" &&
      event.action === "detach"
    )
      void maybeContinueAfterHumanInput(
        event.id,
        exec?.session.id ?? event.sessionID,
      );
    if (
      exec?.session &&
      !event.agentID &&
      event.type !== "session.created" &&
      event.type !== "session.ready"
    ) {
      const sessionStoreController = ctx.state.serviceDirectory.get(
        sessionStoreControllerToken,
      );
      // SQLite already persists the latest context checkpoint in
      // `context_epochs`. Persisting the full checkpoint again in the event
      // journal duplicates multi-MB snapshots and forces every full-session
      // clone to carry them. Keep the event live for the UI and rely on the
      // epoch row for recovery. JSON stores keep the durable event because
      // they have no epoch table.
      const sqliteContextCheckpoint =
        event.type === "context.checkpoint" &&
        sessionStoreController.status().mode === "sqlite";
      if (sqliteContextCheckpoint) {
        void writeContextEpoch(exec, "boundary");
      }
      if (
        !sqliteContextCheckpoint &&
        runtimeEventDurability(event) === "durable"
      ) {
        const sessionSeq = exec.nextSessionSeq++;
        markRuntimeEventSessionSeq(event, sessionSeq);
        feedSessionEventWindow(exec, sessionSeq, event);
        appendSessionEvent(exec.session, event);
        // RINA Phase1: the vault is a DERIVED index of the journal —
        // enqueue beside the append (the study's choke point). Only
        // CLASSIFIED event types ever become records: content.partial
        // and friends carry model/user bodies and are skipped by
        // construction (the study's never-store-bodies isolation).
        ctx.state.serviceDirectory.getOptional(rinaVault)?.enqueue(event);
        feedSessionFactState(exec, event);
        scheduleContextEpochWrite(exec, event);
        if (isCollabSnapshotRelevantEvent(event)) {
          collabSnapshotScheduler.schedule(exec);
        }
        if (!sessionStoreController.status().initialized) {
          return;
        }
        const sessionSnapshot = { ...exec.session };
        const sessionPersistence = ctx.ports.getSessionPersistenceForSession(
          exec.session.id,
        );
        const next = sessionPersistence
          .then(() => {
            if (sessionStoreController.status().initialized)
              return sessionStoreController.appendEvent(sessionSnapshot, event);
          })
          .catch((error) => {
            sink?.({
              type: "diagnostic",
              level: "warning",
              message: `session persistence deferred/failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          });
        ctx.ports.setSessionPersistenceForSession(exec.session.id, next);
        setSessionPersistence(
          Promise.allSettled([getSessionPersistence(), next]).then(
            () => undefined,
          ),
        );
      }
    }
    const pluginStartedAt = performance.now();
    if (!event.agentID) getPluginsController().dispatch(event);
    const pluginMs = performance.now() - pluginStartedAt;
    const sinkStartedAt = performance.now();
    sink?.(event);
    const sinkMs = performance.now() - sinkStartedAt;
    performanceTrace.record(event, {
      publishMs: performance.now() - publishStartedAt,
      pluginMs,
      sinkMs,
    });
    // P8 C1 writer: keep the live work-state tracking current and publish a
    // session intelligence snapshot at work-state boundaries. `session.snapshot`
    // is not a trigger, so the snapshot's own publish cannot recurse here.
    if (!event.agentID && event.type === "tool.update") {
      const turnID = toolEventTurnID(event);
      if (event.status === "running") activeToolByTurn.set(turnID, event.name);
      else if (
        ["succeeded", "failed", "rejected", "cancelled"].includes(event.status)
      )
        activeToolByTurn.delete(turnID);
    }
    if (!event.agentID && isSessionSnapshotTrigger(event))
      publishSessionSnapshot(exec);
    if (
      !event.agentID &&
      (event.type === "turn.finished" || event.type === "turn.cancelled")
    ) {
      flushPartial(event.id);
      pendingPartialByTurn.delete(event.id);
      liveMainOutputByTurn.delete(event.id);
    }
    // P8 C3 safe-boundary scheduler: a finished turn is a safe point (§5.2 —
    // "step complete"). Deliver every queued mailbox message so the main agent
    // sees user intents at the boundary, never mid-token. `mailbox.delivered`
    // is not a trigger, so this cannot recurse. Only a turn that finished on
    // purpose is a settlement: a cancelled/aborted/error turn did not complete
    // its context, so its delivered intents stay delivered for another chance.
    if (
      !event.agentID &&
      event.type === "turn.finished" &&
      exec?.session &&
      event.stopReason === "error"
    ) {
      // Automatic Navi wake on main-turn errors is intentionally removed:
      // only a model-issued collaboration tool call may wake Navi.
      logOf(ctx.state.serviceDirectory).info(
        "navi-wake-trigger",
        "automatic wake removed",
        {
          turnID: event.id,
          reason: event.reason ?? "unknown",
        },
      );
    }
    if (
      !event.agentID &&
      event.type === "nia.chat.turn.finished" &&
      event.stopReason === "done" &&
      exec?.session
    ) {
      const niaMessages = projectedNiaChatMessages(exec.session.events).filter(
        (message) => message.kind === "message",
      );
      const last = niaMessages[niaMessages.length - 1];
      const niaAuditWake = exec.session.events.some(
        (candidate) =>
          candidate.type === "nia.chat.turn.started" &&
          candidate.messageID === event.messageID &&
          candidate.internal === true,
      );
      const auditReported = exec.session.events.some(
        (candidate) =>
          candidate.type === "nia.chat.tool.used" &&
          candidate.messageID === event.messageID &&
          candidate.toolName === "audit_report",
      );
      const niaCollabSent = exec.session.events.some(
        (candidate) =>
          candidate.type === "nia.chat.tool.used" &&
          candidate.messageID === event.messageID &&
          candidate.toolName === "collab_chat",
      );
      const auditReportEvent = exec.session.events.find(
        (
          candidate,
        ): candidate is Extract<RuntimeEvent, { type: "nia.chat.tool.used" }> =>
          candidate.type === "nia.chat.tool.used" &&
          candidate.messageID === event.messageID &&
          candidate.toolName === "audit_report",
      );
      let auditSummary = last?.text ?? "";
      let auditVerdict: string | undefined;
      if (auditReportEvent?.argumentsRaw) {
        try {
          const args = JSON.parse(auditReportEvent.argumentsRaw) as {
            verdict?: string;
            gaps?: string[];
          };
          auditVerdict = args.verdict;
          if (Array.isArray(args.gaps) && args.gaps.length) {
            auditSummary += `\n\nGap list from audit_report:\n${args.gaps
              .map((gap, index) => `${index + 1}. ${gap}`)
              .join("\n")}`;
          }
        } catch {
          // Keep the natural-language fallback if arguments are not JSON.
        }
      }
      const auditPassed = auditVerdict === "passed";
      // Nia's audit wake usually goes through collab_chat or audit_report.
      // Forward when audit_report was used, even for a manually started Nia
      // audit, because that report has already changed the plan lifecycle.
      // Once the plan is passed there is nothing left to remediate, so do not
      // wake Natalia again. Only skip when Nia actively used collab_chat, so
      // the formal audit message is not duplicated.
      const shouldForwardAudit =
        (niaAuditWake || auditReported) && !auditPassed;
      logOf(ctx.state.serviceDirectory).info("nia-audit-tail", "", {
        messageID: event.messageID,
        niaAuditWake,
        auditReported,
        auditVerdict,
        auditPassed,
        niaCollabSent,
        shouldForwardAudit,
        forwarded: Boolean(last && shouldForwardAudit && !niaCollabSent),
        lastText: last?.text.slice(0, 120),
      });
      if (last && shouldForwardAudit && !niaCollabSent) {
        const wakeID = `turn_nia_${event.messageID.replace(/[^a-zA-Z0-9]/gu, "_")}`;
        logOf(ctx.state.serviceDirectory).info(
          "nia-audit-forward",
          "scheduling main wake from audit tail",
          {
            sessionID: exec.session.id,
            wakeID,
            responseMessageID: event.messageID,
            auditSummary: auditSummary.slice(0, 180),
          },
        );
        ctx.ports.scheduleInternalWake(exec, {
          id: wakeID,
          text: `(internal Nia audit result: ${auditSummary}. This is internal context for you and the user. Do not forward it to Navi; act on the findings directly.)`,
          delivery: "next-turn",
        });
      }
      // If Nia did not call audit_report, fall back to known audit phrasing so
      // the plan lifecycle still closes even when the model forgets the tool.
      if (last && niaAuditWake && !auditReported) {
        const auditDone =
          /全部完成|全部通过|没有缺口|已完成|no gaps|all done/iu.test(
            last.text,
          );
        const active = activePlanForExec(ctx, exec);
        if (active && active.status !== "completed") {
          void ctx.ports.planDocRuntime.planDocUpdateStatus({
            planID: active.planID,
            status: auditDone ? "completed" : "audit_gaps",
            sessionID: exec.session.id,
          });
        }
      }
    }
    if (
      !event.agentID &&
      event.type === "turn.finished" &&
      event.stopReason === "done"
    ) {
      // P8 C3 safe-boundary scheduler: a finished turn is a safe point (§5.2 —
      // "step complete"). Delivery is consumption-driven, not model-discipline-
      // driven: messages delivered at the previous boundary were injected into
      // this turn's context, so a normal turn finish acknowledges them (they no
      // longer re-inject); messages still queued are delivered for the next
      // turn. The order matters — acknowledge the already-delivered batch before
      // delivering the queued batch, so a fresh delivery is not mis-acked.
      settleMailboxAtBoundary(exec);
      // Nia is no longer woken automatically on every finished turn. The old
      // runtime-owned promotion to `awaiting_audit` started an audit round after
      // each Natalia turn even when the model had not asked for one, which made
      // the audit agent double as a "keep going" mechanism. The model now asks
      // for an audit explicitly (collab_chat to Nia) and continuation is owned
      // by the goal loop. The `awaiting_audit` wake itself stays in
      // planDocUpdateStatus for callers that still set that status.
      // WG4: a finished turn is a natural reconcile point — discover external
      // edits the watcher saw, graph them as isolated nodes, and drift-check
      // them against the active plan. No explicit call needed.
      void reconcileWorkspaceObservation(exec).catch((error) => {
        if (ctx.ports.isDisposed()) return;
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return;
        publishForSession(exec, {
          type: "diagnostic",
          level: "warning",
          message: `workspace observation reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    }
  }
}

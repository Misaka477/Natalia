/**
 * Collaboration snapshot cache — runtime/collaboration/collab-snapshot.ts.
 *
 * `projectedCollabMessages()` and `projectedPlanDocs()` are O(events) pure
 * projections. They are used synchronously by turn-runner / chat-prompt /
 * event-sink, so on heavy sessions they can block the runtime event loop.
 *
 * This module keeps a main-thread snapshot per session. The worker recomputes
 * the projections in the background and replaces the snapshot atomically; the
 * synchronous consumers keep reading a plain object from `exec.collabSnapshot`.
 */
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import {
  isCollaborationStreamEvent,
  projectedCollabMessages,
  projectedMailboxMessages,
  projectedPlanDocs,
} from "@anthelia/session";
import { computeCollabSnapshotInWorker } from "@anthelia/substrate";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";
import type { CollabSnapshot } from "@anthelia/substrate";
import { perfLog } from "@anthelia/runtime-services";
import { completeSessionFactState } from "@anthelia/substrate";

const SNAPSHOT_DEBOUNCE_MS = 80;

export type CollabSnapshotScheduler = {
  schedule: (exec: SessionExecutionState) => void;
  dispose: () => void;
};

export function createCollabSnapshotScheduler(
  ctx: RuntimeContext,
): CollabSnapshotScheduler {
  const revisions = new Map<SessionID, number>();
  const timers = new Map<SessionID, ReturnType<typeof setTimeout>>();

  function schedule(exec: SessionExecutionState) {
    if (ctx.ports.isDisposed()) return;
    const sessionID: SessionID = exec.session.id;
    const next = (revisions.get(sessionID) ?? 0) + 1;
    revisions.set(sessionID, next);
    if (process.env.NATALIA_PERF_VERBOSE === "1")
      perfLog(
        `[perf] collabSnapshot.schedule session=${sessionID} revision=${next}`,
      );
    const existing = timers.get(sessionID);
    if (existing) clearTimeout(existing);
    timers.set(
      sessionID,
      setTimeout(() => {
        timers.delete(sessionID);
        void flush(sessionID, next);
      }, SNAPSHOT_DEBOUNCE_MS),
    );
  }

  async function flush(sessionID: SessionID, revision: number) {
    if (ctx.ports.isDisposed()) return;
    const exec = ctx.ports.getExecutionBySession().get(sessionID);
    if (!exec) return;
    // Complete the hot state first so the snapshot sees the whole collaboration
    // slice even when the execution is a fast-attach tail. Without this the
    // snapshot would silently drop older collab threads and pending questions.
    await completeSessionFactState(ctx, exec);
    const events = exec.session.events;
    // These projections only consume collaboration/plan/mailbox events. Use the
    // collected slice instead of structured-cloning the whole event array.
    const projectionEvents =
      exec.factStateComplete === true && exec.factState
        ? exec.factState.collaborationEvents
        : events.filter(isCollabProjectionEvent);
    const start = performance.now();
    try {
      const computed = await computeCollabSnapshotInWorker(projectionEvents);
      commit(sessionID, revision, computed);
      perfLog(
        `[perf] collabSnapshot.commit session=${sessionID} revision=${revision} events=${projectionEvents.length}/${events.length} collab=${computed.collabMessages.length} plans=${computed.planDocs.length} +${(performance.now() - start).toFixed(1)}ms worker`,
      );
    } catch {
      // Worker failure must never take the collaboration surfaces offline.
      const computed: CollabSnapshot = {
        collabMessages: projectedCollabMessages(projectionEvents),
        planDocs: projectedPlanDocs(projectionEvents),
        mailboxMessages: projectedMailboxMessages(projectionEvents),
        revision,
        eventCount: projectionEvents.length,
      };
      commit(sessionID, revision, computed);
      perfLog(
        `[perf] collabSnapshot.commit session=${sessionID} revision=${revision} events=${projectionEvents.length}/${events.length} collab=${computed.collabMessages.length} plans=${computed.planDocs.length} +${(performance.now() - start).toFixed(1)}ms fallback`,
      );
    }
  }

  function commit(
    sessionID: SessionID,
    revision: number,
    snapshot: CollabSnapshot,
  ) {
    // If a newer revision was scheduled while the worker was running, discard
    // this stale result; the newer timer will replace it.
    if (revisions.get(sessionID) !== revision) return;
    const exec = ctx.ports.getExecutionBySession().get(sessionID);
    if (!exec) return;
    exec.collabSnapshot = {
      ...snapshot,
      revision,
      // The projection only depends on collab/plan/mailbox events; unrelated
      // events may land during the worker round-trip without invalidating it.
      // Relevant events always schedule a newer revision, so a stale result is
      // still discarded above.
      eventCount: exec.session.events.length,
    };
  }

  function dispose() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    revisions.clear();
  }

  return { schedule, dispose };
}

export function isCollabSnapshotRelevantEvent(event: RuntimeEvent): boolean {
  return isCollabProjectionEvent(event);
}

function isCollabProjectionEvent(event: RuntimeEvent): boolean {
  return isCollaborationStreamEvent(event);
}

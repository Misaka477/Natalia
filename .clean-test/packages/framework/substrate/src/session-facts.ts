/**
 * Incremental hot memory for one execution — the client-side owner of
 * `SessionFactState`.
 *
 * The fact state is the in-memory half of the RINA memory tier: it keeps the
 * active-set facts (open drift, live constitution rules, un-terminated mailbox,
 * recent decisions, collab threads, turn status) without re-scanning the whole
 * journal. It is seeded lazily from `exec.session.events` and then maintained
 * in O(1) per durable event at the single event-sink choke point.
 *
 * Completeness matters: a fast-attach execution holds only the post-epoch tail,
 * so a state seeded from it is missing pre-epoch facts. `factStateComplete`
 * records which case we are in. `completeSessionFactState` fills a tail state by
 * streaming the durable log in pages, without materialising the whole journal;
 * only when no store can serve those pages does a caller fall back to the
 * explicit full-history escape hatch.
 */
import {
  applySessionFactEvent,
  deserializeProjectionState,
  emptySessionFactState,
  evictTerminalFacts,
  sessionFactStateFromEvents,
  type SessionFactState,
} from "@anthelia/session";
import { runtimeEventSessionSeq, type RuntimeEvent } from "@anthelia/contracts";
import type { SessionStoreController } from "@anthelia/session-store";
import { sessionStoreController } from "@anthelia/session-store";
import type { RuntimeContext } from "./context";
import type { SessionExecutionState } from "./session-execution-state";

const FACT_PAGE_LIMIT = 2_000;

/** Lazily build (and memoize) the incremental fact state for an execution. */
export function ensureSessionFactState(
  exec: SessionExecutionState,
): SessionFactState {
  if (!exec.factState) seedSessionFactState(exec);
  return exec.factState!;
}

/** Re-seed after `exec.session.events` is replaced with a new base. */
export function reseedSessionFactState(
  exec: SessionExecutionState,
  complete = exec.fullEventsLoaded === true,
): SessionFactState {
  seedSessionFactState(exec, complete);
  return exec.factState!;
}

/** Feed one durable event already appended to `exec.session.events`. */
export function feedSessionFactState(
  exec: SessionExecutionState,
  event: RuntimeEvent,
): void {
  if (exec.factState) applySessionFactEvent(exec.factState, event);
}

/**
 * Complete the hot state without materialising the whole journal.
 *
 * A fast-attach execution holds only the post-epoch tail, so the state cannot be
 * completed from memory. Stream the durable log forward in pages, fold each page
 * into a fresh state, then fold any live events that landed past the persisted
 * pages. `exec.session.events` intentionally stays a tail; callers that need the
 * full raw array use `ensureSessionFullEvents` instead.
 *
 * Returns false when no store is available, so the caller can fall back.
 */
export async function completeSessionFactState(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
): Promise<boolean> {
  ensureSessionFactState(exec);
  if (exec.factStateComplete === true) return true;
  if (exec.fullEventsLoaded === true) {
    reseedSessionFactState(exec, true);
    return true;
  }
  const store = ctx.state.serviceDirectory.getOptional(sessionStoreController);
  if (!store) return false;
  // Make the persisted tail match the live log before paging it.
  await ctx.ports
    .getSessionPersistenceForSession(exec.session.id)
    .catch(() => undefined);
  await store.flush(exec.session.id).catch(() => undefined);

  const commitFactState = (state: SessionFactState) => {
    exec.factState = state;
    exec.factStateComplete = true;
    // EI Phase 1 "降档": after the complete history is folded, bound the
    // terminal entries so hot memory does not grow with the whole session. The
    // journal keeps everything; a read reconstructs on demand.
    exec.factStateTerminalEvicted = evictTerminalFacts(state);
  };

  // B tier: complete from the persisted projection checkpoint + its tail instead
  // of paging the whole history. The checkpoint carries the durable event log
  // folded so far; eventsAfter(lastSeq) plus any newer live events fold the rest.
  // A missing, stale-versioned, or corrupt checkpoint fails soft to paging (C).
  const checkpoint = store.loadProjectionCheckpoint?.(exec.session.id);
  if (checkpoint) {
    const projection = deserializeProjectionState(checkpoint.serializedState);
    if (projection) {
      const state = emptySessionFactState();
      for (const event of projection.events)
        applySessionFactEvent(state, event);
      for (const event of store.eventsAfter?.(
        exec.session.id,
        checkpoint.lastSeq,
      ) ?? [])
        applySessionFactEvent(state, event);
      for (const event of exec.session.events) {
        const seq = runtimeEventSessionSeq(event);
        if (seq !== undefined && seq > checkpoint.lastSeq)
          applySessionFactEvent(state, event);
      }
      commitFactState(state);
      return true;
    }
  }

  const state = emptySessionFactState();
  let offset = 0;
  let maxSeq = 0;
  for (;;) {
    const page = await store.history(exec.session.id, exec.session.events, {
      offset,
      limit: FACT_PAGE_LIMIT,
    });
    for (const entry of page.events) {
      applySessionFactEvent(state, entry.event);
      const seq = entry.sessionSeq ?? entry.seq;
      if (typeof seq === "number") maxSeq = Math.max(maxSeq, seq);
    }
    if (!page.hasMore || page.events.length === 0) break;
    offset += page.events.length;
  }
  // Events appended while we paged (or not yet persisted) are newer than the
  // last folded sequence; fold them on top so the state matches the live log.
  for (const event of exec.session.events) {
    const seq = runtimeEventSessionSeq(event);
    if (seq !== undefined && seq > maxSeq) applySessionFactEvent(state, event);
  }
  commitFactState(state);
  return true;
}

function seedSessionFactState(
  exec: SessionExecutionState,
  complete = exec.fullEventsLoaded === true,
): void {
  exec.factState = sessionFactStateFromEvents(exec.session.events);
  exec.factStateComplete = complete;
}

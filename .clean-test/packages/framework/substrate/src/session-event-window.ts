import {
  sessionStoreController,
  type SessionStoreController,
} from "@anthelia/session-store";
import { runtimeEventSessionSeq, type RuntimeEvent } from "@anthelia/contracts";
import { ensureSessionFullEvents } from "./session-full-events";
import type { RuntimeContext } from "./context";
import type { SessionExecutionState } from "./session-execution-state";
import { logOf } from "@anthelia/operation-log";
import { SessionWindow } from "./session-window";
import type { SessionWindowEntry, SessionWindowLoader } from "./session-window";

const DEFAULT_EVENT_WINDOW_PAGE = 2_000;

function storeLoader(
  store: SessionStoreController,
  exec: SessionExecutionState,
  limit: number,
): SessionWindowLoader<SessionWindowEntry<RuntimeEvent>> {
  const mapPage = (
    page: Awaited<ReturnType<SessionStoreController["eventWindow"]>>,
  ) => {
    let next = 1;
    return {
      events: page.events.map((entry) => {
        const seq = entry.sessionSeq ?? next;
        next = seq + 1;
        return { seq, event: entry.event } as SessionWindowEntry<RuntimeEvent>;
      }),
      hasMore: page.hasMore,
    };
  };
  return {
    loadTail: async () =>
      mapPage(
        await store.eventWindow(exec.session.id, exec.session.events, {
          limit,
        }),
      ),
    loadBefore: async (beforeSeq) =>
      mapPage(
        await store.eventWindow(exec.session.id, exec.session.events, {
          beforeSeq,
          limit,
        }),
      ),
  };
}

/**
 * Lazily create the one per-session event window used by secondary surfaces.
 *
 * The full journal remains reachable through ensureSessionFullEvents(); this
 * helper is the normal path for chat/subagent/tool projections that only need
 * the current tail and can page older later.
 */
function hasSequenceGap(
  exec: SessionExecutionState,
  window: SessionWindow<SessionWindowEntry<RuntimeEvent>>,
): boolean {
  const seqs = new Set<number>();
  for (const entry of window.eventsView) seqs.add(entry.seq);
  for (const event of exec.session.events) {
    const seq = runtimeEventSessionSeq(event);
    if (seq !== undefined) seqs.add(seq);
  }
  const sorted = [...seqs].sort((left, right) => left - right);
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index] !== sorted[index - 1]! + 1) return true;
  }
  return false;
}

export async function ensureSessionEventWindow(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
  limit = DEFAULT_EVENT_WINDOW_PAGE,
): Promise<SessionWindow<SessionWindowEntry<RuntimeEvent>> | undefined> {
  if (exec.fullEventsLoaded) return undefined;
  const store = ctx.state.serviceDirectory.getOptional(sessionStoreController);
  if (!store) return undefined;
  const existing = exec.eventWindow;
  if (!existing) {
    // A just-finished startup turn may still be queued in the persistence
    // chain. Drain the per-session chain before the store flush, otherwise the
    // DB tail can lag the live cursor and look like a real gap.
    await ctx.ports
      .getSessionPersistenceForSession(exec.session.id)
      .catch(() => undefined);
    await store.flush(exec.session.id).catch(() => undefined);
  }
  if (existing && existing.openState === "open") {
    if (!hasSequenceGap(exec, existing)) return existing;
    exec.eventWindow = undefined;
    await ensureSessionFullEvents(ctx, exec);
    return undefined;
  }
  const window =
    existing ??
    new SessionWindow<SessionWindowEntry<RuntimeEvent>>({
      loader: storeLoader(store, exec, limit),
    });
  exec.eventWindow = window;
  await window.open();
  // A live event may have landed before the first secondary read created the
  // window. Replay the hidden-seq events already resident in the execution so
  // the window covers the same prefix the chat/subagent projection sees.
  for (const event of exec.session.events) {
    const seq = runtimeEventSessionSeq(event);
    if (seq !== undefined) window.acceptLive({ seq, event });
  }
  if (hasSequenceGap(exec, window)) {
    if (
      process.env.NATALIA_MEMORY_TRACE === "1" ||
      process.env.NATALIA_TRACE_FULL_EVENTS === "1"
    ) {
      const windowSeqs = window.eventsView.map((entry) => entry.seq);
      const liveSeqs = exec.session.events
        .map((event) => runtimeEventSessionSeq(event))
        .filter((seq): seq is number => seq !== undefined);
      logOf(ctx.state.serviceDirectory).warn("event-window", "gap", {
        sessionID: exec.session.id,
        windowCount: windowSeqs.length,
        windowFirst: windowSeqs[0],
        windowLast: windowSeqs.at(-1),
        windowHead: windowSeqs.slice(0, 3),
        windowTail: windowSeqs.slice(-3),
        liveCount: liveSeqs.length,
        liveFirst: liveSeqs[0],
        liveLast: liveSeqs.at(-1),
      });
    }
    exec.eventWindow = undefined;
    await ensureSessionFullEvents(ctx, exec);
    return undefined;
  }
  return window;
}

/** Feed one durable live event into the shared window, when it exists. */
export function feedSessionEventWindow(
  exec: SessionExecutionState,
  seq: number,
  event: RuntimeEvent,
): void {
  exec.eventWindow?.acceptLive({ seq, event });
}

/**
 * Merge the persisted window with durable live events already resident in the
 * execution. The persistence queue can lag a just-finished turn, so a read
 * must not discard the live tail merely because the window page is older.
 */
export async function sessionWindowEventsForExec(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
): Promise<RuntimeEvent[]> {
  const window = await ensureSessionEventWindow(ctx, exec);
  return window ? sessionWindowEvents(exec, window) : exec.session.events;
}

export function sessionWindowEvents(
  exec: SessionExecutionState,
  window: SessionWindow<SessionWindowEntry<RuntimeEvent>>,
): RuntimeEvent[] {
  const bySeq = new Map<number, RuntimeEvent>();
  for (const entry of window.eventsView) bySeq.set(entry.seq, entry.event);
  for (const event of exec.session.events) {
    const seq = runtimeEventSessionSeq(event);
    if (seq !== undefined && !bySeq.has(seq)) bySeq.set(seq, event);
  }
  const result = [...bySeq.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, event]) => event);
  return result;
}

export type SessionWindowScanResult<T> =
  | { kind: "found"; item: T; newerCount: number }
  /** The whole durable log was searched (via window pages or full events). */
  | { kind: "exhausted" }
  /** An older page could not be stitched; the caller must use the full escape hatch. */
  | { kind: "gap" };

/**
 * Walk the shared window from the newest event backwards until `match` finds an
 * item in the projected view, or the window reaches the start of the durable
 * log.
 *
 * `newerCount` is the number of projected items after the match in the current
 * (physically newest-anchored) view, so a caller can compute "removed N" without
 * materialising the whole history. The window is always contiguous and anchored
 * at the newest event, so once the match is inside it every newer item is too.
 *
 * Returns `gap` when an older page failed to stitch, and `exhausted` when the
 * whole log was searched without a match.
 */
export async function scanSessionWindowNewestFirst<T>(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
  project: (events: RuntimeEvent[]) => T[],
  match: (item: T) => boolean,
): Promise<SessionWindowScanResult<T>> {
  const settled = (items: T[]): SessionWindowScanResult<T> => {
    const index = items.findIndex(match);
    return index >= 0
      ? {
          kind: "found",
          item: items[index]!,
          newerCount: items.length - index - 1,
        }
      : { kind: "exhausted" };
  };

  const window = await ensureSessionEventWindow(ctx, exec);
  if (!window) {
    // Full events are already resident, or a gap forced the explicit full load.
    return settled(project(exec.session.events));
  }
  for (;;) {
    const result = settled(project(sessionWindowEvents(exec, window)));
    if (result.kind === "found") return result;
    // The first durable event carries sessionSeq 1, so this is the real base.
    if (window.baseSeq === 1) return result;
    const advanced = await window.loadOlder();
    if (!advanced && window.baseSeq !== 1) return { kind: "gap" };
  }
}

import {
  sessionStoreController,
  type SessionStoreController,
} from "@anthelia/session-store";
import { memoryTrace } from "@anthelia/runtime";
import type { RuntimeContext } from "./context";
import type { SessionExecutionState } from "./session-execution-state";
import {
  filterRuntimeRetainedEvents,
  maxLiveSessionEvents,
  windowRuntimeEvents,
} from "./session-event-retention";
import { logOf } from "@anthelia/operation-log";
import {
  completeSessionFactState,
  reseedSessionFactState,
} from "./session-facts";

/**
 * Complete the incremental fact state for an execution that needs cross-history
 * facts. It streams the durable log into the state when a store can be paged, so
 * `exec.session.events` does not have to hold the whole journal; only when no
 * store is available does it fall back to the explicit full load.
 */
export async function ensureCompleteSessionFactState(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
): Promise<void> {
  if (exec.factStateComplete === true) return;
  if (await completeSessionFactState(ctx, exec)) return;
  await ensureSessionFullEvents(ctx, exec);
}

/**
 * Load the full durable event log into an execution state.
 *
 * The fast attach path may initially provide only the context tail. Consumers
 * that need the complete transcript/history must call this before reading
 * `exec.session.events`. The promise is memoized per execution so concurrent
 * callers share one load.
 */
export function ensureSessionFullEvents(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
): Promise<void> {
  if (exec.fullEventsPromise) return exec.fullEventsPromise;
  // The fast attach path seeds `session.events` with only the post-epoch tail
  // and sets `eventCount` to that tail length. Comparing `events.length` to
  // `eventCount` therefore cannot tell whether the complete durable log is
  // loaded. Consumers such as the Navi/Nia chat surfaces read this log directly
  // and saw an empty stream until the background full-load happened to finish.
  if (exec.fullEventsLoaded === true) return Promise.resolve();
  if (
    process.env.NATALIA_MEMORY_TRACE === "1" ||
    process.env.NATALIA_TRACE_FULL_EVENTS === "1"
  ) {
    const stack = new Error("full-events caller").stack
      ?.split("\n")
      .slice(1, 8)
      .join("\n");
    logOf(ctx.state.serviceDirectory).warn(
      "full-events",
      `caller session=${exec.session.id}\n${stack}`,
    );
  }
  const promise = (async () => {
    const sessionStore = ctx.state.serviceDirectory.getOptional(
      sessionStoreController,
    );
    if (!sessionStore)
      throw new Error("session store unavailable (natalia-session-store)");
    // A live event can be queued in the per-session persistence chain but not
    // yet in the store. Drain that chain and the store flush before reading the
    // full log, otherwise the load replaces `session.events` and drops the live
    // tail (the window opener does the same before its gap check).
    await ctx.ports
      .getSessionPersistenceForSession(exec.session.id)
      .catch(() => undefined);
    await sessionStore.flush(exec.session.id).catch(() => undefined);
    memoryTrace("execution.fullEvents.start", {
      sessionID: exec.session.id,
      currentEvents: exec.session.events.length,
    });
    const full = await sessionStore.loadFullAsync(exec.session.id, {
      runtimeEvents: true,
    });
    exec.session.events = windowRuntimeEvents(
      filterRuntimeRetainedEvents(
        full.events,
        sessionStore.status().mode,
        true,
      ),
      maxLiveSessionEvents(),
    );
    exec.eventCount = exec.session.events.length;
    exec.fullEventsLoaded = true;
    // The base log changed, so the incremental fact state must be re-seeded.
    reseedSessionFactState(exec, true);
    memoryTrace("execution.fullEvents.done", {
      sessionID: exec.session.id,
      events: exec.session.events.length,
    });
  })();
  exec.fullEventsPromise = promise.catch((error) => {
    exec.fullEventsPromise = undefined;
    throw error;
  });
  return exec.fullEventsPromise;
}

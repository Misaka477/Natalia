/**
 * The drain: wait until no live turn is running.
 *
 * One implementation, two callers with the same need — the lifecycle
 * surface's `drainForUpdate` (an operator asking the daemon to go quiet)
 * and the generation switch's code path (洞 5: the process underneath a
 * source-carrying generation is about to be replaced, and a restart would
 * drop the turns in flight). Two spellings of the same wait would be two
 * answers to "is it quiet", and only one of them would be the one the
 * restart actually trusts.
 *
 * The marker is the runner's own: `activeTurnID` is cleared by the runner
 * on finish (its own-id guard at provider-runner), so a finished turn
 * always unblocks this loop and nothing SET here leaves sticky state
 * behind — the follow-up submit after a timed-out drain is the regression
 * test for that. A timeout THROWS rather than degrading: switching code
 * over a live turn drops it, and a drain that lied about being quiet would
 * trade a visible refusal for invisible data loss.
 */

import { logOf, type OperationLog } from "@anthelia/operation-log";

/** The runtime's view of "which sessions have a turn in flight". */
export type DrainSource = {
  getExecutionBySession(): Map<string, { activeTurnID?: string } | undefined>;
};

export async function waitForDrain(
  source: DrainSource,
  input?: {
    timeoutMs?: number;
    /**
     * The operation log to report on. Optional so a bare caller (a test, a
     * path with no composition) still works — but the DEFAULT level, not a
     * perf-gated one: a timeout that refuses a switch must be in the log a
     * reader actually has open, and `perfLog` is silent without
     * NATALIA_PERF_VERBOSE=1.
     */
    log?: OperationLog;
  },
): Promise<{ waitedMs: number }> {
  const timeoutMs = Math.max(
    200,
    Math.min(Math.round(input?.timeoutMs ?? 120_000), 600_000),
  );
  const log = input?.log;
  const started = Date.now();
  const deadline = started + timeoutMs;
  // Instrumented (audit 缺口 4: the seams that can fail): a drain that waits
  // and a drain that gives up were both absent from the log, and the second
  // is exactly the case a reader is trying to explain — "why did the restart
  // refuse?" starts here.
  let reportedWait = false;
  for (;;) {
    let active = 0;
    for (const exec of source.getExecutionBySession().values())
      if (exec?.activeTurnID) active += 1;
    if (active === 0) {
      const waitedMs = Date.now() - started;
      if (waitedMs > 100) log?.info("drain", "quiet", { waitedMs, active });
      return { waitedMs };
    }
    if (!reportedWait) {
      reportedWait = true;
      log?.info("drain", "waiting", { active, budgetMs: timeoutMs });
    }
    if (Date.now() >= deadline) {
      const waitedMs = Date.now() - started;
      log?.error("drain", "timed out — refusing the switch", {
        waitedMs,
        active,
      });
      throw new Error(
        `drainForUpdate: ${active} turn(s) still active after ${waitedMs}ms — a restart would drop them; retry when quiet`,
      );
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      timer.unref?.();
    });
  }
}

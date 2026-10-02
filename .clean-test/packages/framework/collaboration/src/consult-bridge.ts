/**
 * The synchronous consult line (the Navi advisor plan's block A).
 *
 * `collab_ask` used to be fire-and-forget: it sent the question, woke
 * Navi, and returned `{asked: true}` — the answer arrived later as an
 * internal wake at the next step boundary, which is fine for
 * human-paced collaboration but useless for a decision-point consult
 * (the main agent has already committed by the time the advice lands).
 *
 * This bridge makes the ask BOUNDED-WAIT: the answer flows back through
 * the very same channel it always did — Navi's `collab_answer` sends an
 * answer, and the collaboration service resolves the pending consult —
 * but now the tool call waits for it and returns the advice as the tool
 * result. The wait is process-local (a consult lives inside a turn; a
 * killed turn's wait dies with it — the speculative heat discipline)
 * and never unbounded: a timeout or the turn's abort answers
 * `unavailable`, which the model can act on.
 */

export type ConsultReply =
  | { state: "answered"; advice: string; answeredAt: string }
  | { state: "unavailable"; reason: string };

type PendingConsult = {
  resolve: (reply: ConsultReply) => void;
  sessionID?: string;
};

/** The pending consults, keyed by the question's message id. */
const pending = new Map<string, PendingConsult>();

/**
 * The DEAD-MAN'S SWITCH, not the normal path's bound. The normal ends
 * are the answer arriving (resolveConsult) or the advisor's turn ending
 * (expireSessionConsults — both fast, both tested). This constant fires
 * only when neither happens: the wake never fired, or the advisor's
 * provider stream is wedged. Ten minutes is deliberately generous — a
 * navi round reads a large live context and may run protocol
 * corrections, and at real model speeds that legitimately exceeds
 * minutes; the bound exists so a wedged advisor cannot cost a turn
 * forever, not to cut a slow advisor short. The user's review caught
 * the first version (120s) reading this switch as a normal-path bound.
 */
export const DEFAULT_CONSULT_WAIT_MS = 600_000;

/**
 * Waits (bounded) for the advisor's answer to `questionMessageID`.
 * Never rejects and never hangs: a timeout or the turn's abort answers
 * `unavailable`, and the pending entry is always cleaned up.
 */
export function waitForConsult(
  questionMessageID: string,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    sessionID?: string;
  } = {},
): Promise<ConsultReply> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONSULT_WAIT_MS;
  return new Promise<ConsultReply>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (reply: ConsultReply) => {
      if (settled) return;
      settled = true;
      pending.delete(questionMessageID);
      if (timer) clearTimeout(timer);
      resolve(reply);
    };
    // An abort that already fired before this registration (the turn was
    // cancelled while the ask was still sending) never fires the listener
    // — check it up front or the wait would hang to the timeout.
    if (options.signal?.aborted) {
      settle({ state: "unavailable", reason: "the turn was cancelled" });
      return;
    }
    timer = setTimeout(
      () =>
        settle({
          state: "unavailable",
          reason: `no advisor answer within ${timeoutMs}ms`,
        }),
      timeoutMs,
    );
    options.signal?.addEventListener(
      "abort",
      () => settle({ state: "unavailable", reason: "the turn was cancelled" }),
      { once: true },
    );
    pending.set(questionMessageID, {
      resolve: settle,
      ...(options.sessionID ? { sessionID: options.sessionID } : {}),
    });
  });
}

/**
 * Resolves a pending consult when the advisor's answer arrives (the
 * collaboration service calls this when an `answer` message is sent).
 * Returns whether a waiter was pending — an answer to a consult nobody
 * is waiting on is just an answer: the async channel already carries
 * it, and this line must not steal it.
 */
export function resolveConsult(
  replyToID: string,
  advice: string,
  answeredAt: string,
): boolean {
  const waiter = pending.get(replyToID);
  if (!waiter) return false;
  waiter.resolve({ state: "answered", advice, answeredAt });
  return true;
}

/** The pending consult's session, for diagnostics (undefined when absent). */
export function pendingConsultSession(
  questionMessageID: string,
): string | undefined {
  return pending.get(questionMessageID)?.sessionID;
}

/**
 * Ends every pending consult of a session as `unavailable` — called when
 * the advisor's turn ends (the wake mechanism's runBody wrapper). A turn
 * that ended without answering a question means no answer is coming on
 * this wake; waiting the full timeout would stall the main turn for
 * minutes after the advisor is long gone. The cost asymmetry decides
 * it: a spurious expiry costs one re-ask, a spurious wait costs the
 * whole turn. The rare cost: a consult registered DURING that turn (its
 * wake still queued) also ends here — the tool description tells the
 * model to continue without the advice or re-ask.
 */
export function expireSessionConsults(
  sessionID: string,
  reason: string,
): number {
  let expired = 0;
  for (const waiter of [...pending.values()])
    if (waiter.sessionID === sessionID) {
      waiter.resolve({ state: "unavailable", reason });
      expired += 1;
    }
  return expired;
}

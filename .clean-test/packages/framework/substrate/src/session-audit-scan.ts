import type { RuntimeEvent } from "@anthelia/contracts";
import { sessionStoreController } from "@anthelia/session-store";
import type { RuntimeContext } from "./context";
import type { SessionExecutionState } from "./session-execution-state";

const AUDIT_PAGE_LIMIT = 2_000;

/** The audit-request facts one idempotency/round decision needs. */
export type AuditRequestFacts = {
  /** The triggerEventID of every audit.requested the plan has. */
  triggerEventIDs: string[];
  /** How many audit.requested events the plan has (the round base). */
  count: number;
};

/**
 * The audit-request facts for one plan — paged from the durable log.
 *
 * The two audit wake paths (plan status → Nia, completion.recorded → Nia)
 * dedupe and number their requests by folding `exec.session.events` directly.
 * A fast-attach execution holds only the post-epoch tail, so an older
 * audit.requested is invisible there: the request republishes, or its round
 * restarts. This pages the durable log in bounded pages (the fact-state
 * completion's shape), unions the resident tail by event id (events appended
 * while paging, or not yet persisted), and returns both.
 *
 * With no store to page, the resident scan is all there is — the fallback is
 * deliberate and this is where it is named.
 */
export async function scanAuditRequestFacts(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
  planID: string,
): Promise<AuditRequestFacts> {
  const seen = new Set<string>();
  const triggerEventIDs: string[] = [];
  const consider = (event: RuntimeEvent): void => {
    if (event.type !== "audit.requested" || event.planID !== planID) return;
    if (seen.has(event.id)) return;
    seen.add(event.id);
    triggerEventIDs.push(event.triggerEventID);
  };
  const store = ctx.state.serviceDirectory.getOptional(sessionStoreController);
  if (store) {
    // Make the persisted tail match the live log before paging it.
    await ctx.ports
      .getSessionPersistenceForSession(exec.session.id)
      .catch(() => undefined);
    await store.flush(exec.session.id).catch(() => undefined);
    let offset = 0;
    for (;;) {
      const page = await store.history(exec.session.id, exec.session.events, {
        offset,
        limit: AUDIT_PAGE_LIMIT,
      });
      for (const entry of page.events) consider(entry.event);
      if (!page.hasMore || page.events.length === 0) break;
      offset += page.events.length;
    }
  }
  for (const event of exec.session.events) consider(event);
  return { triggerEventIDs, count: triggerEventIDs.length };
}

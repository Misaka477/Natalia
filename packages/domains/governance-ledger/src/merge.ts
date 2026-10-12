/**
 * One logical journal, two physical copies, ONE merge.
 *
 * A workspace-tier governance event is written to BOTH the session journal
 * (so the runtime's execution-time checks can read it) and the instance
 * store (so every later session and the CLI face can read it — T-21). The
 * same event object goes to both, so the two stores are two COPIES of one
 * journal, not two journals.
 *
 * Every reader used to hand-roll `[...instance.events, ...session.events]`,
 * which assumes three things that are all false:
 *
 *   1. that the two stores are disjoint — they overlap heavily;
 *   2. that concatenation is chronological — the instance copy always lands
 *      first, so the session's copy of an EARLIER event always lands last;
 *   3. that each event appears once — it appears twice.
 *
 * The third is what resurrects a deleted rule: the fold sees
 * `add → removed → add`, and the trailing duplicate add wins.
 *
 * This function owns the merge so the knowledge lives in one place:
 *
 *   **Law 1 — dedupe by event id.** One logical event folds once.
 *   **Law 2 — the instance store is the authoritative order.** The session
 *   contributes only what the instance does not have, in the session's own
 *   durable order.
 *
 * Law 2 is what makes a removal beat an add regardless of which physical
 * copy it was written to: the add (present in both) folds at the instance's
 * position, and the removal folds after it whether it lives in the instance
 * store or only in the session journal.
 *
 * A reader that concatenates by hand is a reader that has not read this.
 */

import type { RuntimeEvent } from "@anthelia/contracts";

/** The event's identity. Two copies of one event share it. */
function eventKey(event: RuntimeEvent): string {
  // `id` is not on the base type (only on the members that carry one), so the
  // read is a narrowing one. An event without an id cannot be deduped; its
  // content is the only identity it has — and the fold then sees it twice,
  // which is the honest outcome for an event nobody can name.
  const id = (event as { id?: unknown }).id;
  return typeof id === "string" && id ? id : JSON.stringify(event);
}

export function mergeGovernanceEvents(
  instance: readonly RuntimeEvent[],
  session: readonly RuntimeEvent[],
): RuntimeEvent[] {
  const seen = new Set<string>();
  const merged: RuntimeEvent[] = [];
  // Law 2: the instance store's own order is the workspace's order.
  for (const event of instance) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  // Law 1: the session contributes only what the instance does not already
  // carry. Its array order IS its durable order, so no sort is needed — and
  // sorting would need a key the events do not all carry.
  for (const event of session) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged;
}

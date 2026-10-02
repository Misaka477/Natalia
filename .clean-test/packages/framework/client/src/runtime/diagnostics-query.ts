import type { RuntimeEvent } from "@anthelia/contracts";
import type { OperationLevel, OperationRecord } from "@anthelia/operation-log";

/**
 * The unified diagnostics query (decisions §5: journal + operation log,
 * ONE query face; interface spec §4.5's diagnostic query primitive).
 *
 * Pure over its two sources so the same filter serves the live runtime
 * and the offline debug bundle — the bundle's copy and a host's live view
 * must agree on what "errors since X in the collab component" means.
 *
 * Filter semantics are honest about what each side HAS: `contains` and
 * `since` and `sessionID` apply to both; `level`/`component` only exist on
 * the operational half (journal events carry neither), and journal-side
 * `since` only compares events that carry `at` (the rest are excluded when
 * `since` is set — a timestamp filter must not pretend to know times the
 * source never recorded).
 */

export type DiagnosticsFilter = {
  sessionID?: string;
  /** Operational side only: minimum severity. */
  level?: OperationLevel;
  /** Operational side only: exact component. */
  component?: string;
  /** Both sides: case-insensitive substring over the serialized record. */
  contains?: string;
  /** Both sides (see the semantics note): ISO timestamp lower bound. */
  since?: string;
  /** Per-side cap — the newest N of each. */
  limit?: number;
};

export function queryDiagnostics(input: {
  events: readonly RuntimeEvent[];
  records: readonly OperationRecord[];
  filter?: DiagnosticsFilter;
}): { journal: RuntimeEvent[]; operational: OperationRecord[] } {
  const filter = input.filter ?? {};
  const contains = filter.contains?.toLowerCase();

  let journal = input.events.filter((event) => {
    if (filter.sessionID && event.sessionID !== filter.sessionID) return false;
    if (filter.since) {
      const at = (event as { at?: string }).at;
      if (!at || at < filter.since) return false;
    }
    if (contains && !JSON.stringify(event).toLowerCase().includes(contains))
      return false;
    return true;
  });
  if (filter.limit) journal = journal.slice(-filter.limit);

  let operational = input.records.filter((record) => {
    if (filter.sessionID && record.corr?.sessionID !== filter.sessionID)
      return false;
    if (filter.component && record.component !== filter.component) return false;
    if (filter.level) {
      const order: Record<OperationLevel, number> = {
        error: 0,
        warn: 1,
        info: 2,
        debug: 3,
        trace: 4,
      };
      if (order[record.level] > order[filter.level]) return false;
    }
    if (filter.since && (!record.at || record.at < filter.since)) return false;
    if (contains && !JSON.stringify(record).toLowerCase().includes(contains))
      return false;
    return true;
  });
  if (filter.limit) operational = operational.slice(-filter.limit);

  return { journal, operational };
}

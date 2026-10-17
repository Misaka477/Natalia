/**
 * Discovery D4's usage reader: the fold that turns `skill.activated` facts
 * into the per-skill usage the lifecycle's garbage collector reads.
 *
 * The GC (`skill-lifecycle.ts`) scores every skill by usage, success rate,
 * recency and cost — and for its first months it had no usage to read:
 * activation was runtime state, nothing was journaled, and a gc that cannot
 * see usage refuses to guess (it evicted nothing and said so). The
 * `skill.activated` event closed that hole; this module is the reader on
 * the other side of it.
 *
 * The success term is the turn's own outcome: an activation names the turn
 * that loaded the skill, and that turn's `turn.finished` with stopReason
 * "done" is what makes the use a success — the same outcome law D5's
 * run-scorer reads. An activation whose turn never finished (still running,
 * crashed, or activated outside any turn) counts as a use with no success,
 * never as a failure: absence of a verdict is not a negative one.
 */

import type { RuntimeEvent } from "@anthelia/contracts";

/** What the fold knows about one skill's usage in the window. */
export type SkillUsageRow = {
  /** How often it was activated. */
  uses: number;
  /** How often the activating turn finished done. */
  successes: number;
  /** The newest activation (epoch ms), or undefined when never. */
  lastUsedAt?: number;
};

/**
 * Folds a session-event stream into per-skill usage, keyed by the skill's
 * catalog name. Pure: the same events fold to the same rows whatever the
 * caller, so the law is a unit test rather than a hope.
 */
export function skillUsageFromEvents(
  events: readonly RuntimeEvent[],
): Map<string, SkillUsageRow> {
  // The turn outcomes first: an activation's success is read off the turn
  // it names, and the turn's own event can arrive after the activation.
  const doneTurns = new Set<string>();
  for (const event of events)
    if (
      event.type === "turn.finished" &&
      (event as { stopReason?: string }).stopReason === "done"
    )
      doneTurns.add((event as { id: string }).id);

  const rows = new Map<string, SkillUsageRow>();
  for (const event of events) {
    if (event.type !== "skill.activated") continue;
    const activation = event as {
      name: string;
      at: string;
      turnID?: string;
    };
    const row = rows.get(activation.name) ?? {
      uses: 0,
      successes: 0,
      lastUsedAt: undefined,
    };
    row.uses += 1;
    const at = Date.parse(activation.at);
    if (Number.isFinite(at)) row.lastUsedAt = Math.max(row.lastUsedAt ?? 0, at);
    if (activation.turnID && doneTurns.has(activation.turnID))
      row.successes += 1;
    rows.set(activation.name, row);
  }
  return rows;
}

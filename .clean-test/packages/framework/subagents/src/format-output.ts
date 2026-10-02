/**
 * Bounds one subagent's verbose log for hand-off to the parent.
 *
 * `formatOutput(verbose)` returns the whole audit trail, and a subagent that ran
 * many steps with tool output produces a great deal of it. Handing that to the
 * parent verbatim spends the parent's context on a history it rarely needs whole
 * — the same reason the concise path already truncates.
 *
 * The tail is kept, not the head: the most recent steps are what the parent acts
 * on, and the note says how much was dropped rather than hiding it, because a
 * log that silently ends early reads as a subagent that finished early.
 */
export const VERBOSE_OUTPUT_MAX_CHARS = 8_000;

/** How many of the newest steps fit in the budget, and what was dropped. */
export function boundVerboseOutput(
  lines: readonly string[],
  maxChars: number = VERBOSE_OUTPUT_MAX_CHARS,
): string {
  if (maxChars <= 0) return lines.join("\n");
  const kept: string[] = [];
  let chars = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (kept.length > 0 && chars + line.length + 1 > maxChars) break;
    kept.unshift(line);
    chars += line.length + 1;
  }
  const dropped = lines.length - kept.length;
  if (dropped === 0) return kept.join("\n");
  return `${kept.join("\n")}\n… (${dropped} earlier step${dropped === 1 ? "" : "s"} omitted, ${lines.length} total)`;
}

import type { RuntimeEvent } from "@anthelia/contracts";

/**
 * S9's verdict pipe: Nia's judgment of a turn, parsed out of the journal.
 *
 * The merged persona's marker rule is what makes this parseable at all:
 * a verdict opens with `VERDICT:` on its own line, then the subject (which
 * turn), then the judgment and its reasons. Anything she sends without
 * that marker — a greeting, a joke, a thought out loud — is chatter and is
 * never read as data. That is the whole price of letting the auditor be a
 * person, and this module is where the price is collected.
 *
 * Two signals ride the pair, and they are not the same signal:
 *  - the USER's own follow-up (the ground truth — what they actually said),
 *  - Nia's independent reading of it (the interpretation layer).
 * Carrying both is the mitigation for the auditor's own bias: a reader
 * sees her claim beside the words it was drawn from.
 */

/** One parsed verdict, or nothing when the text is chatter. */
export type ParsedVerdict = {
  /** The turn the verdict is about (undefined when she did not name one). */
  turnID?: string;
  judgment: string;
  reasons: string;
};

/**
 * Parse one message's text as a verdict. The marker is mandatory and
 * exact: a message that does not open with `VERDICT:` alone on its first
 * line is not a verdict, whatever else it contains.
 */
export function parseVerdict(text: string): ParsedVerdict | undefined {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "VERDICT:") return undefined;
  let turnID: string | undefined;
  let judgment = "";
  const reasonLines: string[] = [];
  let inReasons = false;
  for (const line of lines.slice(1)) {
    const field = /^(turn|judgment|reasons):\s*(.*)$/u.exec(line.trim());
    if (field) {
      inReasons = field[1] === "reasons";
      const value = field[2] ?? "";
      if (field[1] === "turn") turnID = value.trim() || undefined;
      else if (field[1] === "judgment") judgment = value.trim();
      else reasonLines.push(value);
      continue;
    }
    if (inReasons) reasonLines.push(line);
  }
  if (!judgment && !reasonLines.length) return undefined;
  return {
    ...(turnID ? { turnID } : {}),
    judgment: judgment || "(unstated)",
    reasons: reasonLines.join("\n").trim(),
  };
}

/**
 * The session's verdicts, folded from its own events: Nia's messages that
 * carry the marker, keyed by the turn they name. A verdict that names no
 * turn is counted as unattributed rather than silently dropped — an
 * auditor whose verdicts cannot be attached is telling you something.
 */
export function foldVerdicts(events: readonly RuntimeEvent[]): {
  byTurn: Map<string, ParsedVerdict>;
  unattributed: number;
} {
  const byTurn = new Map<string, ParsedVerdict>();
  let unattributed = 0;
  for (const event of events) {
    if (event.type !== "nia.collab.message") continue;
    const parsed = parseVerdict(
      (event as { message?: { text?: string } }).message?.text ?? "",
    );
    if (!parsed) continue;
    if (!parsed.turnID) {
      unattributed += 1;
      continue;
    }
    byTurn.set(parsed.turnID, parsed);
  }
  return { byTurn, unattributed };
}

/**
 * The pair's feedback text: what the user did next, and Nia's reading of
 * it, side by side. The follow-up rides as `then:` — CONTEXT, not a
 * judgment: a follow-up is only a verdict when it REACTS, and when it is
 * simply the next task it says nothing about the previous answer.
 * Nia's verdict is the judgment layer; the explicit rating (`user:`) is
 * the exception, because a thumbs-up/down IS a judgment.
 */
export function verdictFeedback(input: {
  userFollowUp?: string;
  /** An explicit rating (a thumbs verdict) — a judgment, unlike a follow-up. */
  explicitRating?: string;
  verdict?: ParsedVerdict;
}): string | undefined {
  const parts: string[] = [];
  if (input.userFollowUp) parts.push(`then: ${input.userFollowUp.trim()}`);
  if (input.explicitRating) parts.push(`user: ${input.explicitRating.trim()}`);
  if (input.verdict)
    parts.push(
      `nia: ${input.verdict.judgment}${input.verdict.reasons ? ` — ${input.verdict.reasons}` : ""}`,
    );
  return parts.length ? parts.join(" | ") : undefined;
}

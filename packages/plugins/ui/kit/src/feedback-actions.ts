import type { Message, MessageAction } from "./message";

/**
 * L2's feedback entry, as pure decisions (D6a): which transcript rows
 * carry the thumbs, and what the two buttons say.
 *
 * The row-level rules exist because the rating is about an ANSWER: a
 * streaming tail has no final answer yet, a thinking row is not an answer
 * at all, and a user's own message is not the model's output. The rating
 * itself rides the runtime's feedback face, which journals
 * `feedback.recorded` and structurally never reaches the model — design
 * law 3, "signals about the output, never input to it". Nothing here
 * touches the model's context; the buttons only name the verdict.
 */
export type MessageVerdict = "up" | "down";

/** The row shape the decision reads (the host's projected message). */
export type RateableRow = {
  role: string;
  /** A reasoning row: shown behind its own disclosure, never an answer. */
  thinking?: boolean;
  /** A streaming tail: the answer is still arriving. */
  streaming?: boolean;
  /** The row's confirmed text. */
  text: string;
};

/** Whether this row carries the thumbs at all. */
export function rateableRow(row: RateableRow): boolean {
  return (
    row.role === "assistant" &&
    row.thinking !== true &&
    row.streaming !== true &&
    row.text.trim().length > 0
  );
}

/**
 * The two actions for a rateable row. A row that was already rated says so
 * ("已记录") instead of offering the same choice twice — and the label is
 * the ONLY local state: the verdict itself lives in the journal, not here.
 */
export function feedbackActions(input: {
  row: RateableRow;
  /** The verdict this session already recorded for the row, if any. */
  verdict?: MessageVerdict;
  rate: (verdict: MessageVerdict) => void;
}): MessageAction[] {
  if (!rateableRow(input.row)) return [];
  return [
    {
      label: input.verdict === "up" ? "👍 已记录" : "👍",
      onClick: () => input.rate("up"),
    },
    {
      label: input.verdict === "down" ? "👎 已记录" : "👎",
      onClick: () => input.rate("down"),
    },
  ];
}

/** The kit row type the host builds (re-exported for the host's own typing). */
export type { Message };

/**
 * The goal round's cost, folded from the round's own provider steps.
 *
 * A `turn.finished` event carries the LAST step's input and output tokens —
 * the size of the final request's surface — not what the round spent. The
 * 2026-10-13 audit measured a goal round whose turn reported 10,973 tokens
 * while the round's steps had actually spent 36,678: every step re-sends the
 * growing surface, so the last step is the smallest and the budget guard
 * under-counted by 3.3×. The `runtime.step_usage` events the runner emits
 * per step are the round's real ledger; this module folds them.
 */

/** The turn id a `runtime.step_usage` event belongs to. */
export function turnIDFromStepUsageID(id: string): string {
  // The runner stamps the event `<turn id>:usage:<step>`; the turn id is
  // everything before that suffix. A shape change here must fail loud
  // rather than silently keying every step under its own id.
  return id.replace(/:usage:\d+$/u, "");
}

/** Per-round cost accumulated from the round's own provider steps. */
export type RoundCostFold = {
  tokens: number;
  steps: number;
};

/** Fold one `runtime.step_usage` event into its round's accumulator. */
export function foldStepUsage(
  fold: RoundCostFold | undefined,
  event: { inputTokens?: number; outputTokens?: number },
): RoundCostFold {
  const stepTokens = (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
  return {
    tokens: (fold?.tokens ?? 0) + stepTokens,
    steps: (fold?.steps ?? 0) + 1,
  };
}

/**
 * The round's cost to book. The summed steps when the turn reported any;
 * otherwise the turn's own figures. A provider that reports no usage books
 * nothing — a goal without a budget never blocks on a figure it cannot
 * observe, and a fabricated figure is worse than an absent one.
 */
export function roundCost(
  fold: RoundCostFold | undefined,
  turn: { inputTokens?: number; outputTokens?: number },
): { tokens: number; source: "steps" | "turn" } {
  if (fold && fold.tokens > 0) return { tokens: fold.tokens, source: "steps" };
  return {
    tokens: (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0),
    source: "turn",
  };
}

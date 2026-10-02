import type { RuntimeEvent } from "@anthelia/contracts";

/**
 * Discovery D5 / G-b — the internal-evaluation scorer: score a run from
 * its JOURNAL (replay is a fold, cheaper than any fork) and aggregate
 * the same-prompt distribution. Zero new telemetry: every input field
 * already exists in the journal (turn.submitted carries sha256 — the
 * prompt key — since P0).
 *
 * All reads are defensive: legacy events miss optional fields, and a
 * scorer that throws on old data is worse than one that reports what it
 * can see (missing numbers stay undefined, never zero-invented).
 */

export type TurnWindow = {
  turnID: string;
  /** The admission that asked for this turn (nearest preceding submit). */
  submitted?: { text: string; promptKey?: string };
  /** The turn's own events, lead admission included. */
  events: RuntimeEvent[];
};

export type RunScore = {
  sessionID?: string;
  turnID: string;
  promptKey?: string;
  promptPreview?: string;
  success?: boolean;
  stopReason?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Provider steps observed (step_usage events). */
  steps: number;
  /** The furthest retry attempt seen minus one (0 = no retry). */
  retries: number;
  /** Tool updates whose status read as failed. */
  toolsFailed: number;
};

export type RunGroup = {
  /** promptKey (sha256 prefix) or "unknown" when a turn has no admission text. */
  promptKey: string;
  runs: number;
  successes: number;
  successRate: number;
  avgInputTokens?: number;
  avgOutputTokens?: number;
  avgDurationMs?: number;
  avgSteps: number;
  retries: number;
  lastAt?: string;
};

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Splits a session's events into per-turn windows: the window opens at
 * turn.started(id) (carrying the nearest preceding turn.submitted as the
 * prompt) and closes at turn.finished(id). Events outside any turn (boot,
 * title) do not score.
 */
export function segmentTurns(events: readonly RuntimeEvent[]): TurnWindow[] {
  const windows: TurnWindow[] = [];
  let lead: TurnWindow["submitted"];
  let open: TurnWindow | undefined;
  for (const event of events) {
    if (event.type === "turn.submitted") {
      const promptKey =
        typeof event.sha256 === "string" ? event.sha256 : undefined;
      lead = { text: event.text, promptKey };
      if (open && !open.submitted) open.submitted = lead;
      continue;
    }
    if (event.type === "turn.started") {
      open = { turnID: event.id, submitted: lead, events: [event] };
      windows.push(open);
      continue;
    }
    if (open) open.events.push(event);
    if (event.type === "turn.finished" && open && event.id === open.turnID)
      open = undefined;
  }
  return windows;
}

export function scoreRun(
  window: TurnWindow,
  extra: { sessionID?: string } = {},
): RunScore {
  let inputTokens = 0;
  let outputTokens = 0;
  let steps = 0;
  let furthestAttempt = 1;
  let toolsFailed = 0;
  let stopReason: string | undefined;
  let durationMs: number | undefined;
  for (const event of window.events) {
    if (event.type === "runtime.step_usage") {
      steps += 1;
      inputTokens += num(event.inputTokens) ?? 0;
      outputTokens += num(event.outputTokens) ?? 0;
    }
    const attempt = (event as { attempt?: number }).attempt;
    if (typeof attempt === "number")
      furthestAttempt = Math.max(furthestAttempt, attempt);
    if (event.type === "tool.update") {
      const status = (event as { status?: string }).status;
      if (status === "failed") toolsFailed += 1;
    }
    if (event.type === "turn.finished") {
      stopReason = (event as { stopReason?: string }).stopReason;
      durationMs = num((event as { durationMs?: number }).durationMs);
    }
  }
  return {
    ...extra,
    turnID: window.turnID,
    promptKey: window.submitted?.promptKey,
    promptPreview: window.submitted?.text.slice(0, 80),
    success: stopReason === "done",
    stopReason,
    durationMs,
    inputTokens,
    outputTokens,
    steps,
    retries: furthestAttempt - 1,
    toolsFailed,
  };
}

const average = (values: number[]): number | undefined =>
  values.length
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : undefined;

export function groupRunsByPrompt(scores: readonly RunScore[]): RunGroup[] {
  const byKey = new Map<string, RunScore[]>();
  for (const score of scores) {
    const key = score.promptKey ?? "unknown";
    const bucket = byKey.get(key) ?? [];
    bucket.push(score);
    byKey.set(key, bucket);
  }
  return [...byKey.entries()].map(([promptKey, runs]) => ({
    promptKey,
    runs: runs.length,
    successes: runs.filter((run) => run.success).length,
    successRate: runs.length
      ? Math.round(
          (runs.filter((run) => run.success).length / runs.length) * 100,
        )
      : 0,
    avgInputTokens: average(runs.map((run) => run.inputTokens ?? 0)),
    avgOutputTokens: average(runs.map((run) => run.outputTokens ?? 0)),
    avgDurationMs: average(
      runs.flatMap((run) =>
        run.durationMs === undefined ? [] : [run.durationMs],
      ),
    ),
    avgSteps: average(runs.map((run) => run.steps)) ?? 0,
    retries: runs.reduce((sum, run) => sum + run.retries, 0),
  }));
}

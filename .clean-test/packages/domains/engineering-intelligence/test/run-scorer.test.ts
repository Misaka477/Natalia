import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { groupRunsByPrompt, scoreRun, segmentTurns } from "../src/run-scorer";

/**
 * Discovery D5 / G-b — scoring the journal (replay = a fold) and the
 * same-prompt distribution. Defensive reads: legacy events miss fields,
 * and a scorer must report what it can see instead of throwing.
 */

const submitted = (text: string, sha256?: string) =>
  ({
    type: "turn.submitted",
    id: "adm_1",
    text,
    byteLength: text.length,
    lineCount: 1,
    ...(sha256 ? { sha256 } : {}),
  }) as unknown as RuntimeEvent;
const started = (id: string) => ({ type: "turn.started", id }) as RuntimeEvent;
const finished = (id: string, stopReason: string, durationMs: number) =>
  ({
    type: "turn.finished",
    id,
    stopReason,
    durationMs,
  }) as unknown as RuntimeEvent;
const usage = (input: number, output: number) =>
  ({
    type: "runtime.step_usage",
    id: "u",
    inputTokens: input,
    outputTokens: output,
  }) as unknown as RuntimeEvent;
const retried = () =>
  ({
    type: "content.delta",
    id: "d",
    text: "x",
    attempt: 3,
  }) as unknown as RuntimeEvent;
const toolFailed = () =>
  ({
    type: "tool.update",
    id: "t",
    toolName: "run_shell",
    status: "failed",
  }) as unknown as RuntimeEvent;
const boot = {
  type: "session.created",
  sessionID: "ses_a",
  title: "t",
} as unknown as RuntimeEvent;

test("segmentation opens at turn.started, carries the lead admission, closes on finished", () => {
  const windows = segmentTurns([
    boot,
    submitted("fix the parser", "sha-aaa111"),
    started("turn_1"),
    usage(10, 20),
    finished("turn_1", "done", 900),
    // boot-ish noise between turns must not join any window
    {
      type: "session.title.updated",
      sessionID: "ses_a",
      title: "x",
    } as unknown as RuntimeEvent,
    submitted("second prompt", "sha-bbb222"),
    started("turn_2"),
    finished("turn_2", "error", 120),
  ]);
  expect(windows).toHaveLength(2);
  expect(windows[0]!.turnID).toBe("turn_1");
  expect(windows[0]!.submitted?.promptKey).toBe("sha-aaa111");
  expect(windows[0]!.events.some((e) => e.type === "session.created")).toBe(
    false,
  );
  expect(windows[1]!.submitted?.promptKey).toBe("sha-bbb222");
});

test("scoreRun reads success, cost, steps, retries and tool failures defensively", () => {
  const [turn1] = segmentTurns([
    submitted("p", "sha-ccc333"),
    started("turn_1"),
    usage(100, 50),
    usage(30, 10),
    retried(),
    toolFailed(),
    finished("turn_1", "done", 1_500),
  ]);
  const score = scoreRun(turn1!, { sessionID: "ses_a" });
  expect(score).toMatchObject({
    sessionID: "ses_a",
    turnID: "turn_1",
    promptKey: "sha-ccc333",
    success: true,
    inputTokens: 130,
    outputTokens: 60,
    steps: 2,
    retries: 2,
    toolsFailed: 1,
    durationMs: 1_500,
  });
  // A legacy turn with no optional fields: zeros and undefined, never a throw.
  const bare = scoreRun({
    turnID: "turn_bare",
    events: [
      started("turn_bare"),
      finished("turn_bare", "cancelled", undefined as never),
    ],
  });
  expect(bare.success).toBe(false);
  expect(bare.inputTokens).toBe(0);
  expect(bare.durationMs).toBeUndefined();
  expect(bare.promptKey).toBeUndefined();
});

test("the same-prompt distribution aggregates runs, rates and retries", () => {
  const mk = (sha: string, done: boolean, tokens: number, retries: number) => ({
    turnID: `t_${Math.random()}`,
    promptKey: sha,
    success: done,
    inputTokens: tokens,
    outputTokens: 1,
    durationMs: done ? 100 : undefined,
    steps: 1,
    retries,
    toolsFailed: 0,
  });
  const groups = groupRunsByPrompt([
    mk("sha-aaa", true, 100, 0),
    mk("sha-aaa", false, 300, 2),
    mk("sha-bbb", true, 50, 0),
    mk("unknown", true, 10, 0),
  ]);
  const byKey = Object.fromEntries(groups.map((g) => [g.promptKey, g]));
  expect(byKey["sha-aaa"]).toMatchObject({
    runs: 2,
    successes: 1,
    successRate: 50,
    avgInputTokens: 200,
    retries: 2,
  });
  expect(byKey["sha-bbb"]!.successRate).toBe(100);
  expect(byKey["unknown"]!.runs).toBe(1);
  expect(byKey["sha-aaa"]!.avgDurationMs).toBe(100); // undefined durations drop out of the average
});

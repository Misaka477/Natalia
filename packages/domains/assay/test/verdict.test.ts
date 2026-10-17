import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import { foldVerdicts, parseVerdict, verdictFeedback } from "../src/verdict";

/**
 * S9's verdict pipe. The marker rule is what lets the auditor be a person:
 * a verdict opens with `VERDICT:` alone on its first line, and anything
 * she sends without it — a greeting, a joke — is never read as data.
 */

const verdictMessage = (text: string) =>
  ({
    type: "nia.collab.message",
    message: {
      id: "m1",
      threadID: "t1",
      from: "nia",
      to: "main_agent",
      kind: "chat",
      text,
      expectsReply: false,
      at: "2026-10-13T00:00:00.000Z",
    },
  }) as unknown as RuntimeEvent;

test("a marked verdict parses; chatter never does — that is the whole price of letting her be a person", () => {
  const parsed = parseVerdict(
    [
      "VERDICT:",
      "turn: turn_a",
      "judgment: bad",
      "reasons: the user asked for the rollback step and the answer skipped it",
    ].join("\n"),
  );
  expect(parsed).toEqual({
    turnID: "turn_a",
    judgment: "bad",
    reasons: "the user asked for the rollback step and the answer skipped it",
  });
  // Chatter: no marker, no parse — a joke never becomes a data point.
  expect(parseVerdict("姐姐今天也辛苦了，给你泡了茶")).toBeUndefined();
  expect(parseVerdict("VERDICT: 我觉得还行吧")).toBeUndefined();
  // The case that matters: chatter that happens to contain a field-like
  // line. Without the marker this would parse as a verdict and her small
  // talk would enter the dataset as data.
  expect(parseVerdict("judgment: 姐姐今天真好看")).toBeUndefined();
  expect(parseVerdict("turn: turn_a\njudgment: 顺手写的")).toBeUndefined();
  // A verdict that names no turn is parsed but unattributable.
  expect(parseVerdict("VERDICT:\njudgment: good")?.turnID).toBeUndefined();
});

test("a verdict attaches to its turn by name, and chatter never does", async () => {
  const events: RuntimeEvent[] = [
    {
      type: "turn.submitted",
      id: "turn_a_adm",
      text: "why is the build red",
      byteLength: 17,
      lineCount: 1,
      sha256: "sha-a",
    },
    { type: "turn.started", id: "turn_a" },
    {
      type: "content.delta",
      id: "turn_a_d",
      text: "the guard counts a new module and the import graph has one more edge than yesterday",
    },
    {
      type: "turn.finished",
      id: "turn_a",
      stopReason: "done",
      durationMs: 10,
    },
    // The user's follow-up: the ground truth.
    {
      type: "turn.submitted",
      id: "turn_b_adm",
      text: "不对，你跳过了回滚步骤",
      byteLength: 10,
      lineCount: 1,
      sha256: "sha-b",
    },
    { type: "turn.started", id: "turn_b" },
    {
      type: "content.delta",
      id: "turn_b_d",
      text: "你说得对，我补上回滚步骤并重新跑了一遍守卫确认通过",
    },
    {
      type: "turn.finished",
      id: "turn_b",
      stopReason: "done",
      durationMs: 10,
    },
    // Nia's independent reading, attached to turn_a by name.
    verdictMessage(
      [
        "VERDICT:",
        "turn: turn_a",
        "judgment: bad",
        "reasons: the user asked for the rollback step and the answer skipped it",
      ].join("\n"),
    ),
  ];
  // The fold attaches the named verdict to ITS turn and counts the
  // unattributed ones rather than dropping them.
  const { byTurn, unattributed } = foldVerdicts([
    ...events,
    verdictMessage("VERDICT:\njudgment: good"),
  ]);
  expect(byTurn.size).toBe(1);
  expect(byTurn.get("turn_a")?.judgment).toBe("bad");
  expect(unattributed).toBe(1);
});

test("the feedback text carries whichever sources exist", () => {
  expect(verdictFeedback({})).toBeUndefined();
  expect(verdictFeedback({ userFollowUp: "thanks" })).toBe("then: thanks");
  expect(verdictFeedback({ explicitRating: "down: skipped it" })).toBe(
    "user: down: skipped it",
  );
  expect(
    verdictFeedback({
      verdict: { judgment: "good", reasons: "answered the task" },
    }),
  ).toBe("nia: good — answered the task");
});

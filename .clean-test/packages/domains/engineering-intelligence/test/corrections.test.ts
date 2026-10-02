import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { deriveCorrectionPatterns, readCorrections } from "../src/corrections";

/**
 * G-d's contract: the human's repeated corrections across the journal's
 * three safe sources, clustered into固化 suggestions — a rule or a
 * skill the human keeps writing by hand. The suggestion names its
 * destination; it applies nothing (growth 默认不自授权).
 */

test("the three correction sources are read in their safe forms", () => {
  const events: RuntimeEvent[] = [
    {
      type: "mailbox.queued",
      id: "m1",
      messageID: "msg1",
      source: "user_via_live_chat",
      priority: "normal",
      intent: "constraint",
      text: "no curl in the sandbox",
      safeSummary: "no curl in the sandbox",
      deliveryPolicy: "next_safe_boundary",
      createdAt: "2026-09-24T10:00:00.000Z",
    } as unknown as RuntimeEvent,
    {
      type: "completion.human_validation",
      id: "v1",
      taskID: "t1",
      validation: "always ask before deleting",
      recordedAt: "2026-09-24T11:00:00.000Z",
    } as RuntimeEvent,
    {
      type: "decision.recorded",
      id: "d1",
      decision: "use the fast path",
      alternatives: [
        { option: "the safe path", rejectedReason: "too slow for this run" },
        {
          option: "the careful path",
          rejectedReason: "always ask before deleting",
        },
      ],
      status: "accepted",
    } as RuntimeEvent,
  ];
  const corrections = readCorrections(events);
  expect(corrections).toHaveLength(4);
  expect(corrections.map((entry) => entry.source)).toEqual([
    "mailbox",
    "human_validation",
    "rejected_alternative",
    "rejected_alternative",
  ]);
});

test("a repeated correction becomes a suggestion naming its destination", () => {
  const corrections = [
    { text: "Always ask before deleting.", source: "mailbox" as const },
    { text: "always ask before deleting", source: "human_validation" as const },
    { text: "a one-off note", source: "mailbox" as const },
  ];
  const report = deriveCorrectionPatterns(corrections);
  expect(report.suggestions).toHaveLength(1);
  expect(report.suggestions[0]).toMatchObject({
    capability: "always ask before deleting",
    observations: 2,
    destination: "rule",
    sources: ["mailbox", "human_validation"],
  });
  expect(report.considered).toEqual({ corrections: 3 });
});

test("the destination's classification: the behavioral default is a rule", () => {
  // Documentation knowledge -> a skill.
  expect(
    deriveCorrectionPatterns([
      { text: "keep the docs updated", source: "mailbox" },
      { text: "keep the docs updated", source: "human_validation" },
    ]).suggestions[0]!.destination,
  ).toBe("skill");
  // A text naming a tool -> a tool.
  expect(
    deriveCorrectionPatterns([
      { text: "use the batch tool here", source: "mailbox" },
      { text: "use the batch tool here", source: "human_validation" },
    ]).suggestions[0]!.destination,
  ).toBe("tool");
  // And the default: a behavioral constraint the journal keeps catching
  // is a constitution rule (NOT the gap classifier's tool default — the
  // correction taxonomy differs from the gap taxonomy).
  expect(
    deriveCorrectionPatterns([
      { text: "no network in tests", source: "mailbox" },
      { text: "no network in tests", source: "human_validation" },
    ]).suggestions[0]!.destination,
  ).toBe("rule");
});

test("an empty journal answers an empty report", () => {
  expect(deriveCorrectionPatterns([])).toEqual({
    suggestions: [],
    considered: { corrections: 0 },
  });
});

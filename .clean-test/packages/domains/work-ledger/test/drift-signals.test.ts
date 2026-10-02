import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { createDriftEvaluator, deriveDriftBehaviorSignals } from "../src";

function toolUpdate(
  name: string,
  status: "succeeded" | "failed",
  args = "",
): RuntimeEvent {
  return {
    type: "tool.update",
    id: `tu_${Math.random()}`,
    name,
    status,
    summary: "",
    argumentsDelta: args,
  } as unknown as RuntimeEvent;
}

test("deriveDriftBehaviorSignals classifies actions and collects failures with a hashed key", () => {
  const signals = deriveDriftBehaviorSignals([
    toolUpdate("read_file", "succeeded"),
    { type: "evidence.recorded", id: "e1" } as unknown as RuntimeEvent,
    toolUpdate("run_shell", "failed", "bun test"),
    toolUpdate("run_shell", "failed", "bun test"),
    toolUpdate("run_shell", "failed", "bun test"),
    { type: "completion.recorded", id: "c1" } as unknown as RuntimeEvent,
  ]);
  // Actions: tool_call, evidence, tool_call x3, completion.
  expect(signals.recentActions.map((a) => a.kind)).toEqual([
    "tool_call",
    "evidence.recorded",
    "tool_call",
    "tool_call",
    "tool_call",
    "completion.recorded",
  ]);
  // Three failed run_shell calls, all with the same args → the same key.
  expect(signals.recentFailures).toHaveLength(3);
  expect(signals.recentFailures.every((f) => f.toolName === "run_shell")).toBe(
    true,
  );
  expect(new Set(signals.recentFailures.map((f) => f.key)).size).toBe(1);
  // The key is a hash, never the raw args.
  expect(signals.recentFailures[0]!.key).not.toContain("bun test");
});

test("deriveDriftBehaviorSignals distinguishes different args by key", () => {
  const signals = deriveDriftBehaviorSignals([
    toolUpdate("run_shell", "failed", "bun test"),
    toolUpdate("run_shell", "failed", "bun run build"),
    toolUpdate("run_shell", "failed", "git status"),
  ]);
  expect(new Set(signals.recentFailures.map((f) => f.key)).size).toBe(3);
});

test("evaluateBehavior runs only the behaviour rules (no objective/contract spam)", () => {
  const evaluator = createDriftEvaluator({ openFindingIDs: () => new Set() });
  // Empty activity, no changes/contract: the objective rule would fire on a full
  // evaluate, but evaluateBehavior must not.
  const findings = evaluator.evaluateBehavior({
    sessionID: "ses_b",
    turnID: "t_b",
    objective: "ship it",
    currentActivity: "",
    applicableConstraints: [],
    changes: [],
    evidenceRefs: [],
    recentActions: Array.from({ length: 8 }, () => ({
      kind: "tool_call" as const,
    })),
  });
  expect(findings.map((f) => f.ruleHits?.[0]?.rule)).toEqual(["no_progress"]);
});

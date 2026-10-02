import { expect, test } from "bun:test";
import { ToolExecutionPipeline, type ToolExecutionInput } from "../src";

function input(
  overrides: Partial<ToolExecutionInput> = {},
): ToolExecutionInput {
  return {
    name: "probe",
    args: {},
    context: { workspaceRoot: "/tmp" },
    ...overrides,
  };
}

test("an allowed run executes, finalizes once, and freezes the result", async () => {
  let finalizes = 0;
  const pipeline = new ToolExecutionPipeline()
    .execute(async () => "raw")
    .finalize((content) => {
      finalizes++;
      return content.toUpperCase();
    });
  const run = await pipeline.run(input());
  expect(run.status).toBe("allowed");
  if (run.status !== "allowed") return;
  expect(run.result.content).toBe("RAW");
  expect(run.result.raw).toBe("raw");
  expect(finalizes).toBe(1);
  // The result is frozen: an observer cannot rewrite it.
  expect(Object.isFrozen(run.result)).toBe(true);
  expect(() => {
    (run.result as { content: string }).content = "mutated";
  }).toThrow();
});

test("the first deny in the pre waterfall stops the run", async () => {
  let executed = false;
  const pipeline = new ToolExecutionPipeline()
    .preStage(() => ({ decision: "allow" }))
    .preStage(() => ({ decision: "deny", reason: "policy" }))
    .preStage(() => ({ decision: "deny", reason: "unreachable" }))
    .execute(async () => {
      executed = true;
      return "never";
    });
  const run = await pipeline.run(input());
  expect(run).toEqual({ status: "denied", reason: "policy" });
  expect(executed).toBe(false);
});

test("an ask decision halts for approval before execution", async () => {
  let executed = false;
  const pipeline = new ToolExecutionPipeline()
    .preStage(() => ({ decision: "ask", reason: "side effect" }))
    .execute(async () => {
      executed = true;
      return "x";
    });
  const run = await pipeline.run(input());
  expect(run).toMatchObject({ status: "asking" });
  if (run.status === "asking") expect(run.decision.reason).toBe("side effect");
  expect(executed).toBe(false);
});

test("monotonic guards can only deny and cannot be undone", async () => {
  let executed = false;
  const pipeline = new ToolExecutionPipeline()
    .guard(() => undefined)
    .guard(() => "read-only workspace")
    .guard(() => "unreachable: a later guard cannot re-allow")
    .execute(async () => {
      executed = true;
      return "x";
    });
  const run = await pipeline.run(input());
  expect(run).toEqual({ status: "denied", reason: "read-only workspace" });
  expect(executed).toBe(false);
});

test("post stages accept, replace and block in order", async () => {
  const blocked = new ToolExecutionPipeline()
    .execute(async () => "content")
    .postStage(() => ({ decision: "block", feedback: "rejected by lint" }));
  expect(await blocked.run(input())).toEqual({
    status: "blocked",
    feedback: "rejected by lint",
  });

  const replaced = new ToolExecutionPipeline()
    .execute(async () => "content")
    .postStage(() => ({ decision: "replace", content: "redacted" }));
  const run = await replaced.run(input());
  expect(run.status).toBe("allowed");
  if (run.status === "allowed") expect(run.result.content).toBe("redacted");

  // The first block stops the rest of the post waterfall.
  let laterRan = false;
  const stopped = new ToolExecutionPipeline()
    .execute(async () => "content")
    .postStage(() => ({ decision: "block", feedback: "stop" }))
    .postStage(() => {
      laterRan = true;
      return { decision: "replace" as const, content: "nope" };
    });
  expect((await stopped.run(input())).status).toBe("blocked");
  expect(laterRan).toBe(false);
});

test("reordering the pre stages changes the outcome", async () => {
  const a = (i: ToolExecutionInput) =>
    i.name === "probe"
      ? { decision: "allow" as const }
      : { decision: "allow" as const };
  const b = () => ({ decision: "deny" as const, reason: "b denies" });
  // b first denies; a first allows, then b denies.
  const bFirst = new ToolExecutionPipeline().preStage(b).preStage(a);
  expect((await bFirst.run(input())).status).toBe("denied");
  const aFirst = new ToolExecutionPipeline().preStage(a).preStage(b);
  expect((await aFirst.run(input())).status).toBe("denied");
});

test("a decision-only pipeline allows without an execute stage", async () => {
  const run = await new ToolExecutionPipeline()
    .preStage(() => ({ decision: "allow" as const }))
    .run(input());
  expect(run.status).toBe("allowed");
  if (run.status === "allowed") expect(run.result.content).toBe("");
});

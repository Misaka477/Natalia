import { expect, test } from "bun:test";
import {
  applyPlanDocTick,
  evaluatePlanTaskState,
  parsePlanTasks,
  projectPlanTaskStates,
} from "../src/plan-task-state";

test("parsePlanTasks reads open, done and skipped checkboxes with depth", () => {
  const tasks = parsePlanTasks(
    [
      "# Plan",
      "",
      "- [ ] top-level open task",
      "- [x] top-level done task",
      "- [~] a skipped task",
      "  - [ ] a nested open task",
      "1. [x] a numbered done task",
      "",
      "Some prose that is not a task.",
    ].join("\n"),
  );
  expect(tasks).toHaveLength(5);
  expect(tasks[0]).toMatchObject({
    declaration: "open",
    depth: 0,
    text: "top-level open task",
  });
  expect(tasks[1]).toMatchObject({
    declaration: "done",
    text: "top-level done task",
  });
  expect(tasks[2]).toMatchObject({
    declaration: "skipped",
    text: "a skipped task",
  });
  expect(tasks[3]).toMatchObject({
    declaration: "open",
    depth: 1,
    text: "a nested open task",
  });
  expect(tasks[4]).toMatchObject({
    declaration: "done",
    text: "a numbered done task",
  });
  // Ids are stable document-order ordinals.
  expect(tasks.map((task) => task.id)).toEqual([
    "task:1",
    "task:2",
    "task:3",
    "task:4",
    "task:5",
  ]);
});

test("evaluatePlanTaskState is evidence-first: checked without evidence is a gap", () => {
  expect(
    evaluatePlanTaskState({ declaration: "done", hasEvidence: true }),
  ).toBe("verified");
  expect(
    evaluatePlanTaskState({ declaration: "done", hasEvidence: false }),
  ).toBe("gap");
  expect(
    evaluatePlanTaskState({ declaration: "open", hasEvidence: true }),
  ).toBe("in_progress");
  expect(
    evaluatePlanTaskState({ declaration: "open", hasEvidence: false }),
  ).toBe("pending");
  expect(
    evaluatePlanTaskState({ declaration: "skipped", hasEvidence: false }),
  ).toBe("skipped");
  // A skipped task stays skipped even if some evidence mentions it.
  expect(
    evaluatePlanTaskState({ declaration: "skipped", hasEvidence: true }),
  ).toBe("skipped");
});

test("projectPlanTaskStates matches evidence by taskID or by text reference", () => {
  const tasks = parsePlanTasks(
    [
      "- [ ] wire the runtime client",
      "- [x] add the parser",
      "- [x] ship docs",
    ].join("\n"),
  );
  const states = projectPlanTaskStates(tasks, [
    // Evidence references the "add the parser" task by its text.
    { objective: "add the parser tests", changePaths: [] },
    // Evidence references the runtime client task by taskID.
    { taskID: "task:1", changePaths: ["packages/framework/client"] },
  ]);
  expect(states.map((task) => [task.text, task.state])).toEqual([
    ["wire the runtime client", "in_progress"],
    ["add the parser", "verified"],
    // Checked but no evidence -> gap, not verified.
    ["ship docs", "gap"],
  ]);
});

test("applyPlanDocTick ticks and unticks an existing checkbox, leaving text intact", () => {
  const doc = [
    "# Plan",
    "",
    "- [ ] wire the runtime client",
    "- [x] add the parser",
  ].join("\n");
  const ticked = applyPlanDocTick(doc, {
    task: "wire the runtime client",
    done: true,
  });
  expect(ticked.ok).toBe(true);
  if (!ticked.ok) return;
  expect(ticked.action).toBe("ticked");
  expect(ticked.content).toContain("- [x] wire the runtime client");
  expect(ticked.content).toContain("- [x] add the parser");
  // The heading and label text are untouched.
  expect(ticked.content).toContain("# Plan");
  expect(ticked.content).toContain("wire the runtime client");

  const unticked = applyPlanDocTick(doc, {
    task: "add the parser",
    done: false,
  });
  expect(unticked.ok).toBe(true);
  if (!unticked.ok) return;
  expect(unticked.action).toBe("unticked");
  expect(unticked.content).toContain("- [ ] add the parser");
});

test("applyPlanDocTick matches a unique label substring", () => {
  const doc = ["- [ ] rewrite the tokenizer", "- [ ] add the parser"].join(
    "\n",
  );
  const hit = applyPlanDocTick(doc, { task: "tokenizer", done: true });
  expect(hit.ok).toBe(true);
  if (!hit.ok) return;
  expect(hit.content).toContain("- [x] rewrite the tokenizer");
  // The other task is not touched.
  expect(hit.content).toContain("- [ ] add the parser");
});

test("applyPlanDocTick refuses a non-matching or ambiguous task on a checklist plan", () => {
  const doc = ["- [ ] add the parser", "- [ ] add the tests"].join("\n");
  const missing = applyPlanDocTick(doc, { task: "ship the docs", done: true });
  expect(missing.ok).toBe(false);
  // "add the ..." matches two tasks — ambiguous, refused rather than guessed.
  const ambiguous = applyPlanDocTick(doc, { task: "add the", done: true });
  expect(ambiguous.ok).toBe(false);
});

test("applyPlanDocTick appends a 落地日志 section when the plan has no checkboxes", () => {
  const doc = [
    "# Design notes",
    "",
    "Some prose, no checkboxes here.",
    "",
  ].join("\n");
  const first = applyPlanDocTick(doc, { task: "wired the parser", done: true });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.action).toBe("logged");
  expect(first.content).toContain("## 落地日志");
  expect(first.content).toContain("- [x] wired the parser");
  // The original prose is preserved.
  expect(first.content).toContain("Some prose, no checkboxes here.");

  // A second tick extends the same section instead of adding another heading.
  const second = applyPlanDocTick(first.content, {
    task: "shipped the docs",
    done: true,
  });
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.content.match(/## 落地日志/g)).toHaveLength(1);
  expect(second.content).toContain("- [x] shipped the docs");
  expect(second.content).toContain("- [x] wired the parser");
});

test("applyPlanDocTick is idempotent and refuses an empty task", () => {
  const doc = ["- [x] done thing"].join("\n");
  const again = applyPlanDocTick(doc, { task: "done thing", done: true });
  expect(again.ok).toBe(true);
  if (!again.ok) return;
  expect(again.content).toBe(doc);
  expect(again.action).toBe("ticked");
  const empty = applyPlanDocTick(doc, { task: "   ", done: true });
  expect(empty.ok).toBe(false);
});

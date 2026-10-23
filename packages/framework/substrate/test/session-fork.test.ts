/**
 * The fork handoff's decisions, tested without a runtime.
 *
 * The reference libraries each got half of a handoff right; these tests
 * pin OUR half — the goal MOVES rather than being copied or abandoned —
 * because that is the difference between "the work continues elsewhere"
 * and "two sessions pursue the same objective" or "the child sits waiting
 * for a human".
 */
import { expect, test } from "bun:test";
import {
  buildForkNotice,
  childGoalArmed,
  planGoalMove,
  type ForkGoalInput,
} from "../src/session-fork";

const goal = (over: Partial<ForkGoalInput> = {}): ForkGoalInput => ({
  goalID: "g1",
  title: "把自迭代接完",
  phase: "active",
  roundsStarted: 2,
  revision: 5,
  ...over,
});

test("a continuation moves the goal and arms the child", () => {
  const plan = planGoalMove({ goal: goal(), continuation: true });
  expect(plan).toEqual({
    kind: "move",
    goal: goal(),
    parentReason: "handed_off",
  });
  expect(childGoalArmed(plan)).toBe(true);
});

test("a different task does not drag the goal along", () => {
  // The child would pursue the wrong objective; the parent's goal is
  // closed as superseded and the child gets only its prompt.
  const plan = planGoalMove({ goal: goal(), continuation: false });
  expect(plan.kind).toBe("supersede");
  if (plan.kind !== "supersede") throw new Error("unreachable");
  expect(plan.parentReason).toBe("superseded_by_fork");
  expect(childGoalArmed(plan)).toBe(false);
});

test("no goal, or a finished one, moves nothing", () => {
  expect(planGoalMove({ continuation: true })).toEqual({
    kind: "none",
    reason: "parent has no goal",
  });
  expect(
    planGoalMove({ goal: goal({ phase: "complete" }), continuation: true }),
  ).toEqual({ kind: "none", reason: "parent has no goal" });
});

test("a paused or blocked goal still owns the objective and moves", () => {
  // Paused is not finished: the child inherits something it can resume.
  for (const phase of ["paused", "blocked"] as const) {
    const plan = planGoalMove({ goal: goal({ phase }), continuation: true });
    expect(plan.kind).toBe("move");
  }
});

test("the notice says where the child came from", () => {
  const notice = buildForkNotice({
    parentSessionID: "ses_parent",
    parentWorkspace: "E:\\proj",
    childWorkspace: "E:\\proj",
    cutAt: "turn 7",
  });
  expect(notice).toContain("forked from ses_parent");
  expect(notice).toContain("inherited context");
});

test("a cross-workspace fork warns that the tree changed", () => {
  // The whole point of this notice: `packages/**` exists in BOTH trees, so
  // a stale path is not a missing file — it is a file with different
  // content, which is the hardest kind of wrong to notice.
  const notice = buildForkNotice({
    parentSessionID: "ses_parent",
    parentWorkspace: "E:\\proj",
    childWorkspace: "E:\\Natalia\\source",
    cutAt: "turn 7",
  });
  expect(notice).toContain("DIFFERENT WORKSPACE");
  expect(notice).toContain("E:\\Natalia\\source");
  expect(notice).toContain("read before you");
});

test("a same-workspace fork does not warn about a tree change", () => {
  const notice = buildForkNotice({
    parentSessionID: "ses_parent",
    parentWorkspace: "E:\\proj",
    childWorkspace: "E:\\proj",
    cutAt: "turn 7",
  });
  expect(notice).not.toContain("DIFFERENT WORKSPACE");
});

test("a moved goal is announced as armed, and the parent as closed", () => {
  const notice = buildForkNotice({
    parentSessionID: "ses_parent",
    parentWorkspace: "E:\\proj",
    childWorkspace: "E:\\proj",
    cutAt: "turn 7",
    goal: { title: "接完自迭代", moved: true },
  });
  expect(notice).toContain("now ARMED");
  expect(notice).toContain("without waiting for a human message");
  expect(notice).toContain("handed off");
});

test("a superseded goal is announced as NOT the child's task", () => {
  const notice = buildForkNotice({
    parentSessionID: "ses_parent",
    parentWorkspace: "E:\\proj",
    childWorkspace: "E:\\proj",
    cutAt: "turn 7",
    goal: { title: "别的事", moved: false },
  });
  expect(notice).toContain("superseded");
  expect(notice).toContain("did NOT move here");
  expect(notice).not.toContain("ARMED");
});

test("an unresolved tail is announced with a no-blind-retry rule", () => {
  // The cut landed mid-tool-call: the outcome is unknowable from here, and
  // retrying blindly is how a side effect happens twice.
  const notice = buildForkNotice({
    parentSessionID: "ses_parent",
    parentWorkspace: "E:\\proj",
    childWorkspace: "E:\\proj",
    cutAt: "turn 7",
    unresolvedToolCall: "computer_click",
  });
  expect(notice).toContain("computer_click");
  expect(notice).toContain("read-only or idempotent");
  expect(notice).toContain("Do not retry blindly");
});

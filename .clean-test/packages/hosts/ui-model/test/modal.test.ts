import { expect, test } from "bun:test";
import {
  approvalPresenter,
  createPendingController,
  normalizePendingItems,
  pendingToolLink,
  questionPresenter,
  type PendingItem,
} from "../src/modal";

test("normalizePendingItems orders approvals before questions and links tool cards", () => {
  const items = normalizePendingItems({
    approvals: [
      {
        id: "turn_a:call_1",
        title: "Approve run_shell",
        preview: "rm -rf build",
      },
    ],
    questions: [
      {
        id: "turn_a:call_2:question",
        title: "Pick one",
        questions: [
          {
            id: "q0",
            header: "Q",
            question: "Which?",
            options: [{ label: "a" }, { label: "b" }],
          },
        ],
      },
    ],
  });
  expect(items.map((item) => item.kind)).toEqual(["approval", "question"]);
  expect(items[0]!.tool?.messageID).toBe("turn_a:tool:call_1");
  expect(items[1]!.tool?.messageID).toBe("turn_a:tool:call_2");
  expect(items[0]!.priority).toBeLessThan(items[1]!.priority);
});

test("pendingToolLink ignores non-turn request ids", () => {
  expect(pendingToolLink("plan_acceptance:123")).toBeUndefined();
  expect(pendingToolLink("turn_a:call_1:question")?.turnID).toBe("turn_a");
});

test("approval presenter maps actions to decisions", () => {
  const item = normalizePendingItems({
    approvals: [{ id: "turn_a:call_1", title: "t", preview: "p" }],
  })[0]!;
  expect(
    approvalPresenter.buildResponse(item, { action: "allow-once" }),
  ).toEqual({ requestID: "turn_a:call_1", decision: "once" });
  expect(
    approvalPresenter.buildResponse(item, { action: "allow-session" }),
  ).toEqual({ requestID: "turn_a:call_1", decision: "session" });
  expect(
    approvalPresenter.buildResponse(item, {
      action: "reject",
      feedback: "no",
    }),
  ).toEqual({ requestID: "turn_a:call_1", decision: "reject", feedback: "no" });
  expect(
    approvalPresenter.buildResponse(item, { action: "allow-project" }),
  ).toEqual({ requestID: "turn_a:call_1", decision: "project" });
});

test("the project tier is offered unless the approval is forced", () => {
  // The forced gate: a request carrying allowProject:false (git writes,
  // rule-class changes) never offers the standing grant — the same shape
  // the session tier has always had.
  const offered = normalizePendingItems({
    approvals: [{ id: "a", title: "t", preview: "p" }],
  })[0]!;
  expect(approvalPresenter.actions(offered).map((action) => action.id)).toEqual(
    ["allow-once", "allow-session", "allow-project", "reject"],
  );
  const forced = normalizePendingItems({
    approvals: [
      {
        id: "b",
        title: "t",
        preview: "p",
        allowProject: false,
        allowSession: false,
      },
    ],
  })[0]!;
  expect(approvalPresenter.actions(forced).map((action) => action.id)).toEqual([
    "allow-once",
    "reject",
  ]);
});

test("question presenter keeps selections and custom text separate", () => {
  const item = normalizePendingItems({
    questions: [
      {
        id: "turn_a:call_1:question",
        title: "Pick",
        questions: [
          {
            id: "q0",
            header: "Q",
            question: "Which?",
            options: [{ label: "a" }, { label: "b" }],
            multiple: true,
            custom: true,
          },
        ],
      },
    ],
  })[0] as PendingItem;
  expect(
    questionPresenter.buildResponse(item, {
      selections: [["a", "b"]],
      custom: ["other"],
    }),
  ).toEqual({
    requestID: "turn_a:call_1:question",
    answers: [["a", "b", "other"]],
  });
  // Custom text alone still submits even when no option was selected.
  expect(
    questionPresenter.buildResponse(item, {
      selections: [[]],
      custom: ["typed"],
    }),
  ).toEqual({ requestID: "turn_a:call_1:question", answers: [["typed"]] });
  // Reject never leaks selections.
  expect(
    questionPresenter.buildResponse(item, {
      selections: [["a"]],
      custom: ["x"],
      rejected: true,
    }),
  ).toEqual({
    requestID: "turn_a:call_1:question",
    answers: [],
    rejected: true,
  });
});

test("pending controller dismisses, focuses and prunes live ids", () => {
  let revisions = 0;
  const controller = createPendingController(() => {
    revisions += 1;
  });
  controller.focus("a");
  controller.dismiss("a");
  expect(controller.activeID()).toBeUndefined();
  expect(controller.isDismissed("a")).toBe(true);
  // A dismissed request that leaves the live set is forgotten.
  controller.prune(new Set<string>());
  expect(controller.isDismissed("a")).toBe(false);
  // Focusing a live request clears a previous dismissal.
  controller.dismiss("b");
  controller.prune(new Set(["b"]));
  controller.focus("b");
  expect(controller.isDismissed("b")).toBe(false);
  expect(controller.activeID()).toBe("b");
  expect(revisions).toBeGreaterThan(0);
});

test("normalizePendingItems carries a generic interactive kind through", () => {
  const items = normalizePendingItems({
    interactives: [
      {
        id: "ix1",
        kind: "custom.kind",
        title: "Pick one",
        payload: { options: ["a"] },
        priority: 5,
      },
    ],
  });
  expect(items).toEqual([
    expect.objectContaining({
      id: "ix1",
      kind: "custom.kind",
      title: "Pick one",
      priority: 5,
    }),
  ]);
});

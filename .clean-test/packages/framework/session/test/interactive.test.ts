import { expect, test } from "bun:test";
import { projectInteractiveRequests } from "../src";

test("interactive projection retains only requests without durable replies", () => {
  const projection = projectInteractiveRequests([
    {
      type: "approval.request",
      id: "approval_open",
      title: "Write",
      preview: "a",
    },
    {
      type: "approval.request",
      id: "approval_closed",
      title: "Shell",
      preview: "b",
    },
    { type: "approval.response", id: "approval_closed", decision: "once" },
    { type: "question.request", id: "question_open", title: "Choice" },
    { type: "question.request", id: "question_closed", title: "Done" },
    { type: "question.response", id: "question_closed", answers: [["yes"]] },
  ]);
  expect(projection.approvals.map((request) => request.id)).toEqual([
    "approval_open",
  ]);
  expect(projection.questions.map((request) => request.id)).toEqual([
    "question_open",
  ]);
});

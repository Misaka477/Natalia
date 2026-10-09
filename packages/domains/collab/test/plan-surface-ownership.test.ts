import { expect, test } from "bun:test";
import { createPlanProposeTool } from "../src/plan-contract-tools";
import type { RuntimeContext } from "@anthelia/substrate";

/**
 * The per-surface tool surface (the 2026-10-10 sweep's F6/F8).
 *
 * `plan_propose` is shared by the main agent and Navi, but only Navi holds
 * `mailbox_send` — so the shared tool's description used to tell BOTH of them
 * to hand off with a tool half of them do not have. The handoff sentence is
 * now the caller's, and only the surface that holds the tool names it.
 */

const ctx = { ports: {}, state: {} } as unknown as RuntimeContext;

test("the default plan_propose never names a tool the caller may lack", () => {
  const tool = createPlanProposeTool(ctx);
  expect(tool.description).not.toContain("mailbox_send");
  expect(tool.description).toContain("the runtime routes the accepted plan");
});

test("a surface that holds the mailbox tool says so, and only that one", () => {
  const navi = createPlanProposeTool(ctx, {
    handoff:
      "When accepted, hand the plan off with mailbox_send next_plan_handoff (Navi's own mailbox tool).",
  });
  expect(navi.description).toContain("mailbox_send next_plan_handoff");
  // And the main agent's copy is untouched by it.
  expect(createPlanProposeTool(ctx).description).not.toContain("mailbox_send");
});

import { expect, test } from "bun:test";
import { planDocMarkTool, planDocWriteTool } from "@natalia/collab";

/**
 * EI §8.1: plan provenance follows the caller. The Live Work Chat tools (used
 * by Navi) must pass createdBy:"live_chat" through to the plan-doc runtime —
 * the runtime records it, but only if the tool forwards it.
 */
test("Navi's plan_doc_write / plan_doc_mark forward createdBy live_chat", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const ctx = {
    ports: {
      planDocRuntime: {
        planDocWrite: async (input: Record<string, unknown>) => {
          calls.push(input);
          return { planID: "plan_1", documentPath: input.path };
        },
        planDocMark: async (input: Record<string, unknown>) => {
          calls.push(input);
          return { planID: "plan_1" };
        },
      },
    },
  } as never;

  await planDocWriteTool(ctx, "write a plan", "live_chat").execute(
    { path: "plans/x.md", content: "# x" },
    {} as never,
  );
  await planDocMarkTool(ctx, "live_chat").execute(
    { path: "plans/x.md" },
    {} as never,
  );

  expect(calls[0]).toMatchObject({ createdBy: "live_chat" });
  expect(calls[1]).toMatchObject({ createdBy: "live_chat" });
});

test("without an explicit caller the plan tools omit createdBy (runtime default)", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const ctx = {
    ports: {
      planDocRuntime: {
        planDocMark: async (input: Record<string, unknown>) => {
          calls.push(input);
          return { planID: "plan_1" };
        },
      },
    },
  } as never;
  await planDocMarkTool(ctx).execute({ path: "plans/x.md" }, {} as never);
  expect(calls[0]).not.toHaveProperty("createdBy");
});

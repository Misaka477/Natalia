import { expect, test } from "bun:test";
import {
  ASK_PLUGIN_ID,
  askToolFamily,
  askTools,
  createAskPlugin,
} from "../src";
import { createPluginRegistry } from "@anthelia/plugin";
import { createToolRegistry } from "@anthelia/tools";

test("the ask family describes the tool it ships", () => {
  const family = askToolFamily();
  expect(family.id).toBe("ask");
  expect(family.scope).toBe("session");
  expect(family.tools).toEqual(askTools);
});

test("the ask plugin owns its stable tool and unloads cleanly", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(createAskPlugin());
  expect(registry.list()[0]).toMatchObject({
    id: ASK_PLUGIN_ID,
    scope: "session",
  });
  expect(tools.has("ask_user")).toBe(true);
  await registry.unload(ASK_PLUGIN_ID);
  expect(tools.has("ask_user")).toBe(false);
});

test("ask_user refuses when the host has no interactive channel", async () => {
  const tool = askToolFamily().tools[0]!;
  await expect(
    tool.execute({ question: "q", options: ["a"] }, {} as never),
  ).rejects.toThrow("interactive question channel unavailable");
});

test("ask_user delegates to the runtime question channel", async () => {
  const result = await askTools[0]!.execute(
    { question: "Pick one", options: ["yes", "no"] },
    {
      workspaceRoot: "/workspace",
      askQuestion: async (request) => {
        expect(request.questions[0]?.options).toEqual([
          { label: "yes" },
          { label: "no" },
        ]);
        return [["yes"]];
      },
    },
  );
  expect(result).toContain("yes");
});

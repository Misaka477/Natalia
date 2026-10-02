import { expect, test } from "bun:test";
import { createToolRegistry, materializeTools, type RuntimeTool } from "../src";

const echo = (label = "echo"): RuntimeTool => ({
  name: "echo",
  description: "Echo one string",
  requiresApproval: false,
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  async execute(input) {
    return `${label}:${(input as { text: string }).text}`;
  },
});

const invocation = {
  sessionID: "ses_tool_invocation",
  agentID: "build",
  assistantMessageID: "msg_tool_invocation",
  toolCallID: "call_tool_invocation",
  name: "echo",
  arguments: { text: "hello" },
} as const;

test("materialized tools validate input and preserve invocation identity", async () => {
  const materialized = materializeTools(createToolRegistry([echo()]));
  expect(materialized.definitions).toMatchObject([
    { name: "echo", description: "Echo one string" },
  ]);
  await expect(
    materialized.settle(invocation, { workspaceRoot: "/tmp" }),
  ).resolves.toEqual({
    status: "succeeded",
    output: "echo:hello",
  });
  await expect(
    materialized.settle(
      { ...invocation, arguments: { unexpected: true } },
      { workspaceRoot: "/tmp" },
    ),
  ).resolves.toMatchObject({
    status: "failed",
    error: expect.stringContaining("Invalid tool input"),
  });
});

test("materialized tools report numeric bounds with the failing field", async () => {
  const bounded: RuntimeTool = {
    ...echo(),
    parameters: {
      type: "object",
      properties: { offset: { type: "integer", minimum: 1 } },
      required: ["offset"],
      additionalProperties: false,
    },
  };
  const materialized = materializeTools(createToolRegistry([bounded]));

  await expect(
    materialized.settle(
      { ...invocation, arguments: { offset: 0 } },
      { workspaceRoot: "/tmp" },
    ),
  ).resolves.toEqual({
    status: "failed",
    error: "Invalid tool input: offset: must be at least 1",
  });
});

test("materialized tools reject removed and replaced registrations as stale", async () => {
  const registry = createToolRegistry([echo("first")]);
  const materialized = materializeTools(registry);
  registry.set("echo", echo("second"));
  expect(materialized.resolve("echo")).toEqual({
    status: "stale",
    error: "Stale tool call: echo",
  });
  await expect(
    materialized.settle(invocation, { workspaceRoot: "/tmp" }),
  ).resolves.toEqual({
    status: "stale",
    error: "Stale tool call: echo",
  });
  registry.delete("echo");
  await expect(
    materialized.settle(invocation, { workspaceRoot: "/tmp" }),
  ).resolves.toEqual({
    status: "stale",
    error: "Stale tool call: echo",
  });
});

test("materialized tools report names absent at provider turn creation as unknown", async () => {
  const registry = createToolRegistry([]);
  const materialized = materializeTools(registry);
  registry.set("echo", echo());
  expect(materialized.resolve("echo")).toEqual({
    status: "unknown",
    error: "Unknown tool: echo",
  });
  await expect(
    materialized.settle(invocation, { workspaceRoot: "/tmp" }),
  ).resolves.toEqual({
    status: "unknown",
    error: "Unknown tool: echo",
  });
});

import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "@anthelia/plugin";
import { mcpService, type McpService } from "@anthelia/runtime-services";
import { createToolRegistry } from "@anthelia/tools";
import { createMcpPlugin, MCP_PLUGIN_ID } from "../src";
import { createMcpController } from "../src/mcp-controller";

const SERVER = String.raw`
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (!("id" in message)) return;
  let result = {};
  if (message.method === "initialize") {
    result = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1" },
    };
  } else if (message.method === "tools/list") {
    result = {
      tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }],
    };
  } else if (message.method === "prompts/list") {
    result = { prompts: [] };
  } else if (message.method === "resources/list") {
    result = { resources: [] };
  }
  console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});
`;

test("MCP controller reload is a no-op when the extension is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-mcp-controller-"));
  const events: Array<{ type: string }> = [];
  const controller = createMcpController({
    servers: () => ({}),
    workspaceRoot: root,
    tools: { register: () => () => undefined },
    enabled: () => false,
    publish: (event) => events.push(event),
  });
  await controller.reload();
  expect(await controller.catalog()).toEqual({ prompts: [], resources: [] });
  await expect(
    controller.readResource("missing", "file:///missing"),
  ).rejects.toThrow("MCP server is not connected: missing");
  await controller.close();
  expect(events).toHaveLength(0);
});

test("MCP plugin unload owns connection and tool teardown", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-mcp-plugin-"));
  const tools = createToolRegistry([]);
  let service: McpService | undefined;
  const contributions: Array<[kind: string, name: string]> = [];
  const registry = createPluginRegistry({
    tools,
    registerOwner: async () => ({
      contribute: (kind, name, payload) => {
        contributions.push([kind, name]);
        if (kind === "services" && name === mcpService.id)
          service = payload as McpService;
        return () => undefined;
      },
      release: () => undefined,
    }),
  });
  const plugin = createMcpPlugin({
    servers: () => ({
      fixture: {
        type: "stdio",
        command: process.execPath,
        args: ["-e", SERVER],
        headers: {},
        environment: {},
        allowedTools: [],
        excludedTools: [],
        readOnly: true,
        enabled: true,
        timeoutSec: 5,
      },
    }),
    workspaceRoot: root,
    enabled: () => true,
    publish: () => undefined,
  });
  expect(plugin.manifest).toMatchObject({
    integrationPoints: ["tools", "services"],
  });
  await registry.load(plugin);
  expect(service).toBeDefined();
  await service?.reload();
  expect(tools.get("mcp_fixture_echo")).toBeDefined();
  expect(await service?.catalog()).toEqual({ prompts: [], resources: [] });
  expect(contributions).toContainEqual(["tools", "mcp_fixture_echo"]);
  await registry.unload(MCP_PLUGIN_ID);
  expect(tools.get("mcp_fixture_echo")).toBeUndefined();
  await expect(
    service?.readResource("fixture", "file:///missing"),
  ).rejects.toThrow("MCP server is not connected: fixture");
});

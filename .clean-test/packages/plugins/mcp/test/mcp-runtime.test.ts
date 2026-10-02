import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolRegistry } from "@anthelia/tools";
import {
  HttpMCPClient,
  inspectMCPCatalog,
  loadNativeMCPTools,
  mcpToolToRuntimeTool,
  StdioMCPClient,
} from "../src/mcp-runtime";

function toolRegistrar(registry: ReturnType<typeof createToolRegistry>) {
  return {
    register(tool: Parameters<typeof registry.set>[1]) {
      registry.set(tool.name, tool);
      return () => {
        if (registry.get(tool.name) === tool) registry.delete(tool.name);
      };
    },
  };
}

const SERVER = String.raw`
import json, sys, time
for line in sys.stdin:
  message = json.loads(line)
  if "id" not in message:
    continue
  method = message["method"]
  if method == "initialize":
    result = {"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}
  elif method == "tools/list":
    result = {"tools":[{"name":"echo","description":"echo","inputSchema":{"type":"object"}}]}
  elif method == "tools/call":
    result = {"content":[{"type":"text","text":message["params"]["arguments"]["value"]}]}
  else:
    result = {}
  print(json.dumps({"jsonrpc":"2.0","id":message["id"],"result":result}), flush=True)
`;

const MALFORMED_SERVER = String.raw`
import sys
for line in sys.stdin:
  print('{not-json', flush=True)
`;

/**
 * `python3` is not a valid command on stock Windows installs. The fixtures
 * prefer the platform's python, and the stdio tests are skipped entirely when
 * no interpreter is available so a bare dev box still reports green.
 */
async function resolvePython(): Promise<string | undefined> {
  const candidates =
    process.platform === "win32"
      ? ["python", "python3", "py"]
      : ["python3", "python"];
  for (const candidate of candidates) {
    try {
      const probe = Bun.spawn([candidate, "--version"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if ((await probe.exited) === 0) return candidate;
    } catch {
      // candidate not on PATH
    }
  }
  return undefined;
}

const python = await resolvePython();
const pythonCommand = python ?? "python3";
const pythonTest = python ? test : test.skip;

test("native stdio MCP client initializes, lists and calls tools", async () => {
  const client = await StdioMCPClient.connect({
    command: pythonCommand,
    args: ["-u", "-c", SERVER],
  });
  expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
  expect(await client.callTool("echo", { value: "mcp-ok" })).toEqual({
    content: [{ type: "text", text: "mcp-ok" }],
  });
  const tool = mcpToolToRuntimeTool(client, (await client.listTools())[0]!);
  expect(
    await tool.execute({ value: "wrapped" }, { workspaceRoot: process.cwd() }),
  ).toContain("wrapped");
  await client.close();
});

pythonTest(
  "native stdio MCP rejects promptly on malformed server output",
  async () => {
    await expect(
      StdioMCPClient.connect({
        command: pythonCommand,
        args: ["-u", "-c", MALFORMED_SERVER],
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("malformed JSON-RPC");
  },
);

test("MCP runtime tools surface server errors and preserve structured-only results", async () => {
  const failing = mcpToolToRuntimeTool(
    {
      async callTool() {
        return {
          isError: true,
          content: [{ type: "text", text: "bad input" }],
        };
      },
    },
    { name: "fail", inputSchema: { type: "object" } },
  );
  await expect(
    failing.execute({}, { workspaceRoot: process.cwd() }),
  ).rejects.toThrow("bad input");

  const structured = mcpToolToRuntimeTool(
    {
      async callTool() {
        return { content: [], structuredContent: { answer: "ok" } };
      },
    },
    { name: "structured", inputSchema: { type: "object" } },
  );
  expect(
    JSON.parse(await structured.execute({}, { workspaceRoot: process.cwd() })),
  ).toEqual({
    content: [{ type: "text", text: JSON.stringify({ answer: "ok" }) }],
  });
});

test("native HTTP MCP client authenticates and calls a remote MCP endpoint", async () => {
  const methods: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      expect(request.headers.get("authorization")).toBe("Bearer local-token");
      const message = (await request.json()) as {
        id: number;
        method: string;
        params: { arguments?: { value?: string } };
      };
      methods.push(message.method);
      const result =
        message.method === "tools/list"
          ? {
              tools: [{ name: "remote_echo", inputSchema: { type: "object" } }],
            }
          : message.method === "tools/call"
            ? {
                content: [
                  { type: "text", text: message.params.arguments?.value },
                ],
              }
            : {};
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  });
  try {
    const client = await HttpMCPClient.connect({
      url: server.url.toString(),
      token: "local-token",
    });
    expect((await client.listTools()).map((tool) => tool.name)).toEqual([
      "remote_echo",
    ]);
    expect(await client.callTool("remote_echo", { value: "http-ok" })).toEqual({
      content: [{ type: "text", text: "http-ok" }],
    });
    expect(methods).toContain("notifications/initialized");
  } finally {
    server.stop(true);
  }
});

test("native HTTP MCP forwards configured static headers and request timeout", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      expect(request.headers.get("x-mcp-key")).toBe("local-key");
      const message = (await request.json()) as { id: number };
      return Response.json({ jsonrpc: "2.0", id: message.id, result: {} });
    },
  });
  try {
    await HttpMCPClient.connect({
      url: server.url.toString(),
      headers: { "x-mcp-key": "local-key" },
      timeoutMs: 1_000,
    });
  } finally {
    server.stop(true);
  }
});

test("MCP catalog paginates tools, prompts, and resources", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const message = (await request.json()) as {
        id: number;
        method: string;
        params: { cursor?: string };
      };
      const first = !message.params.cursor;
      const result =
        message.method === "initialize"
          ? {}
          : message.method === "tools/list"
            ? first
              ? {
                  tools: [{ name: "first", inputSchema: { type: "object" } }],
                  nextCursor: "tools-next",
                }
              : { tools: [{ name: "second", inputSchema: { type: "object" } }] }
            : message.method === "prompts/list"
              ? first
                ? { prompts: [{ name: "brief" }], nextCursor: "prompts-next" }
                : { prompts: [{ name: "detail" }] }
              : message.method === "resources/list"
                ? first
                  ? {
                      resources: [{ name: "guide", uri: "file:///guide" }],
                      nextCursor: "resources-next",
                    }
                  : { resources: [{ name: "notes", uri: "file:///notes" }] }
                : {};
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  });
  try {
    const catalog = await inspectMCPCatalog(
      await HttpMCPClient.connect({ url: server.url.toString() }),
    );
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect(catalog.prompts.map((prompt) => prompt.name)).toEqual([
      "brief",
      "detail",
    ]);
    expect(catalog.resources.map((resource) => resource.uri)).toEqual([
      "file:///guide",
      "file:///notes",
    ]);
  } finally {
    server.stop(true);
  }
});

test("native MCP loader registers catalog-backed prompt and resource runtime tools", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const message = (await request.json()) as {
        id: number;
        method: string;
        params: {
          name?: string;
          uri?: string;
          arguments?: Record<string, string>;
        };
      };
      const result =
        message.method === "initialize"
          ? {}
          : message.method === "tools/list"
            ? { tools: [] }
            : message.method === "prompts/list"
              ? { prompts: [{ name: "review" }] }
              : message.method === "resources/list"
                ? { resources: [{ uri: "file:///guide", name: "guide" }] }
                : message.method === "prompts/get"
                  ? {
                      description: "review prompt",
                      messages: [
                        {
                          role: "user",
                          content: {
                            type: "text",
                            text: message.params.arguments?.scope ?? "all",
                          },
                        },
                      ],
                    }
                  : message.method === "resources/read"
                    ? {
                        contents: [
                          { uri: message.params.uri, text: "guide content" },
                        ],
                      }
                    : {};
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  });
  try {
    const registry = createToolRegistry([]);
    const result = await loadNativeMCPTools({
      tools: toolRegistrar(registry),
      workspaceRoot: process.cwd(),
      servers: {
        fixture: {
          type: "http",
          url: server.url.toString(),
          args: [],
          headers: {},
          environment: {},
          allowedTools: [],
          excludedTools: [],
          readOnly: true,
          enabled: true,
        },
      },
    });
    const prompt = registry.get("mcp_fixture_prompt_get");
    const resource = registry.get("mcp_fixture_resource_read");
    expect(prompt?.requiresApproval).toBe(false);
    expect(resource?.requiresApproval).toBe(false);
    expect(
      await prompt!.execute(
        { name: "review", arguments: { scope: "local" } },
        { workspaceRoot: process.cwd() },
      ),
    ).toContain("local");
    expect(
      await resource!.execute(
        { uri: "file:///guide" },
        { workspaceRoot: process.cwd() },
      ),
    ).toContain("guide content");
    await result.close();
  } finally {
    server.stop(true);
  }
});

test("MCP catalog rejects repeated pagination cursors", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const message = (await request.json()) as { id: number; method: string };
      const result =
        message.method === "initialize"
          ? {}
          : { tools: [], nextCursor: "repeat" };
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  });
  try {
    const client = await HttpMCPClient.connect({ url: server.url.toString() });
    await expect(client.listTools()).rejects.toThrow("duplicate cursor");
  } finally {
    server.stop(true);
  }
});

pythonTest(
  "stdio tool-list change refreshes only owned tool registrations",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "natalia-mcp-refresh-"));
    const server = String.raw`
import json, sys, time
calls = 0
for line in sys.stdin:
  message = json.loads(line)
  if "id" not in message:
    continue
  if message["method"] == "initialize":
    result = {}
  elif message["method"] == "tools/list":
    calls += 1
    result = {"tools":[{"name": "old" if calls == 1 else "new", "inputSchema":{"type":"object"}}]}
    if calls == 1:
      print(json.dumps({"jsonrpc":"2.0","id":message["id"],"result":result}), flush=True)
      time.sleep(0.02)
      print(json.dumps({"jsonrpc":"2.0","method":"notifications/tools/list_changed","params":{}}), flush=True)
      continue
  else:
    result = {}
  print(json.dumps({"jsonrpc":"2.0","id":message["id"],"result":result}), flush=True)
`;
    const registry = createToolRegistry([]);
    const result = await loadNativeMCPTools({
      tools: toolRegistrar(registry),
      workspaceRoot: root,
      servers: {
        fixture: {
          type: "stdio",
          command: pythonCommand,
          args: ["-u", "-c", server],
          headers: {},
          environment: {},
          allowedTools: [],
          excludedTools: [],
          readOnly: true,
          enabled: true,
        },
      },
    });
    for (
      let attempt = 0;
      attempt < 50 && !registry.has("mcp_fixture_new");
      attempt++
    )
      await Bun.sleep(5);
    expect(registry.has("mcp_fixture_old")).toBe(false);
    expect(registry.has("mcp_fixture_new")).toBe(true);
    await result.close();
  },
);

pythonTest(
  "native MCP loader returns an idempotent lifecycle cleanup",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "natalia-mcp-cleanup-"));
    const loader = await import("../src/mcp-runtime");
    const registry = createToolRegistry([]);
    const result = await loader.loadNativeMCPTools({
      tools: toolRegistrar(registry),
      workspaceRoot: root,
      servers: {
        fixture: {
          type: "stdio",
          command: pythonCommand,
          args: ["-u", "-c", SERVER],
          headers: {},
          environment: {},
          allowedTools: [],
          excludedTools: [],
          readOnly: true,
          enabled: true,
        },
      },
    });
    expect(result.loaded).toBe(1);
    expect(registry.has("mcp_fixture_echo")).toBe(true);
    await result.close();
    expect(registry.has("mcp_fixture_echo")).toBe(false);
    await result.close();
  },
);

test("native MCP loader reports disabled, failed, and interactive-auth statuses without opening auth", async () => {
  const registry = createToolRegistry([]);
  const result = await loadNativeMCPTools({
    tools: toolRegistrar(registry),
    workspaceRoot: process.cwd(),
    servers: {
      disabled: {
        type: "stdio",
        command: "python3",
        args: [],
        headers: {},
        environment: {},
        allowedTools: [],
        excludedTools: [],
        readOnly: true,
        enabled: false,
      },
      interactive: {
        type: "http",
        url: "https://example.invalid/mcp",
        args: [],
        headers: {},
        environment: {},
        allowedTools: [],
        excludedTools: [],
        readOnly: true,
        enabled: true,
        auth: { clientID: "not-used" },
      },
      failed: {
        type: "stdio",
        command: "definitely-not-installed",
        args: [],
        headers: {},
        environment: {},
        allowedTools: [],
        excludedTools: [],
        readOnly: true,
        enabled: true,
      },
    },
  });
  expect(result.statuses).toMatchObject({
    disabled: { status: "disabled", tools: 0 },
    interactive: { status: "unsupported_auth_flow", tools: 0 },
    failed: { status: "failed", tools: 0 },
  });
  expect(result.diagnostics.join("\n")).toContain(
    "requires interactive authentication",
  );
  await result.close();
});

test("MCP diagnostics are attributed to the server they come from", async () => {
  const seen: Array<[server: string, message: string]> = [];
  const registry = createToolRegistry([]);
  const result = await loadNativeMCPTools({
    tools: toolRegistrar(registry),
    workspaceRoot: process.cwd(),
    onDiagnostic: (server, message) => seen.push([server, message]),
    servers: {
      auth_needed: {
        type: "http",
        url: "https://example.test",
        args: [],
        headers: {},
        environment: {},
        allowedTools: [],
        excludedTools: [],
        readOnly: true,
        enabled: true,
        auth: { clientID: "not-used" },
      },
      failed: {
        type: "stdio",
        command: "definitely-not-installed",
        args: [],
        headers: {},
        environment: {},
        allowedTools: [],
        excludedTools: [],
        readOnly: true,
        enabled: true,
      },
    },
  });
  // Every diagnostic names the server it belongs to, so a consumer can
  // attribute "which MCP server failed" without parsing the message.
  expect(seen.length).toBeGreaterThan(0);
  for (const [server, message] of seen) {
    expect(server).toBeString();
    expect(message.length).toBeGreaterThan(0);
  }
  expect(seen.some(([server, message]) => server === "auth_needed")).toBe(true);
  await result.close();
});

import type { RuntimeTool } from "@anthelia/tools";

export type MCPTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type MCPPrompt = {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

export type MCPResource = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

export type MCPCatalog = {
  tools: MCPTool[];
  prompts: MCPPrompt[];
  resources: MCPResource[];
};

export type MCPServerStatus = {
  status: "disabled" | "connected" | "failed" | "unsupported_auth_flow";
  tools: number;
  message?: string;
};

export type StdioMCPClientOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

export type HttpMCPClientOptions = {
  url: string;
  token?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export class StdioMCPClient {
  private process: ReturnType<typeof Bun.spawn>;
  private stdin: Exclude<
    ReturnType<typeof Bun.spawn>["stdin"],
    number | undefined
  >;
  private nextID = 1;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private readonly toolChangeHandlers = new Set<() => void | Promise<void>>();
  private closed = false;

  private constructor(process: ReturnType<typeof Bun.spawn>) {
    this.process = process;
    if (!process.stdin || typeof process.stdin === "number")
      throw new Error("MCP process stdin is not writable");
    this.stdin = process.stdin;
    void this.readLoop();
    void this.drainStderr();
  }

  static async connect(options: StdioMCPClientOptions) {
    const process = Bun.spawn([options.command, ...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const client = new StdioMCPClient(process);
    await client.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "natalia-ts", version: "0.0.0-ts7" },
      },
      options.timeoutMs,
    );
    await client.notify("notifications/initialized", {});
    return client;
  }

  async listTools(timeoutMs?: number) {
    return await paginateMCP<MCPTool>(
      (cursor) =>
        this.request("tools/list", cursor ? { cursor } : {}, timeoutMs),
      "tools",
      normalizeMCPTool,
    );
  }

  async listPrompts(timeoutMs?: number) {
    return await paginateMCP<MCPPrompt>(
      (cursor) =>
        this.request("prompts/list", cursor ? { cursor } : {}, timeoutMs),
      "prompts",
    );
  }

  async listResources(timeoutMs?: number) {
    return await paginateMCP<MCPResource>(
      (cursor) =>
        this.request("resources/list", cursor ? { cursor } : {}, timeoutMs),
      "resources",
    );
  }

  onToolsChanged(handler: () => void | Promise<void>) {
    this.toolChangeHandlers.add(handler);
    return () => this.toolChangeHandlers.delete(handler);
  }

  async callTool(
    name: string,
    arguments_: Record<string, unknown>,
    timeoutMs?: number,
  ) {
    return await this.request(
      "tools/call",
      { name, arguments: arguments_ },
      timeoutMs,
    );
  }

  async getPrompt(
    name: string,
    arguments_: Record<string, string> = {},
    timeoutMs?: number,
  ) {
    return await this.request(
      "prompts/get",
      { name, arguments: arguments_ },
      timeoutMs,
    );
  }

  async readResource(uri: string, timeoutMs?: number) {
    return await this.request("resources/read", { uri }, timeoutMs);
  }

  async close() {
    this.failPending(new Error("MCP server closed"));
    this.stdin.end();
    this.process.kill("SIGTERM");
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ) {
    const id = this.nextID++;
    const result = new Promise<unknown>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    await this.write({ jsonrpc: "2.0", id, method, params });
    if (timeoutMs === undefined) return await result;
    return await Promise.race([
      result,
      Bun.sleep(timeoutMs).then(() => {
        this.pending.delete(id);
        throw new Error(`MCP stdio request timed out after ${timeoutMs}ms`);
      }),
    ]);
  }

  private async notify(method: string, params: Record<string, unknown>) {
    await this.write({ jsonrpc: "2.0", method, params });
  }

  private async write(value: Record<string, unknown>) {
    this.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private async readLoop() {
    try {
      const stdout = this.process.stdout;
      if (!stdout || typeof stdout === "number")
        throw new Error("MCP process stdout is not readable");
      const reader = stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) this.handleLine(line);
      }
      if (buffer.trim()) this.handleLine(buffer);
      this.failPending(new Error("MCP server closed"));
    } catch (error) {
      this.failPending(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let message: {
      id?: number;
      method?: string;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      this.failPending(new Error("MCP server sent malformed JSON-RPC message"));
      void this.close();
      return;
    }
    if (message.method === "notifications/tools/list_changed") {
      for (const handler of this.toolChangeHandlers) void handler();
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error)
      pending.reject(new Error(message.error.message ?? "MCP error"));
    else pending.resolve(message.result);
  }

  private async drainStderr() {
    const stderr = this.process.stderr;
    if (!stderr || typeof stderr === "number") return;
    const reader = stderr.getReader();
    try {
      while (!(await reader.read()).done) {
        // Consume diagnostics so server-side stderr cannot backpressure stdout.
      }
    } catch {
      // stdout lifecycle owns the externally visible failure.
    }
  }

  private failPending(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export class HttpMCPClient {
  private nextID = 1;
  private readonly fetchImpl: typeof fetch;

  private constructor(private readonly options: HttpMCPClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  static async connect(options: HttpMCPClientOptions) {
    const client = new HttpMCPClient(options);
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "natalia-ts", version: "0.0.0-ts7" },
    });
    await client.notify("notifications/initialized", {});
    return client;
  }

  async listTools() {
    return await paginateMCP<MCPTool>(
      (cursor) => this.request("tools/list", cursor ? { cursor } : {}),
      "tools",
      normalizeMCPTool,
    );
  }

  async listPrompts() {
    return await paginateMCP<MCPPrompt>(
      (cursor) => this.request("prompts/list", cursor ? { cursor } : {}),
      "prompts",
    );
  }

  async listResources() {
    return await paginateMCP<MCPResource>(
      (cursor) => this.request("resources/list", cursor ? { cursor } : {}),
      "resources",
    );
  }

  async callTool(name: string, arguments_: Record<string, unknown>) {
    return await this.request("tools/call", { name, arguments: arguments_ });
  }

  async getPrompt(name: string, arguments_: Record<string, string> = {}) {
    return await this.request("prompts/get", { name, arguments: arguments_ });
  }

  async readResource(uri: string) {
    return await this.request("resources/read", { uri });
  }

  private async request(method: string, params: Record<string, unknown>) {
    const id = this.nextID++;
    const response = await this.fetchImpl(this.options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.options.headers,
        ...(this.options.token
          ? { authorization: `Bearer ${this.options.token}` }
          : {}),
      },
      signal:
        this.options.timeoutMs === undefined
          ? undefined
          : AbortSignal.timeout(this.options.timeoutMs),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok)
      throw new Error(`MCP HTTP request failed: ${response.status}`);
    const message = (await response.json()) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (message.id !== id) throw new Error("MCP HTTP response ID mismatch");
    if (message.error)
      throw new Error(message.error.message ?? "MCP HTTP error");
    return message.result;
  }

  private async notify(method: string, params: Record<string, unknown>) {
    const response = await this.fetchImpl(this.options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.options.headers,
        ...(this.options.token
          ? { authorization: `Bearer ${this.options.token}` }
          : {}),
      },
      signal:
        this.options.timeoutMs === undefined
          ? undefined
          : AbortSignal.timeout(this.options.timeoutMs),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    });
    if (!response.ok)
      throw new Error(`MCP HTTP notification failed: ${response.status}`);
  }
}

type MCPToolClient = {
  callTool(
    name: string,
    arguments_: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
};
type MCPCatalogClient = MCPToolClient & {
  listTools(timeoutMs?: number): Promise<MCPTool[]>;
  listPrompts(timeoutMs?: number): Promise<MCPPrompt[]>;
  listResources(timeoutMs?: number): Promise<MCPResource[]>;
  getPrompt(
    name: string,
    arguments_?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<unknown>;
  readResource(uri: string, timeoutMs?: number): Promise<unknown>;
};
type ClosableMCPClient = MCPCatalogClient & { close?: () => Promise<void> };

export type MCPToolRegistrar = {
  register(tool: RuntimeTool): () => void;
};

export class MCPConnectionOwner {
  private readonly clients: ClosableMCPClient[] = [];
  private readonly servers = new Map<string, ClosableMCPClient>();
  private readonly registrations: Array<{
    name: string;
    dispose: () => void;
  }> = [];
  private closed = false;

  constructor(private readonly tools: MCPToolRegistrar) {}

  addClient(name: string, client: ClosableMCPClient) {
    if (this.closed) throw new Error("MCP connection owner is closed");
    this.clients.push(client);
    this.servers.set(name, client);
  }

  register(name: string, tool: RuntimeTool) {
    if (this.closed) throw new Error("MCP connection owner is closed");
    this.registrations.push({ name, dispose: this.tools.register(tool) });
  }

  unregister(prefix: string) {
    const retained = this.registrations.filter((item) => {
      if (!item.name.startsWith(prefix)) return true;
      item.dispose();
      return false;
    });
    this.registrations.splice(0, this.registrations.length, ...retained);
  }

  count(prefix: string) {
    return this.registrations.filter((item) => item.name.startsWith(prefix))
      .length;
  }

  async catalog() {
    const catalogs = await Promise.all(
      [...this.servers.entries()].map(async ([server, client]) => ({
        server,
        catalog: await inspectMCPCatalog(client),
      })),
    );
    return {
      prompts: catalogs.flatMap(({ server, catalog }) =>
        catalog.prompts.map((prompt) => ({ server, ...prompt })),
      ),
      resources: catalogs.flatMap(({ server, catalog }) =>
        catalog.resources.map((resource) => ({ server, ...resource })),
      ),
    };
  }

  async getPrompt(
    server: string,
    name: string,
    arguments_?: Record<string, string>,
  ) {
    return await this.requireClient(server).getPrompt(name, arguments_);
  }

  async readResource(server: string, uri: string) {
    return await this.requireClient(server).readResource(uri);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.servers.clear();
    for (const registration of this.registrations.splice(0))
      registration.dispose();
    await Promise.all(
      this.clients.map((client) => client.close?.().catch(() => undefined)),
    );
  }

  private requireClient(name: string) {
    const client = this.servers.get(name);
    if (!client) throw new Error(`MCP server is not connected: ${name}`);
    return client;
  }
}

export function mcpToolToRuntimeTool(
  client: MCPToolClient,
  tool: MCPTool,
  options: { serverName?: string; readOnly?: boolean; timeoutMs?: number } = {},
): RuntimeTool {
  const prefix = options.serverName ? `mcp_${options.serverName}_` : "mcp_";
  return {
    name: `${prefix}${tool.name}`,
    description:
      tool.description ??
      `MCP tool ${options.serverName ?? "server"}/${tool.name}`,
    requiresApproval: !options.readOnly,
    parameters: tool.inputSchema as RuntimeTool["parameters"],
    async execute(input) {
      return formatMCPToolResult(
        await client.callTool(
          tool.name,
          requireArguments(input),
          options.timeoutMs,
        ),
      );
    },
  };
}

export async function loadNativeMCPTools(input: {
  tools: MCPToolRegistrar;
  servers: Record<
    string,
    {
      type: "stdio" | "http";
      command?: string;
      args: string[];
      url?: string;
      headers: Record<string, string>;
      environment: Record<string, string>;
      cwd?: string;
      timeoutSec?: number;
      auth?: false | Record<string, unknown>;
      allowedTools: string[];
      excludedTools: string[];
      readOnly: boolean;
      enabled: boolean;
    }
  >;
  workspaceRoot: string;
  onDiagnostic?: (server: string, message: string) => void;
}) {
  let loaded = 0;
  const diagnostics: Array<[server: string, message: string]> = [];
  const statuses: Record<string, MCPServerStatus> = {};
  const owner = new MCPConnectionOwner(input.tools);
  for (const [name, server] of Object.entries(input.servers)) {
    if (!server.enabled) {
      statuses[name] = { status: "disabled", tools: 0 };
      continue;
    }
    if (server.auth) {
      const message = `MCP server ${name} requires interactive authentication, which is unsupported by the local runtime`;
      diagnostics.push([name, message]);
      statuses[name] = { status: "unsupported_auth_flow", tools: 0, message };
      continue;
    }
    try {
      const client: StdioMCPClient | HttpMCPClient =
        server.type === "http"
          ? await HttpMCPClient.connect({
              url: server.url ?? "",
              headers: server.headers,
              timeoutMs: timeoutMilliseconds(server.timeoutSec),
            })
          : await StdioMCPClient.connect({
              command: server.command ?? "",
              args: server.args,
              cwd: server.cwd ?? input.workspaceRoot,
              env: cleanEnv({ ...process.env, ...server.environment }),
              timeoutMs: timeoutMilliseconds(server.timeoutSec),
            });
      owner.addClient(name, client);
      let refresh = Promise.resolve(0);
      const refreshTools = () => {
        const next = refresh.then(() =>
          registerMCPTools({ owner, client, name, server }),
        );
        refresh = next.catch(() => 0);
        return next;
      };
      if (client instanceof StdioMCPClient)
        client.onToolsChanged(async () => {
          try {
            await refreshTools();
            input.onDiagnostic?.(
              name,
              `MCP server ${name} refreshed its tool catalog`,
            );
          } catch (error) {
            input.onDiagnostic?.(
              name,
              `MCP server ${name} tool refresh failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        });
      loaded += await refreshTools();
      statuses[name] = {
        status: "connected",
        tools: owner.count(`mcp_${name}_`),
      };
      diagnostics.push([name, `TS config MCP ${name} loaded`]);
    } catch (error) {
      const message = `TS config MCP ${name} failed: ${error instanceof Error ? error.message : String(error)}`;
      diagnostics.push([name, message]);
      statuses[name] = { status: "failed", tools: 0, message };
    }
  }
  for (const [server, message] of diagnostics)
    input.onDiagnostic?.(server, message);
  return {
    loaded,
    diagnostics,
    statuses,
    catalog: () => owner.catalog(),
    getPrompt: (
      server: string,
      name: string,
      arguments_?: Record<string, string>,
    ) => owner.getPrompt(server, name, arguments_),
    readResource: (server: string, uri: string) =>
      owner.readResource(server, uri),
    close: () => owner.close(),
  };
}

export async function inspectMCPCatalog(
  client: MCPCatalogClient,
  timeoutMs?: number,
): Promise<MCPCatalog> {
  const [tools, prompts, resources] = await Promise.all([
    client.listTools(timeoutMs),
    client.listPrompts(timeoutMs),
    client.listResources(timeoutMs),
  ]);
  return { tools, prompts, resources };
}

async function registerMCPTools(input: {
  owner: MCPConnectionOwner;
  client: MCPCatalogClient;
  name: string;
  server: {
    allowedTools: string[];
    excludedTools: string[];
    readOnly: boolean;
    timeoutSec?: number;
  };
}) {
  const prefix = `mcp_${input.name}_`;
  input.owner.unregister(prefix);
  const tools = await input.client.listTools(
    timeoutMilliseconds(input.server.timeoutSec),
  );
  const [prompts, resources] = await Promise.all([
    listOptional(() =>
      input.client.listPrompts(timeoutMilliseconds(input.server.timeoutSec)),
    ),
    listOptional(() =>
      input.client.listResources(timeoutMilliseconds(input.server.timeoutSec)),
    ),
  ]);
  let registered = 0;
  for (const tool of tools) {
    if (
      input.server.allowedTools.length &&
      !input.server.allowedTools.includes(tool.name)
    )
      continue;
    if (input.server.excludedTools.includes(tool.name)) continue;
    input.owner.register(
      `${prefix}${tool.name}`,
      mcpToolToRuntimeTool(input.client, tool, {
        serverName: input.name,
        readOnly: input.server.readOnly,
        timeoutMs: timeoutMilliseconds(input.server.timeoutSec),
      }),
    );
    registered++;
  }
  if (prompts.length)
    input.owner.register(
      `${prefix}prompt_get`,
      mcpPromptRuntimeTool(input.client, input.name, prompts),
    );
  if (resources.length)
    input.owner.register(
      `${prefix}resource_read`,
      mcpResourceRuntimeTool(input.client, input.name, resources),
    );
  return registered;
}

function mcpPromptRuntimeTool(
  client: MCPCatalogClient,
  server: string,
  prompts: MCPPrompt[],
): RuntimeTool {
  return {
    name: `mcp_${server}_prompt_get`,
    description: `Load a prompt from MCP server ${server}. Available prompts: ${prompts.map((prompt) => prompt.name).join(", ")}.`,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        arguments: {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(input) {
      const args = requireArguments(input);
      const name = requireStringArgument(args.name, "name");
      const arguments_ = stringArguments(args.arguments);
      return JSON.stringify(await client.getPrompt(name, arguments_));
    },
  };
}

function mcpResourceRuntimeTool(
  client: MCPCatalogClient,
  server: string,
  resources: MCPResource[],
): RuntimeTool {
  return {
    name: `mcp_${server}_resource_read`,
    description: `Read a resource from MCP server ${server}. Available resources: ${resources.map((resource) => resource.uri).join(", ")}.`,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: { uri: { type: "string" } },
      required: ["uri"],
      additionalProperties: false,
    },
    async execute(input) {
      const args = requireArguments(input);
      return JSON.stringify(
        await client.readResource(requireStringArgument(args.uri, "uri")),
      );
    },
  };
}

async function listOptional<T>(list: () => Promise<T[]>) {
  try {
    return await list();
  } catch {
    // Prompt/resource support is optional in MCP. The server remains connected.
    return [];
  }
}

async function paginateMCP<T>(
  list: (cursor?: string) => Promise<unknown>,
  field: string,
  normalize: (value: unknown) => T = (value) => value as T,
) {
  const result: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const value = await list(cursor);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`MCP ${field}/list returned an invalid result`);
    const record = value as Record<string, unknown>;
    const items = record[field];
    if (!Array.isArray(items))
      throw new Error(`MCP ${field}/list returned no ${field} array`);
    result.push(...items.map(normalize));
    const next = record.nextCursor;
    if (next === undefined) return result;
    if (typeof next !== "string")
      throw new Error(`MCP ${field}/list returned an invalid nextCursor`);
    if (cursors.has(next))
      throw new Error(`MCP ${field}/list returned duplicate cursor: ${next}`);
    cursors.add(next);
    cursor = next;
  }
  throw new Error(`MCP ${field}/list exceeded 1000 pages`);
}

function normalizeMCPTool(value: unknown): MCPTool {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("MCP tools/list returned an invalid tool");
  const tool = value as Record<string, unknown>;
  if (typeof tool.name !== "string")
    throw new Error("MCP tools/list returned a tool without a name");
  return {
    name: tool.name,
    description:
      typeof tool.description === "string" ? tool.description : undefined,
    inputSchema:
      tool.inputSchema &&
      typeof tool.inputSchema === "object" &&
      !Array.isArray(tool.inputSchema)
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {}, additionalProperties: false },
  };
}

function formatMCPToolResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return JSON.stringify(value);
  const result = value as {
    isError?: unknown;
    content?: unknown;
    structuredContent?: unknown;
  };
  if (result.isError === true) {
    const text = Array.isArray(result.content)
      ? result.content
          .flatMap((item) =>
            item &&
            typeof item === "object" &&
            (item as { type?: unknown }).type === "text"
              ? [(item as { text?: unknown }).text]
              : [],
          )
          .filter(
            (item): item is string =>
              typeof item === "string" && Boolean(item.trim()),
          )
          .join("\n\n")
      : "";
    throw new Error(text || "MCP tool returned an error");
  }
  if (
    Array.isArray(result.content) &&
    result.content.length === 0 &&
    result.structuredContent !== undefined &&
    result.structuredContent !== null
  )
    return JSON.stringify({
      content: [
        { type: "text", text: JSON.stringify(result.structuredContent) },
      ],
    });
  return JSON.stringify(value);
}

function timeoutMilliseconds(timeoutSec?: number) {
  return timeoutSec === undefined ? undefined : timeoutSec * 1000;
}

function cleanEnv(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function requireArguments(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("MCP tool arguments must be an object");
  return input as Record<string, unknown>;
}

function requireStringArgument(value: unknown, name: string) {
  if (typeof value !== "string")
    throw new Error(`MCP ${name} must be a string`);
  return value;
}

function stringArguments(value: unknown) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("MCP prompt arguments must be an object");
  const result: Record<string, string> = {};
  for (const [key, argument] of Object.entries(value)) {
    if (typeof argument !== "string")
      throw new Error(`MCP prompt argument ${key} must be a string`);
    result[key] = argument;
  }
  return result;
}

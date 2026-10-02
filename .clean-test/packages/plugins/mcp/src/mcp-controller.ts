import type { MCPCatalogSnapshot, RuntimeEvent } from "@anthelia/contracts";
import { loadNativeMCPTools, type MCPToolRegistrar } from "./mcp-runtime";
import type { MCPServerConfig } from "@anthelia/contracts";
/**
 * The MCP resource controller — fourth cut of the resource controllers
 * split (mainline plan §15). It owns the native MCP connections: loading the
 * configured servers at startup and reconnecting them when
 * `mcp.server.add`/`mcp.server.remove` change the config, so a config change
 * takes effect without a restart. Per-server status and diagnostics are
 * published; the old connections are closed before the new ones open.
 *
 * Multi-session shape (plan §41.9): `servers()` is an accessor over the
 * runtime's current config, and the module holds no session state.
 */
export function createMcpController(input: {
  servers(): Record<string, MCPServerConfig>;
  workspaceRoot: string;
  tools: MCPToolRegistrar;
  enabled(): boolean;
  publish(event: RuntimeEvent): void;
}) {
  let active: Awaited<ReturnType<typeof loadNativeMCPTools>> | undefined;

  async function reload() {
    await closeActive();
    if (!input.enabled()) return;
    const nativeMCP = await loadNativeMCPTools({
      tools: input.tools,
      servers: input.servers(),
      workspaceRoot: input.workspaceRoot,
      onDiagnostic: (server, message) =>
        input.publish({
          type: "diagnostic",
          level: "info",
          owner: `mcp:${server}`,
          message,
        }),
    });
    active = nativeMCP;
    for (const [server, status] of Object.entries(nativeMCP.statuses))
      input.publish({ type: "mcp.status", server, ...status });
    if (nativeMCP.loaded)
      input.publish({
        type: "diagnostic",
        level: "info",
        owner: "mcp",
        message: `Loaded ${nativeMCP.loaded} native MCP tool(s) from TS config.`,
      });
  }

  async function catalog(): Promise<MCPCatalogSnapshot> {
    return active?.catalog() ?? { prompts: [], resources: [] };
  }

  async function getPrompt(
    server: string,
    name: string,
    arguments_?: Record<string, string>,
  ) {
    return await requireActive(server).getPrompt(server, name, arguments_);
  }

  async function readResource(server: string, uri: string) {
    return await requireActive(server).readResource(server, uri);
  }

  async function close() {
    await closeActive();
  }

  async function closeActive() {
    const current = active;
    active = undefined;
    await current?.close();
  }

  function requireActive(server: string) {
    if (!active) throw new Error(`MCP server is not connected: ${server}`);
    return active;
  }

  return { reload, catalog, getPrompt, readResource, close };
}

import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import { mcpService } from "@anthelia/runtime-services";
import { updateConfigAtScope } from "@anthelia/config";
import type { RuntimeContext } from "@anthelia/substrate";
type Surface = Pick<
  RuntimeServiceClient,
  | "mcpCatalog"
  | "getMcpPrompt"
  | "readMcpResource"
  | "mcpServerAdd"
  | "mcpServerRemove"
>;
export function createMcpRuntime(
  ctx: RuntimeContext,
  globalConfigPath?: string,
): Surface {
  return {
    async mcpCatalog() {
      const mcp = ctx.state.serviceDirectory.getOptional(mcpService);
      return (
        (await mcp?.catalog()) ?? {
          prompts: [],
          resources: [],
        }
      );
    },
    async getMcpPrompt(server, name, arguments_) {
      const mcp = ctx.state.serviceDirectory.getOptional(mcpService);
      if (!mcp) throw new Error(`MCP server is not connected: ${server}`);
      return await mcp.getPrompt(server, name, arguments_);
    },
    async readMcpResource(server, uri) {
      const mcp = ctx.state.serviceDirectory.getOptional(mcpService);
      if (!mcp) throw new Error(`MCP server is not connected: ${server}`);
      return await mcp.readResource(server, uri);
    },
    async mcpServerAdd(input) {
      await ctx.ports.getReady();
      await updateConfigAtScope(
        ctx.ports.getWorkspaceRoot(),
        {
          mcpServers: { [input.name]: input.config },
        } as never,
        "project",
        { globalPath: globalConfigPath },
      );
      await ctx.ports.applyConfigFromDisk();
      return { saved: true };
    },
    async mcpServerRemove(name) {
      await ctx.ports.getReady();
      await updateConfigAtScope(
        ctx.ports.getWorkspaceRoot(),
        {
          mcpServers: { [name]: undefined },
        } as never,
        "project",
        { globalPath: globalConfigPath },
      );
      await ctx.ports.applyConfigFromDisk();
      return { removed: true };
    },
  };
}

export {
  createMcpPlugin,
  MCP_PLUGIN_ID,
  MCP_PLUGIN_MANIFEST,
} from "./mcp-controller-plugin";
import type { MCPServerConfig, RuntimeEvent } from "@anthelia/contracts";
import type { Plugin, PluginAPI } from "@anthelia/plugin";
import { mcpInput } from "@anthelia/runtime-services";
import { createMcpPlugin, MCP_PLUGIN_MANIFEST } from "./mcp-controller-plugin";

export type McpRuntimeInput = {
  servers(): Record<string, MCPServerConfig>;
  workspaceRoot: string;
  enabled(): boolean;
  publish(event: RuntimeEvent): void;
};

export default function mcpPlugin(): Plugin {
  let instance: Plugin | undefined;
  return {
    manifest: {
      ...MCP_PLUGIN_MANIFEST,
      entry: "index.js",
      requires: [mcpInput.id],
    },
    async setup(api: PluginAPI) {
      const input = api.services.get<McpRuntimeInput>(mcpInput.id);
      if (!input) throw new Error(`missing runtime service: ${mcpInput.id}`);
      instance = createMcpPlugin(input);
      await instance.setup(api);
    },
    async dispose() {
      await instance?.dispose?.();
      instance = undefined;
    },
  };
}

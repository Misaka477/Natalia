import { render } from "solid-js/web";
import { defineUiPlugin, type UiPlugin } from "@natalia/ui-host";
import { McpSettings } from "./mcp-settings";

export function createMcpSettingsUiPlugin(): UiPlugin {
  return defineUiPlugin({
    id: "natalia.ui.mcp-settings",
    name: "MCP Settings UI",
    version: "1.0.0",
    description: "MCP server management for the settings panel.",
    panels: [
      {
        id: "mcp-settings",
        title: "MCP",
        region: "settings",
        group: "扩展",
        mount(ctx, container) {
          container.replaceChildren();
          const dispose = render(
            () => (
              <McpSettings runtime={ctx.runtime} projection={ctx.projection} />
            ),
            container,
          );
          return () => dispose();
        },
      },
    ],
    mount() {
      return undefined;
    },
  });
}

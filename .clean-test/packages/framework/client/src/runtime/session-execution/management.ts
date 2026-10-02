import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import { updateConfigAtScope } from "@anthelia/config";
import type { RuntimeContext } from "@anthelia/substrate";
import type { ClientSurfaceOptions } from "./types";
type Surface = Pick<
  RuntimeServiceClient,
  "permissionList" | "permissionSave" | "permissionDelete"
>;
export function createManagementSurface(
  ctx: RuntimeContext,
  options: ClientSurfaceOptions,
): Surface {
  return {
    async permissionList() {
      await ctx.ports.getReady();
      const config = ctx.ports.getTsRuntimeConfig();
      if (!config) return { default: "ask", profiles: [] };
      return {
        default: config.defaultAgentMode,
        profiles: Object.entries(config.agentModes).map(([name, profile]) => ({
          name,
          ...profile,
        })),
      };
    },
    async permissionSave(input) {
      await ctx.ports.getReady();
      const profile = input.profile;
      await updateConfigAtScope(
        ctx.ports.getWorkspaceRoot(),
        {
          agentModes: {
            [input.name]: {
              description: profile.description ?? "",
              approval: profile.approval,
              systemPrompt: "",
              allowedTools: profile.permissions?.tools?.allow ?? [],
              excludedTools: profile.permissions?.tools?.exclude ?? [],
              commandRules: profile.commandRules,
              interactivePrograms: profile.interactivePrograms,
              skills: profile.extensions?.skills !== false,
              mcpServers: [],
            },
          },
        } as never,
        "global",
        { globalPath: options.globalConfigPath },
      );
      const result = await ctx.ports.applyConfigFromDisk();
      return {
        saved: true,
        applied: result.applied,
        reason: result.reason,
      };
    },
    async permissionDelete(name) {
      await ctx.ports.getReady();
      const config = ctx.ports.getTsRuntimeConfig();
      if (config && config.defaultAgentMode === name)
        return {
          deleted: false,
          reason: `permission profile is the active default: ${name}`,
        };
      await updateConfigAtScope(
        ctx.ports.getWorkspaceRoot(),
        {
          agentModes: { [name]: undefined },
        } as never,
        "global",
        { globalPath: options.globalConfigPath },
      );
      await ctx.ports.applyConfigFromDisk();
      return { deleted: true };
    },
  };
}

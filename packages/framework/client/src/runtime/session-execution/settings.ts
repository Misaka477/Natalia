import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import { resolveTuiConfig, saveTuiConfig } from "@anthelia/config";
import type { RuntimeContext } from "@anthelia/substrate";
import type { ClientSurfaceOptions } from "./types";
type Surface = Pick<RuntimeServiceClient, "settingsGet" | "settingsSet">;
export function createSettingsSurface(
  ctx: RuntimeContext,
  options: ClientSurfaceOptions,
): Surface {
  return {
    async settingsGet() {
      await ctx.ports.getReady();
      const resolved = await resolveTuiConfig(ctx.ports.getWorkspaceRoot());
      return {
        config: resolved.config as unknown as Record<string, unknown>,
        sources: resolved.sources,
      };
    },
    async settingsSet(patch, scope) {
      await ctx.ports.getReady();
      // The interface-preference file, served publicly now that the TUI no
      // longer owns it privately. Validated by the shared schema (an invalid
      // patch is an argument error, not a partial write), written atomically,
      // then announced so subscribers can re-read.
      await saveTuiConfig(ctx.ports.getWorkspaceRoot(), patch, scope);
      ctx.ports.publish({ type: "settings.updated", scope });
      return { applied: true };
    },
  };
}

import { defaultGlobalConfigPath } from "@anthelia/config";
import type {
  InitializeCatalogResult,
  InitializeOptions,
  RuntimeContext,
} from "@anthelia/substrate";

export async function configureCatalog(
  ctx: RuntimeContext,
  options: InitializeOptions,
): Promise<InitializeCatalogResult> {
  const deps = ctx.state.initialize;
  const tsConfig = await deps.resolveConfig({
    workspaceRoot: ctx.ports.getWorkspaceRoot(),
    globalPath: options.globalConfigPath,
  });
  ctx.ports.configGlobalPath = () =>
    options.globalConfigPath ?? defaultGlobalConfigPath();
  ctx.ports.setTsRuntimeConfig(tsConfig.config);
  const runtimeConfig = tsConfig.config;
  deps.reloadPermissionSettings(tsConfig.config);
  applyConfiguredShell(runtimeConfig.runtime?.shell?.executable);
  return { runtimeConfig, tsConfig };
}

/**
 * The persisted shell choice, applied to the process environment.
 *
 * `selectExecutor` reads `NATALIA_SHELL`, and eight call sites ask it — six of
 * them at MODULE SCOPE (`const shell = selectExecutor()`), where no config is
 * reachable. Threading a config through all eight is a refactor of every tool
 * that runs a command; projecting the persisted choice onto the one input the
 * seam already reads is one line here and changes nothing at those sites.
 *
 * The config OUTRANKS the variable, and that is the point: `NATALIA_SHELL` is
 * the deployment's default, the panel is the human's, and a human who chose
 * must not be overruled by a stale environment. A deployment that wants to pin
 * the shell pins it in the config file, which is the same place.
 *
 * An absent choice writes nothing, so the platform default (pwsh on Windows,
 * bash elsewhere) stands exactly as before.
 */
function applyConfiguredShell(
  executable: "bash" | "pwsh" | "zsh" | undefined,
): void {
  if (!executable) return;
  process.env.NATALIA_SHELL = executable;
}

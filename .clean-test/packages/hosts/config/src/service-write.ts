import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { configV3Schema, type ConfigV3 } from "@anthelia/contracts";
import { parseConfigText, saveConfigOverlayFile } from "./file";
import { mergeConfig, mergeOverlay } from "./service-merge";
import {
  defaultGlobalConfigPath,
  onlyGlobalModelConfig,
  presentGlobalModelConfigKeys,
  resolveConfig,
  withoutGlobalModelConfig,
  type GlobalModelConfigKey,
} from "./service-resolution";
import type { ConfigPatch, ConfigWriteScope } from "./service-types";

export async function updateConfig(
  workspaceRoot: string,
  patch: ConfigPatch,
  options: { globalPath?: string } = {},
): Promise<ConfigV3> {
  return await updateConfigAtScope(workspaceRoot, patch, "project", options);
}

async function updateProjectConfig(
  workspaceRoot: string,
  patch: ConfigPatch,
  globalPath?: string,
) {
  const { config, projectConfigPath } = await resolveConfig({
    workspaceRoot,
    globalPath,
  });
  const projectPatch = withoutGlobalModelConfig(patch);
  const overlay = mergeOverlay(
    await loadOverlay(projectConfigPath),
    projectPatch as Record<string, unknown>,
  );
  if (Object.keys(projectPatch).length)
    await saveConfigOverlayFile(projectConfigPath, overlay);
  return mergeConfig(config, projectPatch);
}

export async function updateGlobalConfig(
  patch: ConfigPatch,
  globalPath?: string,
) {
  const path = globalPath ?? defaultGlobalConfigPath();
  const persisted = await loadOverlay(path);
  const base = mergeConfig(
    configV3Schema.parse({ version: 3 }),
    persisted as ConfigPatch,
  );
  const next = mergeConfig(base, patch);
  await saveConfigOverlayFile(
    path,
    mergeOverlay(persisted, patch as Record<string, unknown>),
  );
  return next;
}

export async function migrateProjectModelConfigToGlobal(
  workspaceRoot: string,
  options: { globalPath?: string } = {},
): Promise<{ migrated: GlobalModelConfigKey[]; config: ConfigV3 }> {
  const projectConfigPath = resolve(workspaceRoot, ".natalia", "config.json");
  const project = await loadOverlay(projectConfigPath);
  const migrated = presentGlobalModelConfigKeys(project);
  if (!migrated.length)
    return {
      migrated,
      config: (
        await resolveConfig({ workspaceRoot, globalPath: options.globalPath })
      ).config,
    };
  const globalPath = options.globalPath ?? defaultGlobalConfigPath();
  const globalBase = mergeConfig(
    configV3Schema.parse({ version: 3 }),
    (await loadOverlay(globalPath)) as ConfigPatch,
  );
  const effective = mergeConfig(
    globalBase,
    onlyGlobalModelConfig(project as ConfigPatch),
  );
  await updateGlobalConfig(
    Object.fromEntries(
      migrated.map((key) => [key, effective[key]]),
    ) as ConfigPatch,
    globalPath,
  );
  for (const key of migrated) delete project[key];
  await saveConfigOverlayFile(projectConfigPath, project);
  return {
    migrated,
    config: (await resolveConfig({ workspaceRoot, globalPath })).config,
  };
}

async function loadOverlay(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = parseConfigText(await readFile(path, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function updateConfigAtScope(
  workspaceRoot: string,
  patch: ConfigPatch,
  scope: ConfigWriteScope = "project",
  options: { globalPath?: string } = {},
) {
  if (scope === "global")
    return await updateGlobalConfig(patch, options.globalPath);
  const globalPatch = onlyGlobalModelConfig(patch);
  if (Object.keys(globalPatch).length)
    await updateGlobalConfig(globalPatch, options.globalPath);
  await updateProjectConfig(workspaceRoot, patch, options.globalPath);
  return (
    await resolveConfig({ workspaceRoot, globalPath: options.globalPath })
  ).config;
}

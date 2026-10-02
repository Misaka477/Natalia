import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { configV3Schema, parseModelRef } from "@anthelia/contracts";
import { statePath, resolveStatePath } from "@anthelia/platform";
import { globalConfigHome } from "@anthelia/platform";
import { parseConfigText } from "./file";
import { mergeConfig } from "./service-merge";
import type {
  ConfigPatch,
  ConfigSource,
  ResolvedConfig,
} from "./service-types";

export const GLOBAL_MODEL_CONFIG_KEYS = [
  "providers",
  "catalog",
  "modelOverrides",
  "defaultModel",
] as const;

export type GlobalModelConfigKey = (typeof GLOBAL_MODEL_CONFIG_KEYS)[number];
const globalModelConfigKeys = new Set<string>(GLOBAL_MODEL_CONFIG_KEYS);

export function defaultGlobalConfigPath(
  input: { os?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
) {
  return resolve(statePath(globalConfigHome(input), "config.json"));
}

/**
 * The global config's read path, preferring the live state directory and
 * falling back to the legacy `natalia-cli` one that an existing install
 * wrote. `legacy` is reported so the resolution's source list says the
 * truth about where the config came from.
 */
export function resolveGlobalConfigPath(
  input: { os?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
  exists: (path: string) => boolean = existsSync,
): { path: string; legacy: boolean } {
  const root = globalConfigHome(input);
  const resolved = resolveStatePath(root, exists, "config.json");
  return { path: resolve(resolved.path), legacy: resolved.legacy };
}

export async function resolveConfig(input: {
  workspaceRoot: string;
  globalPath?: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<ResolvedConfig> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const projectConfigPath = resolve(workspaceRoot, ".natalia", "config.json");
  // An explicit path wins (the CLI's -c, a test's temp file). Otherwise the
  // live state directory, with the legacy `natalia-cli` location as the read
  // fallback — an existing install's config is still honored, and the source
  // list below records where it actually came from.
  const global = input.globalPath
    ? { path: input.globalPath, legacy: false }
    : resolveGlobalConfigPath({ env: input.environment });
  const globalPath = global.path;
  let config = configV3Schema.parse({ version: 3 });
  const sources: ConfigSource[] = [{ scope: "defaults", applied: true }];
  for (const [scope, path] of [
    ["global", globalPath],
    ["project", projectConfigPath],
  ] as const) {
    const legacyLocation =
      scope === "global" && global.legacy
        ? " (legacy state directory: ~/.config/natalia-cli)"
        : "";
    if (!existsSync(path)) {
      sources.push({
        scope,
        path,
        applied: false,
        diagnostic: `missing${legacyLocation}`,
      });
      continue;
    }
    try {
      const overlay = parseConfigText(
        await readFile(path, "utf8"),
      ) as ConfigPatch;
      const ignored =
        scope === "project" ? presentGlobalModelConfigKeys(overlay) : [];
      config = mergeConfig(
        config,
        scope === "project" ? withoutGlobalModelConfig(overlay) : overlay,
      );
      sources.push({
        scope,
        path,
        applied: true,
        diagnostic: ignored.length
          ? `ignored global-only settings: ${ignored.join(", ")}`
          : undefined,
      });
    } catch (error) {
      sources.push({
        scope,
        path,
        applied: false,
        diagnostic: `invalid_config: ${configFailureReason(error)}`,
      });
    }
  }
  const model = (input.environment ?? process.env).NATALIA_MODEL;
  if (model) {
    config = configV3Schema.parse({
      ...config,
      defaultModel: parseModelRef(model),
    });
    sources.push({
      scope: "environment",
      applied: true,
      diagnostic: "NATALIA_MODEL",
    });
  }
  return { config, sources, projectConfigPath };
}

function configFailureReason(error: unknown) {
  const issues = (
    error as { issues?: Array<{ path?: unknown[]; message?: string }> }
  ).issues;
  if (Array.isArray(issues) && issues.length) {
    const first = issues[0]!;
    const path = (first.path ?? []).join(".");
    return `${path ? `${path}: ` : ""}${first.message ?? "invalid value"}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ""}`;
  }
  return error instanceof Error ? error.message : "parse_error";
}

export function presentGlobalModelConfigKeys(
  patch: ConfigPatch | Record<string, unknown>,
): GlobalModelConfigKey[] {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return [];
  return GLOBAL_MODEL_CONFIG_KEYS.filter((key) => Object.hasOwn(patch, key));
}

export function withoutGlobalModelConfig(patch: ConfigPatch): ConfigPatch {
  return Object.fromEntries(
    Object.entries(patch).filter(([key]) => !globalModelConfigKeys.has(key)),
  ) as ConfigPatch;
}

export function onlyGlobalModelConfig(patch: ConfigPatch): ConfigPatch {
  return Object.fromEntries(
    Object.entries(patch).filter(([key]) => globalModelConfigKeys.has(key)),
  ) as ConfigPatch;
}

import { configV3Schema, type ConfigV3 } from "@anthelia/contracts";
import type { ConfigPatch } from "./service-types";

export function configPatch(base: ConfigV3, next: ConfigV3): ConfigPatch {
  const patch = diffValue(base, next) as ConfigPatch;
  const records = {
    providers: recordPatch(base.providers, next.providers),
    agentModes: recordPatch(base.agentModes, next.agentModes),
    agents: recordPatch(base.agents, next.agents),
    mcpServers: recordPatch(base.mcpServers, next.mcpServers),
    issueTargets: recordPatch(base.issueTargets, next.issueTargets),
    dataSources: recordPatch(base.dataSources, next.dataSources),
    alertChannels: recordPatch(base.alertChannels, next.alertChannels),
    pluginPackages: recordPatch(base.plugins.packages, next.plugins.packages),
  };
  for (const [key, value] of Object.entries(records)) {
    if (key === "pluginPackages") {
      if (Object.keys(value).length) {
        patch.plugins ??= {};
        patch.plugins.packages = value as never;
      } else if (patch.plugins) delete patch.plugins.packages;
    } else if (Object.keys(value).length)
      patch[key as keyof ConfigPatch] = value as never;
    else delete patch[key as keyof ConfigPatch];
  }
  return patch;
}

function recordPatch<Value>(
  base: Record<string, Value>,
  next: Record<string, Value>,
) {
  const patch: Record<string, Value | undefined> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (!(key in next)) patch[key] = undefined;
    else if (
      !(key in base) ||
      JSON.stringify(base[key]) !== JSON.stringify(next[key])
    )
      patch[key] = next[key];
  }
  return patch;
}

function diffValue(base: unknown, next: unknown): unknown {
  if (Object.is(base, next)) return {};
  if (
    !base ||
    !next ||
    Array.isArray(base) ||
    Array.isArray(next) ||
    typeof base !== "object" ||
    typeof next !== "object"
  )
    return next;
  const result: Record<string, unknown> = {};
  const left = base as Record<string, unknown>;
  const right = next as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!(key in right)) result[key] = undefined;
    else if (!(key in left)) result[key] = right[key];
    else {
      const value = diffValue(left[key], right[key]);
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        Object.keys(value).length
      )
        result[key] = value;
    }
  }
  return result;
}

export function mergeConfig(base: ConfigV3, overlay: ConfigPatch): ConfigV3 {
  return configV3Schema.parse({
    version: 3,
    runtime: deepMergeObject(base.runtime, overlay.runtime),
    sandbox: { ...base.sandbox, ...overlay.sandbox },
    team: { ...base.team, ...overlay.team },
    context: { ...base.context, ...overlay.context },
    checkpoint: { ...base.checkpoint, ...overlay.checkpoint },
    providers: deepMergeObject(base.providers, overlay.providers),
    catalog: deepMergeObject(base.catalog, overlay.catalog),
    modelOverrides: deepMergeObject(
      base.modelOverrides,
      overlay.modelOverrides,
    ),
    defaultModel:
      overlay.defaultModel === undefined
        ? base.defaultModel
        : deepMergeObject(base.defaultModel, overlay.defaultModel),
    agentModes: mergeRecord(base.agentModes, overlay.agentModes as never),
    defaultAgentMode: overlay.defaultAgentMode ?? base.defaultAgentMode,
    agents: mergeRecord(base.agents, overlay.agents as never),
    defaultAgent: overlay.defaultAgent ?? base.defaultAgent,
    mcpServers: mergeRecord(base.mcpServers, overlay.mcpServers as never),
    skills: { ...base.skills, ...overlay.skills },
    plugins: {
      enabled: mergeRecord(
        base.plugins.enabled,
        overlay.plugins?.enabled as never,
      ),
      paths: overlay.plugins?.paths ?? base.plugins.paths,
      capabilities: mergeRecord(
        base.plugins.capabilities,
        overlay.plugins?.capabilities as never,
      ),
      readOnly: mergeRecord(
        base.plugins.readOnly,
        overlay.plugins?.readOnly as never,
      ),
      settings: mergeRecord(
        base.plugins.settings,
        overlay.plugins?.settings as never,
      ),
      packages: mergeRecord(
        base.plugins.packages,
        overlay.plugins?.packages as never,
      ),
    },
    tools: { paths: overlay.tools?.paths ?? base.tools.paths },
    workspace: { ...base.workspace, ...overlay.workspace },
    instructions: { ...base.instructions, ...overlay.instructions },
    webSearch: { ...base.webSearch, ...overlay.webSearch },
    browser: { ...base.browser, ...overlay.browser },
    network: { ...base.network, ...overlay.network },
    security: { ...base.security, ...overlay.security },
    issueTargets: mergeRecord(base.issueTargets, overlay.issueTargets as never),
    dataSources: mergeRecord(base.dataSources, overlay.dataSources as never),
    alertChannels: mergeRecord(
      base.alertChannels,
      overlay.alertChannels as never,
    ),
    experimental: { ...base.experimental, ...overlay.experimental },
  });
}

function deepMergeObject(base: unknown, overlay: unknown): unknown {
  if (overlay === undefined) return base;
  if (base === undefined || Array.isArray(base) || Array.isArray(overlay))
    return overlay;
  if (
    typeof base !== "object" ||
    base === null ||
    typeof overlay !== "object" ||
    overlay === null
  )
    return overlay;
  const result = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(
    overlay as Record<string, unknown>,
  )) {
    if (value === undefined) delete result[key];
    else result[key] = deepMergeObject(result[key], value);
  }
  return result;
}

function mergeRecord<Value>(
  base: Record<string, Value>,
  overlay?: Record<string, Value | undefined>,
) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay ?? {})) {
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result;
}

export function mergeOverlay(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete result[key];
    else if (
      result[key] &&
      value &&
      typeof result[key] === "object" &&
      typeof value === "object" &&
      !Array.isArray(result[key]) &&
      !Array.isArray(value)
    )
      result[key] = mergeOverlay(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    else result[key] = value;
  }
  return result;
}

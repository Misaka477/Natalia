import type {
  Plugin,
  PluginConfigIssue,
  PluginConfigValidation,
} from "./types";

function formatConfigIssue(issue: PluginConfigIssue) {
  const path = (issue.path ?? [])
    .map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? String(segment.key)
        : String(segment),
    )
    .join(".");
  return path ? `  - ${issue.message} (at ${path})` : `  - ${issue.message}`;
}

export function resolvePluginConfig(plugin: Plugin, config: unknown): unknown {
  const schema = plugin.configSchema;
  if (!schema) return config;
  const result = schema["~standard"].validate(config);
  if (result !== null && typeof result === "object" && "then" in result)
    throw new Error(
      `plugin config validation must be synchronous: ${plugin.manifest.id}`,
    );
  const settled = result as PluginConfigValidation;
  if (settled.issues?.length)
    throw new Error(
      `plugin config invalid: ${plugin.manifest.id}\n${settled.issues
        .map(formatConfigIssue)
        .join("\n")}`,
    );
  return settled.value;
}

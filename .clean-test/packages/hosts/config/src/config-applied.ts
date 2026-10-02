import type { ResolvedConfig } from "./service";

/** Refuse configuration files the loader rejected instead of using fallbacks. */
export function assertConfigApplied(resolved: ResolvedConfig) {
  const rejected = resolved.sources.filter(
    (source) =>
      !source.applied && source.diagnostic?.startsWith("invalid_config"),
  );
  if (rejected.length)
    throw new Error(
      `configuration was rejected and is not in effect: ${rejected
        .map(
          (source) => `${source.path ?? source.scope} (${source.diagnostic})`,
        )
        .join(", ")}`,
    );
  return resolved.config;
}

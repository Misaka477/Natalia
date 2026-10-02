/**
 * Generic plugin-owned workspace resources.
 *
 * A plugin declares a resource instead of teaching the framework its business
 * directory. The kernel validates the declaration shape and path template; the
 * runtime and platform layers decide how to authorize and read it.
 */

/**
 * Runtime-supplied path parameters that every plugin resource may use without
 * declaring them.
 */
export const pluginWorkspaceBuiltinParams = [
  "sessionID",
  "workspaceID",
] as const;
export type PluginWorkspaceBuiltinParam =
  (typeof pluginWorkspaceBuiltinParams)[number];

/**
 * Older internal name kept as an alias for the built-in parameter list.
 *
 * @deprecated Use `pluginWorkspaceBuiltinParams`.
 */
export const pluginWorkspaceResourceParams = pluginWorkspaceBuiltinParams;

/** Values supplied by the runtime or the named resource-read caller. */
export type PluginWorkspaceResourceParams = Record<string, string | undefined>;

export type PluginWorkspaceResourceScope = "process" | "workspace" | "session";

export type PluginWorkspaceResource = {
  /** Contribution name, unique within the owning plugin. */
  name: string;
  /** Resource kind. Only workspace-file is implemented today. */
  kind: "workspace-file";
  /** Read-only for the first version. */
  access: "read";
  /**
   * Workspace-relative POSIX path template.
   *
   * Built-in placeholders are `sessionID` and `workspaceID`. A plugin may
   * declare additional single-path-segment parameters in `params`; the kernel
   * treats those names as data, never as business semantics.
   */
  path: string;
  /**
   * Additional parameter names this resource exposes to the named read API.
   *
   * Names are plugin-owned (`skillName`, `artifactID`, ...). The framework
   * only enforces syntax, uniqueness, and safety; it does not interpret them.
   */
  params?: string[];
  /**
   * Optional declaration scope. When omitted, the owning capability's scope is
   * used by the runtime resolver.
   */
  scope?: PluginWorkspaceResourceScope;
  /**
   * Optional reader allowlist of UI/plugin ids.
   *
   * When omitted, the path-based generic workspace read surface may still read
   * this exact declared path. When present, only the named `resourceRead`
   * surface may read it and the caller must pass a matching `reader`.
   */
  readers?: string[];
  /**
   * When true, successful named reads publish a live `resource.read` audit
   * event. Defaults to false.
   */
  audit?: boolean;
  description?: string;
};

const placeholderPattern = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/gu;
const paramNamePattern = /^[a-zA-Z][a-zA-Z0-9_]*$/u;
const supportedScopes: ReadonlySet<string> = new Set([
  "process",
  "workspace",
  "session",
]);

export function isPluginWorkspaceResource(
  value: unknown,
): value is PluginWorkspaceResource {
  if (!isRecord(value)) return false;
  if (typeof value.name !== "string" || value.name.length === 0) return false;
  if (value.kind !== "workspace-file") return false;
  if (value.access !== "read") return false;
  if (typeof value.path !== "string") return false;
  if (
    value.scope !== undefined &&
    (typeof value.scope !== "string" || !supportedScopes.has(value.scope))
  )
    return false;
  if (value.description !== undefined && typeof value.description !== "string")
    return false;
  if (
    value.readers !== undefined &&
    (!Array.isArray(value.readers) ||
      value.readers.some(
        (reader) => typeof reader !== "string" || reader.length === 0,
      ))
  )
    return false;
  if (value.audit !== undefined && typeof value.audit !== "boolean")
    return false;

  const declaredParams = pluginWorkspaceDeclaredParams(value.params);
  if (!declaredParams) return false;

  return isSafeResourceTemplate(
    value.path,
    pluginWorkspaceAllowedParams(declaredParams),
  );
}

/**
 * Normalizes a workspace-relative path for template matching.
 *
 * The platform performs the real containment and symlink checks; this function
 * only guarantees that both sides of a resource match use the same POSIX shape.
 */
export function normalizePluginWorkspacePath(
  value: string,
): string | undefined {
  const posix = value.replace(/\\/gu, "/");
  if (!posix || posix.startsWith("/")) return undefined;
  const segments: string[] = [];
  for (const segment of posix.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") return undefined;
    if (segment.includes("\0")) return undefined;
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * Resolves a resource template with trusted runtime parameters and declared
 * plugin parameters.
 *
 * Missing or unsafe placeholder values make the resource unavailable instead
 * of generating a broader path. The template itself is fixed by the plugin;
 * callers can only fill declared single-segment values.
 */
export function pluginWorkspaceResourcePath(
  resource: PluginWorkspaceResource,
  params: PluginWorkspaceResourceParams,
): string | undefined {
  if (!isPluginWorkspaceResource(resource)) return undefined;
  const allowedParams = pluginWorkspaceAllowedParams(
    pluginWorkspaceDeclaredParams(resource.params)!,
  );
  let unresolved = false;
  const replaced = resource.path.replace(
    placeholderPattern,
    (_match, rawName: string) => {
      if (!allowedParams.has(rawName)) {
        unresolved = true;
        return "";
      }
      const value = params[rawName];
      if (!isSafePathSegment(value)) {
        unresolved = true;
        return "";
      }
      return value;
    },
  );
  if (unresolved) return undefined;
  return normalizePluginWorkspacePath(replaced);
}

function pluginWorkspaceDeclaredParams(
  value: unknown,
): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const names = new Set<string>();
  for (const name of value) {
    if (typeof name !== "string" || !paramNamePattern.test(name))
      return undefined;
    if ((pluginWorkspaceBuiltinParams as readonly string[]).includes(name))
      return undefined;
    if (names.has(name)) return undefined;
    names.add(name);
  }
  return [...names];
}

function pluginWorkspaceAllowedParams(
  declaredParams: readonly string[],
): Set<string> {
  return new Set([...pluginWorkspaceBuiltinParams, ...declaredParams]);
}

function isSafeResourceTemplate(
  value: string,
  allowedParams: ReadonlySet<string>,
): boolean {
  const normalized = value.replace(/\\/gu, "/");
  if (!normalized || normalized.startsWith("/")) return false;
  if (/[*?\[\]]/u.test(normalized)) return false;
  const names = new Set<string>();
  for (const match of normalized.matchAll(placeholderPattern))
    names.add(match[1]!);
  const withoutPlaceholders = normalized.replace(placeholderPattern, "");
  if (withoutPlaceholders.includes("{") || withoutPlaceholders.includes("}"))
    return false;
  for (const name of names) if (!allowedParams.has(name)) return false;
  for (const segment of normalized.split("/")) {
    if (!segment || segment === "." || segment === "..") return false;
  }
  return true;
}

function isSafePathSegment(value: string | undefined): value is string {
  if (!value || value === "." || value === "..") return false;
  if (value.includes("/") || value.includes("\\") || value.includes("\0"))
    return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

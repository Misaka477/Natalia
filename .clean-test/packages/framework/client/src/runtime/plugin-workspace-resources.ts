/**
 * Resolves generic plugin-owned workspace resources against the capability
 * registry.
 *
 * The resolver is deliberately pure with respect to the filesystem. It only
 * turns a requested workspace path, or a named resource declaration, into an
 * exact path that the platform may allow through its ignore policy.
 */
import type { CapabilityRegistryView } from "@anthelia/capability";
import {
  isPluginWorkspaceResource,
  normalizePluginWorkspacePath,
  pluginWorkspaceResourcePath,
  type PluginWorkspaceResourceParams,
} from "@anthelia/plugin";

export type ResolvedWorkspaceResource = {
  pluginID: string;
  contributionName: string;
  relativePath: string;
  access: "read";
};

export type ResolvedNamedWorkspaceResource = ResolvedWorkspaceResource & {
  audit: boolean;
};

/**
 * The first implementation intentionally keeps plugin-owned resources inside
 * `.natalia/`. Normal project files already use `workspaceRead`; this surface
 * exists for plugin-private durable data, not for widening general workspace
 * access.
 */
const pluginResourceRoot = ".natalia/";

const reservedResourcePaths = new Set([
  ".natalia/config.json",
  ".natalia/workspace-settings.json",
  ".natalia/sessions",
]);

export function resolvePluginWorkspaceResource(input: {
  registry: CapabilityRegistryView;
  path: string;
  sessionID?: string;
  workspaceID?: string;
  access: "read";
}): ResolvedWorkspaceResource | undefined {
  const requestPath = normalizePluginWorkspacePath(input.path);
  if (!requestPath) return undefined;

  for (const contribution of input.registry.contributions<unknown>(
    "resources",
  )) {
    const resource = contribution.payload;
    if (!isPluginWorkspaceResource(resource)) continue;
    if (resource.access !== input.access) continue;
    // Reader-scoped and parameterized resources are only available through the
    // named API, where the caller can supply an auditable identity and values.
    if (resource.readers?.length || resource.params?.length) continue;

    const scope =
      resource.scope ?? input.registry.scopeOf(contribution.capabilityID);
    if (scope === "session" && !input.sessionID) continue;

    const relativePath = pluginWorkspaceResourcePath(resource, {
      sessionID: input.sessionID,
      workspaceID: input.workspaceID,
    });
    if (!relativePath || relativePath !== requestPath) continue;
    if (!isReadablePluginResourcePath(relativePath)) continue;

    return {
      pluginID: contribution.capabilityID,
      contributionName: contribution.name,
      relativePath,
      access: input.access,
    };
  }

  return undefined;
}

export function resolveNamedPluginWorkspaceResource(input: {
  registry: CapabilityRegistryView;
  resource: string;
  params: PluginWorkspaceResourceParams;
  sessionID?: string;
  reader?: string;
}): ResolvedNamedWorkspaceResource | undefined {
  const owner = input.registry.ownerOf("resources", input.resource);
  if (!owner) return undefined;
  const resource = input.registry.contribution<unknown>(
    "resources",
    input.resource,
  );
  if (!isPluginWorkspaceResource(resource)) return undefined;
  if (resource.access !== "read") return undefined;
  if (
    resource.readers?.length &&
    (!input.reader || !resource.readers.includes(input.reader))
  )
    return undefined;

  const relativePath = pluginWorkspaceResourcePath(resource, {
    ...input.params,
    ...(input.sessionID ? { sessionID: input.sessionID } : {}),
  });
  if (!relativePath || !isReadablePluginResourcePath(relativePath))
    return undefined;

  return {
    pluginID: owner,
    contributionName: input.resource,
    relativePath,
    access: "read",
    audit: resource.audit === true,
  };
}

function isReadablePluginResourcePath(path: string): boolean {
  if (!path.startsWith(pluginResourceRoot)) return false;
  if (reservedResourcePaths.has(path)) return false;
  if (path.startsWith(".natalia/sessions/")) return false;
  return true;
}

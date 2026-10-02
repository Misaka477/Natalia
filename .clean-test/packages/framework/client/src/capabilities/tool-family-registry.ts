import type {
  CapabilityRegistration,
  CapabilityRegistryHost,
} from "@anthelia/capability";
import {
  createToolRegistry,
  type RuntimeTool,
  type ToolFamily,
  type ToolRegistry,
} from "@anthelia/tools";

export function toolFamilyCapabilityID(familyID: string) {
  return `natalia-tool-${familyID}`;
}

export function toolFamilyRegistration(
  family: ToolFamily,
): CapabilityRegistration {
  return {
    id: toolFamilyCapabilityID(family.id),
    name: family.name,
    version: family.version,
    description: family.description,
    scope: family.scope,
    grants: ["tools"],
  };
}

export type ToolFamilyLoadOutcome = {
  loaded: Array<{ registration: CapabilityRegistration; tools: string[] }>;
  failed: Array<{ id: string; reason: string }>;
};

export function registerToolFamilyCapabilities(
  registry: CapabilityRegistryHost,
  families: ToolFamily[],
): ToolFamilyLoadOutcome {
  const loaded: ToolFamilyLoadOutcome["loaded"] = [];
  const failed: ToolFamilyLoadOutcome["failed"] = [];
  for (const family of orderedFamilies(families)) {
    const registration = toolFamilyRegistration(family);
    let owner: import("@anthelia/capability").CapabilityOwnerHandle | undefined;
    try {
      owner = registry.registerOwner(registration);
      for (const tool of family.tools)
        owner.contribute("tools", tool.name, tool);
    } catch (error) {
      owner?.release();
      failed.push({
        id: registration.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    loaded.push({
      registration,
      tools: family.tools.map((tool) => tool.name),
    });
  }
  return { loaded, failed };
}

function orderedFamilies(families: ToolFamily[]): ToolFamily[] {
  const byID = new Map(families.map((family) => [family.id, family]));
  const ordered: ToolFamily[] = [];
  const visited = new Set<string>();
  const visit = (family: ToolFamily) => {
    if (visited.has(family.id)) return;
    visited.add(family.id);
    for (const dependency of family.dependencies ?? []) {
      const dependencyFamily = byID.get(dependency);
      if (dependencyFamily) visit(dependencyFamily);
    }
    ordered.push(family);
  };
  for (const family of families) visit(family);
  return ordered;
}

export function createToolRegistryFromCapabilities(input: {
  registry: CapabilityRegistryHost;
  families?: ToolFamily[];
}): { tools: ToolRegistry; outcome: ToolFamilyLoadOutcome } {
  const families = input.families ?? [];
  const outcome = registerToolFamilyCapabilities(input.registry, families);
  const tools = createToolRegistry([]);
  const accepted = new Set(
    outcome.loaded.map((entry) => entry.registration.id),
  );
  for (const contribution of input.registry.contributions<RuntimeTool>("tools"))
    if (accepted.has(contribution.capabilityID))
      tools.set(contribution.name, contribution.payload);
  for (const family of families) {
    if (!accepted.has(toolFamilyCapabilityID(family.id))) continue;
    for (const [alias, target] of Object.entries(family.aliases ?? {}))
      if (tools.has(target)) tools.addAlias(alias, target);
  }
  return { tools, outcome };
}

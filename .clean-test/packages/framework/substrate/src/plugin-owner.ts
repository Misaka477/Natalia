import type {
  CapabilityGrant,
  CapabilityRegistryHost,
} from "@anthelia/capability";
import {
  manifestIntegrationPoints,
  type PluginManifest,
} from "@anthelia/plugin";

export function registerPluginOwner(
  manifest: PluginManifest,
  registry: CapabilityRegistryHost,
) {
  const grants: CapabilityGrant[] = [];
  const integrationPoints = manifestIntegrationPoints(manifest);
  if (manifest.provides.length) grants.push("services");
  const grantForPoint: Partial<
    Record<(typeof integrationPoints)[number], CapabilityGrant>
  > = {
    tools: "tools",
    commands: "commands",
    events: "listeners",
    services: "services",
    resources: "resources",
    projections: "projections",
    workflows: "workflows",
    settingsSchema: "settingsSchema",
    adapters: "adapters",
    schedulerJobs: "schedulerJobs",
  };
  for (const point of integrationPoints) {
    const grant = grantForPoint[point];
    if (grant && !grants.includes(grant)) grants.push(grant);
  }
  const owner = registry.registerOwner({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    scope: manifest.scope,
    grants,
  });
  return { contribute: owner.contribute, release: owner.release };
}

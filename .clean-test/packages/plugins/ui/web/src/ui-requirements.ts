import {
  describeRuntimeCapabilities,
  type RuntimeClient,
  type UiPanelRequirement,
} from "@anthelia/contracts";

export type UiPanelRequirementContext = {
  runtime: RuntimeClient;
  pluginIds: Set<string>;
  capabilities: Set<string>;
};

export async function createUiPanelRequirementContext(
  runtime: RuntimeClient,
): Promise<UiPanelRequirementContext> {
  const [plugins, report] = await Promise.all([
    runtime.plugins?.(),
    Promise.resolve(describeRuntimeCapabilities(runtime)),
  ]);
  return {
    runtime,
    pluginIds: new Set((plugins ?? []).map((plugin) => plugin.id)),
    capabilities: new Set(
      report.groups
        .filter((group) => group.available)
        .map((group) => group.name),
    ),
  };
}

export function uiPanelRequirementsSatisfied(
  context: UiPanelRequirementContext,
  requirements?: UiPanelRequirement[],
): boolean {
  if (!requirements?.length) return true;
  return requirements.every((requirement) => {
    if (requirement.type === "plugin")
      return context.pluginIds.has(requirement.id);
    if (requirement.type === "capability")
      return context.capabilities.has(requirement.id);
    if (requirement.type === "method")
      return (
        typeof (context.runtime as unknown as Record<string, unknown>)[
          requirement.name
        ] === "function"
      );
    return false;
  });
}

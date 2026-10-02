import type { ProjectionContribution } from "@anthelia/contracts";
import type { CapabilityRegistryHost } from "@anthelia/capability";

const placements = new Set(["tool-card", "sidebar"]);

export function snapshotProjectionContributions(
  registry: CapabilityRegistryHost | undefined,
): ProjectionContribution[] {
  if (!registry) return [];
  const seen = new Set<string>();
  const contributions: ProjectionContribution[] = [];
  for (const entry of registry.contributions<Record<string, unknown>>(
    "projections",
  )) {
    const payload = entry.payload;
    const name =
      typeof payload?.name === "string" && payload.name.trim()
        ? payload.name.trim()
        : entry.name;
    const title =
      typeof payload?.title === "string" ? payload.title.trim() : "";
    if (!name || !title || seen.has(name)) continue;
    const placement =
      typeof payload?.placement === "string" &&
      placements.has(payload.placement)
        ? (payload.placement as ProjectionContribution["placement"])
        : "sidebar";
    const text =
      typeof payload?.text === "string"
        ? payload.text.slice(0, 500)
        : undefined;
    seen.add(name);
    contributions.push({
      name,
      title,
      placement,
      ...(text ? { text } : {}),
    });
  }
  return contributions;
}

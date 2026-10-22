export type EditableModel = {
  id: string;
  name: string;
  reasoning: boolean;
  image: boolean;
};

export function mergeDiscoveredModels(
  current: EditableModel[],
  discoveredIDs: string[],
): EditableModel[] {
  const configured = new Map<string, EditableModel>();
  for (const model of current) {
    const id = model.id.trim();
    if (id && !configured.has(id)) configured.set(id, model);
  }

  const discovered = new Set<string>();
  for (const rawID of discoveredIDs) {
    const id = rawID.trim();
    if (id) discovered.add(id);
  }

  return [...discovered]
    .map((id) => {
      const existing = configured.get(id);
      return existing
        ? { ...existing, id }
        : { id, name: id, reasoning: true, image: false };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

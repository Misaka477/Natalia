import type { PluginManifest, PluginManifestV2 } from "./manifest";

export type PluginDependencyResolution = {
  order: string[];
  pending: Array<{ id: string; reason: string }>;
  denied: Array<{ id: string; reason: string }>;
};

export function resolvePluginDependencies(
  manifests: PluginManifest[],
  active: PluginManifest[] = [],
  mounted: PluginManifest[] = active,
): PluginDependencyResolution {
  const activeByID = new Map(active.map((manifest) => [manifest.id, manifest]));
  const mountedByID = new Map(
    mounted.map((manifest) => [manifest.id, manifest]),
  );
  const byID = new Map<string, PluginManifest>();
  const denied: PluginDependencyResolution["denied"] = [];
  const pending: PluginDependencyResolution["pending"] = [];
  const blocked = new Set<string>();
  const deny = (id: string, reason: string) => {
    if (blocked.has(id)) return;
    blocked.add(id);
    denied.push({ id, reason });
  };
  const pend = (id: string, reason: string) => {
    if (blocked.has(id)) return;
    blocked.add(id);
    pending.push({ id, reason });
  };

  for (const manifest of manifests) {
    if (activeByID.has(manifest.id)) {
      deny(manifest.id, `plugin already active: "${manifest.id}"`);
      continue;
    }
    if (byID.has(manifest.id)) {
      deny(manifest.id, `duplicate plugin id: "${manifest.id}"`);
      continue;
    }
    byID.set(manifest.id, manifest);
  }
  const available = new Map([...activeByID, ...byID]);
  const conflictCandidates = new Map([...mountedByID, ...byID]);

  for (const manifest of manifests) {
    if (manifest.apiVersion !== 2 || blocked.has(manifest.id)) continue;
    const conflict = [...conflictCandidates.values()].find(
      (other) =>
        other.id !== manifest.id &&
        (manifest.conflicts.includes(other.id) ||
          (other.apiVersion === 2 && other.conflicts.includes(manifest.id))),
    );
    if (conflict) {
      deny(manifest.id, `conflicts with "${conflict.id}"`);
      continue;
    }
    for (const dependency of manifest.dependencies) {
      const candidate = available.get(dependency.id);
      if (!candidate) {
        if (!dependency.optional)
          pend(
            manifest.id,
            `requires plugin "${dependency.id}" (${dependency.spec})`,
          );
        continue;
      }
      if (!satisfiesVersion(candidate.version, dependency.spec)) {
        if (dependency.optional) continue;
        pend(
          manifest.id,
          `plugin "${dependency.id}" version ${candidate.version} does not satisfy ${dependency.spec}`,
        );
      }
    }
  }

  // A required dependency that cannot activate also blocks every dependent.
  let changed = true;
  while (changed) {
    changed = false;
    for (const manifest of manifests) {
      if (manifest.apiVersion !== 2 || blocked.has(manifest.id)) continue;
      const dependency = requiredDependencies(manifest).find((item) =>
        blocked.has(item.id),
      );
      if (!dependency) continue;
      pend(manifest.id, `requires unavailable plugin "${dependency.id}"`);
      changed = true;
    }
  }

  const order: string[] = [];
  const remaining = new Set(
    manifests
      .map((manifest) => manifest.id)
      .filter((id) => byID.has(id) && !blocked.has(id)),
  );
  while (remaining.size) {
    const ready = manifests.find((manifest) => {
      if (!remaining.has(manifest.id)) return false;
      if (manifest.apiVersion !== 2) return true;
      return orderedDependencies(manifest, byID).every(
        (dependency) => !remaining.has(dependency.id),
      );
    });
    const next =
      ready ?? manifests.find((manifest) => remaining.has(manifest.id));
    if (!next) break;
    if (!ready) {
      for (const id of remaining) pend(id, "plugin dependency cycle");
      break;
    }
    remaining.delete(next.id);
    order.push(next.id);
  }
  return { order, pending, denied };
}

function requiredDependencies(manifest: PluginManifestV2) {
  return manifest.dependencies.filter((dependency) => !dependency.optional);
}

function orderedDependencies(
  manifest: PluginManifestV2,
  candidates: Map<string, PluginManifest>,
) {
  return manifest.dependencies.filter((dependency) => {
    if (!dependency.optional) return true;
    const candidate = candidates.get(dependency.id);
    return !!candidate && satisfiesVersion(candidate.version, dependency.spec);
  });
}

function satisfiesVersion(version: string, spec: string): boolean {
  if (spec === "*" || spec === "latest" || spec === "workspace:*") return true;
  const normalized = spec.startsWith("workspace:")
    ? spec.slice("workspace:".length)
    : spec;
  const parsed = parseVersion(version);
  if (!parsed) return version === normalized;
  if (normalized.startsWith("^")) {
    const base = parseVersion(normalized.slice(1));
    if (!base || compare(parsed, base) < 0) return false;
    if (base[0] > 0) return parsed[0] === base[0];
    if (base[1] > 0) return parsed[0] === 0 && parsed[1] === base[1];
    return parsed[0] === 0 && parsed[1] === 0 && parsed[2] === base[2];
  }
  if (normalized.startsWith("~")) {
    const base = parseVersion(normalized.slice(1));
    return (
      !!base &&
      parsed[0] === base[0] &&
      parsed[1] === base[1] &&
      compare(parsed, base) >= 0
    );
  }
  for (const operator of [">=", "<=", ">", "<"] as const)
    if (normalized.startsWith(operator)) {
      const base = parseVersion(normalized.slice(operator.length));
      if (!base) return false;
      const result = compare(parsed, base);
      return operator === ">="
        ? result >= 0
        : operator === "<="
          ? result <= 0
          : operator === ">"
            ? result > 0
            : result < 0;
    }
  const exact = parseVersion(normalized);
  return !!exact && compare(parsed, exact) === 0;
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value.trim());
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

function compare(
  left: [number, number, number],
  right: [number, number, number],
) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference) return difference;
  }
  return 0;
}

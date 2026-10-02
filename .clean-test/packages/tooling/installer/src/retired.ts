/**
 * The kill list (the study's removed.yaml): packages that WERE official and
 * were RETIRED — every install path refuses them by name. The list is not a
 * wish: each entry is a real takedown this repository lived through
 * (`72f42dd0`, 2026-09-02: the task/workflow packages dropped from the
 * catalog AND the monorepo). Before this list, a retired package was merely
 * absent from OFFICIAL_PLUGIN_PACKAGES — and the generic install path takes
 * any spec, so `pluginInstall("@natalia/plugin-task-module")` re-installed a
 * retired package. An absent list is not a refusal; this one is.
 *
 * Its own module on purpose: `official.ts` already imports the lifecycle
 * that consumes this, so homing the list there would cycle the graph.
 */

export const RETIRED_PLUGIN_PACKAGES = [
  {
    id: "natalia-task-module",
    packageName: "@natalia/plugin-task-module",
    retiredOn: "2026-09-02",
    reason:
      "the task module left the product (72f42dd0 dropped it from the catalog and the monorepo)",
  },
  {
    id: "natalia-task-workflow",
    packageName: "@natalia/plugin-task-workflow",
    retiredOn: "2026-09-02",
    reason:
      "the workflow module left the product with the task module (72f42dd0)",
  },
] as const;

/**
 * The install spec's package name without its version: `@scope/name@1.2.3`
 * and `@scope/name` both answer `@scope/name`; a bare `name@1.2.3` answers
 * `name` (a scoped name's own `@` is not a separator).
 */
export function specPackageName(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed.startsWith("@")) {
    const slash = trimmed.indexOf("/");
    const versionAt = slash === -1 ? -1 : trimmed.indexOf("@", slash + 1);
    return versionAt === -1 ? trimmed : trimmed.slice(0, versionAt);
  }
  const versionAt = trimmed.indexOf("@");
  return versionAt === -1 ? trimmed : trimmed.slice(0, versionAt);
}

/**
 * Why this spec is refused, or undefined when it may install. Pure: the
 * caller (`installPlugin`) asks before anything is staged, so a refusal
 * leaves no trace — the retirement is a door, not a cleanup.
 */
export function retiredPluginPackageReason(spec: string): string | undefined {
  const name = specPackageName(spec);
  const retired = RETIRED_PLUGIN_PACKAGES.find(
    (entry) => entry.packageName === name,
  );
  if (!retired) return undefined;
  return `${retired.packageName} was retired on ${retired.retiredOn} (${retired.reason}) and cannot be installed`;
}

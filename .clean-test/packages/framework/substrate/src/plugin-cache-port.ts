import type { PluginCachePort } from "@anthelia/plugin";

/**
 * The engine-side fabric the plugin cache port needs, structurally
 * declared: the substrate must not depend on the rina package (the
 * fabric is a framework sibling; the port only ever touches these
 * four methods). The real fabric (`@anthelia/rina`'s CacheFabric)
 * satisfies it; tests satisfy it with a fake.
 */
export type CacheFabricLike = {
  registerKind(kind: CacheKindLike): void;
  unregisterKind(kindID: string): number;
  compute<T>(
    kindID: string,
    key: string,
    compute: () => T | Promise<T>,
  ): Promise<T>;
  metrics(kindID?: string): Record<string, unknown>;
};

/** The fabric's kind shape, mirrored for the same layering reason. */
export type CacheKindLike = {
  readonly id: string;
  readonly deterministic: true;
  readonly invalidation: "path" | "tree";
  readonly captureEvidence?: (key: string) => unknown | Promise<unknown>;
  readonly validEvidence?: (
    evidence: unknown,
    key: string,
  ) => boolean | Promise<boolean>;
  readonly sizeOf?: (value: unknown) => number;
};

/**
 * The plugin cache port over the engine's fabric — the master plan's
 * closure-round base surface ("plugins call rina.cache, never hand-roll
 * a cache"). Three responsibilities beyond passthrough:
 *
 *  1. **Law 1 validation with plugin-named errors.** The fabric's own
 *     registerKind already rejects duplicates and unpaired evidence;
 *     this adds the plugin-shape checks (deterministic flag, mode,
 *     non-empty id) so a failing plugin hears its own kind's name.
 *  2. **Ownership.** registerKind returns a disposer that unregisters
 *     AND drops the kind's entries — a plugin's kind dies with the
 *     plugin; a definition unloaded with its plugin must not keep
 *     answering (the fabric's unregisterKind is the engine half).
 *  3. **Lazy resolution.** The fabric is looked up through the
 *     resolver on first use and then held, so the wiring order
 *     between the services and the plugin controller cannot strand
 *     the port with an undefined fabric.
 */
export function createPluginCachePort(
  resolveFabric: () => CacheFabricLike | undefined,
): PluginCachePort {
  let resolved: CacheFabricLike | undefined | "pending" = "pending";
  function fabric(): CacheFabricLike {
    if (resolved === "pending") {
      resolved = resolveFabric();
    }
    if (!resolved)
      throw new Error(
        "cache is not available in this host (the rina.cache service is not wired)",
      );
    return resolved;
  }

  return {
    registerKind(kind) {
      assertPluginCacheKind(kind);
      const active = fabric();
      active.registerKind(kind);
      let released = false;
      return () => {
        // Idempotent like every other registration disposer: the reverse
        // cleanup may call it twice (once explicit, once on unload).
        if (released) return;
        released = true;
        active.unregisterKind(kind.id);
      };
    },
    // async so a missing fabric REJECTS (a promise-returning API never
    // throws synchronously — a caller's .catch must see it).
    async compute<T>(
      kindID: string,
      key: string,
      compute: () => T | Promise<T>,
    ): Promise<T> {
      return fabric().compute<T>(kindID, key, compute);
    },
    metrics(kindID) {
      return fabric().metrics(kindID) as ReturnType<PluginCachePort["metrics"]>;
    },
  };
}

/**
 * The plugin-shape validation (the fabric's own checks stay where they
 * are; these name the plugin's kind in the error). Pure.
 */
export function assertPluginCacheKind(kind: {
  id: string;
  deterministic: unknown;
  invalidation: unknown;
}): void {
  if (!kind.id || typeof kind.id !== "string")
    throw new Error("plugin cache kind needs a non-empty id");
  if (kind.deterministic !== true)
    throw new Error(
      `cache kind "${kind.id}" must declare deterministic: true — a clock, a sample, or any external state is not a cache`,
    );
  if (kind.invalidation !== "path" && kind.invalidation !== "tree")
    throw new Error(
      `cache kind "${kind.id}" declares invalidation "${String(kind.invalidation)}" — a kind is path-scoped or tree-scoped, nothing else`,
    );
}

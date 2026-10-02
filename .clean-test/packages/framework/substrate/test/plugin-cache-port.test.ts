import { expect, test } from "bun:test";
import {
  assertPluginCacheKind,
  createPluginCachePort,
  type CacheFabricLike,
  type CacheKindLike,
} from "../src/plugin-cache-port";

/**
 * The plugin cache port's engine half: law-1 validation with plugin-named
 * errors, delegation to the fabric, and the ownership disposer (a plugin's
 * kind dies with the plugin — the fabric's unregisterKind is the engine
 * half of that promise). The registration gate and the delegation at the
 * activation seam have their own test in the plugin kernel.
 */

/** A fabric fake that records what the port asked of it. */
function fakeFabric() {
  const registered: CacheKindLike[] = [];
  const unregistered: string[] = [];
  const computed: Array<[string, string]> = [];
  const fabric: CacheFabricLike = {
    registerKind(kind) {
      registered.push(kind);
    },
    unregisterKind(kindID) {
      unregistered.push(kindID);
      return 1;
    },
    async compute<T>(
      kindID: string,
      key: string,
      compute: () => T | Promise<T>,
    ) {
      computed.push([kindID, key]);
      return await compute();
    },
    metrics(kindID) {
      return {
        [kindID ?? "*"]: {
          hits: 1,
          misses: 0,
          invalidations: 0,
          evictions: 0,
          entries: 1,
          bytes: 1,
          bytesServed: 1,
        },
      } as never;
    },
  };
  return { fabric, registered, unregistered, computed };
}

test("a plugin kind that does not classify itself is refused by name", () => {
  // The clock/TTL sin at the door: `deterministic: true` is a typed
  // promise, and a plugin that cannot make it gets its kind named.
  expect(() =>
    assertPluginCacheKind({
      id: "fixture.clock",
      deterministic: false as never,
      invalidation: "tree",
    }),
  ).toThrow(/fixture\.clock.*deterministic: true/u);
  expect(() =>
    assertPluginCacheKind({
      id: "fixture.mode",
      deterministic: true,
      invalidation: "sometimes" as never,
    }),
  ).toThrow(/fixture\.mode.*path-scoped or tree-scoped/u);
  expect(() =>
    assertPluginCacheKind({
      id: "",
      deterministic: true,
      invalidation: "tree",
    }),
  ).toThrow(/non-empty id/u);
});

test("registerKind delegates and its disposer unregisters exactly once", () => {
  const { fabric, registered, unregistered } = fakeFabric();
  const port = createPluginCachePort(() => fabric);
  const kind = {
    id: "fixture.kind",
    deterministic: true,
    invalidation: "tree",
  } as const;
  const dispose = port.registerKind(kind);
  expect(registered).toEqual([kind]);
  // Idempotent like every other registration disposer: the reverse cleanup
  // may call it twice (once explicit, once on unload).
  dispose();
  dispose();
  expect(unregistered).toEqual(["fixture.kind"]);
});

test("compute and metrics pass straight through to the fabric", async () => {
  const { fabric, computed } = fakeFabric();
  const port = createPluginCachePort(() => fabric);
  const value = await port.compute("fixture.kind", "k", () => 7);
  expect(value).toBe(7);
  expect(computed).toEqual([["fixture.kind", "k"]]);
  expect(port.metrics("fixture.kind")).toEqual({
    "fixture.kind": {
      hits: 1,
      misses: 0,
      invalidations: 0,
      evictions: 0,
      entries: 1,
      bytes: 1,
      bytesServed: 1,
    },
  });
});

test("the port resolves the fabric lazily and then holds it", () => {
  // The wiring order between the services and the plugin controller must
  // not strand the port: a fabric that appears after construction is used.
  const { fabric, registered } = fakeFabric();
  let wired: CacheFabricLike | undefined;
  const port = createPluginCachePort(() => wired);
  wired = fabric;
  port.registerKind({
    id: "fixture.late",
    deterministic: true,
    invalidation: "tree",
  });
  expect(registered.map((kind) => kind.id)).toEqual(["fixture.late"]);
});

test("with no fabric the port fails loud, never silently uncached", async () => {
  const port = createPluginCachePort(() => undefined);
  expect(() =>
    port.registerKind({
      id: "fixture.absent",
      deterministic: true,
      invalidation: "tree",
    }),
  ).toThrow(/cache is not available/u);
  await expect(port.compute("fixture.absent", "k", () => 1)).rejects.toThrow(
    /cache is not available/u,
  );
});

test("plugin skill dirs resolve from the catalog, per package", async () => {
  // The controller's skillDirs(): each entry's declared dir resolves
  // against its package manifest path; no declaration or no path (the
  // injected host entries) contributes nothing.
  const { pluginSkillDirsFrom } = await import("../src/plugins-controller");
  const dirs = pluginSkillDirsFrom([
    {
      id: "a",
      enabled: true,
      fingerprint: "x",
      path: "/store/node_modules/@natalia/plugin-a/natalia.plugin.json",
      load: async () => undefined as never,
      manifest: {
        apiVersion: 2,
        id: "a",
        version: "1.0.0",
        name: "A",
        skills: {},
      } as never,
    },
    {
      id: "b",
      enabled: true,
      fingerprint: "y",
      path: "/store/node_modules/@natalia/plugin-b/natalia.plugin.json",
      load: async () => undefined as never,
      manifest: {
        apiVersion: 2,
        id: "b",
        version: "1.0.0",
        name: "B",
        skills: { dir: "agent/skills" },
      } as never,
    },
    {
      id: "c",
      enabled: true,
      fingerprint: "z",
      path: "/store/node_modules/@natalia/plugin-c/natalia.plugin.json",
      load: async () => undefined as never,
      manifest: {
        apiVersion: 2,
        id: "c",
        version: "1.0.0",
        name: "C",
      } as never,
    },
    {
      id: "host",
      enabled: true,
      fingerprint: "h",
      load: async () => undefined as never,
      manifest: {
        apiVersion: 2,
        id: "host",
        version: "1.0.0",
        name: "Host",
        skills: {},
      } as never,
    },
  ]);
  expect(dirs.sort()).toEqual([
    "/store/node_modules/@natalia/plugin-a/skills",
    "/store/node_modules/@natalia/plugin-b/agent/skills",
  ]);
});

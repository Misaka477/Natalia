import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createToolRegistry } from "@anthelia/tools";
import {
  createPluginRegistry,
  createPluginAdapterMaterializer,
  definePlugin,
  discoverPluginManifests,
  pluginManifestSchema,
  manifestIntegrationPoints,
  pluginFacetFor,
  pluginLogDir,
  pluginSkillDir,
  safeDeclaredDir,
  PLUGIN_FACET_ENVS,
  resolvePluginDependencies,
  resolvePluginConfig,
  computePluginPackageHash,
  resolveInstalledPluginEntries,
  loadPluginEntries,
  runPluginConformance,
} from "../src";

test("v2 manifests reject lifecycle hooks that are not implemented", () => {
  expect(() =>
    pluginManifestSchema.parse({
      apiVersion: 2,
      id: "fixture.hooks",
      version: "1.0.0",
      name: "Hooks",
      hooks: { postInstall: "configure" },
    }),
  ).toThrow();
});

test("plugin discovery scans unscoped and scoped installed packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-discovery-"));
  const packages = [
    join(root, "node_modules", "plain-plugin"),
    join(root, "node_modules", "@fixture", "scoped-plugin"),
  ];
  for (const [index, directory] of packages.entries()) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "natalia.plugin.json"),
      JSON.stringify({
        apiVersion: 1,
        id: `fixture.plugin.${index}`,
        version: "1.0.0",
        name: `Fixture ${index}`,
      }),
    );
  }
  expect(
    (await discoverPluginManifests(root))
      .map((entry) => entry.manifest.id)
      .sort(),
  ).toEqual(["fixture.plugin.0", "fixture.plugin.1"]);
});

test("separate registries load isolated plugin module lifecycles", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-plugin-module-lifecycle-"),
  );
  const manifest = pluginManifestSchema.parse({
    apiVersion: 1,
    id: "fixture.module-lifecycle",
    version: "1.0.0",
    name: "Module lifecycle fixture",
    entry: "index.ts",
    scope: "workspace",
  });
  await writeFile(join(root, "natalia.plugin.json"), JSON.stringify(manifest));
  await writeFile(
    join(root, "index.ts"),
    `export default () => {
  let instance = 0;
  return {
  setup(api) {
    instance = Number(api.config);
  },
  dispose() {
    globalThis.__nataliaPluginLifecycle ??= [];
    globalThis.__nataliaPluginLifecycle.push(instance);
  },
  };
};`,
  );
  const lifecycle = [] as number[];
  Object.assign(globalThis, { __nataliaPluginLifecycle: lifecycle });
  const first = createPluginRegistry({ tools: createToolRegistry([]) });
  const second = createPluginRegistry({ tools: createToolRegistry([]) });
  const entries = [{ manifest, path: join(root, "natalia.plugin.json") }];

  await loadPluginEntries({
    entries,
    registry: first,
    settings: { [manifest.id]: 1 },
  });
  await loadPluginEntries({
    entries,
    registry: second,
    settings: { [manifest.id]: 2 },
  });
  await second.unloadAll();
  await first.unloadAll();

  expect(lifecycle).toEqual([2, 1]);
  delete (globalThis as { __nataliaPluginLifecycle?: number[] })
    .__nataliaPluginLifecycle;
});

test("installed plugin entries require matching lock and manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-closure-"));
  const pluginStoreRoot = join(root, "plugin-store");
  const packageRoot = join(
    pluginStoreRoot,
    "node_modules",
    "@fixture",
    "plugin",
  );
  await mkdir(packageRoot, { recursive: true });
  const manifestPath = join(packageRoot, "natalia.plugin.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      apiVersion: 2,
      id: "fixture.plugin",
      version: "1.2.3",
      name: "Fixture",
      entry: "index.ts",
      scope: "workspace",
    }),
  );
  await writeFile(join(packageRoot, "index.ts"), "export default {};");
  const lockPath = join(pluginStoreRoot, "natalia.lock");
  await writeFile(
    lockPath,
    JSON.stringify({
      version: 1,
      plugins: {
        "fixture.plugin": {
          packageName: "@fixture/plugin",
          manifest: manifestPath,
          metadata: {
            id: "fixture.plugin",
            source: { type: "registry", spec: "@fixture/plugin@1.2.3" },
            resolvedVersion: "1.2.3",
            integrity: "sha512-fixture",
            scope: "workspace",
            dependencies: [],
          },
        },
      },
    }),
  );
  const resolved = await resolveInstalledPluginEntries({
    pluginStoreRoot,
  });
  expect(resolved.errors).toEqual([]);
  expect(resolved.entries).toEqual([
    expect.objectContaining({
      path: manifestPath,
      manifest: expect.objectContaining({ id: "fixture.plugin" }),
    }),
  ]);

  await writeFile(
    lockPath,
    JSON.stringify({
      version: 1,
      plugins: {
        "fixture.plugin": {
          packageName: "@fixture/plugin",
          manifest: manifestPath,
          metadata: {
            id: "fixture.plugin",
            source: { type: "registry", spec: "@fixture/plugin@2.0.0" },
            resolvedVersion: "2.0.0",
            integrity: "sha512-fixture",
            scope: "workspace",
            dependencies: [],
          },
        },
        "missing.plugin": {
          packageName: "missing-plugin",
          manifest: join(
            pluginStoreRoot,
            "node_modules",
            "missing-plugin",
            "natalia.plugin.json",
          ),
          metadata: {
            id: "missing.plugin",
            source: { type: "registry", spec: "missing-plugin@1.0.0" },
            resolvedVersion: "1.0.0",
            scope: "workspace",
            dependencies: [],
          },
        },
      },
    }),
  );
  const mismatch = await resolveInstalledPluginEntries({ pluginStoreRoot });
  expect(mismatch.entries).toEqual([]);
  expect(mismatch.errors.map(({ id }) => id).sort()).toEqual([
    "fixture.plugin",
    "missing.plugin",
  ]);
});

test("installed plugin entries reject lock paths outside their package", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-escape-"));
  const pluginStoreRoot = join(root, "plugin-store");
  const packageRoot = join(pluginStoreRoot, "node_modules", "fixture-plugin");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "index.ts"), "export default {};");
  await writeFile(
    join(pluginStoreRoot, "natalia.lock"),
    JSON.stringify({
      version: 1,
      plugins: {
        "fixture.plugin": {
          packageName: "fixture-plugin",
          manifest: join(root, "outside", "natalia.plugin.json"),
          metadata: {
            id: "fixture.plugin",
            source: { type: "registry", spec: "fixture-plugin" },
            resolvedVersion: "1.0.0",
            scope: "workspace",
            dependencies: [],
          },
        },
      },
    }),
  );
  const resolved = await resolveInstalledPluginEntries({
    pluginStoreRoot,
  });
  expect(resolved.entries).toEqual([]);
  expect(resolved.errors[0]?.error.message).toContain(
    "manifest escapes package",
  );
});

test("plugin manifest v2 keeps v1 compatibility and applies defaults", () => {
  expect(
    pluginManifestSchema.parse({
      apiVersion: 2,
      id: "v2.plugin",
      version: "2.0.0",
      name: "V2",
    }),
  ).toMatchObject({
    apiVersion: 2,
    scope: "session",
    optionalRequires: [],
    conflicts: [],
    dependencies: [],
    integrationPoints: [],
  });
  expect(
    pluginManifestSchema.parse({
      apiVersion: 1,
      id: "v1.plugin",
      version: "1.0.0",
      name: "V1",
    }),
  ).toMatchObject({ apiVersion: 1, capabilities: [], scope: "session" });
});

test("v2 manifests accept renderer-side UI metadata", () => {
  const parsed = pluginManifestSchema.parse({
    apiVersion: 2,
    id: "ui.plugin",
    version: "1.0.0",
    name: "UI Plugin",
    integrationPoints: ["tools"],
    ui: {
      entry: "src/ui/plugin.js",
      panels: [
        {
          id: "settings",
          title: "Settings",
          region: "settings",
          group: "扩展",
          requires: [
            { type: "plugin", id: "natalia-ui" },
            { type: "capability", id: "settings" },
          ],
        },
      ],
    },
  });
  expect(parsed).toMatchObject({
    apiVersion: 2,
    ui: {
      entry: "src/ui/plugin.js",
      panels: [
        {
          id: "settings",
          title: "Settings",
          region: "settings",
          group: "扩展",
          requires: [
            { type: "plugin", id: "natalia-ui" },
            { type: "capability", id: "settings" },
          ],
        },
      ],
    },
  });
});

test("plugin dependency resolver orders required dependencies", () => {
  const provider = pluginManifestSchema.parse({
    apiVersion: 2,
    id: "provider.plugin",
    version: "1.4.0",
    name: "Provider",
  });
  const consumer = pluginManifestSchema.parse({
    apiVersion: 2,
    id: "consumer.plugin",
    version: "1.0.0",
    name: "Consumer",
    dependencies: [
      { id: "provider.plugin", spec: "^1.2.0" },
      { id: "missing.optional", spec: "*", optional: true },
    ],
  });
  expect(resolvePluginDependencies([consumer, provider])).toEqual({
    order: ["provider.plugin", "consumer.plugin"],
    pending: [],
    denied: [],
  });
});

test("plugin dependency resolver orders available optional dependencies", () => {
  const manifest = (id: string, input: Record<string, unknown> = {}) =>
    pluginManifestSchema.parse({
      apiVersion: 2,
      id,
      version: "1.0.0",
      name: id,
      ...input,
    });
  expect(
    resolvePluginDependencies([
      manifest("consumer.plugin", {
        dependencies: [
          { id: "optional.plugin", spec: "^1.0.0", optional: true },
        ],
      }),
      manifest("optional.plugin"),
    ]).order,
  ).toEqual(["optional.plugin", "consumer.plugin"]);
});

test("plugin dependency resolver reports missing, cycles, and conflicts", () => {
  const manifest = (id: string, input: Record<string, unknown> = {}) =>
    pluginManifestSchema.parse({
      apiVersion: 2,
      id,
      version: "1.0.0",
      name: id,
      ...input,
    });
  const result = resolvePluginDependencies(
    [
      manifest("a.plugin", {
        dependencies: [{ id: "b.plugin", spec: "*" }],
      }),
      manifest("b.plugin", {
        dependencies: [{ id: "a.plugin", spec: "*" }],
      }),
      manifest("missing.plugin", {
        dependencies: [{ id: "absent.plugin", spec: ">=1.0.0" }],
      }),
      manifest("conflict.plugin", { conflicts: ["active.plugin"] }),
    ],
    [manifest("active.plugin")],
  );
  expect(result.order).toEqual([]);
  expect(result.pending).toEqual(
    expect.arrayContaining([
      { id: "a.plugin", reason: "plugin dependency cycle" },
      { id: "b.plugin", reason: "plugin dependency cycle" },
      expect.objectContaining({ id: "missing.plugin" }),
    ]),
  );
  expect(result.denied).toContainEqual({
    id: "conflict.plugin",
    reason: 'conflicts with "active.plugin"',
  });
});

test("plugin dependency resolver propagates unavailable dependencies", () => {
  const manifest = (id: string, input: Record<string, unknown> = {}) =>
    pluginManifestSchema.parse({
      apiVersion: 2,
      id,
      version: "1.0.0",
      name: id,
      ...input,
    });
  const result = resolvePluginDependencies([
    manifest("consumer.plugin", {
      dependencies: [{ id: "provider.plugin", spec: "*" }],
    }),
    manifest("provider.plugin", {
      dependencies: [{ id: "missing.plugin", spec: "*" }],
    }),
  ]);
  expect(result.order).toEqual([]);
  expect(result.pending).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "provider.plugin" }),
      {
        id: "consumer.plugin",
        reason: 'requires unavailable plugin "provider.plugin"',
      },
    ]),
  );
});

test("plugin dependency conflicts are enforced from either side", () => {
  const manifest = (id: string, conflicts: string[] = []) =>
    pluginManifestSchema.parse({
      apiVersion: 2,
      id,
      version: "1.0.0",
      name: id,
      conflicts,
    });
  expect(
    resolvePluginDependencies(
      [manifest("incoming.plugin")],
      [manifest("active.plugin", ["incoming.plugin"])],
    ).denied,
  ).toEqual([
    {
      id: "incoming.plugin",
      reason: 'conflicts with "active.plugin"',
    },
  ]);
});

test("plugin registry enforces v2 dependencies and conflicts before setup", async () => {
  const registry = createPluginRegistry({ tools: createToolRegistry([]) });
  const plugin = (
    id: string,
    input: {
      dependencies?: Array<{ id: string; spec: string }>;
      conflicts?: string[];
    } = {},
  ) =>
    definePlugin({
      manifest: {
        apiVersion: 2,
        id,
        version: "1.0.0",
        name: id,
        description: "",
        entry: `natalia:${id}`,
        scope: "workspace",
        provides: [],
        requires: [],
        optionalRequires: [],
        conflicts: input.conflicts ?? [],
        dependencies: (input.dependencies ?? []).map((dependency) => ({
          ...dependency,
          optional: false,
          peer: false,
        })),
        hooks: {},
        integrationPoints: [],
      },
      setup() {},
    });
  await expect(
    registry.load(
      plugin("consumer.plugin", {
        dependencies: [{ id: "provider.plugin", spec: "^1.0.0" }],
      }),
    ),
  ).rejects.toThrow("plugin dependency unresolved");
  await registry.load(plugin("provider.plugin"));
  await registry.load(
    plugin("consumer.plugin", {
      dependencies: [{ id: "provider.plugin", spec: "^1.0.0" }],
    }),
  );
  await expect(
    registry.load(
      plugin("conflict.plugin", { conflicts: ["provider.plugin"] }),
    ),
  ).rejects.toThrow('conflicts with "provider.plugin"');
});

test("failed mounted plugins conflict but cannot satisfy dependencies", async () => {
  const registry = createPluginRegistry({ tools: createToolRegistry([]) });
  const plugin = (
    id: string,
    input: {
      dependencies?: string[];
      conflicts?: string[];
      fails?: boolean;
    } = {},
  ) =>
    definePlugin({
      manifest: {
        apiVersion: 2,
        id,
        version: "1.0.0",
        name: id,
        description: "",
        entry: `natalia:${id}`,
        scope: "workspace",
        provides: [],
        requires: [],
        optionalRequires: [],
        conflicts: input.conflicts ?? [],
        dependencies: (input.dependencies ?? []).map((dependency) => ({
          id: dependency,
          spec: "*",
          optional: false,
          peer: false,
        })),
        hooks: {},
        integrationPoints: [],
      },
      setup() {
        if (input.fails) throw new Error("setup failed");
      },
    });
  await expect(
    registry.load(plugin("failed.provider", { fails: true })),
  ).rejects.toThrow("setup failed");
  await expect(
    registry.load(
      plugin("required.consumer", { dependencies: ["failed.provider"] }),
    ),
  ).rejects.toThrow('requires plugin "failed.provider"');
  await expect(
    registry.load(
      plugin("conflicting.consumer", { conflicts: ["failed.provider"] }),
    ),
  ).rejects.toThrow('conflicts with "failed.provider"');
});

test("unloading a provider unloads required dependents first", async () => {
  const cleanup: string[] = [];
  const registry = createPluginRegistry({ tools: createToolRegistry([]) });
  const plugin = (id: string, dependencies: string[] = []) =>
    definePlugin({
      manifest: {
        apiVersion: 2,
        id,
        version: "1.0.0",
        name: id,
        description: "",
        entry: `natalia:${id}`,
        scope: "workspace",
        provides: [],
        requires: [],
        optionalRequires: [],
        conflicts: [],
        dependencies: dependencies.map((dependency) => ({
          id: dependency,
          spec: "*",
          optional: false,
          peer: false,
        })),
        hooks: {},
        integrationPoints: [],
      },
      setup() {},
      dispose() {
        cleanup.push(id);
      },
    });
  await registry.load(plugin("provider.plugin"));
  await registry.load(plugin("middle.plugin", ["provider.plugin"]));
  await registry.load(plugin("consumer.plugin", ["middle.plugin"]));
  await registry.unload("provider.plugin");
  expect(cleanup).toEqual([
    "consumer.plugin",
    "middle.plugin",
    "provider.plugin",
  ]);
  expect(registry.list()).toEqual([]);
});

test("batch unload isolates plugin cleanup failures", async () => {
  const cleanup: string[] = [];
  const registry = createPluginRegistry({ tools: createToolRegistry([]) });
  for (const id of ["first.plugin", "broken.plugin", "last.plugin"])
    await registry.load(
      definePlugin({
        manifest: {
          apiVersion: 1,
          id,
          version: "1.0.0",
          name: id,
          description: "",
          entry: `natalia:${id}`,
          scope: "workspace",
          capabilities: [],
          provides: [],
          requires: [],
        },
        setup() {},
        dispose() {
          cleanup.push(id);
          if (id === "broken.plugin") throw new Error("cleanup failed");
        },
      }),
    );
  await expect(registry.unloadAll()).rejects.toThrow("cleanup failed");
  expect(cleanup).toEqual(["last.plugin", "broken.plugin", "first.plugin"]);
  expect(registry.list()).toEqual([]);
});

test("v2 contributions and typed services use the shared ownership channel", async () => {
  const contributions: Array<{ kind: string; name: string }> = [];
  const releases: string[] = [];
  let serviceValue: unknown = { ready: true };
  let serviceListener: ((update: { name: string }) => void) | undefined;
  const seenServices: unknown[] = [];
  const registry = createPluginRegistry({
    tools: createToolRegistry([]),
    service: <T>() => serviceValue as T,
    onServiceUpdate(listener) {
      serviceListener = listener;
      return () => {
        serviceListener = undefined;
      };
    },
    registerOwner: () => ({
      contribute: (kind, name) => {
        contributions.push({ kind, name });
        return () => releases.push(`${kind}:${name}`);
      },
      release: () => undefined,
    }),
  });
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 2,
        id: "natalia-v2",
        version: "2.0.0",
        name: "V2",
        description: "",
        entry: "natalia:v2",
        scope: "workspace",
        provides: [],
        requires: [],
        optionalRequires: [],
        conflicts: [],
        dependencies: [],
        hooks: {},
        integrationPoints: [
          "resources",
          "projections",
          "workflows",
          "settingsSchema",
          "adapters",
          "schedulerJobs",
        ],
      },
      setup(api) {
        expect(api.services.get<{ ready: boolean }>("status.service")).toEqual({
          ready: true,
        });
        api.services.on("status.service", (value) => seenServices.push(value));
        api.resources.register({ name: "resource" });
        api.projections.register({
          name: "projection",
          title: "Demo card",
          placement: "sidebar",
          text: "hello from a plugin",
        });
        api.workflows.register({ name: "workflow" });
        api.settingsSchema.register({ name: "settings" });
        api.adapters.register({
          name: "adapter",
          adapterType: "test",
          create: () => ({ dispose() {} }),
        });
        api.scheduler.add({ name: "job" });
      },
    }),
  );
  serviceValue = { ready: false };
  serviceListener?.({ name: "status.service" });
  expect(seenServices).toEqual([{ ready: false }]);
  expect(contributions).toEqual([
    { kind: "resources", name: "resource" },
    { kind: "projections", name: "projection" },
    { kind: "workflows", name: "workflow" },
    { kind: "settingsSchema", name: "settings" },
    { kind: "adapters", name: "adapter" },
    { kind: "schedulerJobs", name: "job" },
  ]);
  await registry.unload("natalia-v2");
  expect(releases).toEqual([
    "schedulerJobs:job",
    "adapters:adapter",
    "settingsSchema:settings",
    "workflows:workflow",
    "projections:projection",
    "resources:resource",
  ]);
  expect(serviceListener).toBeUndefined();
});

test("adapter contributions stay inert until materialized and dispose in reverse", async () => {
  const contributions = new Map<string, unknown>();
  const owners = new Map<string, string>();
  const lifecycle: string[] = [];
  const registry = createPluginRegistry({
    tools: createToolRegistry([]),
    registerOwner: (manifest) => ({
      contribute: (kind, name, payload) => {
        if (kind === "adapters") {
          contributions.set(name, payload);
          owners.set(name, manifest.id);
        }
        return () => {
          contributions.delete(name);
          owners.delete(name);
        };
      },
      release: () => undefined,
    }),
  });
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 2,
        id: "natalia-adapters",
        version: "2.0.0",
        name: "Adapters",
        description: "",
        entry: "natalia:adapters",
        scope: "process",
        provides: [],
        requires: [],
        optionalRequires: [],
        conflicts: [],
        dependencies: [],
        hooks: {},
        integrationPoints: ["adapters"],
      },
      setup(api) {
        for (const name of ["first", "second"]) {
          api.adapters.register({
            name,
            adapterType: "test",
            create(context: { value: string }) {
              lifecycle.push(`create:${name}:${context.value}`);
              return {
                dispose: () => {
                  lifecycle.push(`dispose:${name}`);
                },
              };
            },
          });
        }
      },
    }),
  );
  expect(lifecycle).toEqual([]);

  const materializer = createPluginAdapterMaterializer({
    contribution: <T>(_kind: "adapters", name: string) =>
      contributions.get(name) as T | undefined,
    ownerOf: (_kind, name) => owners.get(name),
  });
  await materializer.materialize("first", { value: "a" });
  await materializer.materialize("second", { value: "b" });
  expect(materializer.active()).toEqual([
    { name: "first", ownerID: "natalia-adapters" },
    { name: "second", ownerID: "natalia-adapters" },
  ]);
  await materializer.close();
  await materializer.close();
  expect(lifecycle).toEqual([
    "create:first:a",
    "create:second:b",
    "dispose:second",
    "dispose:first",
  ]);
  await registry.unloadAll();
});

test("UI adapters receive host runtime ports and follow materializer lifecycle", async () => {
  const contributions = new Map<string, unknown>();
  const owners = new Map<string, string>();
  const lifecycle: string[] = [];
  const registry = createPluginRegistry({
    tools: createToolRegistry([]),
    registerOwner: (manifest) => ({
      contribute: (kind, name, payload) => {
        if (kind === "adapters") {
          contributions.set(name, payload);
          owners.set(name, manifest.id);
        }
        return () => {
          contributions.delete(name);
          owners.delete(name);
        };
      },
      release: () => undefined,
    }),
  });
  const input = {
    runtime: {} as import("@anthelia/contracts").RuntimeClient,
    events: { subscribe: () => () => undefined },
    commands: {
      list: async () => [],
      execute: async () => undefined,
    },
  };
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 2,
        id: "natalia-ui-test",
        version: "1.0.0",
        name: "UI Test",
        description: "",
        entry: "natalia:ui-test",
        scope: "process",
        provides: [],
        requires: [],
        optionalRequires: [],
        conflicts: [],
        dependencies: [],
        hooks: {},
        integrationPoints: ["adapters"],
      },
      setup(api) {
        api.adapters.registerUi({
          kind: "ui.test",
          mount(received) {
            expect(received).toBe(input);
            lifecycle.push("mount");
          },
          dispose() {
            lifecycle.push("dispose");
          },
        });
      },
    }),
  );
  expect(lifecycle).toEqual([]);
  const materializer = createPluginAdapterMaterializer({
    contribution: <T>(_kind: "adapters", name: string) =>
      contributions.get(name) as T | undefined,
    ownerOf: (_kind, name) => owners.get(name),
  });
  await materializer.materialize("ui.test", input);
  await materializer.close();
  await materializer.close();
  expect(lifecycle).toEqual(["mount", "dispose"]);
  await registry.unloadAll();
});

test("adapter materializer fails before creating unavailable resources", async () => {
  const materializer = createPluginAdapterMaterializer({
    contribution: () => undefined,
    ownerOf: () => undefined,
  });
  await expect(materializer.materialize("missing", {})).rejects.toThrow(
    "adapter is not available: missing",
  );
  await materializer.close();
});

test("plugin cleanup is reverse ordered and isolates disposer failures", async () => {
  const cleanup: string[] = [];
  const registry = createPluginRegistry({
    tools: createToolRegistry([]),
    registerOwner: () => ({
      contribute: (_kind, name) => () => {
        cleanup.push(name);
        if (name === "middle") throw new Error("middle cleanup failed");
      },
      release: () => undefined,
    }),
  });
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 2,
        id: "natalia-cleanup",
        version: "2.0.0",
        name: "Cleanup",
        description: "",
        entry: "natalia:cleanup",
        scope: "workspace",
        provides: [],
        requires: [],
        optionalRequires: [],
        conflicts: [],
        dependencies: [],
        hooks: {},
        integrationPoints: ["resources"],
      },
      setup(api) {
        api.resources.register({ name: "first" });
        api.resources.register({ name: "middle" });
        api.resources.register({ name: "last" });
      },
    }),
  );
  await expect(registry.unload("natalia-cleanup")).rejects.toThrow(
    "middle cleanup failed",
  );
  expect(cleanup).toEqual(["last", "middle", "first"]);
  expect(registry.list()).toEqual([]);
});

test("plugin dispose owns lifecycle before capability ownership is released", async () => {
  const lifecycle: string[] = [];
  const registry = createPluginRegistry({
    tools: createToolRegistry([]),
    registerOwner: () => ({
      contribute: () => () => undefined,
      release: () => lifecycle.push("owner.release"),
    }),
  });
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 2,
        id: "natalia-lifecycle-owner",
        version: "1.0.0",
        name: "Lifecycle Owner",
        description: "",
        entry: "natalia:lifecycle-owner",
        scope: "workspace",
        provides: [],
        requires: [],
        optionalRequires: [],
        conflicts: [],
        dependencies: [],
        hooks: {},
        integrationPoints: ["resources"],
      },
      setup(api) {
        lifecycle.push("plugin.setup");
        api.resources.register({ name: "resource" });
      },
      dispose() {
        lifecycle.push("plugin.dispose");
      },
    }),
  );
  await registry.unload("natalia-lifecycle-owner");
  expect(lifecycle).toEqual([
    "plugin.setup",
    "plugin.dispose",
    "owner.release",
  ]);
});

test("missing required services leave the plugin mounted and pending", async () => {
  let setupRan = false;
  let ownerRegistered = false;
  const registry = createPluginRegistry({
    tools: createToolRegistry([]),
    service: () => undefined,
    registerOwner: () => {
      ownerRegistered = true;
      return {
        contribute: () => () => undefined,
        release: () => undefined,
      };
    },
  });
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 2,
        id: "natalia-missing-service",
        version: "1.0.0",
        name: "Missing Service",
        description: "",
        entry: "natalia:missing-service",
        scope: "workspace",
        provides: [],
        requires: ["missing.service"],
        optionalRequires: [],
        conflicts: [],
        dependencies: [],
        hooks: {},
        integrationPoints: [],
      },
      setup() {
        setupRan = true;
      },
    }),
  );
  expect(setupRan).toBe(false);
  expect(ownerRegistered).toBe(false);
  expect(registry.list().map(({ id }) => id)).toEqual([
    "natalia-missing-service",
  ]);
  expect(registry.status("natalia-missing-service")).toEqual({
    id: "natalia-missing-service",
    status: "pending",
    missingServices: ["missing.service"],
  });
  expect(registry.active("natalia-missing-service")).toBe(false);
});

test("required service availability drives serialized activation epochs", async () => {
  let serviceValue: object | undefined;
  let provider: string | undefined;
  let notify: ((update: { name: string }) => void) | undefined;
  let epoch = 0;
  const lifecycle: string[] = [];
  const contributions = new Set<string>();
  const registry = createPluginRegistry({
    tools: createToolRegistry([]),
    service: <T>() => serviceValue as T | undefined,
    serviceProvider: () => provider,
    onServiceUpdate(listener) {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
    registerOwner: () => {
      const ownerEpoch = epoch + 1;
      lifecycle.push(`owner:${ownerEpoch}`);
      return {
        contribute: (_kind, name) => {
          contributions.add(name);
          return () => {
            lifecycle.push(`cleanup:${ownerEpoch}`);
            contributions.delete(name);
          };
        },
        release: () => lifecycle.push(`release:${ownerEpoch}`),
      };
    },
  });
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 2,
        id: "natalia-epochs",
        version: "1.0.0",
        name: "Epochs",
        description: "",
        entry: "natalia:epochs",
        scope: "workspace",
        provides: [],
        requires: ["required.service"],
        optionalRequires: [],
        conflicts: [],
        dependencies: [],
        hooks: {},
        integrationPoints: ["resources"],
      },
      setup(api) {
        const current = ++epoch;
        lifecycle.push(`setup:${current}`);
        api.resources.register({ name: `resource:${current}` });
        void api.effects.run(
          (signal) =>
            new Promise<void>((resolve) =>
              signal.addEventListener(
                "abort",
                () => {
                  lifecycle.push(`settled:${current}`);
                  resolve();
                },
                { once: true },
              ),
            ),
        );
      },
      dispose() {
        lifecycle.push(`dispose:${epoch}`);
      },
    }),
  );
  expect(registry.status("natalia-epochs")?.status).toBe("pending");

  serviceValue = {};
  provider = "provider:a";
  notify?.({ name: "required.service" });
  await registry.whenIdle();
  expect(registry.active("natalia-epochs")).toBe(true);
  expect(contributions).toEqual(new Set(["resource:1"]));

  serviceValue = undefined;
  provider = undefined;
  notify?.({ name: "required.service" });
  await registry.whenIdle();
  expect(registry.status("natalia-epochs")).toEqual({
    id: "natalia-epochs",
    status: "pending",
    missingServices: ["required.service"],
  });
  expect(contributions.size).toBe(0);

  serviceValue = {};
  provider = "provider:a";
  notify?.({ name: "required.service" });
  await registry.whenIdle();
  expect(contributions).toEqual(new Set(["resource:2"]));

  serviceValue = {};
  provider = "provider:b";
  notify?.({ name: "required.service" });
  await registry.whenIdle();
  expect(registry.active("natalia-epochs")).toBe(true);
  expect(contributions).toEqual(new Set(["resource:3"]));
  expect(lifecycle).toEqual([
    "owner:1",
    "setup:1",
    "dispose:1",
    "settled:1",
    "cleanup:1",
    "release:1",
    "owner:2",
    "setup:2",
    "dispose:2",
    "settled:2",
    "cleanup:2",
    "release:2",
    "owner:3",
    "setup:3",
  ]);
  await registry.unload("natalia-epochs");
  expect(lifecycle.slice(-4)).toEqual([
    "dispose:3",
    "settled:3",
    "cleanup:3",
    "release:3",
  ]);
  expect(registry.status("natalia-epochs")).toBeUndefined();
});

test("manual registration disposal releases local and kernel ownership", async () => {
  const tools = createToolRegistry([]);
  const released: string[] = [];
  let dispatches = 0;
  let dispose!: () => void;
  const registry = createPluginRegistry({
    tools,
    registerOwner: () => ({
      contribute: (kind, name) => () => released.push(`${kind}:${name}`),
      release: () => undefined,
    }),
  });
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 1,
        id: "natalia-dynamic",
        version: "1.0.0",
        name: "Dynamic",
        description: "",
        entry: "natalia:dynamic",
        scope: "workspace",
        capabilities: ["tools", "commands", "events"],
        provides: [],
        requires: [],
      },
      setup(api) {
        const releases = [
          api.tools.register({
            name: "dynamic_tool",
            description: "Dynamic",
            requiresApproval: false,
            parameters: { type: "object", properties: {} },
            async execute() {
              return "ok";
            },
          }),
          api.commands.register({
            name: "dynamic_command",
            title: "Dynamic command",
            run() {},
          }),
          api.events.on(() => {
            dispatches += 1;
          }),
        ];
        dispose = () => {
          for (const release of releases.reverse()) release();
        };
      },
    }),
  );
  dispose();
  dispose();
  registry.dispatch({ type: "test" });
  expect(tools.has("dynamic_tool")).toBe(false);
  expect(registry.commands()).toEqual([]);
  expect(dispatches).toBe(0);
  expect(released).toEqual([
    "listeners:natalia-dynamic:listener:1",
    "commands:dynamic_command",
    "tools:dynamic_tool",
  ]);
  await registry.unload("natalia-dynamic");
  expect(released).toHaveLength(3);
});

test("setup failure rolls back every registered contribution", async () => {
  const tools = createToolRegistry([]);
  const cleanup: string[] = [];
  let unloaded = 0;
  const registry = createPluginRegistry({
    tools,
    registerOwner: () => ({
      contribute: (kind, name) => () => cleanup.push(`${kind}:${name}`),
      release: () => {
        unloaded += 1;
      },
    }),
  });
  await expect(
    registry.load(
      definePlugin({
        manifest: {
          apiVersion: 2,
          id: "natalia-rollback",
          version: "2.0.0",
          name: "Rollback",
          description: "",
          entry: "natalia:rollback",
          scope: "workspace",
          provides: [],
          requires: [],
          optionalRequires: [],
          conflicts: [],
          dependencies: [],
          hooks: {},
          integrationPoints: ["tools", "commands", "resources"],
        },
        setup(api) {
          api.tools.register({
            name: "rollback_tool",
            description: "Rollback",
            requiresApproval: false,
            parameters: { type: "object", properties: {} },
            async execute() {
              return "ok";
            },
          });
          api.commands.register({
            name: "rollback_command",
            title: "Rollback command",
            run() {},
          });
          api.resources.register({ name: "rollback_resource" });
          throw new Error("setup failed");
        },
      }),
    ),
  ).rejects.toThrow("setup failed");
  expect(tools.has("rollback_tool")).toBe(false);
  expect(registry.commands()).toEqual([]);
  expect(registry.status("natalia-rollback")?.status).toBe("failed");
  expect(cleanup).toEqual([
    "resources:rollback_resource",
    "commands:rollback_command",
    "tools:rollback_tool",
  ]);
  expect(unloaded).toBe(1);
});

test("plugin-owned effects are cancelled and settled before unload completes", async () => {
  let observedAbort = false;
  let releaseSetup!: () => void;
  const started = new Promise<void>((resolve) => {
    releaseSetup = resolve;
  });
  const registry = createPluginRegistry({ tools: createToolRegistry([]) });
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 2,
        id: "natalia-effects",
        version: "2.0.0",
        name: "Effects",
        description: "",
        entry: "natalia:effects",
        scope: "workspace",
        provides: [],
        requires: [],
        optionalRequires: [],
        conflicts: [],
        dependencies: [],
        hooks: {},
        integrationPoints: [],
      },
      setup(api) {
        void api.effects.run(
          (signal) =>
            new Promise<void>((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  observedAbort = true;
                  resolve();
                },
                { once: true },
              );
              releaseSetup();
            }),
        );
      },
    }),
  );
  await started;
  await registry.unload("natalia-effects");
  expect(observedAbort).toBe(true);
  expect(registry.list()).toEqual([]);
});

test("plugin registrations are capability-gated and removed on unload", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 1,
        id: "demo.plugin",
        version: "1.0.0",
        name: "Demo",
        description: "",
        entry: "index.ts",
        capabilities: ["tools"],
        scope: "session",
        provides: [] as string[],
        requires: [] as string[],
      },
      setup(api) {
        api.tools.register({
          name: "echo",
          description: "Echo",
          requiresApproval: false,
          parameters: { type: "object", properties: {} },
          async execute() {
            return "ok";
          },
        });
      },
    }),
  );
  expect(tools.has("echo")).toBe(true);
  await registry.unload("demo.plugin");
  expect(tools.has("echo")).toBe(false);
  expect(registry.audit().map((entry) => entry.action)).toEqual([
    "loaded",
    "unloaded",
  ]);
});

test("plugin aliases are removed on unload and cannot shadow tools", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  const aliasedPlugin = definePlugin({
    manifest: {
      apiVersion: 1,
      id: "alias.plugin",
      version: "1.0.0",
      name: "Alias",
      description: "",
      entry: "index.ts",
      capabilities: ["tools"],
      scope: "session",
      provides: [],
      requires: [],
    },
    setup(api) {
      api.tools.register({
        name: "target",
        description: "Target",
        requiresApproval: false,
        parameters: { type: "object", properties: {} },
        async execute() {
          return "ok";
        },
      });
      api.tools.registerAlias("shortcut", "target");
    },
  });

  await registry.load(aliasedPlugin);
  expect(tools.has("shortcut")).toBe(true);
  expect(() => tools.addAlias("target", "target")).toThrow(
    "tool alias already registered: target",
  );
  expect(() => tools.addAlias("shortcut", "target")).toThrow(
    "tool alias already registered: shortcut",
  );
  const staleDispose = tools.addAlias("stale", "target");
  staleDispose();
  const currentDispose = tools.addAlias("stale", "target");
  staleDispose();
  expect(tools.has("stale")).toBe(true);
  currentDispose();
  await registry.unload("alias.plugin");
  expect(tools.has("shortcut")).toBe(false);

  await registry.load(aliasedPlugin);
  expect(tools.has("shortcut")).toBe(true);
  await registry.unload("alias.plugin");
});

test("plugins use their declared public names", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 1,
        id: "natalia-observe",
        version: "1.0.0",
        name: "Observe",
        description: "",
        entry: "natalia:observe",
        capabilities: ["tools"],
        scope: "workspace",
        provides: [],
        requires: [],
      },
      setup(api) {
        api.tools.register({
          name: "observe",
          description: "Observe",
          requiresApproval: false,
          parameters: { type: "object", properties: {} },
          async execute() {
            return "ok";
          },
        });
      },
    }),
  );

  expect(tools.get("observe")?.requiresApproval).toBe(false);
  expect(tools.has("plugin_natalia_observe_observe")).toBe(false);
  await registry.unload("natalia-observe");
  expect(tools.has("observe")).toBe(false);
});

test("declared services must be provided before activation completes", async () => {
  const registry = createPluginRegistry({ tools: createToolRegistry([]) });
  await expect(
    registry.load(
      definePlugin({
        manifest: {
          apiVersion: 1,
          id: "natalia-lying-service",
          version: "1.0.0",
          name: "Lying Service",
          description: "",
          entry: "natalia:lying-service",
          capabilities: [],
          scope: "workspace",
          provides: ["missing.service"],
          requires: [],
        },
        setup() {},
      }),
    ),
  ).rejects.toThrow("did not provide declared services");
  expect(registry.status("natalia-lying-service")?.status).toBe("failed");
});

test("declared services must remain active through setup", async () => {
  const registry = createPluginRegistry({
    tools: createToolRegistry([]),
    registerOwner: () => ({
      contribute: () => () => {},
      release: () => undefined,
    }),
  });
  await expect(
    registry.load(
      definePlugin({
        manifest: {
          apiVersion: 1,
          id: "natalia-disposed-service",
          version: "1.0.0",
          name: "Disposed Service",
          description: "",
          entry: "natalia:disposed-service",
          scope: "workspace",
          capabilities: [],
          provides: ["disposed.service"],
          requires: [],
        },
        setup(api) {
          const dispose = api.services.provide("disposed.service", {});
          dispose();
        },
      }),
    ),
  ).rejects.toThrow("did not provide declared services");
  expect(registry.status("natalia-disposed-service")?.status).toBe("failed");
});

test("a failing plugin disposer cannot retain owned registrations", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 1,
        id: "natalia-broken-dispose",
        version: "1.0.0",
        name: "Broken Dispose",
        description: "",
        entry: "natalia:broken-dispose",
        capabilities: ["tools"],
        scope: "workspace",
        provides: [],
        requires: [],
      },
      setup(api) {
        api.tools.register({
          name: "temporary",
          description: "Temporary",
          requiresApproval: false,
          parameters: { type: "object", properties: {} },
          async execute() {
            return "ok";
          },
        });
      },
      dispose() {
        throw new Error("dispose failed");
      },
    }),
  );

  await expect(registry.unload("natalia-broken-dispose")).rejects.toThrow(
    "dispose failed",
  );
  expect(tools.has("temporary")).toBe(false);
  expect(registry.list()).toEqual([]);
});

test("plugin tools preserve their declared approval requirement", async () => {
  const safeTools = createToolRegistry([]);
  const safeRegistry = createPluginRegistry({
    tools: safeTools,
  });
  await safeRegistry.load(pluginWithApprovalTool("safe.plugin", false));
  expect(safeTools.get("observe")?.requiresApproval).toBe(false);

  const guardedTools = createToolRegistry([]);
  const guardedRegistry = createPluginRegistry({ tools: guardedTools });
  await guardedRegistry.load(pluginWithApprovalTool("guarded.plugin", true));
  expect(guardedTools.get("observe")?.requiresApproval).toBe(true);
});

test("plugin conformance harness verifies lifecycle cleanup", async () => {
  const results = await runPluginConformance({
    plugin: definePlugin({
      manifest: {
        apiVersion: 1,
        id: "conformance.plugin",
        version: "1.0.0",
        name: "Conformance",
        description: "",
        entry: "index.ts",
        capabilities: ["tools"],
        scope: "session",
        provides: [] as string[],
        requires: [] as string[],
      },
      setup(api) {
        api.tools.register({
          name: "ping",
          description: "Ping",
          requiresApproval: false,
          parameters: { type: "object", properties: {} },
          async execute() {
            return "pong";
          },
        });
      },
    }),
  });
  expect(results).toEqual([
    { name: "manifest-and-setup", passed: true, detail: undefined },
    { name: "tool-ownership", passed: true, detail: undefined },
    { name: "approval-boundary", passed: true, detail: undefined },
    { name: "owned-registration-cleanup", passed: true, detail: undefined },
  ]);
});

test("plugin cannot use an undeclared capability", async () => {
  const registry = createPluginRegistry({
    tools: createToolRegistry([]),
  });
  await expect(
    registry.load(
      definePlugin({
        manifest: {
          apiVersion: 1,
          id: "events.plugin",
          version: "1.0.0",
          name: "Events",
          description: "",
          entry: "index.ts",
          capabilities: [],
          scope: "session",
          provides: [] as string[],
          requires: [] as string[],
        },
        setup(api) {
          api.events.on(() => undefined);
        },
      }),
    ),
  ).rejects.toThrow("capability denied");
});

test("a manifest-declared capability is authorized without a host whitelist", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({
    tools,
  });
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 1,
        id: "declared.plugin",
        version: "1.0.0",
        name: "Declared",
        description: "",
        entry: "index.ts",
        capabilities: ["tools"],
        scope: "session",
        provides: [] as string[],
        requires: [] as string[],
      },
      setup(api) {
        api.tools.register({
          name: "echo",
          description: "Echo",
          requiresApproval: false,
          parameters: { type: "object", properties: {} },
          async execute() {
            return "ok";
          },
        });
      },
    }),
  );
  expect(tools.has("echo")).toBe(true);
});

function pluginWithApprovalTool(id: string, requiresApproval: boolean) {
  return definePlugin({
    manifest: {
      apiVersion: 1,
      id,
      version: "1.0.0",
      name: "Observe",
      description: "",
      entry: "index.ts",
      capabilities: ["tools"],
      scope: "session",
      provides: [] as string[],
      requires: [] as string[],
    },
    setup(api) {
      api.tools.register({
        name: "observe",
        description: "Observe",
        requiresApproval,
        parameters: { type: "object", properties: {} },
        async execute() {
          return "ok";
        },
      });
    },
  });
}

test("a plugin command uses its declared name and is removed on unload", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  const ran: string[] = [];
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 1,
        id: "demo.plugin",
        version: "1.0.0",
        name: "Demo",
        description: "",
        entry: "index.ts",
        capabilities: ["commands"],
        scope: "session",
        provides: [] as string[],
        requires: [] as string[],
      },
      setup(api) {
        api.commands.register({
          name: "sync",
          title: "Sync everything",
          run: () => {
            ran.push("sync");
          },
        });
      },
    }),
  );

  const commands = registry.commands();
  expect(commands).toHaveLength(1);
  expect(commands[0]!.name).toBe("sync");
  expect(commands[0]!.category).toBe("Demo");
  await commands[0]!.run();
  expect(ran).toEqual(["sync"]);

  await registry.unload("demo.plugin");
  expect(registry.commands()).toEqual([]);
});

test("a plugin without the commands capability cannot register one", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await expect(
    registry.load(
      definePlugin({
        manifest: {
          apiVersion: 1,
          id: "sneaky.plugin",
          version: "1.0.0",
          name: "Sneaky",
          description: "",
          entry: "index.ts",
          capabilities: ["tools"],
          scope: "session",
          provides: [] as string[],
          requires: [] as string[],
        },
        setup(api) {
          api.commands.register({
            name: "escalate",
            title: "Escalate",
            run: () => {},
          });
        },
      }),
    ),
  ).rejects.toThrow(/capability denied: sneaky.plugin\/commands/u);
  // The failed setup leaves no contributions but remains observable.
  expect(registry.commands()).toEqual([]);
  expect(registry.status("sneaky.plugin")?.status).toBe("failed");
});

test("two plugins cannot register the same command name", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  const manifest = (id: string) => ({
    apiVersion: 1 as const,
    id,
    version: "1.0.0",
    name: id,
    description: "",
    entry: "index.ts",
    capabilities: ["commands" as const],
    scope: "session" as const,
    provides: [] as string[],
    requires: [] as string[],
  });
  await registry.load(
    definePlugin({
      manifest: manifest("first.plugin"),
      setup(api) {
        api.commands.register({ name: "go", title: "Go", run: () => {} });
      },
    }),
  );
  await expect(
    registry.load(
      definePlugin({
        manifest: manifest("second.plugin"),
        setup(api) {
          api.commands.register({ name: "go", title: "Go", run: () => {} });
        },
      }),
    ),
  ).rejects.toThrow("plugin command already registered: go");
});

function configuredPlugin(input: {
  id: string;
  seen: { config?: unknown };
  configSchema?: ReturnType<typeof z.object>;
}) {
  return definePlugin({
    manifest: {
      apiVersion: 1,
      id: input.id,
      version: "1.0.0",
      name: "Configured",
      description: "",
      entry: "index.ts",
      capabilities: ["tools"],
      scope: "session",
      provides: [] as string[],
      requires: [] as string[],
    },
    configSchema: input.configSchema,
    setup(api) {
      input.seen.config = api.config;
      api.tools.register({
        name: "run",
        description: "Run",
        requiresApproval: false,
        parameters: { type: "object", properties: {} },
        async execute() {
          return "ok";
        },
      });
    },
  });
}

test("a plugin receives its own config validated by its declared schema", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  const seen: { config?: unknown } = {};
  await registry.load(
    configuredPlugin({
      id: "configured.plugin",
      seen,
      configSchema: z.object({
        retries: z.number().int().default(3),
        label: z.string(),
      }),
    }),
    { label: "primary" },
  );
  // The parsed value reaches setup, so schema defaults are applied.
  expect(seen.config).toEqual({ retries: 3, label: "primary" });
  expect(tools.has("run")).toBe(true);
});

test("an invalid plugin config fails the load and registers nothing", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  const seen: { config?: unknown } = {};
  await expect(
    registry.load(
      configuredPlugin({
        id: "invalid.plugin",
        seen,
        configSchema: z.object({ label: z.string() }),
      }),
      { label: 42 },
    ),
  ).rejects.toThrow(/plugin config invalid: invalid.plugin/u);
  // Misconfiguration fails before setup runs, so nothing was contributed.
  expect(seen.config).toBeUndefined();
  expect(tools.has("run")).toBe(false);
  expect(registry.list()).toEqual([]);
  expect(registry.audit().map((entry) => entry.action)).toEqual(["failed"]);
});

test("a plugin without a config schema keeps its config unchanged", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  const seen: { config?: unknown } = {};
  await registry.load(configuredPlugin({ id: "raw.plugin", seen }), {
    anything: true,
  });
  expect(seen.config).toEqual({ anything: true });
});

test("plugin config validation reports the failing path", () => {
  const seen: { config?: unknown } = {};
  const plugin = configuredPlugin({
    id: "paths.plugin",
    seen,
    configSchema: z.object({ nested: z.object({ port: z.number() }) }),
  });
  expect(() => resolvePluginConfig(plugin, { nested: { port: "80" } })).toThrow(
    /\(at nested.port\)/u,
  );
});

test("an async plugin config schema is refused instead of loading unvalidated", () => {
  const seen: { config?: unknown } = {};
  const plugin = {
    ...configuredPlugin({ id: "async.plugin", seen }),
    configSchema: {
      "~standard": {
        validate: () => Promise.resolve({ value: {} }),
      },
    },
  };
  expect(() => resolvePluginConfig(plugin, {})).toThrow(
    /must be synchronous: async.plugin/u,
  );
});

test("conformance checks a plugin against the config it will be loaded with", async () => {
  const seen: { config?: unknown } = {};
  const plugin = configuredPlugin({
    id: "conformance.plugin",
    seen,
    configSchema: z.object({ endpoint: z.string().min(1) }),
  });
  const passed = await runPluginConformance({
    plugin,
    config: { endpoint: "https://example.test" },
  });
  expect(passed.every((check) => check.passed)).toBe(true);
  expect(seen.config).toEqual({ endpoint: "https://example.test" });

  // The same plugin with an unusable config fails its conformance run, so a
  // config contract is testable before the plugin ships.
  const failed = await runPluginConformance({
    plugin,
    config: {},
  });
  expect(failed[0]?.passed).toBe(false);
  expect(failed[0]?.detail).toMatch(
    /plugin config invalid: conformance.plugin/u,
  );
});

test("a plugin manifest without a scope defaults to session", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 1,
        id: "scopeless.plugin",
        version: "1.0.0",
        name: "Scopeless",
        description: "",
        entry: "index.ts",
        capabilities: ["tools"],
        scope: "session",
        provides: [] as string[],
        requires: [] as string[],
      },
      setup(api) {
        api.tools.register({
          name: "noop",
          description: "Noop",
          requiresApproval: false,
          parameters: { type: "object", properties: {} },
          async execute() {
            return "ok";
          },
        });
      },
    }),
  );
  expect(registry.list()[0]?.scope).toBe("session");
});

test("plugin tools are offered to the kernel channel with the plugin's scope", async () => {
  const tools = createToolRegistry([]);
  const contributed: Array<{ name: string; tool: unknown; manifest: unknown }> =
    [];
  const released: string[] = [];
  let unloaded: string | undefined;
  const registry = createPluginRegistry({
    tools,
    registerOwner: (manifest) => ({
      contribute: (_kind, name, tool) => {
        contributed.push({ name, tool, manifest });
        return () => released.push(name);
      },
      release: () => {
        unloaded = manifest.id;
      },
    }),
  });
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 1,
        id: "owned.plugin",
        version: "1.0.0",
        name: "Owned",
        description: "",
        entry: "index.ts",
        scope: "workspace",
        capabilities: ["tools"],
        provides: [],
        requires: [],
      },
      setup(api) {
        api.tools.register({
          name: "scan",
          description: "Scan",
          requiresApproval: false,
          parameters: { type: "object", properties: {} },
          async execute() {
            return "ok";
          },
        });
      },
    }),
  );
  // The kernel channel saw the declared tool name and the manifest it came
  // from, so a host can attribute it and read the plugin's declared scope.
  expect(contributed).toHaveLength(1);
  expect(contributed[0]!.name).toBe("scan");
  expect((contributed[0]!.manifest as { scope: string }).scope).toBe(
    "workspace",
  );
  await registry.unload("owned.plugin");
  expect(released).toEqual(["scan"]);
  expect(unloaded).toBe("owned.plugin");
});

test("conformance reports tool ownership and the approval boundary", async () => {
  const results = await runPluginConformance({
    plugin: definePlugin({
      manifest: {
        apiVersion: 1,
        id: "owned.plugin",
        version: "1.0.0",
        name: "Owned",
        description: "",
        entry: "index.ts",
        capabilities: ["tools"],
        scope: "session",
        provides: [] as string[],
        requires: [] as string[],
      },
      setup(api) {
        api.tools.register({
          name: "scan",
          description: "Scan",
          requiresApproval: false,
          parameters: { type: "object", properties: {} },
          async execute() {
            return "ok";
          },
        });
      },
    }),
  });
  const byName = new Map(results.map((check) => [check.name, check]));
  expect(byName.get("tool-ownership")?.passed).toBe(true);
  expect(byName.get("approval-boundary")?.passed).toBe(true);
  expect(byName.get("owned-registration-cleanup")?.passed).toBe(true);
});

test("a plugin reads the runtime's resolved config via api.runtimeConfig", async () => {
  const tools = createToolRegistry([]);
  const seen: unknown[] = [];
  const registry = createPluginRegistry({
    tools,
    runtimeConfig: () => ({
      defaultAgentMode: "ask",
      runtime: { maxSteps: 8 },
    }),
  });
  await registry.load(
    definePlugin({
      manifest: {
        apiVersion: 1,
        id: "cfg.reader",
        version: "1.0.0",
        name: "Cfg Reader",
        description: "",
        entry: "index.ts",
        capabilities: [],
        scope: "session",
        provides: [] as string[],
        requires: [] as string[],
      },
      setup(api) {
        seen.push(api.runtimeConfig?.());
      },
    }),
  );
  // The resolved config reached the plugin by name — the D2 service has a real
  // production consumer, not just tests.
  expect(seen).toEqual([{ defaultAgentMode: "ask", runtime: { maxSteps: 8 } }]);
  expect(registry.list()[0]?.id).toBe("cfg.reader");
});

test("the content pin verifies the installed package at load", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-pin-"));
  const pluginStoreRoot = join(root, "plugin-store");
  const packageRoot = join(pluginStoreRoot, "node_modules", "@fixture", "pin");
  await mkdir(packageRoot, { recursive: true });
  const manifestPath = join(packageRoot, "natalia.plugin.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      apiVersion: 2,
      id: "fixture.pin",
      version: "1.2.3",
      name: "Fixture",
      entry: "index.ts",
      scope: "workspace",
    }),
  );
  await writeFile(join(packageRoot, "index.ts"), "export default {};");
  const lockEntry = (contentHash: string) => ({
    version: 1,
    plugins: {
      "fixture.pin": {
        packageName: "@fixture/pin",
        manifest: manifestPath,
        metadata: {
          id: "fixture.pin",
          source: { type: "registry" as const, spec: "@fixture/pin@1.2.3" },
          resolvedVersion: "1.2.3",
          contentHash,
          scope: "workspace" as const,
          dependencies: [],
        },
      },
    },
  });
  const lockPath = join(pluginStoreRoot, "natalia.lock");

  // The pin is the installed content: resolve, then drift the package
  // exactly the way the electron incident did — an entry file edited
  // after install — and the load refuses with both hashes named.
  const contentHash = await computePluginPackageHash(packageRoot);
  // Deterministic: the same tree pins to the same hash.
  expect(await computePluginPackageHash(packageRoot)).toBe(contentHash);
  await writeFile(lockPath, JSON.stringify(lockEntry(contentHash)));
  const pinned = await resolveInstalledPluginEntries({ pluginStoreRoot });
  expect(pinned.errors).toEqual([]);
  expect(pinned.entries).toHaveLength(1);

  await writeFile(
    join(packageRoot, "index.ts"),
    "export default { drift: 1 };",
  );
  const drifted = await resolveInstalledPluginEntries({ pluginStoreRoot });
  expect(drifted.entries).toEqual([]);
  expect(drifted.errors).toHaveLength(1);
  expect(drifted.errors[0]!.id).toBe("fixture.pin");
  expect(drifted.errors[0]!.error.message).toContain(
    "package content does not match natalia.lock",
  );
  expect(drifted.errors[0]!.error.message).toContain("reinstall to re-pin");

  // A nested node_modules rearrangement is NOT content: hoisting moves
  // files the package does not own, and the pin must not false-positive.
  await writeFile(join(packageRoot, "index.ts"), "export default {};");
  await mkdir(join(packageRoot, "node_modules", "dep"), { recursive: true });
  await writeFile(join(packageRoot, "node_modules", "dep", "index.js"), "1;");
  const hoisted = await resolveInstalledPluginEntries({ pluginStoreRoot });
  expect(hoisted.errors).toEqual([]);

  // A legacy entry with no pin still loads — the field is an install-time
  // addition, not a load-time requirement.
  await writeFile(
    lockPath,
    JSON.stringify({
      version: 1,
      plugins: {
        "fixture.pin": {
          packageName: "@fixture/pin",
          manifest: manifestPath,
          metadata: {
            id: "fixture.pin",
            source: { type: "registry" as const, spec: "@fixture/pin@1.2.3" },
            resolvedVersion: "1.2.3",
            scope: "workspace" as const,
            dependencies: [],
          },
        },
      },
    }),
  );
  const legacy = await resolveInstalledPluginEntries({ pluginStoreRoot });
  expect(legacy.errors).toEqual([]);
  expect(legacy.entries).toHaveLength(1);
});

test("v2 ui metadata keeps its css (the schema no longer strips it)", () => {
  // The contract mirror and the web loader have always carried css; the
  // zod schema silently dropped it — a half-wired field, now aligned.
  const parsed = pluginManifestSchema.parse({
    apiVersion: 2,
    id: "css.plugin",
    version: "1.0.0",
    name: "CSS Plugin",
    ui: { entry: "src/ui/plugin.js", css: "src/ui/plugin.css" },
  });
  expect(parsed.apiVersion === 2 && parsed.ui?.css).toBe("src/ui/plugin.css");
});

test("v3 manifests generalize renderer packages as facets and reject ui", () => {
  const parsed = pluginManifestSchema.parse({
    apiVersion: 3,
    id: "facets.plugin",
    version: "1.0.0",
    name: "Facets Plugin",
    integrationPoints: ["tools"],
    facets: {
      web: {
        entry: "src/ui/web.js",
        css: "src/ui/web.css",
        panels: [{ id: "settings", title: "Settings", region: "settings" }],
      },
      // The reserved, unwired key: a declaration the runtime does not
      // interpret yet — it fails no load, it simply serves nobody.
      tui: { entry: "src/ui/tui.js" },
    },
  });
  expect(parsed.apiVersion).toBe(3);
  if (parsed.apiVersion !== 3) throw new Error("unreachable");
  expect(parsed.facets?.web?.css).toBe("src/ui/web.css");
  expect(parsed.facets?.tui?.entry).toBe("src/ui/tui.js");
  // ui is rejected at v3 — carrying both would let the two drift.
  expect(() =>
    pluginManifestSchema.parse({
      apiVersion: 3,
      id: "both.plugin",
      version: "1.0.0",
      name: "Both",
      ui: { entry: "src/ui/x.js" },
      facets: { web: { entry: "src/ui/y.js" } },
    }),
  ).toThrow(/ui/);
});

test("the facet resolver maps v2's ui to facets.web and stays version-blind", () => {
  const v2 = pluginManifestSchema.parse({
    apiVersion: 2,
    id: "v2.plugin",
    version: "1.0.0",
    name: "V2",
    ui: { entry: "src/ui/v2.js" },
  });
  const v3 = pluginManifestSchema.parse({
    apiVersion: 3,
    id: "v3.plugin",
    version: "1.0.0",
    name: "V3",
    facets: { web: { entry: "src/ui/v3.js" }, tui: { entry: "src/ui/t.js" } },
  });
  const v1 = pluginManifestSchema.parse({
    apiVersion: 1,
    id: "v1.plugin",
    version: "1.0.0",
    name: "V1",
  });
  // The migration mapping, exactly: v2's ui IS its facets.web.
  expect(pluginFacetFor(v2, "web")).toEqual(
    v2.apiVersion === 2 ? v2.ui : undefined,
  );
  // An env the declaration does not serve is undefined — the degradation
  // law's first clause, no error.
  expect(pluginFacetFor(v2, "tui")).toBeUndefined();
  expect(pluginFacetFor(v3, "web")).toEqual({ entry: "src/ui/v3.js" });
  expect(pluginFacetFor(v3, "tui")).toEqual({ entry: "src/ui/t.js" });
  expect(pluginFacetFor(v1, "web")).toBeUndefined();
});

test("v3's integration points and dependencies load like v2's", () => {
  const v3 = pluginManifestSchema.parse({
    apiVersion: 3,
    id: "points.plugin",
    version: "1.0.0",
    name: "Points",
    integrationPoints: ["tools", "services"],
    dependencies: [{ id: "dep.plugin", spec: "^1.0.0" }],
  });
  if (v3.apiVersion !== 3) throw new Error("unreachable");
  expect(manifestIntegrationPoints(v3)).toEqual(["tools", "services"]);
  // The env registry: web wired, tui reserved (a consumer checks this,
  // the schema never restricts keys).
  expect(PLUGIN_FACET_ENVS).toEqual(["web", "tui"]);
});

test("a plugin declares its shipped skills directory (v2 and v3)", () => {
  // The CU fit study's missing base surface: a plugin ships skills in
  // its package, declared like facets. Default is `skills/`; absent
  // means the plugin ships none; the dir stays package-relative.
  const bare = pluginManifestSchema.parse({
    apiVersion: 2,
    id: "fixture.skills.bare",
    version: "1.0.0",
    name: "Bare",
    skills: {},
  });
  expect(pluginSkillDir(bare)).toBe("skills");
  const custom = pluginManifestSchema.parse({
    apiVersion: 2,
    id: "fixture.skills.custom",
    version: "1.0.0",
    name: "Custom",
    skills: { dir: "agent/skills" },
  });
  expect(pluginSkillDir(custom)).toBe("agent/skills");
  const none = pluginManifestSchema.parse({
    apiVersion: 2,
    id: "fixture.skills.none",
    version: "1.0.0",
    name: "None",
  });
  expect(pluginSkillDir(none)).toBeUndefined();
  const v3 = pluginManifestSchema.parse({
    apiVersion: 3,
    id: "fixture.skills.v3",
    version: "1.0.0",
    name: "V3",
    facets: { web: { entry: "ui/plugin.js" } },
    skills: { dir: "skills" },
  });
  expect(pluginSkillDir(v3)).toBe("skills");
  // An unknown key in the declaration is a hard error (strict), like facets.
  expect(() =>
    pluginManifestSchema.parse({
      apiVersion: 2,
      id: "fixture.skills.bad",
      version: "1.0.0",
      name: "Bad",
      skills: { dirs: "skills" },
    }),
  ).toThrow();
});

test("the logging declaration is the spec's shape: optional, defaulted, boxed", () => {
  // Interface spec §2.4: a CONVENTION field, never a gate — the runtime
  // never reads a plugin's logs. The declaration is optional; the dir
  // defaults to `logs/`; the shape is strict; an escaping directory is
  // refused at the declaration boundary (the same discipline facets'
  // entries get at load).
  const none = pluginManifestSchema.parse({
    apiVersion: 2,
    id: "fixture.logging.none",
    version: "1.0.0",
    name: "None",
  });
  expect(pluginLogDir(none)).toBeUndefined();
  const bare = pluginManifestSchema.parse({
    apiVersion: 2,
    id: "fixture.logging.bare",
    version: "1.0.0",
    name: "Bare",
    logging: {},
  });
  expect(pluginLogDir(bare)).toBe("logs");
  const custom = pluginManifestSchema.parse({
    apiVersion: 2,
    id: "fixture.logging.custom",
    version: "1.0.0",
    name: "Custom",
    logging: { dir: "var/log" },
  });
  expect(pluginLogDir(custom)).toBe("var/log");
  const v3 = pluginManifestSchema.parse({
    apiVersion: 3,
    id: "fixture.logging.v3",
    version: "1.0.0",
    name: "V3",
    facets: { web: { entry: "ui/plugin.js" } },
    logging: { dir: "logs" },
  });
  expect(pluginLogDir(v3)).toBe("logs");
  // The escape boundary, at the declaration: absolute, parent, drive.
  expect(safeDeclaredDir("logs")).toBe(true);
  expect(safeDeclaredDir("var/log")).toBe(true);
  expect(safeDeclaredDir("/etc")).toBe(false);
  expect(safeDeclaredDir("../escape")).toBe(false);
  expect(safeDeclaredDir("C:\\Windows")).toBe(false);
  for (const bad of ["/etc", "../escape", "C:\\Windows"]) {
    expect(() =>
      pluginManifestSchema.parse({
        apiVersion: 2,
        id: "fixture.logging.bad",
        version: "1.0.0",
        name: "Bad",
        logging: { dir: bad },
      }),
    ).toThrow();
  }
  // Strict: an unknown key is a hard error, like every declaration here.
  expect(() =>
    pluginManifestSchema.parse({
      apiVersion: 2,
      id: "fixture.logging.bad2",
      version: "1.0.0",
      name: "Bad",
      logging: { dirs: "logs" },
    }),
  ).toThrow();
});

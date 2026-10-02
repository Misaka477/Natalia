import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createToolRegistry } from "@anthelia/tools";
import { CapabilityRegistry } from "@anthelia/capability";
import { createPluginsController } from "@anthelia/substrate";
import {
  discoverPluginManifests,
  validatePluginPath,
  type Plugin,
  type DesiredPluginEntry,
} from "@anthelia/plugin";
import type { PluginConfigSnapshot } from "@anthelia/substrate";
import {
  installPluginSdkLinks,
  pluginSdkImportPath,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();

async function pluginWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugins-controller-"));
  await mkdir(join(root, ".natalia", "plugins", "demo.plugin"), {
    recursive: true,
  });
  await installPluginSdkLinks(root);
  await writeFile(
    join(root, ".natalia", "plugins", "demo.plugin", "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 1,
      id: "demo.plugin",
      version: "1.0.0",
      name: "Demo",
      capabilities: ["commands"],
    }),
  );
  await writeFile(
    join(root, ".natalia", "plugins", "demo.plugin", "index.ts"),
    `import { definePlugin } from "${pluginSdkImportPath()}";
export default definePlugin({ manifest: { apiVersion: 1, id: "demo.plugin", version: "1.0.0", name: "Demo", capabilities: ["commands"] }, setup(api) { api.commands.register({ name: "hello", title: "Hello", run() {} }); } });`,
  );
  return root;
}

function makeController(
  root: string,
  capabilityRegistry = new CapabilityRegistry(),
  config: {
    enabled?: Record<string, boolean>;
    settings?: Record<string, unknown>;
  } = {},
) {
  const controller = createPluginsController({
    pluginStoreRoot: join(root, "plugin-store"),
    workspaceRoot: root,
    tools: createToolRegistry([]),
    capabilityRegistry,
    discoverDesiredEntries: fixtureDiscovery(root),
    publish: () => undefined,
  });
  return { controller };
}

function fixtureDiscovery(root: string) {
  return async (
    input: Parameters<
      NonNullable<
        Parameters<typeof createPluginsController>[0]["discoverDesiredEntries"]
      >
    >[0],
  ) => {
    const entries = await discoverPluginManifests(
      join(root, ".natalia", "plugins"),
      { nodeModules: false },
    );
    const ids = new Set(input.declaredIDs);
    return entries.flatMap((entry) => {
      if (ids.has(entry.manifest.id))
        throw new Error(`duplicate plugin id: ${entry.manifest.id}`);
      ids.add(entry.manifest.id);
      if (input.enabled?.[entry.manifest.id] === false) return [];
      return [
        {
          id: entry.manifest.id,
          enabled: true,
          fingerprint: JSON.stringify({
            manifest: entry.manifest,
            path: entry.path,
          }),
          manifest: entry.manifest,
          onError: (error: unknown) => input.onError(entry.manifest.id, error),
          async load(cacheBust?: string) {
            const modulePath = validatePluginPath(
              resolve(entry.path, ".."),
              entry.manifest.entry,
            );
            const specifier = cacheBust
              ? `${modulePath}?reload=${cacheBust}`
              : pathToFileURL(modulePath).href;
            const module = (await import(specifier)) as { default: Plugin };
            return { ...module.default, manifest: entry.manifest };
          },
        } satisfies DesiredPluginEntry,
      ];
    });
  };
}

async function initialize(
  controller: ReturnType<typeof createPluginsController>,
  defaults: DesiredPluginEntry[] = [],
  config: PluginConfigSnapshot = {},
) {
  controller.init();
  await controller.reconcileDesired(defaults, config);
}

function desiredPlugin(
  plugin: Plugin,
  fingerprint = plugin.manifest.version,
  enabled = true,
): DesiredPluginEntry {
  return {
    id: plugin.manifest.id,
    enabled,
    fingerprint,
    manifest: plugin.manifest,
    load: async () => plugin,
  };
}

test("plugins controller reconciles the configured user plugin set", async () => {
  const root = await pluginWorkspace();
  const config: {
    enabled?: Record<string, boolean>;
    settings?: Record<string, unknown>;
  } = {};
  const kernel = new CapabilityRegistry();
  const { controller } = makeController(root, kernel, config);
  await initialize(controller);
  expect(controller.list().map((plugin) => plugin.id)).toEqual(["demo.plugin"]);

  config.enabled = { "demo.plugin": false };
  await controller.reconcileDesired([], { enabled: config.enabled });
  expect(controller.list()).toHaveLength(0);
  expect(kernel.has("demo.plugin")).toBe(false);

  config.enabled = { "demo.plugin": true };
  await controller.reconcileDesired([], { enabled: config.enabled });
  expect(controller.list().map((plugin) => plugin.id)).toEqual(["demo.plugin"]);
  expect(kernel.has("demo.plugin")).toBe(true);
  await controller.close();
});

test("disabled user declarations still conflict with duplicate default ids", async () => {
  const root = await pluginWorkspace();
  const { controller } = makeController(root);
  const duplicate = desiredPlugin({
    manifest: {
      apiVersion: 2,
      id: "demo.plugin",
      version: "1.0.0",
      name: "Duplicate",
      description: "",
      entry: "natalia:test:duplicate",
      scope: "workspace",
      provides: [],
      requires: [],
      optionalRequires: [],
      conflicts: [],
      dependencies: [],
      hooks: {},
      integrationPoints: [],
    },
    setup() {},
  });
  controller.init();
  await expect(
    controller.reconcileDesired([duplicate], {
      enabled: { "demo.plugin": false },
    }),
  ).rejects.toThrow("duplicate plugin id: demo.plugin");
  await controller.close();
});

test("plugins controller reapplies user plugin settings on reconcile", async () => {
  const root = await pluginWorkspace();
  const entry = join(root, ".natalia", "plugins", "demo.plugin", "index.ts");
  await writeFile(
    entry,
    `import { definePlugin } from "${pluginSdkImportPath()}";
export default definePlugin({ manifest: { apiVersion: 1, id: "demo.plugin", version: "1.0.0", name: "Demo", capabilities: ["commands"] }, setup(api) { const name = String(api.config); api.commands.register({ name, title: name, run() {} }); } });`,
  );
  const config: { settings?: Record<string, unknown> } = {
    settings: { "demo.plugin": "before" },
  };
  const { controller } = makeController(root, new CapabilityRegistry(), config);
  await initialize(controller, [], { settings: config.settings });
  expect(
    controller
      .get()
      .commands()
      .map((command) => command.name),
  ).toEqual(["before"]);

  config.settings = { "demo.plugin": "after" };
  await controller.reconcileDesired([], { settings: config.settings });
  expect(
    controller
      .get()
      .commands()
      .map((command) => command.name),
  ).toEqual(["after"]);
  await controller.close();
});

test("plugins controller loads, unloads idempotently and reloads", async () => {
  const root = await pluginWorkspace();
  const { controller } = makeController(root);
  await initialize(controller);
  expect(
    controller
      .get()
      .list()
      .some((p) => p.id === "demo.plugin"),
  ).toBe(true);

  const unloaded = await controller.unload("demo.plugin");
  expect(unloaded.unloaded).toBe(true);
  const again = await controller.unload("demo.plugin");
  expect(again.unloaded).toBe(true);
  expect(controller.get().list()).toHaveLength(0);

  const reloaded = await controller.reload("demo.plugin");
  expect(reloaded.reloaded).toBe(true);
  expect(
    controller
      .get()
      .list()
      .some((p) => p.id === "demo.plugin"),
  ).toBe(true);

  const missing = await controller
    .reload("missing.plugin")
    .catch((error: unknown) => error);
  expect((missing as Error).message).toContain("plugin not found");

  await controller.close();
  expect(() => controller.get()).toThrow("plugins are not enabled");
});

test("plugins controller loads only configured lock-backed packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugins-closure-"));
  const pluginStoreRoot = join(root, "plugin-store");
  const modulesRoot = join(pluginStoreRoot, "node_modules");
  const configuredRoot = join(modulesRoot, "configured-plugin");
  const neighborRoot = join(modulesRoot, "neighbor-plugin");
  await Promise.all([
    mkdir(configuredRoot, { recursive: true }),
    mkdir(neighborRoot, { recursive: true }),
  ]);
  for (const [directory, id, command] of [
    [configuredRoot, "configured.plugin", "configured"],
    [neighborRoot, "neighbor.plugin", "neighbor"],
  ] as const) {
    await writeFile(
      join(directory, "natalia.plugin.json"),
      JSON.stringify({
        apiVersion: 1,
        id,
        version: "1.0.0",
        name: id,
        entry: "index.ts",
        capabilities: ["commands"],
        scope: "workspace",
      }),
    );
    await writeFile(
      join(directory, "index.ts"),
      `import { definePlugin } from "${pluginSdkImportPath()}";
export default definePlugin({ manifest: { apiVersion: 1, id: "${id}", version: "1.0.0", name: "${id}", capabilities: ["commands"], scope: "workspace" }, setup(api) { api.commands.register({ name: "${command}", title: "${command}", run() {} }); } });`,
    );
  }
  await writeFile(
    join(pluginStoreRoot, "natalia.lock"),
    JSON.stringify({
      version: 1,
      plugins: {
        "configured.plugin": {
          packageName: "configured-plugin",
          manifest: join(configuredRoot, "natalia.plugin.json"),
          metadata: {
            id: "configured.plugin",
            source: { type: "registry", spec: "configured-plugin@1.0.0" },
            resolvedVersion: "1.0.0",
            scope: "workspace",
            dependencies: [],
          },
        },
      },
    }),
  );
  const controller = createPluginsController({
    pluginStoreRoot,
    workspaceRoot: root,
    tools: createToolRegistry([]),
    capabilityRegistry: new CapabilityRegistry(),
    publish: () => undefined,
  });
  await initialize(controller, [], {
    packages: {
      "configured.plugin": {
        source: { type: "registry", spec: "configured-plugin@1.0.0" },
        version: "1.0.0",
        scope: "workspace",
      },
    },
  });
  expect(controller.list().map((plugin) => plugin.id)).toEqual([
    "configured.plugin",
  ]);
  expect(
    controller
      .get()
      .commands()
      .map((command) => command.name),
  ).toEqual(["configured"]);
  await controller.close();
});

test("plugin tools are owned by the kernel with the plugin's declared scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugins-owned-"));
  await mkdir(join(root, ".natalia", "plugins", "scanner.plugin"), {
    recursive: true,
  });
  await writeFile(
    join(root, ".natalia", "plugins", "scanner.plugin", "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 1,
      id: "scanner.plugin",
      version: "1.0.0",
      name: "Scanner",
      description: "",
      entry: "index.ts",
      capabilities: ["tools"],
      scope: "workspace",
    }),
  );
  await writeFile(
    join(root, ".natalia", "plugins", "scanner.plugin", "index.ts"),
    `import { definePlugin } from "${pluginSdkImportPath()}";
export default definePlugin({ manifest: { apiVersion: 1, id: "scanner.plugin", version: "1.0.0", name: "Scanner", capabilities: ["tools"], scope: "workspace" }, setup(api) { api.tools.register({ name: "scan", description: "Scan", requiresApproval: false, parameters: { type: "object", properties: {} }, async execute() { return "ok"; } }); } });`,
  );

  const kernel = new CapabilityRegistry();
  const { controller } = makeController(root, kernel);
  await initialize(controller);

  // The kernel owns the plugin's tool, named after the plugin, with the scope
  // the plugin declared — the same attribution a built-in family gets.
  expect(kernel.ownerOf("tools", "scan")).toBe("scanner.plugin");
  expect(kernel.scopeOf("scanner.plugin")).toBe("workspace");

  await controller.unload("scanner.plugin");
  expect(kernel.has("scanner.plugin")).toBe(false);
  expect(kernel.ownerOf("tools", "scan")).toBeUndefined();
  await controller.close();
});

test("a failing plugin's diagnostic is attributed to the plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugins-owner-"));
  // A plugin whose entry does not exist fails to load; its diagnostic must say
  // which plugin it belongs to, so "which package failed" is traceable.
  await mkdir(join(root, ".natalia", "plugins", "broken.plugin"), {
    recursive: true,
  });
  await writeFile(
    join(root, ".natalia", "plugins", "broken.plugin", "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 1,
      id: "broken.plugin",
      version: "1.0.0",
      name: "Broken",
      description: "",
      entry: "missing.ts",
      capabilities: [],
    }),
  );
  const diagnostics: Array<{ owner?: string; message: string }> = [];
  const controller = createPluginsController({
    pluginStoreRoot: join(root, "plugin-store"),
    workspaceRoot: root,
    tools: createToolRegistry([]),
    capabilityRegistry: new CapabilityRegistry(),
    discoverDesiredEntries: fixtureDiscovery(root),
    publish: (event) => {
      if (event.type === "diagnostic") diagnostics.push(event);
    },
  });
  await expect(initialize(controller)).rejects.toThrow("broken.plugin");
  expect(diagnostics.length).toBeGreaterThan(0);
  expect(diagnostics.some((entry) => entry.owner === "broken.plugin")).toBe(
    true,
  );
  await controller.close();
});

test("plugin reload re-reads the module after a file change (cache-bust)", async () => {
  const root = await pluginWorkspace();
  const { controller } = makeController(root);
  await initialize(controller);
  // The plugin's file changes on disk (an agent self-edit promoted to the
  // system slot); reload must re-read it, not serve the cached module.
  const entry = join(root, ".natalia", "plugins", "demo.plugin", "index.ts");
  try {
    for (const name of ["reloaded_once", "reloaded_twice"]) {
      await writeFile(
        entry,
        `import { definePlugin } from "${pluginSdkImportPath()}";
export default definePlugin({ manifest: { apiVersion: 1, id: "demo.plugin", version: "1.0.0", name: "Demo", capabilities: ["commands"] }, setup(api) { api.commands.register({ name: "${name}", title: "Reloaded", run() {} }); } });`,
      );
      await controller.reload("demo.plugin");
    }
    const commands = controller.get().commands();
    // The second immediate reload must expose v2 even when both calls happen
    // within one clock tick.
    expect(commands.some((command) => command.name === "reloaded_twice")).toBe(
      true,
    );
  } finally {
    await controller.close();
  }
});

test("default and user plugins disable all contributions uniformly", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugins-single-"));
  await mkdir(join(root, ".natalia", "plugins", "full.plugin"), {
    recursive: true,
  });
  await writeFile(
    join(root, ".natalia", "plugins", "full.plugin", "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 1,
      id: "full.plugin",
      version: "1.0.0",
      name: "Full",
      description: "",
      entry: "index.ts",
      capabilities: ["tools", "commands", "events"],
      provides: ["full.service"],
    }),
  );
  await writeFile(
    join(root, ".natalia", "plugins", "full.plugin", "index.ts"),
    `import { definePlugin } from "${pluginSdkImportPath()}";
export default definePlugin({ manifest: { apiVersion: 1, id: "full.plugin", version: "1.0.0", name: "Full", capabilities: ["tools", "commands", "events"], provides: ["full.service"] }, setup(api) {
  api.tools.register({ name: "run", description: "Run", requiresApproval: false, parameters: { type: "object", properties: {} }, async execute() { return "ok"; } });
  api.commands.register({ name: "greet", title: "Greet", run() {} });
  api.events.on(() => {});
  api.services.provide("full.service", {});
} });`,
  );

  const kernel = new CapabilityRegistry();
  const config: { enabled?: Record<string, boolean> } = {};
  const { controller } = makeController(root, kernel, config);
  const defaultPlugin: Plugin = {
    manifest: {
      apiVersion: 2,
      id: "default.plugin",
      version: "1.0.0",
      name: "Default",
      description: "",
      entry: "natalia:test:default",
      scope: "workspace",
      provides: ["default.service"],
      requires: [],
      optionalRequires: [],
      conflicts: [],
      dependencies: [],
      hooks: {},
      integrationPoints: ["tools", "commands", "events", "services"],
    },
    setup(api) {
      api.tools.register({
        name: "default_tool",
        description: "Default",
        requiresApproval: false,
        parameters: { type: "object", properties: {} },
        async execute() {
          return "ok";
        },
      });
      api.commands.register({
        name: "default_command",
        title: "Default",
        run() {},
      });
      api.events.on(() => {});
      api.services.provide("default.service", {});
    },
  };
  const defaultEntry = desiredPlugin(defaultPlugin);
  await initialize(controller, [defaultEntry]);

  expect(controller.list().map((plugin) => plugin.id)).toEqual([
    "default.plugin",
    "full.plugin",
  ]);
  expect(kernel.ownerOf("tools", "run")).toBe("full.plugin");
  expect(kernel.ownerOf("commands", "greet")).toBe("full.plugin");
  expect(kernel.ownerOf("services", "full.service")).toBe("full.plugin");
  expect(kernel.ownerOf("tools", "default_tool")).toBe("default.plugin");
  expect(kernel.ownerOf("commands", "default_command")).toBe("default.plugin");
  expect(kernel.ownerOf("services", "default.service")).toBe("default.plugin");
  expect(
    kernel
      .contributions("listeners")
      .some(
        (entry) =>
          entry.capabilityID === "full.plugin" &&
          entry.name.startsWith("full.plugin:listener:"),
      ),
  ).toBe(true);
  expect(
    kernel
      .contributions("listeners")
      .some((entry) => entry.capabilityID === "default.plugin"),
  ).toBe(true);

  await controller.unload("full.plugin");
  await controller.unload("default.plugin");
  expect(kernel.ownerOf("tools", "run")).toBeUndefined();
  expect(kernel.ownerOf("commands", "greet")).toBeUndefined();
  expect(kernel.ownerOf("services", "full.service")).toBeUndefined();
  expect(kernel.ownerOf("tools", "default_tool")).toBeUndefined();
  expect(kernel.ownerOf("commands", "default_command")).toBeUndefined();
  expect(kernel.ownerOf("services", "default.service")).toBeUndefined();
  expect(kernel.contributions("listeners")).toHaveLength(0);

  await controller.reconcileDesired([defaultEntry], { enabled: {} });
  expect(controller.list().map((plugin) => plugin.id)).toEqual([
    "default.plugin",
    "full.plugin",
  ]);

  config.enabled = { "full.plugin": false };
  await controller.reconcileDesired(
    [{ ...defaultEntry, enabled: false, fingerprint: "disabled" }],
    { enabled: config.enabled },
  );
  expect(controller.list()).toEqual([]);
  expect(kernel.ownerOf("tools", "run")).toBeUndefined();
  expect(kernel.ownerOf("commands", "greet")).toBeUndefined();
  expect(kernel.ownerOf("services", "full.service")).toBeUndefined();
  expect(kernel.ownerOf("tools", "default_tool")).toBeUndefined();
  expect(kernel.ownerOf("commands", "default_command")).toBeUndefined();
  expect(kernel.ownerOf("services", "default.service")).toBeUndefined();
  expect(kernel.contributions("listeners")).toHaveLength(0);
  await controller.close();
});

test("a plugin provides a service through the kernel, resolvable by name", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugins-service-"));
  await mkdir(join(root, ".natalia", "plugins", "svc.plugin"), {
    recursive: true,
  });
  await writeFile(
    join(root, ".natalia", "plugins", "svc.plugin", "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 1,
      id: "svc.plugin",
      version: "1.0.0",
      name: "Svc",
      description: "",
      entry: "index.ts",
      capabilities: [],
      provides: ["greeting"],
    }),
  );
  await writeFile(
    join(root, ".natalia", "plugins", "svc.plugin", "index.ts"),
    `import { definePlugin } from "${pluginSdkImportPath()}";
export default definePlugin({ manifest: { apiVersion: 1, id: "svc.plugin", version: "1.0.0", name: "Svc", provides: ["greeting"] }, setup(api) {
  api.services.provide("greeting", { text: "hello" });
} });`,
  );

  const kernel = new CapabilityRegistry();
  const { controller } = makeController(root, kernel);
  await initialize(controller);

  // The plugin's service is a kernel-owned contribution, resolvable by name —
  // the first-class service surface a built-in capability has.
  expect(kernel.ownerOf("services", "greeting")).toBe("svc.plugin");
  expect(kernel.service<{ text: string }>("greeting")?.text).toBe("hello");
  await controller.unload("svc.plugin");
  expect(kernel.ownerOf("services", "greeting")).toBeUndefined();
  await controller.close();
});

test("the composition root can unload a default through its lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugins-default-"));
  const kernel = new CapabilityRegistry();
  const { controller } = makeController(root, kernel);
  const plugin: Plugin = {
    manifest: {
      apiVersion: 2,
      id: "default.service",
      version: "1.0.0",
      name: "Default Service",
      description: "Test default lifecycle.",
      entry: "natalia:test:default-service",
      scope: "workspace",
      provides: ["default.greeting"],
      requires: [],
      optionalRequires: [],
      conflicts: [],
      dependencies: [],
      hooks: {},
      integrationPoints: ["services"],
    },
    setup(api) {
      api.services.provide("default.greeting", { text: "hello" });
    },
  };
  await initialize(controller, [desiredPlugin(plugin)]);

  expect(kernel.service("default.greeting")).toBeDefined();
  expect(controller.list().map((entry) => entry.id)).toContain(
    "default.service",
  );
  await controller.unload("default.service");
  expect(kernel.service("default.greeting")).toBeUndefined();
  await controller.unload("default.service");
  await controller.close();
});

test("desired default reconciliation diffs identity, settings and enabled state", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-defaults-desired-"));
  const kernel = new CapabilityRegistry();
  const { controller } = makeController(root, kernel);
  const lifecycle: string[] = [];
  const entry = (fingerprint: string, enabled = true) =>
    desiredPlugin(
      {
        manifest: {
          apiVersion: 2 as const,
          id: "default.desired",
          version: "1.0.0",
          name: "Desired",
          description: "Desired state test builtin.",
          entry: "natalia:test:desired",
          scope: "workspace" as const,
          provides: ["desired.value"],
          requires: [],
          optionalRequires: [],
          conflicts: [],
          dependencies: [],
          hooks: {},
          integrationPoints: ["services" as const],
        },
        setup(api: Parameters<Plugin["setup"]>[0]) {
          lifecycle.push("setup");
          api.services.provide("desired.value", {});
        },
        dispose() {
          lifecycle.push("dispose");
        },
      },
      fingerprint,
      enabled,
    );

  controller.init();
  await controller.reconcileDesired([entry("one")], {
    settings: { "default.desired": { value: 1 } },
  });
  await controller.reconcileDesired([entry("one")], {
    settings: { "default.desired": { value: 1 } },
  });
  expect(lifecycle).toEqual(["setup"]);

  await controller.reconcileDesired([entry("two")], {
    settings: { "default.desired": { value: 1 } },
  });
  await controller.reconcileDesired([entry("two")], {
    settings: { "default.desired": { value: 2 } },
  });
  expect(lifecycle).toEqual(["setup", "dispose", "setup", "dispose", "setup"]);

  await controller.reconcileDesired([entry("two", false)], {});
  expect(kernel.service("desired.value")).toBeUndefined();
  expect(lifecycle.at(-1)).toBe("dispose");
  await controller.close();
});

test("desired default reconciliation restores dependency closure in catalog order", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-defaults-deps-"));
  const kernel = new CapabilityRegistry();
  const { controller } = makeController(root, kernel);
  const lifecycle: string[] = [];
  const catalog = (providerFingerprint: string) => [
    desiredPlugin(
      {
        manifest: {
          apiVersion: 2 as const,
          id: "builtin.provider",
          version: "1.0.0",
          name: "Provider",
          description: "",
          entry: "natalia:test:provider",
          scope: "workspace" as const,
          provides: [],
          requires: [],
          optionalRequires: [],
          conflicts: [],
          dependencies: [],
          hooks: {},
          integrationPoints: [],
        },
        setup() {
          lifecycle.push(`provider:${providerFingerprint}`);
        },
      },
      providerFingerprint,
    ),
    desiredPlugin({
      manifest: {
        apiVersion: 2 as const,
        id: "builtin.consumer",
        version: "1.0.0",
        name: "Consumer",
        description: "",
        entry: "natalia:test:consumer",
        scope: "workspace" as const,
        provides: [],
        requires: [],
        optionalRequires: [],
        conflicts: [],
        dependencies: [
          {
            id: "builtin.provider",
            spec: "*",
            optional: false,
            peer: false,
          },
        ],
        hooks: {},
        integrationPoints: [],
      },
      setup() {
        lifecycle.push("consumer");
      },
    }),
  ];

  controller.init();
  await controller.reconcileDesired(catalog("one"), {});
  await controller.reconcileDesired(catalog("two"), {});
  expect(lifecycle).toEqual([
    "provider:one",
    "consumer",
    "provider:two",
    "consumer",
  ]);
  expect(controller.active("builtin.consumer")).toBe(true);
  await controller.close();
});

test("a default plugin can depend on a discovered user plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-default-user-deps-"));
  const lifecycle: string[] = [];
  const user = desiredPlugin({
    manifest: {
      apiVersion: 2,
      id: "user.provider",
      version: "1.0.0",
      name: "User Provider",
      description: "",
      entry: "natalia:test:user-provider",
      scope: "workspace",
      provides: [],
      requires: [],
      optionalRequires: [],
      conflicts: [],
      dependencies: [],
      hooks: {},
      integrationPoints: [],
    },
    setup() {
      lifecycle.push("user");
    },
  });
  const defaultConsumer = desiredPlugin({
    manifest: {
      apiVersion: 2,
      id: "default.consumer",
      version: "1.0.0",
      name: "Default Consumer",
      description: "",
      entry: "natalia:test:default-consumer",
      scope: "workspace",
      provides: [],
      requires: [],
      optionalRequires: [],
      conflicts: [],
      dependencies: [{ id: user.id, spec: "*", optional: false, peer: false }],
      hooks: {},
      integrationPoints: [],
    },
    setup() {
      lifecycle.push("default");
    },
  });
  const controller = createPluginsController({
    pluginStoreRoot: join(root, "plugin-store"),
    workspaceRoot: root,
    tools: createToolRegistry([]),
    capabilityRegistry: new CapabilityRegistry(),
    discoverDesiredEntries: async () => [user],
    publish: () => undefined,
  });
  await initialize(controller, [defaultConsumer]);
  expect(lifecycle).toEqual(["user", "default"]);
  expect(controller.list().map((entry) => entry.id)).toEqual([
    user.id,
    defaultConsumer.id,
  ]);
  await controller.close();
});

test("default and user plugin conflicts deny both sources symmetrically", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-default-user-conflict-"));
  const diagnostics: Array<{ owner?: string; message: string }> = [];
  const conflicting = (id: string, conflict: string) =>
    desiredPlugin({
      manifest: {
        apiVersion: 2,
        id,
        version: "1.0.0",
        name: id,
        description: "",
        entry: `natalia:test:${id}`,
        scope: "workspace",
        provides: [],
        requires: [],
        optionalRequires: [],
        conflicts: [conflict],
        dependencies: [],
        hooks: {},
        integrationPoints: [],
      },
      setup() {},
    });
  const user = conflicting("user.conflict", "default.conflict");
  const defaultEntry = conflicting("default.conflict", "user.conflict");
  const controller = createPluginsController({
    pluginStoreRoot: join(root, "plugin-store"),
    workspaceRoot: root,
    tools: createToolRegistry([]),
    capabilityRegistry: new CapabilityRegistry(),
    discoverDesiredEntries: async () => [user],
    publish: (event) => {
      if (event.type === "diagnostic") diagnostics.push(event);
    },
  });
  await initialize(controller, [defaultEntry]);
  expect(controller.list()).toEqual([]);
  expect(diagnostics.map((entry) => entry.owner).sort()).toEqual([
    defaultEntry.id,
    user.id,
  ]);
  await controller.close();
});

test("concurrent desired default reconciliation serializes complete lifecycle changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-defaults-concurrent-"));
  const kernel = new CapabilityRegistry();
  const { controller } = makeController(root, kernel);
  const lifecycle: string[] = [];
  const entry = (fingerprint: string) =>
    desiredPlugin(
      {
        manifest: {
          apiVersion: 2 as const,
          id: "builtin.concurrent",
          version: "1.0.0",
          name: "Concurrent",
          description: "",
          entry: "natalia:test:concurrent",
          scope: "workspace" as const,
          provides: [],
          requires: [],
          optionalRequires: [],
          conflicts: [],
          dependencies: [],
          hooks: {},
          integrationPoints: [],
        },
        async setup() {
          lifecycle.push(`setup:${fingerprint}`);
          await Promise.resolve();
        },
        async dispose() {
          lifecycle.push(`dispose:${fingerprint}`);
          await Promise.resolve();
        },
      },
      fingerprint,
    );

  controller.init();
  await controller.reconcileDesired([entry("one")], {});
  await Promise.all([
    controller.reconcileDesired([entry("two")], {}),
    controller.reconcileDesired([entry("three")], {}),
  ]);
  expect(lifecycle).toEqual([
    "setup:one",
    "dispose:one",
    "setup:two",
    "dispose:two",
    "setup:three",
  ]);
  expect(kernel.has("builtin.concurrent")).toBe(true);
  await controller.close();
});

test("failed default setup is retried by the same desired reconcile", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-default-retry-"));
  const { controller } = makeController(root);
  let attempts = 0;
  const plugin: Plugin = {
    manifest: {
      apiVersion: 2,
      id: "default.retry",
      version: "1.0.0",
      name: "Retry",
      description: "",
      entry: "natalia:test:retry",
      scope: "workspace",
      provides: [],
      requires: [],
      optionalRequires: [],
      conflicts: [],
      dependencies: [],
      hooks: {},
      integrationPoints: [],
    },
    setup() {
      if (++attempts === 1) throw new Error("default setup failed");
    },
  };
  const entry = desiredPlugin(plugin);
  controller.init();
  await expect(controller.reconcileDesired([entry], {})).rejects.toThrow(
    "default setup failed",
  );
  expect(controller.status(entry.id)?.status).toBe("failed");
  await controller.reconcileDesired([entry], {});
  expect(controller.active(entry.id)).toBe(true);
  expect(attempts).toBe(2);
  await controller.close();
});

test("failed provider blocks its consumer until reconcile retries it", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-provider-retry-"));
  const { controller } = makeController(root);
  let attempts = 0;
  const provider = desiredPlugin({
    manifest: {
      apiVersion: 2,
      id: "retry.provider",
      version: "1.0.0",
      name: "Provider",
      description: "",
      entry: "natalia:test:retry-provider",
      scope: "workspace",
      provides: [],
      requires: [],
      optionalRequires: [],
      conflicts: [],
      dependencies: [],
      hooks: {},
      integrationPoints: [],
    },
    setup() {
      if (++attempts === 1) throw new Error("provider setup failed");
    },
  });
  const consumer = desiredPlugin({
    manifest: {
      apiVersion: 2,
      id: "retry.consumer",
      version: "1.0.0",
      name: "Consumer",
      description: "",
      entry: "natalia:test:retry-consumer",
      scope: "workspace",
      provides: [],
      requires: [],
      optionalRequires: [],
      conflicts: [],
      dependencies: [
        { id: provider.id, spec: "*", optional: false, peer: false },
      ],
      hooks: {},
      integrationPoints: [],
    },
    setup() {},
  });
  controller.init();
  await expect(
    controller.reconcileDesired([provider, consumer], {}),
  ).rejects.toThrow("provider setup failed");
  expect(controller.status(provider.id)?.status).toBe("failed");
  expect(controller.status(consumer.id)).toBeUndefined();
  await controller.reconcileDesired([provider, consumer], {});
  expect(controller.active(provider.id)).toBe(true);
  expect(controller.active(consumer.id)).toBe(true);
  await controller.close();
});

test("failed discovered user setup is retried by the same desired reconcile", async () => {
  const root = await pluginWorkspace();
  await writeFile(
    join(root, ".natalia", "plugins", "demo.plugin", "index.ts"),
    `import { definePlugin } from "${pluginSdkImportPath()}";
globalThis.__desiredUserAttempts ??= 0;
export default definePlugin({ manifest: { apiVersion: 1, id: "demo.plugin", version: "1.0.0", name: "Demo", capabilities: ["commands"] }, setup(api) {
  if (++globalThis.__desiredUserAttempts === 1) throw new Error("user setup failed");
  api.commands.register({ name: "recovered", title: "Recovered", run() {} });
} });`,
  );
  const { controller } = makeController(root);
  controller.init();
  await expect(controller.reconcileDesired([], {})).rejects.toThrow(
    "user setup failed",
  );
  expect(controller.status("demo.plugin")?.status).toBe("failed");
  await controller.reconcileDesired([], {});
  expect(controller.active("demo.plugin")).toBe(true);
  await controller.close();
});

test("failed provider reload restores the desired closure and can recover", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-reload-closure-"));
  const { controller } = makeController(root);
  let failReload = true;
  const reloadDiagnostics: string[] = [];
  const provider = desiredPlugin({
    manifest: {
      apiVersion: 2,
      id: "default.provider",
      version: "1.0.0",
      name: "Provider",
      description: "",
      entry: "natalia:test:provider",
      scope: "workspace",
      provides: [],
      requires: [],
      optionalRequires: [],
      conflicts: [],
      dependencies: [],
      hooks: {},
      integrationPoints: [],
    },
    setup() {},
  });
  const originalLoad = provider.load;
  provider.load = async (cacheBust) => {
    if (cacheBust && failReload) throw new Error("provider reload failed");
    return originalLoad(cacheBust);
  };
  provider.onError = (error) =>
    reloadDiagnostics.push(
      error instanceof Error ? error.message : String(error),
    );
  const consumer = desiredPlugin({
    manifest: {
      apiVersion: 2,
      id: "default.consumer",
      version: "1.0.0",
      name: "Consumer",
      description: "",
      entry: "natalia:test:consumer",
      scope: "workspace",
      provides: [],
      requires: [],
      optionalRequires: [],
      conflicts: [],
      dependencies: [
        { id: provider.id, spec: "*", optional: false, peer: false },
      ],
      hooks: {},
      integrationPoints: [],
    },
    setup() {},
  });
  controller.init();
  await controller.reconcileDesired([provider, consumer], {});
  await expect(controller.reload(provider.id)).rejects.toThrow(
    "provider reload failed",
  );
  expect(controller.list().map((entry) => entry.id)).toEqual([
    provider.id,
    consumer.id,
  ]);
  expect(reloadDiagnostics).toContain("provider reload failed");
  failReload = false;
  await controller.reload(provider.id);
  expect(controller.list().map((entry) => entry.id)).toEqual([
    provider.id,
    consumer.id,
  ]);
  await controller.close();
});

test("failed reload and rollback leave required consumers absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-reload-rollback-"));
  const { controller } = makeController(root);
  let initial = true;
  const provider = desiredPlugin({
    manifest: {
      apiVersion: 2,
      id: "broken.provider",
      version: "1.0.0",
      name: "Provider",
      description: "",
      entry: "natalia:test:broken-provider",
      scope: "workspace",
      provides: [],
      requires: [],
      optionalRequires: [],
      conflicts: [],
      dependencies: [],
      hooks: {},
      integrationPoints: [],
    },
    setup() {},
  });
  provider.load = async () => {
    if (initial) {
      initial = false;
      return {
        manifest: provider.manifest!,
        setup() {},
      };
    }
    return {
      manifest: provider.manifest!,
      setup() {
        throw new Error("provider activation failed");
      },
    };
  };
  const consumer = desiredPlugin({
    manifest: {
      apiVersion: 2,
      id: "broken.consumer",
      version: "1.0.0",
      name: "Consumer",
      description: "",
      entry: "natalia:test:broken-consumer",
      scope: "workspace",
      provides: [],
      requires: [],
      optionalRequires: [],
      conflicts: [],
      dependencies: [
        { id: provider.id, spec: "*", optional: false, peer: false },
      ],
      hooks: {},
      integrationPoints: [],
    },
    setup() {},
  });
  controller.init();
  await controller.reconcileDesired([provider, consumer], {});
  await expect(controller.reload(provider.id)).rejects.toThrow(
    "provider activation failed",
  );
  expect(controller.status(provider.id)).toBeUndefined();
  expect(controller.status(consumer.id)).toBeUndefined();
  await controller.close();
});

test("desired state advances before a failing disposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-desired-disposal-"));
  const { controller } = makeController(root);
  const lifecycle: string[] = [];
  const plugin = (version: string, disposeFails = false) =>
    desiredPlugin(
      {
        manifest: {
          apiVersion: 2,
          id: "default.disposal",
          version: "1.0.0",
          name: "Disposal",
          description: "",
          entry: "natalia:test:disposal",
          scope: "workspace",
          provides: [],
          requires: [],
          optionalRequires: [],
          conflicts: [],
          dependencies: [],
          hooks: {},
          integrationPoints: [],
        },
        setup() {
          lifecycle.push(`setup:${version}`);
        },
        dispose() {
          lifecycle.push(`dispose:${version}`);
          if (disposeFails) throw new Error("disposal failed");
        },
      },
      version,
    );
  controller.init();
  await controller.reconcileDesired([plugin("old", true)], {});
  await expect(
    controller.reconcileDesired([plugin("new")], {}),
  ).rejects.toThrow("disposal failed");
  await controller.reload("default.disposal");
  expect(lifecycle).toEqual(["setup:old", "dispose:old", "setup:new"]);
  await controller.close();
});

test("discovery and reconcile use queued immutable config snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-snapshot-"));
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const seen: string[] = [];
  const controller = createPluginsController({
    pluginStoreRoot: join(root, "plugin-store"),
    workspaceRoot: root,
    tools: createToolRegistry([]),
    capabilityRegistry: new CapabilityRegistry(),
    discoverDesiredEntries: async (input) => {
      seen.push(String(input.enabled?.["snapshot.plugin"]));
      if (seen.length === 1) await firstBlocked;
      return [];
    },
    publish: () => undefined,
  });
  controller.init();
  const config: PluginConfigSnapshot = {
    enabled: { "snapshot.plugin": true },
  };
  const first = controller.reconcileDesired([], config);
  config.enabled!["snapshot.plugin"] = false;
  const second = controller.reconcileDesired([], {
    enabled: { "snapshot.plugin": false },
  });
  releaseFirst();
  await Promise.all([first, second]);
  expect(seen).toEqual(["true", "false"]);
  await controller.close();
});

test("direct load updates desired state for reload and reconcile", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-direct-load-"));
  const { controller } = makeController(root);
  const entry = desiredPlugin({
    manifest: {
      apiVersion: 2,
      id: "direct.plugin",
      version: "1.0.0",
      name: "Direct",
      description: "",
      entry: "natalia:test:direct",
      scope: "workspace",
      provides: [],
      requires: [],
      optionalRequires: [],
      conflicts: [],
      dependencies: [],
      hooks: {},
      integrationPoints: [],
    },
    setup() {},
  });
  controller.init();
  await controller.load(entry, { value: 1 });
  await controller.reload(entry.id);
  expect(controller.active(entry.id)).toBe(true);
  await controller.reconcileDesired([entry], {
    settings: { [entry.id]: { value: 1 } },
  });
  expect(controller.active(entry.id)).toBe(true);
  await controller.close();
});

test("desired entry loads once per actual load epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-default-factory-"));
  const { controller } = makeController(root);
  let constructions = 0;
  const defaults: DesiredPluginEntry[] = [
    {
      id: "default.factory",
      enabled: true,
      fingerprint: "stable",
      manifest: {
        apiVersion: 2,
        id: "default.factory",
        version: "1.0.0",
        name: "Factory",
        description: "",
        entry: "natalia:test:factory",
        scope: "workspace",
        provides: [],
        requires: [],
        optionalRequires: [],
        conflicts: [],
        dependencies: [],
        hooks: {},
        integrationPoints: [],
      },
      async load() {
        constructions++;
        return {
          manifest: {
            apiVersion: 2,
            id: "default.factory",
            version: "1.0.0",
            name: "Factory",
            description: "",
            entry: "natalia:test:factory",
            scope: "workspace",
            provides: [],
            requires: [],
            optionalRequires: [],
            conflicts: [],
            dependencies: [],
            hooks: {},
            integrationPoints: [],
          },
          setup() {},
        };
      },
    },
  ];
  controller.init();
  await controller.reconcileDesired(defaults, {});
  await controller.reconcileDesired(defaults, {});
  expect(constructions).toBe(1);
  await controller.reload("default.factory");
  expect(constructions).toBe(2);
  await controller.close();
});

test("dependency-blocked desired entry is not loaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-default-blocked-"));
  const { controller } = makeController(root);
  let constructions = 0;
  const defaults: DesiredPluginEntry[] = [
    {
      id: "blocked.default",
      enabled: true,
      fingerprint: "stable",
      manifest: {
        apiVersion: 2,
        id: "blocked.default",
        version: "1.0.0",
        name: "Blocked",
        description: "",
        entry: "natalia:test:blocked-default",
        scope: "workspace",
        provides: [],
        requires: [],
        optionalRequires: [],
        conflicts: [],
        dependencies: [
          {
            id: "missing.default",
            spec: "*",
            optional: false,
            peer: false,
          },
        ],
        hooks: {},
        integrationPoints: [],
      },
      async load() {
        constructions++;
        throw new Error("blocked default was constructed");
      },
    },
  ];
  controller.init();
  await controller.reconcileDesired(defaults, {});
  expect(constructions).toBe(0);
  expect(controller.status("blocked.default")).toBeUndefined();
  await controller.close();
});

test("a plugin providing an undeclared service is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugins-undeclared-"));
  await mkdir(join(root, ".natalia", "plugins", "bad.plugin"), {
    recursive: true,
  });
  await writeFile(
    join(root, ".natalia", "plugins", "bad.plugin", "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 1,
      id: "bad.plugin",
      version: "1.0.0",
      name: "Bad",
      description: "",
      entry: "index.ts",
      capabilities: [],
      provides: [],
    }),
  );
  await writeFile(
    join(root, ".natalia", "plugins", "bad.plugin", "index.ts"),
    `import { definePlugin } from "${pluginSdkImportPath()}";
export default definePlugin({ manifest: { apiVersion: 1, id: "bad.plugin", version: "1.0.0", name: "Bad" }, setup(api) {
  api.services.provide("undeclared", {});
} });`,
  );
  const diagnostics: string[] = [];
  const controller = createPluginsController({
    pluginStoreRoot: join(root, "plugin-store"),
    workspaceRoot: root,
    tools: createToolRegistry([]),
    capabilityRegistry: new CapabilityRegistry(),
    discoverDesiredEntries: fixtureDiscovery(root),
    publish: (event) => {
      if (event.type === "diagnostic") diagnostics.push(event.message);
    },
  });
  await expect(initialize(controller)).rejects.toThrow("bad.plugin");
  expect(
    diagnostics.some((message) => message.includes("undeclared service")),
  ).toBe(true);
  await controller.close();
});

test("a plugin requiring a service waits for it before its setup runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugins-requires-"));
  await mkdir(join(root, ".natalia", "plugins", "req.plugin"), {
    recursive: true,
  });
  await writeFile(
    join(root, ".natalia", "plugins", "req.plugin", "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 1,
      id: "req.plugin",
      version: "1.0.0",
      name: "Req",
      description: "",
      entry: "index.ts",
      capabilities: [],
      requires: ["runtime.config"],
    }),
  );
  await writeFile(
    join(root, ".natalia", "plugins", "req.plugin", "index.ts"),
    `import { definePlugin } from "${pluginSdkImportPath()}";
let setupRan = false;
export default definePlugin({ manifest: { apiVersion: 1, id: "req.plugin", version: "1.0.0", name: "Req", requires: ["runtime.config"] }, setup(api) {
  setupRan = true;
  (globalThis as any).__reqPluginSetupRan = setupRan;
} });`,
  );

  const kernel = new CapabilityRegistry();
  const { controller } = makeController(root, kernel);
  // The runtime-config framework service provides the required service before
  // the local plugin loads, exactly as the real runtime wires it.
  const runtimeConfigOwner = kernel.registerOwner({
    id: "natalia-runtime-config",
    name: "Runtime Config",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services"],
  });
  runtimeConfigOwner.contribute("services", "runtime.config", { runtime: {} });
  await initialize(controller, []);
  // Plugin dependency ordering ensures the service is available before setup.
  expect(kernel.has("req.plugin")).toBe(true);
  await controller.close();
});

test("plugins controller reactivates a mounted plugin when service provider identity changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugins-epochs-"));
  const kernel = new CapabilityRegistry();
  const { controller } = makeController(root, kernel);
  const lifecycle: string[] = [];
  let epoch = 0;
  const consumer: Plugin = {
    manifest: {
      apiVersion: 2,
      id: "builtin.consumer",
      version: "1.0.0",
      name: "Consumer",
      description: "",
      entry: "natalia:test:consumer",
      scope: "workspace",
      provides: [],
      requires: ["test.provider"],
      optionalRequires: [],
      conflicts: [],
      dependencies: [],
      hooks: {},
      integrationPoints: ["resources"],
    },
    setup(api) {
      const current = ++epoch;
      lifecycle.push(`setup:${current}`);
      api.resources.register({ name: "consumer.resource", epoch: current });
    },
    dispose() {
      lifecycle.push(`dispose:${epoch}`);
    },
  };
  await initialize(controller, [desiredPlugin(consumer)]);
  expect(controller.status("builtin.consumer")?.status).toBe("pending");
  expect(controller.active("builtin.consumer")).toBe(false);

  const providerA = kernel.registerOwner({
    id: "provider:a",
    name: "Provider A",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services"],
  });
  providerA.contribute("services", "test.provider", {});
  await controller.get().whenIdle();
  expect(controller.active("builtin.consumer")).toBe(true);
  expect(
    kernel.contribution<{ epoch: number }>("resources", "consumer.resource")
      ?.epoch,
  ).toBe(1);

  const providerB = kernel.registerOwner({
    id: "provider:b",
    name: "Provider B",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services"],
    precedence: 1,
  });
  providerB.contribute("services", "test.provider", {});
  await controller.get().whenIdle();
  expect(controller.active("builtin.consumer")).toBe(true);
  expect(
    kernel.contribution<{ epoch: number }>("resources", "consumer.resource")
      ?.epoch,
  ).toBe(2);

  providerB.release();
  await controller.get().whenIdle();
  expect(controller.status("builtin.consumer")?.status).toBe("pending");
  expect(kernel.contribution("resources", "consumer.resource")).toBeUndefined();

  const providerC = kernel.registerOwner({
    id: "provider:c",
    name: "Provider C",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services"],
  });
  providerC.contribute("services", "test.provider", {});
  await controller.get().whenIdle();
  expect(
    kernel.contribution<{ epoch: number }>("resources", "consumer.resource")
      ?.epoch,
  ).toBe(3);
  expect(lifecycle).toEqual([
    "setup:1",
    "dispose:1",
    "setup:2",
    "dispose:2",
    "setup:3",
  ]);
  await controller.unload("builtin.consumer");
  expect(lifecycle).toEqual([
    "setup:1",
    "dispose:1",
    "setup:2",
    "dispose:2",
    "setup:3",
    "dispose:3",
  ]);
  providerA.release();
  providerC.release();
  await controller.close();
});

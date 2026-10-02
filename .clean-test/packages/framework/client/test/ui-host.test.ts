import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeClient, RuntimeEvent } from "@anthelia/contracts";
import {
  discoverPluginManifests,
  validatePluginPath,
  type DesiredPluginEntry,
  type Plugin,
  type PluginManifest,
} from "@anthelia/plugin";
import { createUiAdapterHost } from "../src/ui-host";
import {
  installPluginSdkLinks,
  pluginSdkImportPath,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();

const SDK = pluginSdkImportPath();

function runtimeFixture() {
  let sink: ((event: RuntimeEvent) => void) | undefined;
  let disposals = 0;
  const runtime = {
    start(next: (event: RuntimeEvent) => void) {
      sink = next;
    },
    submit: async () => ({ sessionID: "ses_fixture", turnID: "turn_fixture" }),
    async dispose() {
      disposals += 1;
    },
  } as unknown as RuntimeClient;
  return {
    runtime,
    disposals: () => disposals,
    emit(event: RuntimeEvent) {
      sink?.(event);
    },
  };
}

function resetCounters() {
  (globalThis as { __uiHostMounts?: number }).__uiHostMounts = 0;
  (globalThis as { __uiHostDisposals?: number }).__uiHostDisposals = 0;
  (globalThis as { __uiHostNonAdapterSetup?: number }).__uiHostNonAdapterSetup =
    0;
}

function uiManifest(id: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    apiVersion: 2,
    id,
    version: "1.0.0",
    name: "Fixture UI",
    description: "Fixture UI adapter.",
    entry: "index.ts",
    scope: "process",
    provides: [],
    requires: [],
    optionalRequires: [],
    conflicts: [],
    dependencies: [],
    hooks: {},
    integrationPoints: ["adapters"],
    ...extra,
  });
}

function uiEntry(id: string, kind: string) {
  return `import { definePlugin } from ${JSON.stringify(SDK)};
export default definePlugin({
  manifest: ${uiManifest(id)},
  setup(api) {
    api.adapters.registerUi({
      kind: ${JSON.stringify(kind)},
      mount: async () => {
        (globalThis as any).__uiHostMounts = ((globalThis as any).__uiHostMounts ?? 0) + 1;
      },
      dispose: () => {
        (globalThis as any).__uiHostDisposals = ((globalThis as any).__uiHostDisposals ?? 0) + 1;
      },
    });
  },
});
`;
}

async function discoveredUiWorkspace(config: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "natalia-ui-host-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await installPluginSdkLinks(root);
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      plugins: { paths: ["ui-plugins"] },
      ...config,
    }),
  );
  const pluginRoot = join(root, "ui-plugins", "fixture");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "natalia.plugin.json"),
    uiManifest("fixture.ui"),
  );
  await writeFile(
    join(pluginRoot, "index.ts"),
    uiEntry("fixture.ui", "ui.fixture"),
  );
  return { root, pluginStoreRoot: join(root, "plugin-store") };
}

function directUiDiscovery(root: string) {
  return async (
    input: Parameters<
      NonNullable<Parameters<typeof createUiAdapterHost>[0]["discover"]>
    >[0],
  ) => {
    const entries = await discoverPluginManifests(join(root, "ui-plugins"), {
      nodeModules: false,
    });
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

async function installedUiWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "natalia-ui-installed-"));
  const pluginStoreRoot = join(root, "plugin-store");
  const packageRoot = join(pluginStoreRoot, "node_modules", "fixture-ui");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(join(root, ".natalia"), { recursive: true });
  await installPluginSdkLinks(root);
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      plugins: {
        packages: {
          "fixture.ui": {
            source: { type: "registry", spec: "fixture-ui@1.0.0" },
            version: "1.0.0",
            scope: "process",
          },
        },
      },
    }),
  );
  await writeFile(
    join(pluginStoreRoot, "natalia.lock"),
    JSON.stringify({
      version: 1,
      plugins: {
        "fixture.ui": {
          packageName: "fixture-ui",
          manifest: join(packageRoot, "natalia.plugin.json"),
          metadata: {
            id: "fixture.ui",
            source: { type: "registry", spec: "fixture-ui@1.0.0" },
            resolvedVersion: "1.0.0",
            scope: "process",
            dependencies: [],
          },
        },
      },
    }),
  );
  await writeFile(
    join(packageRoot, "natalia.plugin.json"),
    uiManifest("fixture.ui"),
  );
  await writeFile(
    join(packageRoot, "index.ts"),
    uiEntry("fixture.ui", "ui.fixture"),
  );
  return { root, pluginStoreRoot };
}

test("an enabled discovered UI plugin mounts and disposes through the generic host", async () => {
  resetCounters();
  const { root, pluginStoreRoot } = await discoveredUiWorkspace();
  const fixture = runtimeFixture();
  const host = await createUiAdapterHost({
    pluginStoreRoot,
    workspaceRoot: root,
    runtime: fixture.runtime,
    kinds: ["ui.fixture"],
    configPath: join(root, "missing-global.json"),
    discover: directUiDiscovery(root),
  });
  expect(
    (globalThis as unknown as { __uiHostMounts: number }).__uiHostMounts,
  ).toBe(1);
  expect(host.instances).toHaveLength(1);
  expect(host.availableKinds()).toEqual(["ui.fixture"]);
  await host.mountInput!.commands.list();
  await host.close();
  expect(
    (globalThis as unknown as { __uiHostDisposals: number }).__uiHostDisposals,
  ).toBe(1);
  expect(fixture.disposals()).toBe(1);
  await host.close();
  expect(
    (globalThis as unknown as { __uiHostDisposals: number }).__uiHostDisposals,
  ).toBe(1);
  expect(fixture.disposals()).toBe(1);
});

test("an enabled installed (lock-backed) UI plugin mounts through the generic host", async () => {
  resetCounters();
  const { root, pluginStoreRoot } = await installedUiWorkspace();
  const fixture = runtimeFixture();
  const host = await createUiAdapterHost({
    pluginStoreRoot,
    workspaceRoot: root,
    runtime: fixture.runtime,
    kinds: ["ui.fixture"],
    configPath: join(root, "missing-global.json"),
  });
  expect(
    (globalThis as unknown as { __uiHostMounts: number }).__uiHostMounts,
  ).toBe(1);
  expect(host.availableKinds()).toEqual(["ui.fixture"]);
  await host.close();
  expect(
    (globalThis as unknown as { __uiHostDisposals: number }).__uiHostDisposals,
  ).toBe(1);
  expect(fixture.disposals()).toBe(1);
});

test("a disabled discovered UI plugin mounts nothing and fails closed", async () => {
  resetCounters();
  const { root, pluginStoreRoot } = await discoveredUiWorkspace({
    plugins: {
      paths: ["ui-plugins"],
      enabled: { "fixture.ui": false },
    },
  });
  const fixture = runtimeFixture();
  await expect(
    createUiAdapterHost({
      pluginStoreRoot,
      workspaceRoot: root,
      runtime: fixture.runtime,
      kinds: ["ui.fixture"],
      configPath: join(root, "missing-global.json"),
      discover: directUiDiscovery(root),
    }),
  ).rejects.toThrow("adapter is not available: ui.fixture");
  expect(
    (globalThis as unknown as { __uiHostMounts: number }).__uiHostMounts,
  ).toBe(0);
  expect(fixture.disposals()).toBe(1);
});

test("an explicit missing UI kind fails closed without mounting anything", async () => {
  resetCounters();
  const { root, pluginStoreRoot } = await discoveredUiWorkspace();
  const fixture = runtimeFixture();
  await expect(
    createUiAdapterHost({
      pluginStoreRoot,
      workspaceRoot: root,
      runtime: fixture.runtime,
      kinds: ["ui.missing"],
      configPath: join(root, "missing-global.json"),
      discover: directUiDiscovery(root),
    }),
  ).rejects.toThrow("adapter is not available: ui.missing");
  expect(
    (globalThis as unknown as { __uiHostMounts: number }).__uiHostMounts,
  ).toBe(0);
  expect(
    (globalThis as unknown as { __uiHostDisposals: number }).__uiHostDisposals,
  ).toBe(0);
  expect(fixture.disposals()).toBe(1);
});

test("only adapter-capable process plugins are loaded into the host registry", async () => {
  resetCounters();
  const root = await mkdtemp(join(tmpdir(), "natalia-ui-filter-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await installPluginSdkLinks(root);
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      plugins: { paths: ["ui-plugins"] },
    }),
  );
  const nonAdapter = join(root, "ui-plugins", "worker");
  await mkdir(nonAdapter, { recursive: true });
  await writeFile(
    join(nonAdapter, "natalia.plugin.json"),
    uiManifest("worker.plugin", {
      scope: "process",
      integrationPoints: ["commands"],
    }),
  );
  await writeFile(
    join(nonAdapter, "index.ts"),
    `import { definePlugin } from ${JSON.stringify(SDK)};
export default definePlugin({
  manifest: ${uiManifest("worker.plugin", { scope: "process", integrationPoints: ["commands"] })},
  setup() {
    (globalThis as any).__uiHostNonAdapterSetup = ((globalThis as any).__uiHostNonAdapterSetup ?? 0) + 1;
  },
});
`,
  );
  const fixture = runtimeFixture();
  const host = await createUiAdapterHost({
    pluginStoreRoot: join(root, "plugin-store"),
    workspaceRoot: root,
    runtime: fixture.runtime,
    kinds: [],
    configPath: join(root, "missing-global.json"),
    discover: directUiDiscovery(root),
  });
  expect(
    (globalThis as unknown as { __uiHostNonAdapterSetup: number })
      .__uiHostNonAdapterSetup,
  ).toBe(0);
  expect(host.availableKinds()).toEqual([]);
  await host.close();
  expect(fixture.disposals()).toBe(1);
});

test("extra desired entries share the same generic host path", async () => {
  resetCounters();
  const root = await mkdtemp(join(tmpdir(), "natalia-ui-extra-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3 }),
  );
  const fixture = runtimeFixture();
  let mounts = 0;
  let disposals = 0;
  const manifest: PluginManifest = {
    apiVersion: 2,
    id: "natalia-tui",
    version: "1.0.0",
    name: "TUI",
    description: "Fixture TUI.",
    entry: "natalia:tui",
    scope: "process",
    provides: [],
    requires: [],
    optionalRequires: [],
    conflicts: [],
    dependencies: [],
    hooks: {},
    integrationPoints: ["adapters"],
  };
  const entry: DesiredPluginEntry = {
    id: manifest.id,
    enabled: true,
    fingerprint: manifest.version,
    manifest,
    load: async () => ({
      manifest,
      setup(api) {
        api.adapters.registerUi({
          kind: "ui.tui",
          mount: async () => {
            mounts += 1;
          },
          dispose: () => {
            disposals += 1;
          },
        });
      },
    }),
  };
  const host = await createUiAdapterHost({
    workspaceRoot: root,
    runtime: fixture.runtime,
    kinds: ["ui.tui"],
    extraEntries: [entry],
    configPath: join(root, "missing-global.json"),
  });
  expect(mounts).toBe(1);
  expect(host.availableKinds()).toEqual(["ui.tui"]);
  await host.close();
  expect(disposals).toBe(1);
  expect(fixture.disposals()).toBe(1);
});

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry, type CapabilityGrant } from "@anthelia/capability";
import { createPluginAdapterMaterializer } from "@anthelia/plugin";
import { createToolRegistry } from "@anthelia/tools";
import { discoverDesiredPluginEntries } from "@anthelia/substrate";
import { createPluginsController } from "@anthelia/substrate";
import {
  pluginSdkImportPath,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();

const pluginID = "lifecycle.symmetry";
const packageName = "lifecycle-symmetry-plugin";
const version = "1.0.0";
const contributions: ReadonlyArray<[CapabilityGrant, string]> = [
  ["tools", "symmetry_tool"],
  ["commands", "symmetry_command"],
  ["services", "symmetry.persistence"],
  ["resources", "symmetry.resource"],
  ["projections", "symmetry.projection"],
  ["workflows", "symmetry.workflow"],
  ["settingsSchema", "symmetry.settings"],
  ["adapters", "symmetry.adapter"],
  ["adapters", "symmetry.ui"],
  ["schedulerJobs", "symmetry.job"],
];

type PersistenceService = {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
};

async function installedFixture(): Promise<{
  root: string;
  pluginStoreRoot: string;
  config: {
    packages: Record<
      string,
      {
        source: { type: "registry"; spec: string };
        version: string;
        scope: "workspace";
      }
    >;
  };
}> {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-symmetry-"));
  const pluginStoreRoot = join(root, "plugin-store");
  const packageRoot = join(pluginStoreRoot, "node_modules", packageName);
  await mkdir(packageRoot, { recursive: true });
  const manifest = {
    apiVersion: 2,
    id: pluginID,
    version,
    name: "Lifecycle symmetry fixture",
    description: "Exercises every plugin contribution surface.",
    entry: "index.ts",
    scope: "workspace",
    provides: ["symmetry.persistence"],
    requires: [],
    optionalRequires: [],
    conflicts: [],
    dependencies: [],
    hooks: {},
    integrationPoints: [
      "tools",
      "commands",
      "events",
      "services",
      "resources",
      "projections",
      "workflows",
      "settingsSchema",
      "adapters",
      "schedulerJobs",
    ],
  };
  const manifestPath = join(packageRoot, "natalia.plugin.json");
  const persistencePath = join(root, ".natalia", "symmetry-state.txt");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(
    join(packageRoot, "index.ts"),
    `import { readFile, writeFile } from "node:fs/promises";
import { definePlugin } from "${pluginSdkImportPath()}";
const persistencePath = ${JSON.stringify(persistencePath)};
export default definePlugin({
  manifest: ${JSON.stringify(manifest)},
  setup(api) {
    api.tools.register({ name: "symmetry_tool", description: "Symmetry", requiresApproval: false, parameters: { type: "object", properties: {} }, async execute() { return "ok"; } });
    api.commands.register({ name: "symmetry_command", title: "Symmetry", run() {} });
    api.events.on(() => {});
    api.services.provide("symmetry.persistence", {
      async read() { try { return await readFile(persistencePath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } },
      async write(value: string) { await writeFile(persistencePath, value); },
    });
    api.resources.register({ name: "symmetry.resource" });
    api.projections.register({ name: "symmetry.projection" });
    api.workflows.register({ name: "symmetry.workflow" });
    api.settingsSchema.register({ name: "symmetry.settings" });
    api.adapters.register({ name: "symmetry.adapter", adapterType: "test", create: () => ({ dispose() {} }) });
    api.adapters.registerUi({ kind: "symmetry.ui", mount() {}, dispose() {} });
    api.scheduler.add({ name: "symmetry.job" });
  },
});`,
  );
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(pluginStoreRoot, "natalia.lock"),
    JSON.stringify({
      version: 1,
      plugins: {
        [pluginID]: {
          packageName,
          manifest: manifestPath,
          metadata: {
            id: pluginID,
            source: { type: "registry", spec: `${packageName}@${version}` },
            resolvedVersion: version,
            scope: "workspace",
            dependencies: [],
          },
        },
      },
    }),
  );
  const config = {
    packages: {
      [pluginID]: {
        source: {
          type: "registry" as const,
          spec: `${packageName}@${version}`,
        },
        version,
        scope: "workspace" as const,
      },
    },
  };
  const entries = await discoverDesiredPluginEntries({
    pluginStoreRoot,
    packages: config.packages,
    declaredIDs: [],
    onError: (_id, error) => {
      throw error;
    },
  });
  expect(entries).toHaveLength(1);
  return { root, pluginStoreRoot, config };
}

function assertPresent(kernel: CapabilityRegistry) {
  for (const [kind, name] of contributions)
    expect(kernel.ownerOf(kind, name)).toBe(pluginID);
  expect(
    kernel
      .contributions("listeners")
      .some((entry) => entry.capabilityID === pluginID),
  ).toBe(true);
}

function assertAbsent(kernel: CapabilityRegistry) {
  for (const [kind, name] of contributions)
    expect(kernel.ownerOf(kind, name)).toBeUndefined();
  expect(
    kernel
      .contributions("listeners")
      .some((entry) => entry.capabilityID === pluginID),
  ).toBe(false);
  expect(kernel.has(pluginID)).toBe(false);
}

test("installed discovery uses the complete lifecycle", async () => {
  const { root, pluginStoreRoot, config } = await installedFixture();
  const kernel = new CapabilityRegistry();
  const tools = createToolRegistry([]);
  const controller = createPluginsController({
    pluginStoreRoot,
    workspaceRoot: root,
    tools,
    capabilityRegistry: kernel,
    publish: () => undefined,
  });
  controller.init();
  await controller.reconcileDesired([], config);

  assertPresent(kernel);
  expect(tools.has("symmetry_tool")).toBe(true);
  expect(
    controller
      .get()
      .commands()
      .map(({ name }) => name),
  ).toContain("symmetry_command");
  const persistence = kernel.service<PersistenceService>(
    "symmetry.persistence",
  )!;
  await persistence.write("installed discovery");
  expect(await persistence.read()).toBe("installed discovery");
  const materializer = createPluginAdapterMaterializer(kernel);
  await materializer.materialize("symmetry.adapter", {});
  await materializer.materialize("symmetry.ui", {} as never);
  await materializer.close();

  await controller.unload(pluginID);
  assertAbsent(kernel);
  expect(tools.has("symmetry_tool")).toBe(false);
  expect(controller.get().commands()).toEqual([]);
  await expect(
    createPluginAdapterMaterializer(kernel).materialize(
      "symmetry.ui",
      {} as never,
    ),
  ).rejects.toThrow("adapter is not available");

  await controller.reconcileDesired([], config);
  assertPresent(kernel);
  expect(
    await kernel.service<PersistenceService>("symmetry.persistence")?.read(),
  ).toBe("installed discovery");
  const recoveredUi = createPluginAdapterMaterializer(kernel);
  await recoveredUi.materialize("symmetry.ui", {} as never);
  await recoveredUi.close();
  await controller.close();
  assertAbsent(kernel);
});

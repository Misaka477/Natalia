import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, updateConfig } from "@anthelia/config";
import {
  doctorPlugins,
  initializeOfficialPlugins,
  installPlugin,
  listInstalledPlugins,
  loadNataliaLock,
  OFFICIAL_PLUGIN_PACKAGES,
  reconcilePlugins,
  reinstallOfficialPlugin,
  resolveOfficialPluginPackage,
  saveNataliaLock,
  setPluginEnabled,
  uninstallPlugin,
  type PackageManagerRun,
} from "../src";
import { rollbackWith } from "../src/closure";

const packageName = "@fixture/natalia-plugin";
const pluginID = "fixture.plugin";

function pluginModule(manifest: object) {
  return `export default { manifest: ${JSON.stringify(manifest)}, setup() {} };`;
}

function fixturePackageManager(runs: string[][]): PackageManagerRun {
  return async ({ args }) => {
    runs.push(args);
    const prefix = args[args.indexOf("--prefix") + 1]!;
    const packageDir = join(
      prefix,
      "node_modules",
      "@fixture",
      "natalia-plugin",
    );
    if (args[0] === "uninstall") {
      await rm(packageDir, { recursive: true, force: true });
      return;
    }
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      join(prefix, "package.json"),
      JSON.stringify({ dependencies: { [packageName]: "1.2.3" } }),
    );
    await writeFile(
      join(prefix, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          [`node_modules/${packageName}`]: {
            version: "1.2.3",
            integrity: "sha512-fixture",
          },
        },
      }),
    );
    const manifest = {
      apiVersion: 2,
      id: pluginID,
      version: "1.2.3",
      name: "Fixture",
      entry: "index.ts",
      scope: "workspace",
    } as const;
    await writeFile(
      join(packageDir, "natalia.plugin.json"),
      JSON.stringify(manifest),
    );
    await writeFile(join(packageDir, "index.ts"), pluginModule(manifest));
  };
}

async function installedWorkspace() {
  const pluginStoreRoot = await mkdtemp(join(tmpdir(), "natalia-transaction-"));
  const runs: string[][] = [];
  const runPackageManager = fixturePackageManager(runs);
  await installPlugin({
    pluginStoreRoot,
    spec: `${packageName}@1.2.3`,
    runPackageManager,
  });
  return { pluginStoreRoot, runs, runPackageManager };
}

test("plugin lifecycle installs, catalogs, toggles, reconciles, and fully uninstalls", async () => {
  const pluginStoreRoot = await mkdtemp(join(tmpdir(), "natalia-store-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "natalia-installer-"));
  const runs: string[][] = [];
  const runPackageManager = fixturePackageManager(runs);
  const installed = await installPlugin({
    pluginStoreRoot,
    spec: `${packageName}@1.2.3`,
    runPackageManager,
  });
  expect(installed).toMatchObject({
    installed: true,
    pluginID,
    packageName,
    metadata: { resolvedVersion: "1.2.3", integrity: "sha512-fixture" },
  });
  expect(runs).toHaveLength(1);
  expect(runs[0]!.join(" ")).toContain(`--prefix ${pluginStoreRoot}`);
  expect(runs[0]!.join(" ")).not.toContain("plugin-staging");
  expect(await doctorPlugins(pluginStoreRoot)).toEqual([]);

  const rows = await listInstalledPlugins({ pluginStoreRoot, workspaceRoot });
  expect(rows.find((row) => row.id === pluginID)).toMatchObject({
    name: "Fixture",
    installed: true,
    packageName,
  });
  expect(rows.map((row) => row.id)).toEqual(
    [...rows.map((row) => row.id)].sort(),
  );
  expect(
    new Set(rows.map((row) => Object.keys(row).sort().join(","))).size,
  ).toBe(1);

  await setPluginEnabled({
    pluginStoreRoot,
    workspaceRoot,
    pluginID,
    enabled: false,
  });
  const toggled = JSON.parse(
    await readFile(join(workspaceRoot, ".natalia", "config.json"), "utf8"),
  );
  expect(toggled.plugins.enabled).toMatchObject({
    [pluginID]: false,
  });
  expect(toggled.tools?.enabled).toBeUndefined();

  await updateConfig(workspaceRoot, {
    plugins: {
      settings: { [pluginID]: { key: true } },
      capabilities: { [pluginID]: ["tools"] },
      readOnly: { [pluginID]: true },
    },
  });
  expect(
    await uninstallPlugin({ pluginStoreRoot, pluginID, runPackageManager }),
  ).toMatchObject({ disposition: "removed" });
  expect((await loadNataliaLock(pluginStoreRoot)).plugins).toEqual({});
  const config = (await resolveConfig({ workspaceRoot })).config.plugins;
  expect(config.enabled[pluginID]).toBe(false);
  expect(config.settings[pluginID]).toEqual({ key: true });
  expect(config.capabilities[pluginID]).toEqual(["tools"]);
  expect(config.readOnly[pluginID]).toBe(true);
});

test("invalid installed package does not create a Natalia lock", async () => {
  const pluginStoreRoot = await mkdtemp(join(tmpdir(), "natalia-invalid-"));
  const runs: string[][] = [];
  const runPackageManager: PackageManagerRun = async ({ args }) => {
    runs.push(args);
    const prefix = args[args.indexOf("--prefix") + 1]!;
    if (args[0] === "uninstall") {
      await rm(join(prefix, "node_modules", "invalid-plugin"), {
        recursive: true,
        force: true,
      });
      await writeFile(join(prefix, "package.json"), JSON.stringify({}));
      return;
    }
    const packageDir = join(prefix, "node_modules", "invalid-plugin");
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      join(prefix, "package.json"),
      JSON.stringify({ dependencies: { "invalid-plugin": "1.0.0" } }),
    );
    await writeFile(
      join(prefix, "package-lock.json"),
      JSON.stringify({
        packages: { "node_modules/invalid-plugin": { version: "1.0.0" } },
      }),
    );
  };
  await expect(
    installPlugin({
      pluginStoreRoot,
      spec: "invalid-plugin",
      runPackageManager,
    }),
  ).rejects.toThrow("exactly one natalia.plugin.json");
  expect(runs.some((args) => args[0] === "uninstall")).toBe(true);
  expect(
    existsSync(join(pluginStoreRoot, "node_modules", "invalid-plugin")),
  ).toBe(false);
  expect(existsSync(join(pluginStoreRoot, "natalia.lock"))).toBe(false);
});

test("install enables the plugin in the selected workspace", async () => {
  const pluginStoreRoot = await mkdtemp(join(tmpdir(), "natalia-store-"));
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "natalia-enable-on-install-"),
  );
  await installPlugin({
    pluginStoreRoot,
    workspaceRoot,
    spec: `${packageName}@1.2.3`,
    runPackageManager: fixturePackageManager([]),
  });
  const config = JSON.parse(
    await readFile(join(workspaceRoot, ".natalia", "config.json"), "utf8"),
  );
  expect(config.plugins.enabled).toMatchObject({ [pluginID]: true });
  expect(
    (await listInstalledPlugins({ pluginStoreRoot, workspaceRoot }))[0]
      ?.enabled,
  ).toBe(true);
});

test("install rejects an entry manifest that differs from the package manifest", async () => {
  const pluginStoreRoot = await mkdtemp(join(tmpdir(), "natalia-mismatch-"));
  const base = fixturePackageManager([]);
  const runPackageManager: PackageManagerRun = async (input) => {
    await base(input);
    const prefix = input.args[input.args.indexOf("--prefix") + 1]!;
    const entry = join(
      prefix,
      "node_modules",
      "@fixture",
      "natalia-plugin",
      "index.ts",
    );
    await writeFile(
      entry,
      pluginModule({
        apiVersion: 2,
        id: "different.plugin",
        version: "1.2.3",
        name: "Fixture",
        entry: "index.ts",
        scope: "workspace",
      }),
    );
  };
  await expect(
    installPlugin({ pluginStoreRoot, spec: packageName, runPackageManager }),
  ).rejects.toThrow("does not match natalia.plugin.json");
});

test("installer state is not synthesized without a physical package", async () => {
  const pluginStoreRoot = await mkdtemp(join(tmpdir(), "natalia-no-store-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "natalia-no-runtime-"));
  expect(
    await listInstalledPlugins({ pluginStoreRoot, workspaceRoot }),
  ).toEqual([]);
  await expect(
    setPluginEnabled({
      pluginStoreRoot,
      workspaceRoot,
      pluginID: "runtime.plugin",
      enabled: false,
    }),
  ).rejects.toThrow("unknown plugin");
  await expect(
    uninstallPlugin({
      pluginStoreRoot,
      pluginID: "runtime.plugin",
    }),
  ).rejects.toThrow("unknown plugin");

  const physicalRoot = await mkdtemp(join(tmpdir(), "natalia-runtime-id-"));
  const installed = await installPlugin({
    pluginStoreRoot: physicalRoot,
    spec: packageName,
    runPackageManager: fixturePackageManager([]),
  });
  expect(installed.pluginID).toBe(pluginID);
});

test("plugin doctor reports and reconciles a package missing from disk", async () => {
  const pluginStoreRoot = await mkdtemp(join(tmpdir(), "natalia-doctor-"));
  const runs: string[][] = [];
  const runPackageManager = fixturePackageManager(runs);
  await installPlugin({
    pluginStoreRoot,
    spec: `${packageName}@1.2.3`,
    runPackageManager,
  });
  await rm(
    join(pluginStoreRoot, "node_modules", "@fixture", "natalia-plugin"),
    { recursive: true },
  );
  expect(await doctorPlugins(pluginStoreRoot)).toContainEqual(
    expect.objectContaining({ code: "package_missing" }),
  );
  await reconcilePlugins(pluginStoreRoot, runPackageManager);
  expect(await doctorPlugins(pluginStoreRoot)).toEqual([]);
});

test("package manager failure does not mutate Natalia metadata", async () => {
  const { pluginStoreRoot } = await installedWorkspace();
  const beforeLock = await loadNataliaLock(pluginStoreRoot);
  await expect(
    installPlugin({
      pluginStoreRoot,
      spec: `${packageName}@2.0.0`,
      runPackageManager: async () => {
        throw new Error("npm failed");
      },
    }),
  ).rejects.toThrow("npm failed");
  expect(await loadNataliaLock(pluginStoreRoot)).toEqual(beforeLock);
});

test("lock failure rolls back a successful package install", async () => {
  const pluginStoreRoot = await mkdtemp(join(tmpdir(), "natalia-metadata-"));
  const runs: string[][] = [];
  await expect(
    installPlugin({
      pluginStoreRoot,
      spec: `${packageName}@1.2.3`,
      runPackageManager: fixturePackageManager(runs),
      seams: {
        saveLock: async () => {
          throw new Error("lock write failed");
        },
      },
    }),
  ).rejects.toThrow("lock write failed");
  expect(runs.some((args) => args[0] === "uninstall")).toBe(true);
  expect(
    existsSync(
      join(pluginStoreRoot, "node_modules", "@fixture", "natalia-plugin"),
    ),
  ).toBe(false);
  expect(
    (await loadNataliaLock(pluginStoreRoot)).plugins[pluginID],
  ).toBeUndefined();
});

test("install rejects duplicate plugin IDs and package manifest ID changes", async () => {
  const { pluginStoreRoot } = await installedWorkspace();
  const manager =
    (name: string, id: string): PackageManagerRun =>
    async ({ args }) => {
      const prefix = args[args.indexOf("--prefix") + 1]!;
      const dir = join(prefix, "node_modules", name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(prefix, "package.json"),
        JSON.stringify({ dependencies: { [name]: "1.0.0" } }),
      );
      await writeFile(
        join(prefix, "package-lock.json"),
        JSON.stringify({
          packages: { [`node_modules/${name}`]: { version: "1.0.0" } },
        }),
      );
      const manifest = {
        apiVersion: 1,
        id,
        version: "1.0.0",
        name,
        entry: `index-${id}.ts`,
        scope: "workspace",
      } as const;
      await writeFile(
        join(dir, "natalia.plugin.json"),
        JSON.stringify(manifest),
      );
      await writeFile(join(dir, manifest.entry), pluginModule(manifest));
    };
  await expect(
    installPlugin({
      pluginStoreRoot,
      spec: "other-package",
      runPackageManager: manager("other-package", pluginID),
    }),
  ).rejects.toThrow("already owned");
  await expect(
    installPlugin({
      pluginStoreRoot,
      spec: packageName,
      runPackageManager: manager(packageName, "changed.id"),
    }),
  ).rejects.toThrow("changing plugin id");
});

test("reinstall resolves an unchanged scoped registry dependency", async () => {
  const { pluginStoreRoot, runPackageManager } = await installedWorkspace();
  const installed = await installPlugin({
    pluginStoreRoot,
    spec: `${packageName}@1.2.3`,
    runPackageManager,
  });
  expect(installed.packageName).toBe(packageName);
  expect(installed.pluginID).toBe(pluginID);
});

test("uninstall leaves Natalia metadata unchanged when npm fails", async () => {
  const { pluginStoreRoot } = await installedWorkspace();
  const beforeLock = await loadNataliaLock(pluginStoreRoot);
  await expect(
    uninstallPlugin({
      pluginStoreRoot,
      pluginID,
      runPackageManager: async () => {
        throw new Error("npm uninstall failed");
      },
    }),
  ).rejects.toThrow("npm uninstall failed");
  expect(await loadNataliaLock(pluginStoreRoot)).toEqual(beforeLock);
});

test("uninstall does not restore a package after metadata cleanup fails", async () => {
  const { pluginStoreRoot, runPackageManager } = await installedWorkspace();
  await expect(
    uninstallPlugin({
      pluginStoreRoot,
      pluginID,
      runPackageManager,
      seams: {
        saveLock: async () => {
          throw new Error("lock removal failed");
        },
      },
    }),
  ).rejects.toThrow("lock removal failed");
  expect(
    existsSync(
      join(pluginStoreRoot, "node_modules", "@fixture", "natalia-plugin"),
    ),
  ).toBe(false);
  expect(
    (await loadNataliaLock(pluginStoreRoot)).plugins[pluginID],
  ).toBeDefined();
});

test("reconcile delegates every physical package repair to installPlugin", async () => {
  const pluginStoreRoot = await mkdtemp(
    join(tmpdir(), "natalia-reconcile-npm-"),
  );
  await writeFile(join(pluginStoreRoot, "sentinel"), "before");
  await saveNataliaLock(pluginStoreRoot, {
    version: 1,
    plugins: {
      "first.plugin": lockEntry("first-package", "first.plugin"),
      "second.plugin": lockEntry("second-package", "second.plugin"),
    },
  });
  const repairs: string[] = [];
  await expect(
    reconcilePlugins(pluginStoreRoot, undefined, {
      installPlugin: async (input) => {
        repairs.push(input.spec);
        if (repairs.length === 2) throw new Error("second repair failed");
        return {} as never;
      },
    }),
  ).rejects.toThrow("second repair failed");
  expect(repairs).toHaveLength(2);
  expect(await readFile(join(pluginStoreRoot, "sentinel"), "utf8")).toBe(
    "before",
  );
});

test("package validation enforces package, manifest, entry, and lock boundaries", async () => {
  const manager =
    (
      mode: "dependency" | "entryEscape" | "packageEscape" | "missing",
    ): PackageManagerRun =>
    async ({ args }) => {
      const prefix = args[args.indexOf("--prefix") + 1]!;
      const dir = join(prefix, "node_modules", "boundary-plugin");
      const packageRoot =
        mode === "packageEscape" ? join(prefix, "outside-package") : dir;
      await mkdir(packageRoot, { recursive: true });
      if (mode === "packageEscape") {
        await mkdir(join(prefix, "node_modules"), { recursive: true });
        await symlink(packageRoot, dir, "dir");
      }
      await writeFile(
        join(prefix, "package.json"),
        JSON.stringify({ dependencies: { "boundary-plugin": "1.0.0" } }),
      );
      await writeFile(
        join(prefix, "package-lock.json"),
        JSON.stringify({
          packages:
            mode === "missing"
              ? {}
              : { "node_modules/boundary-plugin": { version: "1.0.0" } },
        }),
      );
      const manifest = {
        apiVersion: 1,
        id: "boundary.plugin",
        version: "1.0.0",
        name: "Boundary",
        entry: "index.ts",
        scope: "workspace",
      } as const;
      await writeFile(
        join(packageRoot, "natalia.plugin.json"),
        JSON.stringify(manifest),
      );
      if (mode === "entryEscape") {
        await writeFile(join(prefix, "outside.ts"), "export default {};");
        await symlink(
          join(prefix, "outside.ts"),
          join(packageRoot, "index.ts"),
        );
      } else
        await writeFile(join(packageRoot, "index.ts"), pluginModule(manifest));
      if (mode === "dependency") {
        const dependency = join(dir, "node_modules", "dependency");
        await mkdir(dependency, { recursive: true });
        await writeFile(join(dependency, "natalia.plugin.json"), "{}");
      }
    };
  const entryRoot = await mkdtemp(join(tmpdir(), "natalia-boundary-entry-"));
  await expect(
    installPlugin({
      pluginStoreRoot: entryRoot,
      spec: "boundary-plugin",
      runPackageManager: manager("entryEscape"),
    }),
  ).rejects.toThrow("entry escapes");
  const packageRoot = await mkdtemp(
    join(tmpdir(), "natalia-boundary-package-"),
  );
  await expect(
    installPlugin({
      pluginStoreRoot: packageRoot,
      spec: "boundary-plugin",
      runPackageManager: manager("packageEscape"),
    }),
  ).rejects.toThrow("package escapes node_modules");
  const missingRoot = await mkdtemp(join(tmpdir(), "natalia-boundary-lock-"));
  await expect(
    installPlugin({
      pluginStoreRoot: missingRoot,
      spec: "boundary-plugin",
      runPackageManager: manager("missing"),
    }),
  ).rejects.toThrow("package-lock is missing");
  const dependencyRoot = await mkdtemp(
    join(tmpdir(), "natalia-boundary-dependency-"),
  );
  const installed = await installPlugin({
    pluginStoreRoot: dependencyRoot,
    spec: "boundary-plugin",
    runPackageManager: manager("dependency"),
  });
  expect(installed?.pluginID).toBe("boundary.plugin");
});

test("rollback attempts every restoration and aggregates failures", async () => {
  const attempts: string[] = [];
  const original = new Error("mutation failed");
  const firstRestore = new Error("closure restore failed");
  try {
    await rollbackWith(original, [
      async () => {
        attempts.push("closure");
        throw firstRestore;
      },
      async () => {
        attempts.push("lock");
      },
      async () => {
        attempts.push("config");
      },
    ]);
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([original, firstRestore]);
  }
  expect(attempts).toEqual(["closure", "lock", "config"]);
});

test("real and symlink store paths share one operation queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-realpath-"));
  const alias = `${root}-alias`;
  await symlink(root, alias, "dir");
  let active = 0;
  let maximum = 0;
  const base = fixturePackageManager([]);
  const manager: PackageManagerRun = async (input) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await base(input);
    active -= 1;
  };
  await Promise.all([
    installPlugin({
      pluginStoreRoot: root,
      spec: packageName,
      runPackageManager: manager,
    }),
    installPlugin({
      pluginStoreRoot: alias,
      spec: packageName,
      runPackageManager: manager,
    }),
  ]);
  expect(maximum).toBe(1);
});

test("workspaces share one plugin store and keep independent enabled config", async () => {
  const pluginStoreRoot = await mkdtemp(
    join(tmpdir(), "natalia-shared-store-"),
  );
  const firstWorkspaceRoot = await mkdtemp(
    join(tmpdir(), "natalia-workspace-a-"),
  );
  const secondWorkspaceRoot = await mkdtemp(
    join(tmpdir(), "natalia-workspace-b-"),
  );
  await installPlugin({
    pluginStoreRoot,
    spec: packageName,
    runPackageManager: fixturePackageManager([]),
  });

  let active = 0;
  let maximum = 0;
  const apply = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
  };
  await Promise.all([
    setPluginEnabled({
      pluginStoreRoot,
      workspaceRoot: firstWorkspaceRoot,
      pluginID,
      enabled: false,
      apply,
    }),
    setPluginEnabled({
      pluginStoreRoot,
      workspaceRoot: secondWorkspaceRoot,
      pluginID,
      enabled: true,
      apply,
    }),
  ]);

  expect(maximum).toBe(1);
  expect(Object.keys((await loadNataliaLock(pluginStoreRoot)).plugins)).toEqual(
    [pluginID],
  );
  expect(
    existsSync(
      join(pluginStoreRoot, "node_modules", "@fixture", "natalia-plugin"),
    ),
  ).toBe(true);
  for (const workspaceRoot of [firstWorkspaceRoot, secondWorkspaceRoot]) {
    expect(existsSync(join(workspaceRoot, "natalia.lock"))).toBe(false);
    expect(existsSync(join(workspaceRoot, "node_modules"))).toBe(false);
  }
  expect(
    (
      await listInstalledPlugins({
        pluginStoreRoot,
        workspaceRoot: firstWorkspaceRoot,
      })
    )[0]?.enabled,
  ).toBe(false);
  expect(
    (
      await listInstalledPlugins({
        pluginStoreRoot,
        workspaceRoot: secondWorkspaceRoot,
      })
    )[0]?.enabled,
  ).toBe(true);
});

test("custom global config participates in maintenance reads and writes", async () => {
  const pluginStoreRoot = await mkdtemp(join(tmpdir(), "natalia-store-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "natalia-custom-config-"));
  const globalPath = join(workspaceRoot, "custom-global.json");
  await writeFile(
    globalPath,
    JSON.stringify({
      version: 3,
      plugins: { enabled: { [pluginID]: false } },
    }),
  );
  await installPlugin({
    pluginStoreRoot,
    spec: packageName,
    runPackageManager: fixturePackageManager([]),
  });
  expect(
    (
      await listInstalledPlugins({
        pluginStoreRoot,
        workspaceRoot,
        globalPath,
      })
    )[0]?.enabled,
  ).toBe(false);
  await setPluginEnabled({
    pluginStoreRoot,
    workspaceRoot,
    pluginID,
    enabled: true,
    config: { globalPath },
  });
  expect(
    (await resolveConfig({ workspaceRoot, globalPath })).config.plugins.enabled[
      pluginID
    ],
  ).toBe(true);
});

test("official catalog contains 16 prebuilt packages and excludes PDF", () => {
  expect(OFFICIAL_PLUGIN_PACKAGES).toHaveLength(16);
  expect(
    OFFICIAL_PLUGIN_PACKAGES.map(({ id }) => id) as readonly string[],
  ).not.toContain("natalia-tool-pdf");
});

test("first initialization physically installs through installPlugin", async () => {
  const pluginStoreRoot = await mkdtemp(
    join(tmpdir(), "natalia-official-first-"),
  );
  const distributionRoot = await officialDistribution("natalia-tool-ask");
  const calls: string[] = [];
  const result = await initializeOfficialPlugins({
    pluginStoreRoot,
    distributionRoot,
    pluginIDs: ["natalia-tool-ask"],
    runPackageManager: fixturePackageManager([]),
    seams: {
      installPlugin: async (input) => {
        calls.push(input.spec);
        return await installPlugin(input);
      },
    },
  });
  expect(result.initialized).toBe(true);
  expect(calls).toEqual([
    await resolveOfficialPluginPackage(distributionRoot, "natalia-tool-ask"),
  ]);
  expect(
    (await loadNataliaLock(pluginStoreRoot)).plugins[pluginID],
  ).toBeDefined();
});

test("uninstalled official plugin stays absent after re-init and reconcile", async () => {
  const pluginStoreRoot = await mkdtemp(
    join(tmpdir(), "natalia-official-absent-"),
  );
  const distributionRoot = await officialDistribution("natalia-tool-ask");
  const runPackageManager = fixturePackageManager([]);
  await initializeOfficialPlugins({
    pluginStoreRoot,
    distributionRoot,
    pluginIDs: ["natalia-tool-ask"],
    runPackageManager,
  });
  await uninstallPlugin({ pluginStoreRoot, pluginID, runPackageManager });
  expect(
    await initializeOfficialPlugins({
      pluginStoreRoot,
      distributionRoot,
      pluginIDs: ["natalia-tool-ask"],
      runPackageManager,
    }),
  ).toEqual({ initialized: false, installed: [] });
  await reconcilePlugins(pluginStoreRoot, runPackageManager);
  expect((await loadNataliaLock(pluginStoreRoot)).plugins).toEqual({});
});

test("official reinstall resolves the current bundled source", async () => {
  const pluginStoreRoot = await mkdtemp(
    join(tmpdir(), "natalia-official-reinstall-"),
  );
  const firstRoot = await officialDistribution("natalia-tool-ask");
  const currentRoot = await officialDistribution("natalia-tool-ask");
  const calls: string[] = [];
  await reinstallOfficialPlugin({
    pluginStoreRoot,
    distributionRoot: firstRoot,
    pluginID: "natalia-tool-ask",
    runPackageManager: fixturePackageManager([]),
  });
  await reinstallOfficialPlugin({
    pluginStoreRoot,
    distributionRoot: currentRoot,
    pluginID: "natalia-tool-ask",
    seams: {
      installPlugin: async (input) => {
        calls.push(input.spec);
        return await installPlugin({
          ...input,
          runPackageManager: fixturePackageManager([]),
        });
      },
    },
  });
  expect(calls).toEqual([
    await resolveOfficialPluginPackage(currentRoot, "natalia-tool-ask"),
  ]);
  expect(
    (await loadNataliaLock(pluginStoreRoot)).plugins[pluginID],
  ).toBeDefined();
});

test("zero official plugins is a valid initialized state", async () => {
  const pluginStoreRoot = await mkdtemp(
    join(tmpdir(), "natalia-official-zero-"),
  );
  const distributionRoot = await mkdtemp(join(tmpdir(), "natalia-dist-zero-"));
  expect(
    await initializeOfficialPlugins({
      pluginStoreRoot,
      distributionRoot,
      pluginIDs: [],
    }),
  ).toEqual({ initialized: true, installed: [] });
  expect((await loadNataliaLock(pluginStoreRoot)).plugins).toEqual({});
  expect(
    await initializeOfficialPlugins({ pluginStoreRoot, distributionRoot }),
  ).toEqual({ initialized: false, installed: [] });
});

async function officialDistribution(id: "natalia-tool-ask") {
  const root = await mkdtemp(join(tmpdir(), "natalia-distribution-"));
  const entry = OFFICIAL_PLUGIN_PACKAGES.find(
    (candidate) => candidate.id === id,
  )!;
  await mkdir(join(root, entry.directory), { recursive: true });
  return root;
}

function lockEntry(packageName: string, id: string) {
  return {
    packageName,
    manifest: `plugin-store/node_modules/${packageName}/natalia.plugin.json`,
    metadata: {
      id,
      source: { type: "registry" as const, spec: `${packageName}@1.2.3` },
      resolvedVersion: "1.2.3",
      integrity: "sha512-fixture",
      scope: "workspace" as const,
      dependencies: [],
    },
  };
}

test("a v3 manifest's web facet reaches the catalog row version-blind", async () => {
  // The row is what the web loader, the CLI bundle service and the CEF
  // host read; they must never learn which version wrote the declaration.
  const pluginStoreRoot = await mkdtemp(join(tmpdir(), "natalia-v3-store-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "natalia-v3-ws-"));
  const packageDir = join(pluginStoreRoot, "node_modules", "fixture-v3");
  await mkdir(packageDir, { recursive: true });
  const manifestPath = join(packageDir, "natalia.plugin.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      apiVersion: 3,
      id: "fixture.v3",
      version: "1.0.0",
      name: "V3 Fixture",
      entry: "index.ts",
      scope: "workspace",
      facets: {
        web: { entry: "ui/web.js", css: "ui/web.css" },
        // The reserved key: declared, not served, harmless.
        tui: { entry: "ui/tui.js" },
      },
    }),
  );
  await writeFile(
    join(pluginStoreRoot, "natalia.lock"),
    JSON.stringify({
      version: 1,
      plugins: {
        "fixture.v3": {
          packageName: "fixture-v3",
          manifest: manifestPath,
          metadata: {
            id: "fixture.v3",
            source: { type: "registry", spec: "fixture-v3@1.0.0" },
            resolvedVersion: "1.0.0",
            scope: "workspace",
            dependencies: [],
          },
        },
      },
    }),
  );
  const rows = await listInstalledPlugins({ pluginStoreRoot, workspaceRoot });
  expect(rows).toHaveLength(1);
  // §2.3's mapping at the row: the web facet, css included, and nothing
  // of the unwired env leaks into the row.
  expect(rows[0]!.ui).toEqual({ entry: "ui/web.js", css: "ui/web.css" });
});

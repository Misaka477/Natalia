import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installPlugin,
  loadNataliaLock,
  type PackageManagerRun,
} from "@natalia/installer";
import { createPluginRuntime } from "../src/runtime/plugin-runtime";
import type { RuntimeContext } from "@anthelia/substrate";

const packageName = "@fixture/natalia-plugin";
const pluginID = "fixture.plugin";

function pluginModule(manifest: object) {
  return `export default { manifest: ${JSON.stringify(manifest)}, setup() {} };`;
}

function fixturePackageManager(): PackageManagerRun {
  return async ({ args }) => {
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

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-runtime-"));
  const pluginStoreRoot = join(root, "plugin-store");
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const runPackageManager = fixturePackageManager();
  await installPlugin({
    pluginStoreRoot,
    spec: `${packageName}@1.2.3`,
    runPackageManager,
  });

  let blockedReason: string | undefined;
  let reloadResult: { applied: boolean; reason?: string } = { applied: true };
  let applyCalls = 0;

  const ctx = {
    state: { pluginStoreRoot },
    ports: {
      getWorkspaceRoot: () => workspaceRoot,
      configReloadBlockedReason: () => blockedReason,
      applyConfigFromDisk: async () => {
        applyCalls += 1;
        return reloadResult;
      },
      reloadConfigFromDisk: async () => ({
        read: true,
        providerReconfigured: false,
      }),
    },
  } as unknown as RuntimeContext;

  const runtime = createPluginRuntime(ctx, { runPackageManager });
  const packageDir = join(
    pluginStoreRoot,
    "node_modules",
    "@fixture",
    "natalia-plugin",
  );

  return {
    runtime,
    pluginStoreRoot,
    workspaceRoot,
    packageDir,
    setBlocked(reason: string | undefined) {
      blockedReason = reason;
    },
    setReloadResult(result: { applied: boolean; reason?: string }) {
      reloadResult = result;
    },
    applyCallCount: () => applyCalls,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test("pluginUninstall refuses while a turn is running and leaves the package installed", async () => {
  const h = await harness();
  try {
    h.setBlocked("runtime config cannot be applied while a turn is running");
    await expect(h.runtime.pluginUninstall!({ pluginID })).rejects.toThrow(
      /turn is running/,
    );
    // The delete step must not have run: the package and its lock entry stay.
    expect(existsSync(h.packageDir)).toBe(true);
    expect(
      (await loadNataliaLock(h.pluginStoreRoot)).plugins[pluginID],
    ).toBeDefined();
    // And the runtime reload is never reached.
    expect(h.applyCallCount()).toBe(0);
  } finally {
    await h.dispose();
  }
});

test("pluginUninstall refuses while an approval or question is pending", async () => {
  const h = await harness();
  try {
    h.setBlocked(
      "runtime config cannot be applied while an approval or question is pending",
    );
    await expect(h.runtime.pluginUninstall!({ pluginID })).rejects.toThrow(
      /approval or question is pending/,
    );
    expect(existsSync(h.packageDir)).toBe(true);
    expect(
      (await loadNataliaLock(h.pluginStoreRoot)).plugins[pluginID],
    ).toBeDefined();
    expect(h.applyCallCount()).toBe(0);
  } finally {
    await h.dispose();
  }
});

test("pluginUninstall reports when the reload cannot unload after the files are gone", async () => {
  const h = await harness();
  try {
    h.setBlocked(undefined);
    h.setReloadResult({
      applied: false,
      reason: "runtime config could not be applied: reconcile failed",
    });
    await expect(h.runtime.pluginUninstall!({ pluginID })).rejects.toThrow(
      /reconcile failed/,
    );
    // The delete already happened, so the package is gone — but the caller is
    // told the runtime still holds it instead of a clean success.
    expect(existsSync(h.packageDir)).toBe(false);
    expect(
      (await loadNataliaLock(h.pluginStoreRoot)).plugins[pluginID],
    ).toBeUndefined();
    expect(h.applyCallCount()).toBe(1);
  } finally {
    await h.dispose();
  }
});

test("pluginUninstall removes the package and reloads when nothing blocks it", async () => {
  const h = await harness();
  try {
    h.setBlocked(undefined);
    h.setReloadResult({ applied: true });
    const result = await h.runtime.pluginUninstall!({ pluginID });
    expect(result).toMatchObject({ uninstalled: true, pluginID });
    expect(existsSync(h.packageDir)).toBe(false);
    expect(
      (await loadNataliaLock(h.pluginStoreRoot)).plugins[pluginID],
    ).toBeUndefined();
    expect(h.applyCallCount()).toBe(1);
  } finally {
    await h.dispose();
  }
});

test("pluginInstall refuses while a turn is running and installs nothing", async () => {
  const h = await harness();
  try {
    h.setBlocked("runtime config cannot be applied while a turn is running");
    await expect(
      h.runtime.pluginInstall!({ spec: `${packageName}@1.2.3` }),
    ).rejects.toThrow(/turn is running/);
    // The store is untouched: no second package, no new lock entry.
    expect(existsSync(h.packageDir)).toBe(true);
    expect(
      Object.keys((await loadNataliaLock(h.pluginStoreRoot)).plugins),
    ).toEqual([pluginID]);
  } finally {
    await h.dispose();
  }
});

test("pluginSetEnabled refuses while a turn is running and writes no config", async () => {
  const h = await harness();
  try {
    const configPath = join(h.workspaceRoot, ".natalia", "config.json");
    expect(existsSync(configPath)).toBe(false);
    h.setBlocked("runtime config cannot be applied while a turn is running");
    await expect(
      h.runtime.pluginSetEnabled!({ pluginID, enabled: false }),
    ).rejects.toThrow(/turn is running/);
    // The guard runs before setPluginEnabled, so the enabled config is not
    // written for a turn that is still live.
    expect(existsSync(configPath)).toBe(false);
  } finally {
    await h.dispose();
  }
});

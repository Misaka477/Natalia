import { expect, test } from "bun:test";
import { realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  officialPluginStoreRoot,
  officialPluginWorkspace,
  removeOfficialPluginWorkspace,
  sharedPluginStoreRoot,
} from "../src/official-plugin-fixtures";

/**
 * The shared-install invariant: every workspace's store resolves the same
 * realpaths, so the ESM registry evaluates each official bundle once for
 * the whole test run instead of once per workspace.
 *
 * This is the memory fix's load-bearing fact. A plugin bundle inlines its
 * dependencies (zod, the config schemas) and the registry keys evaluations
 * by URL without releasing them, so per-workspace copies measured ~50MB
 * retained per test — the real-runtime files sat at 4GB with every
 * assertion green. If this test fails, that regression is back.
 */
test("every workspace's official plugins resolve to the shared install's realpaths", async () => {
  const first = await officialPluginWorkspace("natalia-shared-store-first");
  const second = await officialPluginWorkspace("natalia-shared-store-second");
  try {
    const firstStore = officialPluginStoreRoot(first.workspaceRoot);
    const secondStore = officialPluginStoreRoot(second.workspaceRoot);
    // The stores themselves stay per-workspace: separate locks, separate
    // markers, so which plugins load is still each workspace's own fact.
    expect(firstStore).not.toBe(secondStore);
    for (const store of [firstStore, secondStore]) {
      const lock = JSON.parse(
        await readFile(join(store, "natalia.lock"), "utf8"),
      ) as { plugins: Record<string, { manifest: string }> };
      const entries = Object.values(lock.plugins);
      expect(entries.length).toBeGreaterThan(0);
      // Each workspace's lock names its own store path, but the manifest
      // realpath — the URL the loader evaluates — lands in the shared
      // install for BOTH.
      for (const entry of entries)
        expect(await realpath(entry.manifest)).toContain(
          await realpath(sharedPluginStoreRoot),
        );
    }
    // The decisive pair: the same plugin, two workspaces, one realpath.
    const manifestFor = async (store: string) => {
      const lock = JSON.parse(
        await readFile(join(store, "natalia.lock"), "utf8"),
      ) as { plugins: Record<string, { manifest: string }> };
      const first = Object.values(lock.plugins)[0]!;
      return await realpath(first.manifest);
    };
    expect(await manifestFor(firstStore)).toBe(await manifestFor(secondStore));
  } finally {
    await removeOfficialPluginWorkspace(first.workspaceRoot);
    await removeOfficialPluginWorkspace(second.workspaceRoot);
  }
});

test("the shared install lives outside the hygiene guard's scan root", async () => {
  await officialPluginWorkspace("natalia-shared-store-hygiene");
  // dist/ts/client-test-workspaces is scanned for leftovers after a run;
  // a long-lived shared install inside it would fail that guard. The
  // workspace's own store is a sibling, which the guard's own suite covers.
  expect(sharedPluginStoreRoot).not.toContain(
    join("dist", "ts", "client-test-workspaces"),
  );
  expect(sharedPluginStoreRoot.startsWith(tmpdir())).toBe(false);
});

import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RETIRED_PLUGIN_PACKAGES,
  installPlugin,
  retiredPluginPackageReason,
  specPackageName,
} from "../src/index";
import type { PackageManagerRun } from "../src/index";

/**
 * The kill list (the gap matrix's T5 item, closed 2026-09-25 with REAL
 * entries): the two packages retired on 2026-09-02 (`72f42dd0`). The door
 * is `installPlugin`'s first act — a retired spec is refused before the
 * package manager runs, so a refusal leaves no trace (the spy below proves
 * it: zero runs, no lock written).
 */

test("the kill list names the two real takedowns", () => {
  expect(RETIRED_PLUGIN_PACKAGES.map((entry) => entry.packageName)).toEqual([
    "@natalia/plugin-task-module",
    "@natalia/plugin-task-workflow",
  ]);
});

test("a retired package is refused by name, bare or versioned", () => {
  for (const entry of RETIRED_PLUGIN_PACKAGES) {
    const reason = retiredPluginPackageReason(entry.packageName);
    expect(reason).toContain(entry.packageName);
    expect(reason).toContain("retired");
    // The version suffix must not smuggle a retired package past the door.
    expect(retiredPluginPackageReason(`${entry.packageName}@1.2.3`)).toBe(
      reason,
    );
  }
});

test("the refusal is narrow: officials and third parties pass", () => {
  // An official package is not on the kill list.
  expect(
    retiredPluginPackageReason("@natalia/plugin-tool-shell"),
  ).toBeUndefined();
  expect(
    retiredPluginPackageReason("@natalia/plugin-tool-shell@1.2.3"),
  ).toBeUndefined();
  // And neither is a genuine third-party package — the kill list kills
  // retired packages, not non-official ones.
  expect(retiredPluginPackageReason("@fixture/natalia-plugin")).toBeUndefined();
  expect(retiredPluginPackageReason("some-random-pkg")).toBeUndefined();
});

test("the spec's package name survives scoped and versioned forms", () => {
  expect(specPackageName("@scope/name")).toBe("@scope/name");
  expect(specPackageName("@scope/name@1.2.3")).toBe("@scope/name");
  expect(specPackageName("name@1.2.3")).toBe("name");
  expect(specPackageName("name")).toBe("name");
});

test("installPlugin refuses a retired spec before anything runs", async () => {
  const pluginStoreRoot = await mkdtemp(join(tmpdir(), "kill-list-"));
  const runs: string[][] = [];
  const runPackageManager: PackageManagerRun = async ({ args }) => {
    runs.push(args);
  };
  let thrown: unknown;
  try {
    await installPlugin({
      pluginStoreRoot,
      spec: "@natalia/plugin-task-module",
      runPackageManager,
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain(
    "@natalia/plugin-task-module was retired",
  );
  // No trace: the door answered before the package manager saw the spec.
  expect(runs).toEqual([]);
});

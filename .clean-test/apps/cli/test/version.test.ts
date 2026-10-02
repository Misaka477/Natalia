import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { NATALIA_VERSION, pickVersion } from "../src/version";

/**
 * D1 (install study): `natalia --version` 正确 — the acceptance for the
 * standalone-binary spike, at both levels: the version picker's rules, and
 * (when a release binary exists) the compiled artifact itself answering
 * from its versioned directory.
 */

const repoRoot = resolve(import.meta.dir, "../../..");
const pkgVersion = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    version: string;
  }
).version;

test("the baked value wins, then package.json, then dev", () => {
  expect(pickVersion("1.2.3", "9.9.9")).toBe("1.2.3");
  expect(pickVersion(undefined, "9.9.9")).toBe("9.9.9");
  expect(pickVersion(undefined, undefined)).toBe("dev");
});

test("a dev run reports the workspace's package version", () => {
  // Not baked here (the release define only exists in built bundles), so
  // the constant comes from package.json — --version in dev equals the
  // workspace the CLI runs from.
  expect(NATALIA_VERSION).toBe(pkgVersion);
});

test("the compiled release binary answers --version (gated on the build)", () => {
  const host =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "darwin"
        : `${process.platform}`;
  const binary = join(
    repoRoot,
    "dist",
    "release",
    pkgVersion,
    `${host}-${process.arch}`,
    "natalia",
  );
  if (!existsSyncLike(binary)) return; // fresh checkout: `npm run release:build` produces it
  const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(pkgVersion);
  // The manifest the D2 installer verifies exists and names this binary.
  const manifest = JSON.parse(
    readFileSync(
      join(
        repoRoot,
        "dist",
        "release",
        pkgVersion,
        `${host}-${process.arch}`,
        "manifest.json",
      ),
      "utf8",
    ),
  ) as { version: string; files: Array<{ file: string; sha256: string }> };
  expect(manifest.version).toBe(pkgVersion);
  const self = manifest.files.find((file) => file.file === "natalia");
  expect(self?.sha256).toMatch(/^[0-9a-f]{64}$/u);
});

function existsSyncLike(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

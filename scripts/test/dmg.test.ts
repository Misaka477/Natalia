import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDmgStaging, dmgStagingIsReady } from "../dmg";

/**
 * The staging layout a Mac user drags an app out of.
 *
 * The `Applications` symlink is the whole point: an image that mounts, shows the
 * app, and offers nowhere to drag it is a worse experience than no image at all.
 * These pins are what keep that one line from being lost.
 */

async function fakeRelease() {
  const root = await mkdtemp(join(tmpdir(), "natalia-dmg-release-"));
  await mkdir(join(root, "libcef-bin"), { recursive: true });
  await mkdir(join(root, "resources"), { recursive: true });
  await writeFile(join(root, "natalia-cef-desktop"), "#!/bin/sh\n");
  await writeFile(join(root, "natalia"), "rt\n");
  await writeFile(join(root, "libcef-bin", "libcef.dylib"), "lib\n");
  await writeFile(join(root, "resources", "plugin.js"), "");
  await writeFile(join(root, "SHA256SUMS"), "abc\n");
  return root;
}

test("the staging root holds the app and the drop target", async () => {
  const release = await fakeRelease();
  const out = await mkdtemp(join(tmpdir(), "natalia-dmg-"));
  const result = await buildDmgStaging({
    releaseDir: release,
    outDir: out,
    version: "9.9.9",
  });

  // The bundle is IN the staging root, not beside it: an image built from the
  // bundle's own directory would mount empty.
  expect(existsSync(join(result.stagingDir, "Natalia.app"))).toBe(true);
  expect(
    existsSync(
      join(result.stagingDir, "Natalia.app", "Contents", "Info.plist"),
    ),
  ).toBe(true);
  // The drop target, and it is a SYMLINK — a directory copy of /Applications
  // would be empty on the user's machine and the drag would silently no-op.
  expect(lstatSync(result.applicationsLink).isSymbolicLink()).toBe(true);
  expect(await dmgStagingIsReady(result.stagingDir)).toBe(true);
});

test("the release's bookkeeping never reaches the staged image", async () => {
  // A disk image containing install.sh tells the user they should run something;
  // that is the thing a normal application must never require.
  const release = await fakeRelease();
  const out = await mkdtemp(join(tmpdir(), "natalia-dmg-"));
  const result = await buildDmgStaging({ releaseDir: release, outDir: out });
  expect(existsSync(join(result.stagingDir, "SHA256SUMS"))).toBe(false);
  expect(existsSync(join(result.stagingDir, "install.sh"))).toBe(false);
  // And exactly one app, so the image mounts with one drag source.
  const bundles = await Array.fromAsync(
    new Bun.Glob("*.app").scan({ cwd: result.stagingDir, onlyFiles: false }),
  );
  expect(bundles).toEqual(["Natalia.app"]);
});

test("a staging directory missing its drop target is not ready", async () => {
  const out = await mkdtemp(join(tmpdir(), "natalia-dmg-"));
  expect(await dmgStagingIsReady(join(out, "does-not-exist"))).toBe(false);
  // An app with nowhere to drag it.
  const bare = join(out, "staging");
  await mkdir(join(bare, "Natalia.app", "Contents"), { recursive: true });
  expect(await dmgStagingIsReady(bare)).toBe(false);
});

test("hdiutil is macOS-only, so a non-Mac builder stages rather than fails", async () => {
  // On this host the image cannot be produced; that must not be an error, and the
  // staging layout must still be complete enough for a Mac to finish the job.
  const release = await fakeRelease();
  const out = await mkdtemp(join(tmpdir(), "natalia-dmg-"));
  const result = await buildDmgStaging({ releaseDir: release, outDir: out });
  if (Bun.which("hdiutil") === null) {
    expect(result.packed).toBe(false);
    expect(result.dmgPath).toBeUndefined();
    expect(await dmgStagingIsReady(result.stagingDir)).toBe(true);
  }
});

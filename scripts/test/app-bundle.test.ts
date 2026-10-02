import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAppBundle,
  bundleIsLaunchable,
  readInfoPlist,
} from "../app-bundle";

/**
 * The bundle's identity, and the fact that it launches.
 *
 * A macOS `.app` is a directory with a fixed shape, and two of its three files
 * are what the release never carries: `Info.plist` (the identity Launch Services
 * reads) and an `.icns` in Resources. Without the plist the bundle looks like an
 * application and behaves like a folder — the Finder shows a folder icon and
 * double-clicking lists files. These pins are what keep that from shipping.
 */

async function fakeRelease(extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "natalia-darwin-release-"));
  await mkdir(join(root, "libcef-bin"), { recursive: true });
  await mkdir(join(root, "resources"), { recursive: true });
  await writeFile(join(root, "natalia-cef-desktop"), "cef\n");
  await writeFile(join(root, "natalia"), "runtime\n");
  await writeFile(join(root, "libcef-bin", "libcef.dylib"), "lib\n");
  await writeFile(join(root, "resources", "plugin.js"), "");
  await writeFile(join(root, "composition.base.json"), "{}\n");
  await writeFile(join(root, "SHA256SUMS"), "abc\n");
  await writeFile(join(root, "install.sh"), "#!/bin/sh\n");
  for (const [name, text] of Object.entries(extra))
    await writeFile(join(root, name), text);
  return root;
}

test("the bundle carries the three parts a working .app needs", async () => {
  const release = await fakeRelease();
  const out = await mkdtemp(join(tmpdir(), "natalia-appbundle-"));
  const result = await buildAppBundle({ releaseDir: release, outDir: out });

  // The fixed shape: Info.plist, MacOS/<executable>, Resources.
  expect(existsSync(result.infoPlist)).toBe(true);
  expect(existsSync(join(result.macOsDir, "natalia-cef-desktop"))).toBe(true);
  expect(existsSync(result.resourcesDir)).toBe(true);
  // The declared executable is real — a bundle whose Info.plist names a missing
  // binary is a folder wearing a bundle's clothes.
  expect(await bundleIsLaunchable(result.bundleDir)).toBe(true);
});

test("Info.plist states the identity the Finder and Launch Services read", async () => {
  const release = await fakeRelease();
  const out = await mkdtemp(join(tmpdir(), "natalia-appbundle-"));
  const result = await buildAppBundle({
    releaseDir: release,
    outDir: out,
    bundleId: "sh.natalia.desktop",
    version: "9.9.9",
  });
  const plist = await readInfoPlist(result.infoPlist);
  // CFBundleExecutable must be the file in MacOS; CFBundleIconFile names the icns
  // in Resources. Either one wrong is the "looks like an app, acts like a folder"
  // failure.
  expect(plist["CFBundleExecutable"]).toBe("natalia-cef-desktop");
  expect(plist["CFBundleIconFile"]).toBe("AppIcon");
  expect(plist["CFBundleIdentifier"]).toBe("sh.natalia.desktop");
  expect(plist["CFBundlePackageType"]).toBe("APPL");
  expect(plist["CFBundleShortVersionString"]).toBe("9.9.9");
  // A GUI app must not be marked background-only, or it never shows a window.
  expect(plist["LSBackgroundOnly"]).toBe("false");
});

test("the executables are executable and the release's bookkeeping stays out", async () => {
  const release = await fakeRelease();
  const out = await mkdtemp(join(tmpdir(), "natalia-appbundle-"));
  const result = await buildAppBundle({ releaseDir: release, outDir: out });
  // A checksum manifest and the shell installers must not land inside a bundle
  // any more than inside an AppDir: their presence implies the user should run
  // something.
  expect(existsSync(join(result.resourcesDir, "SHA256SUMS"))).toBe(false);
  expect(existsSync(join(result.resourcesDir, "install.sh"))).toBe(false);
  // The app's data does belong there.
  expect(existsSync(join(result.resourcesDir, "resources"))).toBe(true);
  expect(existsSync(join(result.resourcesDir, "composition.base.json"))).toBe(
    true,
  );
  const { statSync } = await import("node:fs");
  const mode = statSync(join(result.macOsDir, "natalia-cef-desktop")).mode;
  expect(mode & 0o111).toBe(0o111);
});

test("the icon ships as the iconset iconutil consumes", async () => {
  const release = await fakeRelease();
  const out = await mkdtemp(join(tmpdir(), "natalia-appbundle-"));
  const icons = await mkdtemp(join(tmpdir(), "natalia-appicons-"));
  await writeFile(join(icons, "icon-1024.png"), "png");
  const result = await buildAppBundle({
    releaseDir: release,
    outDir: out,
    icon: join(icons, "icon-1024.png"),
  });
  // The named siblings iconutil looks for, at the sizes an icns carries.
  expect(result.iconSetDir).toBeDefined();
  for (const size of [16, 32, 64, 128, 256, 512, 1024])
    expect(
      existsSync(join(result.iconSetDir!, `icon_${size}x${size}.png`)),
      `missing ${size}`,
    ).toBe(true);
  // iconutil is macOS-only, so on a Linux builder the iconset is the deliverable
  // and the absence of an icns is expected, not a failure.
  if (existsSync(join(result.resourcesDir, "AppIcon.icns")))
    expect(result.icns).toBeDefined();
});

test("a directory that is not a release is refused before writing anything", async () => {
  const empty = await mkdtemp(join(tmpdir(), "natalia-not-a-release-"));
  const out = await mkdtemp(join(tmpdir(), "natalia-appbundle-"));
  let threw = "";
  try {
    await buildAppBundle({ releaseDir: empty, outDir: out });
  } catch (error) {
    threw = String(error);
  }
  expect(threw).toContain("does not look like a release directory");
  // Nothing was written.
  expect(existsSync(join(out, "Natalia.app"))).toBe(false);
});

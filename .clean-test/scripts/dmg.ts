/**
 * The macOS disk image.
 *
 * A `.dmg` is the container a Mac user drags an app out of, and its staging
 * layout is what makes that work:
 *
 *   Natalia.app            the bundle
 *   Applications -> /Applications   the drop target
 *
 * The symlink is not decoration. Without it the image mounts, shows the app, and
 * offers nowhere to drag it — the user has to know to copy to `/Applications`
 * themselves. With it, the Finder's own drag-to-install works and most users
 * never touch a path.
 *
 * `hdiutil` is how macOS builds a real UDIF image, and it is macOS-only. Every
 * other builder produces the staging directory, which is the part a Mac needs
 * and the part this file can verify; the image compression itself degrades to
 * "staged, compress on a Mac" rather than failing, exactly like `iconutil` for
 * the bundle's icns.
 */
import { existsSync, lstatSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildAppBundle, type AppBundleResult } from "./app-bundle";

export type DmgOptions = {
  /** The release directory the bundle is built from. */
  releaseDir: string;
  /** Where to write the staging directory and the .dmg. */
  outDir: string;
  appName?: string;
  version?: string;
  icon?: string;
  /** An already-built bundle, to skip rebuilding it. */
  bundle?: AppBundleResult;
};

export type DmgResult = {
  /** The staging directory a real image is created from. */
  stagingDir: string;
  appPath: string;
  /** The `Applications` symlink users drag onto. */
  applicationsLink: string;
  dmgPath?: string;
  /** True when the image itself was produced here (macOS only). */
  packed: boolean;
};

/**
 * Build the staging directory a macOS disk image is made from.
 *
 * `hdiutil` — which creates the real UDIF image — runs only on macOS, so on any
 * other builder this returns the staged layout and leaves the compression to a
 * Mac (the same degradation as the bundle's icns). The symlink is absolute
 * because that is what the Finder resolves when the user drags onto it.
 */
export async function buildDmgStaging(options: DmgOptions): Promise<DmgResult> {
  const outDir = resolve(options.outDir);
  const appName = options.appName ?? "Natalia";
  const version = options.version ?? "0.0.0";
  const stagingDir = join(outDir, "dmg-root");
  const appPath = join(stagingDir, `${appName}.app`);
  const applicationsLink = join(stagingDir, "Applications");
  const dmgPath = join(outDir, `${appName}-${version}.dmg`);

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  const bundle =
    options.bundle ??
    (await buildAppBundle({
      releaseDir: options.releaseDir,
      outDir,
      appName,
      version,
      icon: options.icon,
    }));

  // Move the built bundle into the staging root.
  await rm(appPath, { recursive: true, force: true });
  const { rename, cp } = await import("node:fs/promises");
  try {
    await rename(bundle.bundleDir, appPath);
  } catch {
    // A cross-device rename (a temp dir on another filesystem) needs a copy.
    await cp(bundle.bundleDir, appPath, { recursive: true });
  }

  // The drop target. Absolute, so dragging onto it copies to the real place.
  await rm(applicationsLink, { force: true });
  await symlink("/Applications", applicationsLink, "dir");

  const packed = await createImage(stagingDir, dmgPath);
  return {
    stagingDir,
    appPath,
    applicationsLink,
    dmgPath: packed ? dmgPath : undefined,
    packed,
  };
}

/** Create the UDIF image with `hdiutil`, when this host has it. */
async function createImage(
  stagingDir: string,
  dmgPath: string,
): Promise<boolean> {
  const tool = Bun.which("hdiutil");
  if (!tool) return false;
  await rm(dmgPath, { force: true });
  const run = Bun.spawnSync(
    [
      tool,
      "create",
      "-volname",
      "Natalia",
      "-srcfolder",
      stagingDir,
      "-ov",
      "-format",
      "UDZO",
      dmgPath,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  return run.exitCode === 0;
}

/** True when a staging directory is ready for a Mac to image. */
export async function dmgStagingIsReady(stagingDir: string): Promise<boolean> {
  if (!existsSync(stagingDir)) return false;
  // The app and the drop target: an image without either one mounts and offers
  // the user nothing to do. The drop target is checked with lstat, NOT exists:
  // `existsSync` FOLLOWS the symlink, and `/Applications` does not exist on the
  // machine building the image — it exists on the Mac the user drags onto. A
  // Linux builder must not report its own staging directory as broken because a
  // macOS path is absent.
  if (!lstatSync(join(stagingDir, "Applications"), { throwIfNoEntry: false }))
    return false;
  const bundles = await Array.fromAsync(
    new Bun.Glob("*.app").scan({ cwd: stagingDir, onlyFiles: false }),
  );
  return bundles.length === 1;
}

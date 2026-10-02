/**
 * The Linux portable bundle: a tarball a user downloads, extracts and runs.
 *
 * The AppDir `build-appimage.ts` produces is a complete, runnable application — a
 * valid `.desktop` entry, the icon at nine sizes, the CEF host, its runtime, the
 * web shell, and an `AppRun` that sets the library path and hands off to a running
 * instance. What it is not is a single file. `appimagetool` would make it one, and
 * that tool needs `/dev/fuse` or `libgpgme.so.11` — measured absent on the Linux
 * workspace this was written on, so a single-file artifact could not be produced
 * there at all.
 *
 * So this is the alternative that CAN be produced and verified end to end: a
 * `.tar.gz` of the AppDir. Extract it anywhere, run `AppDir/AppRun`, and the
 * application starts with no install and no command line. The entry and the icon
 * ship inside it, so a user who wants a menu icon gets the two `cp` lines printed
 * rather than having to read this file — "extract and run" and "install into the
 * menu" are different intents and both are ordinary.
 *
 * Execute bits are asserted, not hoped for: a tarball preserves whatever mode the
 * source had, and an `AppRun` without its execute bit extracts into an application
 * that cannot start — a failure that would surface at the user's first
 * double-click instead of here.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { buildAppImage } from "./appimage";

const root = resolve(import.meta.dir, "..");
const HOST_TRIPLE = "linux-x64";
// Injectable so the packer can be driven against a synthetic tree (which is how
// the mode-repair path was measured); the default is the workspace a CI run
// invokes it from.
const workspace = process.env.NATALIA_PACKAGE_ROOT ?? root;

/** What must be executable inside a runnable bundle. */
const EXECUTABLES = [
  "AppRun",
  "natalia-cef-desktop",
  "natalia",
  "libcef.so",
  "libEGL.so",
  "libGLESv2.so",
];

function findIcon(): string | undefined {
  for (const candidate of [
    join(root, "assets", "icons", "icon.png"),
    join(root, "assets", "icons", "icon-1024.png"),
  ])
    if (existsSync(candidate)) return candidate;
  return undefined;
}

async function main(): Promise<number> {
  const requested = process.argv[2];
  const releaseDir = requested
    ? join(workspace, "dist", "release", requested, HOST_TRIPLE)
    : await latestRelease();
  if (!releaseDir || !existsSync(join(releaseDir, "natalia"))) {
    console.error(
      `[bundle] no packable release for ${HOST_TRIPLE}. Run \`npm run release:build\` first.`,
    );
    return 1;
  }
  const appVersion = versionOf(releaseDir);
  const outDir = join(workspace, "dist", "appimage", appVersion);
  const appDir = join(outDir, "AppDir");

  // Build the AppDir if something else has not already (a release alone is not
  // runnable — it needs the entry, the icon and the launcher).
  if (!existsSync(join(appDir, "AppRun"))) {
    await mkdir(outDir, { recursive: true });
    await buildAppImage({
      releaseDir,
      outDir,
      icon: findIcon(),
      version: appVersion,
    });
  }
  if (!existsSync(join(appDir, "AppRun"))) {
    console.error(
      `[bundle] no AppDir at ${appDir}; run \`npm run appimage\` first`,
    );
    return 1;
  }

  // Assert the execute bits BEFORE tarring.
  let repaired = 0;
  for (const name of EXECUTABLES) {
    const path = join(appDir, name);
    if (!existsSync(path)) continue;
    if (((await stat(path)).mode & 0o111) === 0) {
      console.error(
        `[bundle] ${name} is not executable; repairing before packing`,
      );
      await chmod(path, 0o755);
      repaired += 1;
    }
  }

  const target = join(
    workspace,
    "dist",
    `Natalia-${appVersion}-linux-x64.tar.gz`,
  );
  await Bun.$`rm -f ${target}`.quiet();
  await Bun.$`tar -czf ${target} -C ${dirname(appDir)} ${basename(appDir)}`.quiet();
  const { size } = await stat(target);

  console.log(
    `[bundle] ${target} (${(size / 1024 / 1024).toFixed(0)} MiB${repaired ? `, ${repaired} mode(s) repaired` : ""})`,
  );
  console.log(`[bundle] extract and run:`);
  console.log(`    tar -xzf Natalia-${appVersion}-linux-x64.tar.gz`);
  console.log(`    ./AppDir/AppRun`);
  console.log(`[bundle] or install into the menu:`);
  console.log(`    cp -r AppDir ~/.local/share/natalia`);
  console.log(`    cp AppDir/natalia.desktop ~/.local/share/applications/`);
  console.log(`    cp AppDir/natalia*.png ~/.local/share/icons/`);
  return 0;
}

/** The most recent release directory for this host. */
async function latestRelease(): Promise<string | undefined> {
  const base = join(workspace, "dist", "release");
  if (!existsSync(base)) return undefined;
  const candidates: string[] = [];
  for await (const version of new Bun.Glob("*/").scan({
    cwd: base,
    onlyFiles: false,
  })) {
    const dir = join(base, version, HOST_TRIPLE);
    if (existsSync(join(dir, "natalia"))) candidates.push(dir);
  }
  candidates.sort();
  return candidates.at(-1);
}

function versionOf(releaseDir: string): string {
  const parts = releaseDir.split("/");
  const index = parts.lastIndexOf(HOST_TRIPLE);
  return index > 0 ? parts[index - 1]! : "0.0.0";
}

process.exit(await main());

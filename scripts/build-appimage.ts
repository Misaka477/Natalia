/**
 * Build the installable Linux image from whatever release directory exists.
 *
 * A release directory is a directory of files; this turns it into what a user's
 * launcher understands: an AppDir with a `.desktop` entry, an `AppRun` that
 * starts the bundled CEF binary with its own libraries first, and the release's
 * own icon when one is available. The final `.AppImage` is a squashfs of that
 * directory, produced by `appimagetool` when it is on PATH — the AppDir itself
 * is the useful artifact (it installs, it runs, it is what a .deb/.rpm would
 * contain), so a missing optional tool degrades to "AppDir built, image not
 * packed" rather than failing the build.
 *
 * The user never runs a command: this is a build step, its output is the
 * installable.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildAppImage, isPackableRelease } from "./appimage";

const root = resolve(import.meta.dir, "..");

/** Where `release:build` leaves its output for this host. */
const HOST_TRIPLE = "linux-x64";

function versionFromRelease(releaseDir: string): string {
  // The layout is dist/release/<version>/<triple>, so the version is the
  // directory two levels up.
  const parts = releaseDir.split("/");
  const index = parts.lastIndexOf(HOST_TRIPLE);
  if (index > 0) return parts[index - 1]!;
  return "0.0.0";
}

/** An icon the release (or the repo) can offer, preferring the branded one. */
function findIcon(): string | undefined {
  const candidates = [
    join(root, "assets", "icons", "icon.png"),
    join(root, "assets", "icon.png"),
    join(root, "assets", "icons", "icon.png"),
    join(root, "apps", "cef-desktop", "assets", "icon.png"),
    join(root, "apps", "web", "public", "icon.png"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function main(): Promise<number> {
  const version = process.argv[2];
  const releaseDir = version
    ? join(root, "dist", "release", version, HOST_TRIPLE)
    : await newestRelease();
  if (!releaseDir || !(await isPackableRelease(releaseDir))) {
    console.error(
      `[appimage] no packable release for ${HOST_TRIPLE}. Run \`npm run release:build\` first.`,
    );
    return 1;
  }

  const appVersion = versionFromRelease(releaseDir);
  const outDir = join(root, "dist", "appimage", appVersion);
  const result = await buildAppImage({
    releaseDir,
    outDir,
    icon: findIcon(),
    version: appVersion,
  });
  console.log(
    `[appimage] AppDir ready at ${result.appDir}\n` +
      `[appimage]   desktop entry: ${result.desktopEntry}\n` +
      `[appimage]   launcher:       ${result.appRun}\n` +
      (result.icon
        ? `[appimage]   icon:           ${result.icon}\n`
        : "[appimage]   (no icon shipped — the repo has none to offer; the entry resolves to the launcher's generic mark)\n"),
  );

  // Packing needs appimagetool, which is an optional download. Degrade rather
  // than fail: the AppDir is installable and runnable as-is.
  // The tool may live in .tools/ (where `npm run appimage:fetch` puts it) rather
  // than on PATH — a build host that fetched it once should not have to export
  // anything.
  const tool =
    Bun.which("appimagetool") ??
    (existsSync(join(root, ".tools", "appimagetool"))
      ? join(root, ".tools", "appimagetool")
      : undefined);
  if (!tool) {
    // NOT "optional": the AppDir installs, but the single file a user
    // double-clicks is what this step exists to make. Say what is missing and
    // what produces it, rather than reporting success.
    console.error(
      "[appimage] appimagetool is not available, so no .AppImage was produced. " +
        "The AppDir above is complete and installable, but it is not the " +
        "single-file artifact a user double-clicks.\n" +
        "  fix: npm run appimage:fetch   (then re-run npm run appimage)",
    );
    return 0;
  }
  const imagePath = join(outDir, `Natalia-${appVersion}-x86_64.AppImage`);
  const packed = Bun.spawnSync(
    [tool, "--no-appstream", result.appDir, imagePath],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (packed.exitCode !== 0) {
    // appimagetool is a FUSE AppImage itself, and it links libgpgme.so.11 (an ABI
    // this repository's build hosts do not all carry). Measured on the Linux
    // workspace that produced the AppDir: it downloads and unpacks, then dies on
    // the missing library — so the failure is the host's, not the AppDir's.
    console.error(
      `[appimage] appimagetool failed (exit ${packed.exitCode}). The AppDir is ` +
        `complete and installable as-is; packing it needs a host with ` +
        `/dev/fuse (to run the AppImage) or libgpgme.so.11 (to run the ` +
        `extracted binary).`,
    );
    return 1;
  }
  console.log(`[appimage] image: ${imagePath}`);
  return 0;
}

/** The most recent release directory this host can pack. */
async function newestRelease(): Promise<string | undefined> {
  const base = join(root, "dist", "release");
  if (!existsSync(base)) return undefined;
  const candidates: string[] = [];
  for await (const version of new Bun.Glob("*/").scan({
    cwd: base,
    onlyFiles: false,
  })) {
    const dir = join(base, version, HOST_TRIPLE);
    if (existsSync(dir)) candidates.push(dir);
  }
  // Newest by version, falling back to the last one seen.
  candidates.sort();
  return candidates.at(-1);
}

process.exit(await main());

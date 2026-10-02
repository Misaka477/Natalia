/**
 * Build the installable macOS application from whatever release directory exists.
 *
 * A `.app` is a directory with a fixed shape, and `Info.plist` is the file that
 * makes it an application rather than a folder: it names the executable Launch
 * Services runs, the icon to show, the bundle identity, and the schemes the app
 * claims. This script writes that, lays out Contents/MacOS and
 * Contents/Resources, and leaves the `.icns` to `iconutil` when it is present
 * (it is macOS-only, so on any other builder the iconset it consumes is the
 * deliverable and the bundle still builds).
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildAppBundle } from "./app-bundle";

const root = resolve(import.meta.dir, "..");
const HOST_TRIPLE = "darwin-arm64";

function findIcon(): string | undefined {
  const candidates = [
    join(root, "assets", "icons", "icon-1024.png"),
    join(root, "assets", "icons", "icon.png"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function main(): Promise<number> {
  const version = process.argv[2];
  const releaseDir = version
    ? join(root, "dist", "release", version, HOST_TRIPLE)
    : await newestRelease();
  if (!releaseDir || !existsSync(join(releaseDir, "natalia-cef-desktop"))) {
    console.error(
      `[appbundle] no packable release for ${HOST_TRIPLE}. Run \`npm run release:build\` for this target first.`,
    );
    return 1;
  }

  const appVersion = versionFromRelease(releaseDir);
  const outDir = join(root, "dist", "appbundle", appVersion);
  const icon = findIcon();
  const result = await buildAppBundle({
    releaseDir,
    outDir,
    icon,
    version: appVersion,
  });
  console.log(
    `[appbundle] bundle ready at ${result.bundleDir}\n` +
      `[appbundle]   identity:    ${result.infoPlist}\n` +
      (result.icns
        ? `[appbundle]   icon:        ${result.icns}\n`
        : result.iconSetDir
          ? `[appbundle]   iconset:     ${result.iconSetDir} (iconutil is macOS-only; pack it on a Mac)\n`
          : `[appbundle]   (no icon found in the repo — the bundle ships without one)\n`),
  );
  return 0;
}

function versionFromRelease(releaseDir: string): string {
  const parts = releaseDir.split("/");
  const index = parts.lastIndexOf(HOST_TRIPLE);
  if (index > 0) return parts[index - 1]!;
  return "0.0.0";
}

/** The most recent release directory for this host. */
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
  candidates.sort();
  return candidates.at(-1);
}

process.exit(await main());

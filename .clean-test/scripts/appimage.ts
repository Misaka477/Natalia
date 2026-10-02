/**
 * The Linux AppImage bundle.
 *
 * A release directory is not yet an application a user can install: it is a
 * directory of files, and Linux's desktop integration needs three things it
 * does not have — a `.desktop` entry so the launcher can list it, an icon, and
 * an `AppRun` that is the executable the entry points at. AppImage is just a
 * squashfs of an AppDir whose shape the desktop already understands.
 *
 * The AppDir layout (this is what the spec calls "the AppDir"):
 *
 *   natalia-cef-desktop        the CEF window
 *   natalia                    the compiled runtime (bun --compile)
 *   natalia-gui, natalia-mux-server   wezterm's per-platform natives
 *   libcef.so, *.pak, locales, …      the CEF runtime it loads
 *   resources/                 dist/ts: plugins, plugin store, assets
 *   natalia.desktop            the launcher entry
 *   natalia.png                the icon, from the existing assets
 *
 * `AppRun` is a tiny shell shim that puts the AppDir first on PATH and
 * LD_LIBRARY_PATH and starts the CEF binary, because CEF resolves its resources
 * relative to the executable. The single-instance lock lives in the user's state
 * root, so two launches of the AppImage hand off rather than double-start.
 */
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type AppImageOptions = {
  /** The release directory (`dist/release/<version>/linux-x64`). */
  releaseDir: string;
  /** Where to write the AppDir and the .AppImage. */
  outDir: string;
  /** The app's displayed name. */
  appName?: string;
  /** The desktop entry's identifier (also the icon/stem name). */
  id?: string;
  /** The version, for the file name and the entry. */
  version?: string;
  /** An existing PNG to ship as the icon; absent means no icon is shipped. */
  icon?: string;
  /** The packaged bun executable name, when the release ships one. */
  bunName?: string;
};

export type AppImageResult = {
  appDir: string;
  desktopEntry: string;
  appRun: string;
  icon?: string;
  /** Everything the desktop entry declares, for the installer to inspect. */
  entry: {
    name: string;
    exec: string;
    icon: string;
    terminal: boolean;
    categories: "Development;";
  };
};

const DEFAULT_NAME = "Natalia";
const DEFAULT_ID = "natalia";

/** The CEF binary and the compiled runtime keep their release names. */
const CEF_BINARY = "natalia-cef-desktop";
const RUNTIME_BINARY = "natalia";

/** Files the desktop never wants in an installable image. */
const EXCLUDED_TOP_LEVEL = new Set([
  "SHA256SUMS",
  "SHA256SUMS.asc",
  "install.sh",
  "install.sh.sha256",
  "install.ps1",
]);

export async function buildAppImage(
  options: AppImageOptions,
): Promise<AppImageResult> {
  const releaseDir = resolve(options.releaseDir);
  const outDir = resolve(options.outDir);
  const appName = options.appName ?? DEFAULT_NAME;
  const id = options.id ?? DEFAULT_ID;
  const version = options.version ?? "0.0.0";
  const appDir = join(outDir, "AppDir");

  if (!existsSync(releaseDir))
    throw new Error(`no release directory at ${releaseDir}`);
  for (const required of [
    join(releaseDir, CEF_BINARY),
    join(releaseDir, RUNTIME_BINARY),
  ])
    if (!existsSync(required))
      throw new Error(
        `${releaseDir} does not look like a release directory: ${required} is missing`,
      );

  await rm(appDir, { recursive: true, force: true });
  await mkdir(appDir, { recursive: true });

  // The release root's files land at the AppDir's root, minus the release
  // bookkeeping (a checksum file and the shell installers are meaningless
  // inside an image, and `install.sh`'s presence would suggest the user should
  // run something).
  const entries = await readdir(releaseDir);
  for (const entry of entries) {
    if (EXCLUDED_TOP_LEVEL.has(entry)) continue;
    await cp(join(releaseDir, entry), join(appDir, entry), { recursive: true });
  }

  // The desktop entry. `StartupWMClass` matches the CEF window's class so the
  // running window dedupes against the launcher's entry instead of showing a
  // second icon while the app is open.
  const entry = {
    name: appName,
    // AppRun, not the app's own name. `Exec=<name>` makes the launcher search
    // PATH for a binary of that name; the executable the entry must name is the
    // bundle's own launcher, which is what the desktop is actually pointed at.
    exec: "AppRun",
    icon: id,
    terminal: false,
    // ONE main category: `desktop-file-validate` warns that several make the
    // app appear more than once in the application menu.
    categories: "Development;",
  };
  const desktopPath = join(appDir, `${id}.desktop`);
  await writeFile(
    desktopPath,
    `[Desktop Entry]
Type=Application
# The spec version, NOT the app's: the freedesktop entry's Version key is the
# version of the Desktop Entry Specification it follows, and the validator
# rejects an application version there (a "9.9.9-test" reads as an unknown spec).
Version=1.0
Name=${entry.name}
Exec=${entry.exec}
TryExec=${entry.exec}
Icon=${entry.icon}
Terminal=${String(entry.terminal)}
Categories=${entry.categories}
StartupWMClass=${id}
Comment=The Natalia desktop workspace
`,
    "utf8",
  );

  // AppRun: the executable the entry points at. Everything it does is what a
  // normal install would have done for the user — set the library path, make
  // the bundled binaries reachable, hand off if another instance is running.
  const appRunPath = join(appDir, "AppRun");
  await writeFile(
    appRunPath,
    `#!/bin/sh
# Generated by scripts/build-appimage.ts — do not edit.
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HERE:$PATH"
export LD_LIBRARY_PATH="$HERE:$HERE/lib:$HERE/bin:$HERE/lib64:\${LD_LIBRARY_PATH:-}"
export NATALIA_APPIMAGE=1
exec "$HERE/${CEF_BINARY}" --url="\${NATALIA_CEF_URL:-http://127.0.0.1:5178/}" "$@"
`,
    "utf8",
  );
  await chmod(appRunPath, 0o755);

  // The icon. An entry whose Icon names a file with no size suffix is what the
  // desktop looks up, so the shipped copy carries the entry's own name; the
  // sized siblings beside it let the shell pick a bitmap instead of scaling the
  // one it found. Without any of them the app shows the launcher's generic
  // "unknown application" mark, which is the difference between an installed app
  // and a file that happens to have a launcher entry.
  let iconPath: string | undefined;
  if (options.icon) {
    iconPath = join(appDir, `${id}.png`);
    await cp(resolve(options.icon), iconPath);
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
      const sibling = join(dirname(resolve(options.icon)), `icon-${size}.png`);
      if (existsSync(sibling))
        await cp(sibling, join(appDir, `${id}-${size}.png`));
    }
  }

  // The executables must be executable inside the image.
  for (const name of [CEF_BINARY, RUNTIME_BINARY])
    if (existsSync(join(appDir, name))) await chmod(join(appDir, name), 0o755);

  return {
    appDir,
    desktopEntry: desktopPath,
    appRun: appRunPath,
    icon: iconPath,
    entry,
  };
}

/** Read the desktop entry back, the way a launcher (or a test) would. */
export async function readDesktopEntry(
  path: string,
): Promise<Record<string, string>> {
  const text = await readFile(path, "utf8");
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z0-9-]+)=(.*)$/u.exec(line.trim());
    if (match) fields[match[1]!] = match[2]!;
  }
  return fields;
}

/** True when a release directory looks like one this bundler can pack. */
export async function isPackableRelease(releaseDir: string): Promise<boolean> {
  return (
    existsSync(join(releaseDir, CEF_BINARY)) &&
    existsSync(join(releaseDir, RUNTIME_BINARY))
  );
}

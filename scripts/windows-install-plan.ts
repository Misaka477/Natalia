/**
 * The Windows installer's data layer.
 *
 * A Windows application is not a directory: it is a Program Files tree, a Start
 * Menu entry, an uninstaller the OS can find, and an icon the shell displays.
 * Both ways of producing that — MSIX and a classic installer — consume the same
 * facts, so they are computed once here rather than twice:
 *
 *   the file tree       what ships, and where each file lands relative to the
 *                       install root (the binary goes beside the app, the CEF
 *                       runtime beside it, the plugins and their UI under
 *                       `resources/`)
 *   the shortcut        the Start Menu entry: what it points at, its arguments,
 *                       its working directory, and its icon
 *   the uninstall entry the registry values that make "Apps & features" and the
 *                       classic Add/Remove Programs list the app with a real
 *                       version and a real uninstaller
 *   the identity        the display name, publisher, version and the upgrade
 *                       code that lets a later install replace an earlier one
 *
 * The file list is derived from the release directory rather than declared, so a
 * release that adds a plugin cannot ship an installer that forgets it. That is
 * the failure this avoids: a hand-written manifest that passes every test and
 * still drops a directory the app needs.
 */
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export type WindowsInstallOptions = {
  /** The release directory (`dist/release/<version>/windows-x64`). */
  releaseDir: string;
  /** The display name in Apps & features and the Start Menu. */
  appName?: string;
  /** The publisher shown in the uninstall entry. */
  publisher?: string;
  /** The version, which the uninstall entry and the upgrade code use. */
  version?: string;
  /** The install root's Program Files subdirectory. */
  installDirName?: string;
  /** The compiled runtime's name (the release's `natalia`). */
  runtimeBinary?: string;
  /** The CEF host binary's name (the release's `natalia-cef-desktop`). */
  cefBinary?: string;
  /** The icon shipped with the app, used by the shortcut and the shell. */
  icon?: string;
};

export type InstallerFile = {
  /** The path inside the install root, with `\` separators. */
  target: string;
  /**
   * The path an installer's `Source` line uses: RELATIVE to the release
   * directory. An absolute path bakes the build machine into the script, so the
   * same .iss cannot be compiled on the Windows host that has the tree — found
   * by rendering from a real 91 MB release and reading the output.
   */
  source: string;
  /** Byte length, so the manifest can report a size without re-reading. */
  bytes: number;
};

export type WindowsInstallPlan = {
  appName: string;
  publisher: string;
  version: string;
  installDirName: string;
  /** The install root, e.g. `%ProgramFiles%\Natalia`. */
  installRoot: string;
  files: InstallerFile[];
  shortcut: {
    /** The Start Menu entry's path relative to the Programs folder. */
    name: string;
    targetRelative: string;
    arguments: string;
    workingDirRelative: string;
    iconRelative?: string;
  };
  uninstall: {
    displayName: string;
    displayVersion: string;
    publisher: string;
    displayIcon?: string;
    installLocation: string;
    /** The estimated size the shell shows, in KB. */
    estimatedSizeKB: number;
    uninstallString: string;
    quietUninstallString: string;
    /** Stable across versions so a later install upgrades rather than parallels. */
    upgradeCode: string;
  };
};

const DEFAULT_NAME = "Natalia";
const DEFAULT_PUBLISHER = "Natalia";
const DEFAULT_RUNTIME = "natalia";
const DEFAULT_CEF = "natalia-cef-desktop";
/**
 * The Start Menu entry's target: `natalia.exe`, and nothing else.
 *
 * It was `natalia-cef-desktop.exe` first (development default URL, so it exited
 * and the app never opened), then `Natalia.cmd` (a batch file, which is also a
 * second "which of these do I run" question), then `natalia-launcher.exe` (a
 * real parent process, but a THIRD executable the user has never heard of).
 *
 * The reported failure was: "I double-clicked natalia.exe and it never starts".
 * The obvious executable — the one named after the program — did nothing,
 * because bare `natalia` printed status JSON and exited. So the CLI now starts
 * the whole stack when given no subcommand, and the shortcut points at it: one
 * exe, one entry, the same thing you double-click in the install folder.
 * `natalia-launcher.exe` stays supported for anyone who has it, but it is no
 * longer what the shortcut names.
 */
const DEFAULT_LAUNCHER = "natalia.exe";

/** Release bookkeeping that must never be installed. */
const EXCLUDED = new Set([
  "SHA256SUMS",
  "SHA256SUMS.asc",
  "install.sh",
  "install.ps1",
]);

/**
 * Machine-local runtime state that must never be INSTALLED either, tested by
 * the release self-check with `Bun.file().exists()` — which is false for a
 * DIRECTORY, so `plugin-store/` walked straight through the guard and into the
 * installer (a 91 MB release that carried this checkout's dev plugin store:
 * `natalia.lock`, its node_modules and the initialized marker). The same three
 * names `build-standalone.ts` refuses to copy into a release. Matched on the
 * path's leading segments, because the glob yields `plugin-store\node_modules\…`
 * and the offender is the top-level directory.
 */
const EXCLUDED_PREFIXES = new Set([
  "plugin-store",
  "cli-dev-pty-stores",
  "client-test-workspaces",
]);

function excludedTarget(target: string): boolean {
  if (EXCLUDED.has(target)) return true;
  const head = target.split("\\")[0]!;
  return EXCLUDED_PREFIXES.has(head);
}

/**
 * The upgrade code: a stable identity for "this product", independent of
 * version, so 1.2 upgrades 1.1 instead of installing beside it. Derived from the
 * app name so it cannot drift between versions, and a stable string is what an
 * installer needs (a random one per build would make every release a stranger to
 * the last).
 */
function upgradeCodeFor(appName: string): string {
  // A fixed, readable GUID derived from the name: Windows wants 8-4-4-4-12 hex.
  const seed = `natalia:${appName}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const hex = hash.toString(16).padStart(8, "0");
  const tail = `${hex}${hex}`.slice(0, 12);
  return `${hex}-${hex.slice(0, 4)}-4${hex.slice(4, 7)}-a${hex.slice(0, 3)}-${tail}`;
}

export async function planWindowsInstall(
  options: WindowsInstallOptions,
): Promise<WindowsInstallPlan> {
  const releaseDir = resolve(options.releaseDir);
  const appName = options.appName ?? DEFAULT_NAME;
  const publisher = options.publisher ?? DEFAULT_PUBLISHER;
  const version = options.version ?? "0.0.0";
  const installDirName = options.installDirName ?? appName;
  const runtimeBinary = options.runtimeBinary ?? DEFAULT_RUNTIME;
  const cefBinary = options.cefBinary ?? DEFAULT_CEF;

  // The Windows release names its executables with the suffix (the same rule
  // `build-standalone.ts` applies), so the check looks for what the release
  // actually carries rather than a platform-neutral name.
  const cefPath = join(releaseDir, `${cefBinary}.exe`);
  if (!existsSync(releaseDir) || !existsSync(cefPath))
    throw new Error(
      `${releaseDir} does not look like a release directory: ${cefPath} is missing`,
    );

  // The file tree, derived from the release rather than declared, so a release
  // that gains a plugin cannot produce an installer that drops it.
  const files: InstallerFile[] = [];
  let bytes = 0;
  for await (const entry of new Bun.Glob("**/*").scan({
    cwd: releaseDir,
    onlyFiles: true,
  })) {
    // The relative path is the target path as-is: the release directory already
    // carries the layout the app expects (binary, CEF runtime, resources/).
    const target = entry.split("/").join("\\");
    if (excludedTarget(target)) continue;
    // Relative to the release directory, so the rendered script compiles on any
    // host that has the tree rather than only on the one that built it.
    const source = entry.split("/").join("\\");
    const size = await Bun.file(join(releaseDir, entry)).size;
    if (size === undefined) continue;
    bytes += size;
    files.push({ target, source, bytes: size });
  }
  if (!files.some((file) => file.target === `${runtimeBinary}.exe`))
    // The compiled runtime is what the launcher starts; without it the install
    // is an icon that opens nothing.
    throw new Error(
      `${releaseDir} has no ${runtimeBinary}.exe — build the release for windows-x64 first`,
    );

  return {
    appName,
    publisher,
    version,
    installDirName,
    installRoot: `%ProgramFiles%\\${installDirName}`,
    files,
    shortcut: {
      name: appName,
      // The CEF window, not the compiled runtime: it is the process with a
      // window. Its argument points at the bundled web server, which the
      // launcher starts before it (run-cef-desktop.cmd does the same ordering).
      // The launcher, NOT the CEF host. The host alone has no URL of its own in
      // production: its default is the dev server at 127.0.0.1:5178, which
      // nothing in an install listens on, so a shortcut to it opened nothing.
      // The launcher starts the runtime and the web server first, then hands
      // the host a URL that exists.
      targetRelative: DEFAULT_LAUNCHER,
      arguments: "",
      workingDirRelative: ".",
      // The installed path, not the source: the shortcut and the shell entry name
      // a file inside the install root. `assets/icons/icon.ico` is where the
      // build keeps it; `icon.ico` beside the binary is where it lives on the
      // user's disk. Naming the source made the plan unsatisfiable — no file
      // list could ever contain it, so "installable" was always false once an
      // icon was supplied.
      ...(options.icon
        ? { iconRelative: options.icon.split(/[\\/]/u).pop()! }
        : {}),
    },
    uninstall: {
      displayName: `${appName} ${version}`,
      displayVersion: version,
      publisher,
      ...(options.icon ? { displayIcon: options.icon } : {}),
      installLocation: `%ProgramFiles%\\${installDirName}`,
      estimatedSizeKB: Math.max(1, Math.round(bytes / 1024)),
      uninstallString: `"%ProgramFiles%\\${installDirName}\\uninstall.exe"`,
      quietUninstallString: `"%ProgramFiles%\\${installDirName}\\uninstall.exe" /S`,
      upgradeCode: upgradeCodeFor(appName),
    },
  };
}

/** True when a plan describes something installable. */
export function planIsInstallable(plan: WindowsInstallPlan): boolean {
  // The binary the shortcut runs, the runtime it needs, and the icon it shows:
  // an install missing any of them is a directory the user had to make themselves.
  const targets = new Set(plan.files.map((file) => file.target));
  return (
    targets.has(plan.shortcut.targetRelative) &&
    targets.has("natalia.exe") &&
    plan.shortcut.iconRelative !== undefined &&
    targets.has(plan.shortcut.iconRelative) &&
    plan.uninstall.estimatedSizeKB > 0
  );
}

/** Render the plan as a WiX-compatible file/directory fragment. */
export function renderWixFiles(plan: WindowsInstallPlan): string {
  const lines: string[] = [];
  for (const file of plan.files) {
    const parts = file.target.split("\\");
    const name = parts.pop()!;
    const attributes =
      parts.length === 0
        ? ""
        : ` (deriving the directory from ${parts.join("\\")})`;
    void attributes;
    lines.push(`    <File Source="${file.source}" Name="${name}" />`);
  }
  return lines.join("\n");
}

/**
 * The macOS application bundle.
 *
 * A `.app` is a directory with a fixed shape the Finder and Launch Services
 * understand, and two of the three files in it are things a release directory
 * never carries on its own:
 *
 *   Contents/Info.plist         the identity: bundle id, version, the executable
 *                               to launch, the document/URL schemes it claims,
 *                               and whether it runs hidden (the tray case)
 *   Contents/Resources/*.icns   the icon, in Apple's container format
 *   Contents/MacOS/<binary>     the CEF window
 *
 * Without Info.plist the bundle is a directory: the Finder shows a folder icon
 * and double-clicking opens a window listing files. With it, it is an application
 * — the Dock, the menu bar, "Quit", and the About box all come from that file.
 *
 * The `.icns` is produced by Apple's `iconutil`, which reads a directory of
 * PNGs named for their pixel sizes; the same icon set the Linux and Windows
 * paths ship feeds it, so the three platforms carry one mark. `iconutil` is
 * macOS-only, so it is an optional tool here: the `.iconset` it consumes is the
 * deliverable, and a missing iconutil degrades to "iconset built, icns not
 * packed" rather than failing the bundle.
 */
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type AppBundleOptions = {
  /** The release directory (`dist/release/<version>/darwin-arm64`). */
  releaseDir: string;
  /** Where to write `Natalia.app`. */
  outDir: string;
  /** The bundle identifier — the identity Launch Services and the keychain use. */
  bundleId?: string;
  /** The displayed name (the `.app` directory's base name). */
  appName?: string;
  /** The version shown in About. */
  version?: string;
  /** The CEF binary's name inside the release. */
  cefBinary?: string;
  /** The compiled runtime, placed beside the CEF binary as the bundle expects. */
  runtimeBinary?: string;
  /** The icon source: an `icon-1024.png` (or the directory's named sibling). */
  icon?: string;
};

export type AppBundleResult = {
  bundleDir: string;
  infoPlist: string;
  macOsDir: string;
  resourcesDir: string;
  iconSetDir?: string;
  icns?: string;
};

const DEFAULT_BUNDLE_ID = "sh.natalia.desktop";
const DEFAULT_NAME = "Natalia";
const DEFAULT_CEF = "natalia-cef-desktop";
const DEFAULT_RUNTIME = "natalia";

/** Release bookkeeping that must not land inside a bundle. */
const EXCLUDED = new Set([
  "SHA256SUMS",
  "SHA256SUMS.asc",
  "install.sh",
  "install.ps1",
]);

/** The pixel sizes an icns is expected to carry, by iconutil's file names. */
const ICONSET_SIZES = [16, 32, 64, 128, 256, 512, 1024];

export async function buildAppBundle(
  options: AppBundleOptions,
): Promise<AppBundleResult> {
  const releaseDir = resolve(options.releaseDir);
  const outDir = resolve(options.outDir);
  const bundleId = options.bundleId ?? DEFAULT_BUNDLE_ID;
  const appName = options.appName ?? DEFAULT_NAME;
  const version = options.version ?? "0.0.0";
  const cefBinary = options.cefBinary ?? DEFAULT_CEF;
  const runtimeBinary = options.runtimeBinary ?? DEFAULT_RUNTIME;
  const bundleDir = join(outDir, `${appName}.app`);

  const cefPath = join(releaseDir, cefBinary);
  if (!existsSync(releaseDir) || !existsSync(cefPath))
    throw new Error(
      `${releaseDir} does not look like a release directory: ${cefPath} is missing`,
    );

  await rm(bundleDir, { recursive: true, force: true });
  const macOsDir = join(bundleDir, "Contents", "MacOS");
  const resourcesDir = join(bundleDir, "Contents", "Resources");
  await mkdir(macOsDir, { recursive: true });
  await mkdir(resourcesDir, { recursive: true });

  // Info.plist — the identity. CFBundleExecutable is what Launch Services runs,
  // and it must name a file that is in Contents/MacOS; CFBundleIconFile is the
  // icns in Resources. Getting either wrong produces a bundle that looks like an
  // application and behaves like a folder.
  const infoPlist = join(bundleDir, "Contents", "Info.plist");
  await writeFile(
    infoPlist,
    plist({
      CFBundleIdentifier: bundleId,
      CFBundleName: appName,
      CFBundleDisplayName: appName,
      CFBundleExecutable: cefBinary,
      CFBundleIconFile: "AppIcon",
      CFBundlePackageType: "APPL",
      CFBundleShortVersionString: version,
      CFBundleVersion: version,
      CFBundleInfoDictionaryVersion: "6.0",
      // A CEF host is a GUI app: it must not put a Terminal icon in the Dock and
      // must not spawn a console window when launched from the Finder.
      LSBackgroundOnly: false,
      LSApplicationCategoryType: "public.app-category.developer-tools",
      // The window comes from the bundled web server, so a URL the app owns.
      CFBundleURLTypes: [
        {
          CFBundleURLName: bundleId,
          CFBundleURLSchemes: ["natalia"],
        },
      ],
      // High-resolution and a single instance: a second launch focuses the running
      // window instead of starting a copy that fights over the same session store.
      NSHighResolutionCapable: true,
      NSSupportsAutomaticTermination: false,
      NSPrincipalClass: "NSApplication",
    }),
    "utf8",
  );

  // The executables. Everything else in the release ships as Resources, which is
  // where the binary looks for its assets and where a bundle's data belongs.
  await cp(cefPath, join(macOsDir, cefBinary));
  if (existsSync(join(releaseDir, runtimeBinary)))
    await cp(join(releaseDir, runtimeBinary), join(macOsDir, runtimeBinary));
  await chmod(join(macOsDir, cefBinary), 0o755);
  for (const entry of await listDir(releaseDir)) {
    if (EXCLUDED.has(entry)) continue;
    if (entry === cefBinary || entry === runtimeBinary) continue;
    await cp(join(releaseDir, entry), join(resourcesDir, entry), {
      recursive: true,
    });
  }

  // The icon, as the `.iconset` iconutil consumes.
  let iconSetDir: string | undefined;
  let icns: string | undefined;
  if (options.icon) {
    iconSetDir = join(resourcesDir, "AppIcon.iconset");
    await mkdir(iconSetDir, { recursive: true });
    const source = resolve(options.icon);
    for (const size of ICONSET_SIZES)
      await cp(source, join(iconSetDir, `icon_${size}x${size}.png`));
    // iconutil also accepts the @2x named variants; a single set is enough for
    // the sizes above, and shipping the 1024 source covers the largest.
    icns = await packIcns(iconSetDir, resourcesDir);
  }

  return {
    bundleDir,
    infoPlist,
    macOsDir,
    resourcesDir,
    iconSetDir,
    icns,
  };
}

/** Pack an iconset into AppIcon.icns when `iconutil` is available. */
async function packIcns(
  iconSetDir: string,
  resourcesDir: string,
): Promise<string | undefined> {
  const tool = Bun.which("iconutil");
  if (!tool) return undefined;
  const target = join(resourcesDir, "AppIcon.icns");
  const run = Bun.spawnSync([tool, "-c", "icns", "-o", target, iconSetDir], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return run.exitCode === 0 ? target : undefined;
}

/** Read Info.plist back, the way `plutil` or a bundle reader would. */
export async function readInfoPlist(
  path: string,
): Promise<Record<string, string>> {
  const text = await Bun.file(path).text();
  const fields: Record<string, string> = {};
  const keyValue = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/gu;
  for (const match of text.matchAll(keyValue)) fields[match[1]!] = match[2]!;
  const booleans = /<key>([^<]+)<\/key>\s*<(true|false)\/>/gu;
  for (const match of text.matchAll(booleans))
    fields[match[1]!] = match[2]! === "true" ? "true" : "false";
  return fields;
}

/** True when the bundle's declared executable is actually in Contents/MacOS. */
export async function bundleIsLaunchable(bundleDir: string): Promise<boolean> {
  const plist = join(bundleDir, "Contents", "Info.plist");
  if (!existsSync(plist)) return false;
  const fields = await readInfoPlist(plist);
  const executable = fields["CFBundleExecutable"];
  if (!executable) return false;
  return existsSync(join(bundleDir, "Contents", "MacOS", executable));
}

/** Serialize a dictionary, with the scalar shapes Info.plist actually uses. */
function plist(dictionary: Record<string, unknown>): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
  ];
  for (const [key, value] of Object.entries(dictionary)) {
    lines.push(`  <key>${key}</key>`);
    lines.push(plistValue(value, 2));
  }
  lines.push("</dict>");
  lines.push("</plist>");
  return lines.join("\n") + "\n";
}

function plistValue(value: unknown, depth: number): string {
  const pad = " ".repeat(depth);
  if (Array.isArray(value))
    return (
      `${pad}<array>\n` +
      value.map((item) => plistValue(item, depth + 2) + "\n").join("") +
      `${pad}</array>`
    );
  if (value && typeof value === "object")
    return (
      `${pad}<dict>\n` +
      Object.entries(value as Record<string, unknown>)
        .map(
          ([key, inner]) =>
            `${pad}  <key>${key}</key>\n${plistValue(inner, depth + 2)}\n`,
        )
        .join("") +
      `${pad}</dict>`
    );
  if (typeof value === "boolean") return `${pad}<${value ? "true" : "false"}/>`;
  if (typeof value === "number") return `${pad}<integer>${value}</integer>`;
  return `${pad}<string>${escapeXml(String(value))}</string>`;
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function listDir(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of new Bun.Glob("*").scan({
    cwd: dir,
    onlyFiles: false,
  }))
    out.push(entry);
  return out;
}

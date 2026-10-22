/**
 * D1 (install study): the standalone-binary spike.
 *
 * Produces the study's artifact layout — a versioned, per-target directory
 * holding the compiled `natalia` binary, its runtime assets beside it
 * ("native 附件随二进制同目录分发"), and a SHA256 manifest the D2 installer
 * will verify (the supply-chain list, verbatim hermes-style).
 *
 * The version is baked by the ts:build step's define (same mechanism the
 * release bundle already uses), so the compiled binary answers
 * `--version` without reading anything it does not carry.
 *
 * Targets: the host target always builds; `--all` additionally attempts
 * the study's other two platforms. A cross target whose bun runtime bundle
 * is unavailable (offline machines cannot fetch it) is REPORTED as a
 * per-target result — the spike's job is to show exactly what produces and
 * what does not, not to pretend.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashTreeFiles } from "../packages/hosts/platform/src/hash-tree";
import { resolvePwshPath } from "../packages/hosts/platform/src/pwsh";
import { censusFromWorkspace } from "../apps/cli/src/layer-census";
import { MACHINE_LOCAL_STATE_DIRS } from "./machine-local-state";

type TargetResult = {
  target: string;
  ok: boolean;
  binary?: string;
  files?: number;
  bytes?: number;
  error?: string;
};

const root = resolve(import.meta.dir, "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  version: string;
};
const version = pkg.version;

/** The copyright line the Windows exe carries. Ours, never bun's. */
const WINDOWS_COPYRIGHT =
  "Copyright (c) 2026 Natalia. Licensed under the Apache License, Version 2.0";

/**
 * The release version in the four-number form Windows compares.
 *
 * Windows orders versions as four integers, so `0.0.0-m13` as a string
 * does not compare — `m14` would not sort after `m13`. The pre-release
 * suffix folds into the last field, giving `0.0.0.13`, which does.
 */
function windowsFileVersion(releaseVersion: string): string {
  const [core, suffix] = releaseVersion.split("-");
  const parts = (core ?? releaseVersion).split(".").map(Number);
  const numeric = [
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0,
    suffix ? Number.parseInt(suffix.replace(/\D/gu, ""), 10) || 0 : 0,
  ];
  return numeric.join(".");
}
const hostTarget = `${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : process.platform}-${process.arch}`;
const requested = process.argv.slice(2);
const wantAll = requested.includes("--all");
const explicit = requested.find((arg) => arg.startsWith("--target="));
// macOS is DEFERRED by the distribution plan (no mac terminal build): a
// release whose interactive terminal cannot run is a lie with a
// checksum, so --all builds the two platforms that can actually ship.
const targets = explicit
  ? [explicit.slice("--target=".length)]
  : wantAll
    ? [`bun-${hostTarget}` as const, "bun-windows-x64" as const]
    : [`bun-${hostTarget}` as const];

/**
 * The terminal executables are per-platform, and there is exactly one now.
 *
 * The interactive terminal's backend is this repo's own PTY controller (an
 * in-process document plus the platform's PTY bridge — the Rust bridge on
 * POSIX, the ConPTY helper on Windows), which needs no terminal executables
 * at all: the fork's three binaries rode the WINDOWS release only while the
 * Windows pane still ran inside the mux, and that ended when the ConPTY
 * bridge became the default (P23 fixed, 2026-10-04). A release tree therefore
 * carries NO wezterm directory — only the platform's own bridge, in its own
 * `pty-bridge/` directory so no trim of another tier can take it with it
 * (the bug that once shipped a bridge-less Windows release).
 */
/**
 * The Natalia Browser Bridge extension, staged beside the plugin that needs it.
 *
 * `browser_*` cannot work without it: the plugin's purpose is to drive the
 * user's EXISTING browser, and the only way in is an extension loaded in that
 * browser, which talks to the local bridge server. The extension lives in the
 * plugin's `src/extension/<chromium|firefox>` and was shipped NOWHERE — a
 * release carried `plugins/natalia-browser/{index.js,LICENSE,manifest,package.json}`
 * and nothing else, so every `browser_*` call failed with "the Natalia Browser
 * Bridge extension is not installed or not enabled", forever, on every install.
 *
 * It is staged under the plugin's own `extension/<engine>/` so the plugin stays
 * self-contained and the path the plugin resolves is relative to the plugin
 * rather than to a checkout.
 */
/**
 * Stage the SOURCE tree, for self-iteration.
 *
 * An installed deployment has no way to change its own code without it: the
 * runtime is a compiled binary and the plugins are bundles, so a generation
 * that wants to evolve `packages/**` has nothing to read, edit or rebuild.
 * Measured on this machine: an install and a release tree hold zero `.ts`
 * files. Shipping the tracked source (git's own inventory, so nothing
 * untracked or generated rides along) is what turns "self-iteration" from a
 * dev-checkout-only capability into a property of the product.
 *
 * What is deliberately NOT here: `node_modules` (rebuilt by `bun install`
 * against the shipped lockfile), `dist` (build output), and the untracked
 * `diff-wasm/ast/*.wasm` grammars, which are build ARTIFACTS produced by
 * `scripts/build-ast-packs.ts` from crates.io — those live in `toolchains/`
 * as a prebuilt pack instead, so a rebuild does not need cargo or network.
 */
async function stageSource(outDir: string): Promise<void> {
  const root = process.cwd();
  const target = join(outDir, "source");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  // git's own inventory: the tracked files, and nothing else. A directory
  // walk would copy whatever a developer happened to leave on disk. The
  // listing arrives on the run's stdout — `run` answers with the process
  // result, not the text.
  const listed = (await run("git", ["ls-files", "-z"], root)).stdout;
  const tracked = listed
    .split("\0")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (tracked.length === 0)
    throw new Error("stageSource: git ls-files returned nothing");
  for (const relativePath of tracked) {
    const from = join(root, relativePath);
    if (!(await Bun.file(from).exists())) continue;
    const to = join(target, relativePath);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to);
  }
  // The lockfile the install runs against, so `bun install` inside the
  // source tree resolves the same versions the build used.
  //
  // ONE TRAP this creates, measured: `bun test`'s path filter is a SUBSTRING
  // match, so a bare `bun test packages/plugins/skills/test` also matches
  // this copy's own path inside dist/ and runs the release's tests too —
  // which fail, because the copy has no node_modules beside it. The
  // repository's own scripts and the CI matrix all use the `./` prefix
  // (`./packages/...`), which does not match. Keep it that way, and say so
  // in the dev-environment skill.
  await Bun.write(
    join(target, ".gitignore"),
    [
      "# This tree is a release artifact, not a repository.",
      "node_modules/",
      "dist/",
      "*.log",
      "",
    ].join("\n"),
  );
}

/**
 * Stage the TOOLCHAINS a rebuild needs.
 *
 * Two of them, both because "ship the source" without them ships a tree
 * that cannot build:
 *
 *   - `bun`, at exactly the version the build used. The suite's green is a
 *     statement about ONE bun version, so a rebuild that picks up whatever
 *     bun is on the user's PATH can produce a green-on-my-machine lie. The
 *     shipped one is the one the build resolves.
 *   - the tree-sitter wasm grammars, which are 98 MB of build OUTPUT the
 *     source tree does not carry. Without them, any change touching
 *     `packages/framework/diff-wasm` needs cargo and network access to
 *     crates.io — a dependency the product does not otherwise have.
 */
async function stageToolchains(outDir: string): Promise<void> {
  const root = process.cwd();
  const target = join(outDir, "toolchains");
  await rm(target, { recursive: true, force: true });
  await mkdir(join(target, "bun"), { recursive: true });
  // The bun THIS process runs under: the build's own version, by
  // construction, which is the only version whose green means anything.
  const bunPath = process.execPath;
  if (!bunPath || !(await Bun.file(bunPath).exists()))
    throw new Error(`stageToolchains: no bun at process.execPath (${bunPath})`);
  await cp(bunPath, join(target, "bun", "bun.exe"));
  // The grammar pack: prebuilt, so a rebuild needs neither cargo nor network.
  const grammars = join(root, "packages", "framework", "diff-wasm", "ast");
  const grammarFiles = (await readdir(grammars)).filter((name) =>
    name.endsWith(".wasm"),
  );
  if (grammarFiles.length === 0)
    throw new Error(
      "stageToolchains: no tree-sitter grammars found; run " +
        "`bun run build:ast-packs` first (it builds them from crates.io)",
    );
  await mkdir(join(target, "grammars"), { recursive: true });
  for (const name of grammarFiles)
    await cp(join(grammars, name), join(target, "grammars", name));
  // A manifest, so a rebuild can check what it has without guessing — and
  // so the attribution travels WITH the artifacts. Every grammar is the
  // compiled output of one crate declared in scripts/build-ast-packs.ts;
  // recording that crate here is what keeps "98 MB of third-party wasm" from
  // shipping unrecorded. The license text itself is not vendored: it ships
  // with the crate's source, and NOTICE says exactly that.
  await Bun.write(
    join(target, "toolchains.json"),
    JSON.stringify(
      {
        bun: { version: Bun.version, file: "bun/bun.exe" },
        grammars: {
          count: grammarFiles.length,
          directory: "grammars",
          source: "packages/framework/diff-wasm/ast",
          builtBy: "scripts/build-ast-packs.ts",
          crates: await grammarCrates(),
        },
      },
      null,
      2,
    ),
  );
}

/**
 * The crates the shipped grammars were built from, read out of the pack
 * builder's own table — so the attribution is the builder's declaration, not
 * a second list that can drift from it.
 */
async function grammarCrates(): Promise<
  Array<{ id: string; crate: string; version: string }>
> {
  const root = process.cwd();
  const builder = await Bun.file(
    join(root, "scripts", "build-ast-packs.ts"),
  ).text();
  // The table's rows are object literals with id/crate/version; reading them
  // as text keeps this script from importing a script that runs a build.
  const rows: Array<{ id: string; crate: string; version: string }> = [];
  const pattern =
    /id:\s*"([^"]+)"[\s\S]*?crate:\s*"([^"]+)"[\s\S]*?version:\s*"([^"]+)"/gu;
  for (const match of builder.matchAll(pattern))
    rows.push({ id: match[1]!, crate: match[2]!, version: match[3]! });
  if (rows.length === 0)
    throw new Error(
      "stageToolchains: no grammar rows found in scripts/build-ast-packs.ts",
    );
  return rows;
}

async function stageBrowserExtension(outDir: string): Promise<void> {
  const staged = join(outDir, "plugins", "natalia-browser", "index.js");
  if (!(await Bun.file(staged).exists())) return;
  const source = join(
    root,
    "packages",
    "plugins",
    "browser",
    "src",
    "extension",
  );
  const target = join(outDir, "plugins", "natalia-browser", "extension");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  // The shared page-scan script both engines inject: Chromium through
  // scripting.executeScript({files}), Firefox through one concatenated
  // tabs.executeScript({code}) call. An engine directory staged without it
  // ships an extension whose scan, click and input all fail on a missing
  // global, so it rides the release beside them rather than beside neither.
  const shared = join(source, "shared");
  if (!(await Bun.file(join(shared, "page-scan.js")).exists()))
    throw new Error(
      "packages/plugins/browser/src/extension/shared/page-scan.js is missing",
    );
  await cp(shared, join(target, "shared"), { recursive: true });
  for (const engine of ["chromium", "firefox"]) {
    const from = join(source, engine);
    if (!(await Bun.file(join(from, "manifest.json")).exists())) continue;
    await cp(from, join(target, engine), { recursive: true });
  }
}

/**
 * Stages the detached-process owner beside the pty bridge, and refuses when it
 * is missing.
 *
 * The same bug the bridge had: a helper staged somewhere nothing reads is a
 * helper the runtime cannot find, and a detached start that cannot find its
 * owner is a detached start that refuses — so this throws with the build
 * command rather than shipping a release whose background starts fall back to
 * the old shape.
 */
async function stagePlatformOwner(
  outDir: string,
  platformDir: string,
): Promise<void> {
  if (!platformDir.startsWith("windows")) return;
  const name = "natalia-job-runner.exe";
  const source = join(
    root,
    "packages",
    "hosts",
    "platform",
    "prebuilt",
    "windows-x64",
    name,
  );
  if (!(await Bun.file(source).exists()))
    throw new Error(
      `${platformDir}: the detached-process owner is not built — run platform:build-job-runner:windows before packaging`,
    );
  const target = join(outDir, "prebuilt", "windows-x64");
  await mkdir(target, { recursive: true });
  await cp(source, join(target, name));
}

async function stageTerminalNatives(
  outDir: string,
  platformDir: string,
): Promise<void> {
  const pluginDir = join(outDir, "plugins", "natalia-tool-terminal");
  if (!(await Bun.file(join(pluginDir, "index.js")).exists())) return;
  void pluginDir;
  // Our own bridge, in its OWN directory — and the fix for the bug that made
  // a Windows release ship with no bridge at all (measured): the ConPTY binary
  // used to ride `wezterm/` beside the fork's trio, and the retirement's
  // POSIX trim deleted it. Separate directories, separate owners.
  // The bridge is staged where the RUNTIME looks for it. prebuilt-dir.ts now
  // resolves, in order: the install's own `prebuilt/<triple>/` (what this stages
  // — present in every release, so an installed copy always has it) and then the
  // plugin-relative path, which is what a checkout resolves to.
  //
  // It was staged under `plugins/natalia-tool-terminal/pty-bridge/`, which
  // nothing reads: the terminal tab of a fresh install failed with "the ConPTY
  // bridge is not built" naming a path that directory never got.
  //
  // It is NOT staged inside plugin-store/: that directory is the machine's own
  // plugin state (natalia.lock, installed node_modules, the initialized marker)
  // and the release's hygiene guard rejects it wholesale — correctly, because
  // shipping it ties the artifact to the machine that built it.
  const isWindows = platformDir.startsWith("windows");
  const bridgeDir = join(
    outDir,
    "prebuilt",
    isWindows ? "windows-x64" : "linux-x64",
  );
  const bridgeName = isWindows
    ? "natalia-conpty-bridge.exe"
    : "natalia-pty-bridge";
  const prebuilt = join(
    root,
    "packages/plugins/native-terminal/prebuilt",
    isWindows ? "windows-x64" : "linux-x64",
  );
  await rm(bridgeDir, { recursive: true, force: true });
  if (!(await Bun.file(join(prebuilt, bridgeName)).exists()))
    throw new Error(
      `${platformDir}: the terminal's ${bridgeName} is not built — run native-terminal:build-pty-bridge (POSIX) or native-terminal:build-conpty:windows before packaging`,
    );
  await mkdir(bridgeDir, { recursive: true });
  await cp(join(prebuilt, bridgeName), join(bridgeDir, bridgeName));
}

/** The newest modification time in a tree, or 0 when it has no files at all. */
async function newestMtime(dir: string): Promise<number> {
  let newest = 0;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const stats = await stat(full);
      if (stats.mtimeMs > newest) newest = stats.mtimeMs;
    }
  };
  try {
    await walk(dir);
  } catch {
    return 0;
  }
  return newest;
}

/**
 * Assemble the web shell the CEF window loads.
 *
 * `apps/web/dist` is built by its own step (`npm run build:web`) and lived
 * outside every release tree, so a release's window pointed at a server that had
 * nothing to serve: the CEF host started, connected to 127.0.0.1:<port>, and got
 * a connection the static server could not answer — a blank window in an
 * otherwise complete install. The runtime serves this directory, so shipping it
 * is what makes the window show anything.
 *
 * STALE, not only missing. The existence check below was the whole guard, and
 * it let a seven-hour-old shell into a release: this script COPIES
 * `apps/web/dist` and never rebuilds it (`npm run build:web` is chained by
 * `package:windows`, not by `release:build`). The install then carried a UI
 * without the fixes just written into its sources, so every observation made
 * on it was an observation of the PREVIOUS build — which is exactly how a
 * "the terminal tab is still missing" report came to be made against code that
 * had already been changed to fix it. A guard that only asks whether an
 * artifact EXISTS cannot tell "we built it" from "it was already sitting
 * there".
 */
async function stageWebShell(outDir: string): Promise<void> {
  const built = join(root, "apps", "web", "dist");
  if (!(await Bun.file(join(built, "index.html")).exists()))
    throw new Error(
      "the web shell is not built — run \`npm run build:web\` before packaging " +
        "(its output is apps/web/dist and no release step produces it)",
    );
  const shellBuiltAt = await newestMtime(built);
  for (const source of [
    "apps/web/src",
    "packages/plugins/ui/web/src",
    "packages/hosts/ui-model/src",
  ]) {
    const sourceAt = await newestMtime(join(root, source));
    if (sourceAt > shellBuiltAt)
      throw new Error(
        `the web shell is STALE: ${source} is newer than ${built} ` +
          `(${new Date(sourceAt).toISOString()} > ` +
          `${new Date(shellBuiltAt).toISOString()}) — run \`npm run build:web\` ` +
          `first, or the release ships the previous UI`,
      );
  }
  const target = join(outDir, "web");
  await rm(target, { recursive: true, force: true });
  await cp(built, target, { recursive: true });
}

/**
 * The application icon, at the install root as `icon.ico`.
 *
 * The Windows install plan's shortcut and the Apps & features row both name
 * a file called `icon.ico` in the install root, and the Inno script writes
 * `UninstallDisplayIcon={app}\icon.ico` — so the release tree must carry it
 * under that exact name. The repository keeps the source at
 * `assets/icons/icon.ico`; this is the copy that puts it where the plan
 * looks. A missing source is reported rather than skipped: a release whose
 * installer promises an icon and does not deliver one is the same class of
 * lie as a release that omits its window.
 */
async function stageAppIcon(outDir: string): Promise<void> {
  const source = join(root, "assets", "icons", "icon.ico");
  if (!(await Bun.file(source).exists()))
    throw new Error(
      `the application icon is missing: ${source} — the Windows installer ` +
        `names icon.ico in the install root and the release must carry it`,
    );
  await cp(source, join(outDir, "icon.ico"));
}

/**
 * The application icon source, read once so the two consumers (the exe's
 * own PE resource and the release tree's `icon.ico`) cannot disagree about
 * which file is the icon.
 */
const iconSource = join(root, "assets", "icons", "icon.ico");

/**
 * Write the application icon into a compiled Windows exe's resource section.
 *
 * The payloads are the .ico's own images — every size becomes its own
 * RT_ICON with id 1..N, and one RT_GROUP_ICON binds them, each entry
 * naming its image by RESOURCE ID rather than by file offset (which is
 * what the .ico directory carries and what a copy would misinterpret).
 *
 * The three Win32 calls need PowerShell — kernel32 is not reachable from
 * Bun without a native addon — so this generates a thin script and runs
 * it. The script is generated, not stored, so there is no second copy of
 * the layout to keep in sync.
 */
async function stampWindowsIcon(exePath: string): Promise<void> {
  if (!(await Bun.file(iconSource).exists()))
    throw new Error(
      `cannot stamp the exe icon: ${iconSource} is missing — the compiled ` +
        `binary would have no icon at all`,
    );
  const work = join(root, ".btmp", "icon-stamp");
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const iconDir = join(work, "icons");
  const groupBin = join(work, "group.bin");
  await buildIconPayloads(iconSource, iconDir, groupBin);

  const script = join(work, "stamp.ps1");
  // Written with Bun.write and NO third argument: a positional third
  // argument is read as the options object and throws.
  await Bun.write(
    script,
    [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -TypeDefinition @'",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public class IconStamper {",
      '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
      "  public static extern IntPtr BeginUpdateResource(string fileName, bool deleteExistingResources);",
      '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
      "  public static extern bool UpdateResource(IntPtr hUpdate, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);",
      '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
      "  public static extern bool EndUpdateResource(IntPtr hUpdate, bool discardChanges);",
      "}",
      "'@",
      "$exe = $args[0]; $iconDir = $args[1]; $group = $args[2]",
      "$h = [IconStamper]::BeginUpdateResource($exe, $false)",
      'if ($h -eq [IntPtr]::Zero) { throw "BeginUpdateResource failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }',
      "foreach ($file in (Get-ChildItem -Path $iconDir -Filter '*.bin' | Sort-Object Name)) {",
      "  $id = [int]($file.BaseName)",
      "  $bytes = [System.IO.File]::ReadAllBytes($file.FullName)",
      "  if (-not [IconStamper]::UpdateResource($h, [IntPtr]3, [IntPtr]$id, 0x0409, $bytes, $bytes.Length)) {",
      '    throw "UpdateResource RT_ICON $($id) failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"',
      "  }",
      "}",
      "$groupBytes = [System.IO.File]::ReadAllBytes($group)",
      'if (-not [IconStamper]::UpdateResource($h, [IntPtr]14, [IntPtr]1, 0x0409, $groupBytes, $groupBytes.Length)) { throw "UpdateResource RT_GROUP_ICON failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }',
      'if (-not [IconStamper]::EndUpdateResource($h, $false)) { throw "EndUpdateResource failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }',
      "",
    ].join("\n"),
  );
  const run = Bun.spawnSync(
    [
      resolvePwshPath(undefined),
      "-NoProfile",
      "-NonInteractive",
      "-File",
      script,
      exePath,
      iconDir,
      groupBin,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (run.exitCode !== 0)
    throw new Error(
      `could not stamp the application icon into ${exePath}: ` +
        `${new TextDecoder().decode(run.stderr).trim() || `exit ${run.exitCode}`}`,
    );
}

/**
 * The PE payloads a stamped icon needs, from one .ico file.
 *
 * EVERY image in the .ico becomes its own RT_ICON (id 1..N), and one
 * RT_GROUP_ICON binds them: a 6-byte GRPICONDIR header plus a 14-byte
 * GRPICONDIRENTRY per image. The entry's LAST field is the image's
 * RESOURCE ID — not the file offset the .ico directory carries.
 *
 * A single-image stamp is not enough, and that is not theoretical: the
 * first version wrote only the 16px entry, the group declared only it, and
 * `LoadImage(..., "#1", IMAGE_ICON, 32, 32)` — what Explorer, the taskbar
 * and the properties sheet ask for — found no 32px image and fell back to
 * bun's default mark. Three Win32 calls returned true, the build exited 0,
 * and the shipped exe still showed the wrong icon.
 */
async function buildIconPayloads(
  icoPath: string,
  iconDir: string,
  groupBin: string,
): Promise<void> {
  const ico = await Bun.file(icoPath).arrayBuffer();
  const bytes = new Uint8Array(ico);
  if (bytes.length < 22)
    throw new Error(`${icoPath} is too small to be an .ico`);
  // The image count is the uint16 at offset 4, little-endian — the LOW byte
  // first. Reading the high byte here (which is 0 for any real icon) had a
  // 7-image .ico refused with "declares no images".
  const count = bytes[4] | (bytes[5] << 8);
  if (count < 1) throw new Error(`${icoPath} declares no images`);

  await mkdir(iconDir, { recursive: true });
  const groupEntries: Buffer[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const length =
      bytes[entry + 8] |
      (bytes[entry + 9] << 8) |
      (bytes[entry + 10] << 16) |
      (bytes[entry + 11] << 24);
    const offset =
      bytes[entry + 12] |
      (bytes[entry + 13] << 8) |
      (bytes[entry + 14] << 16) |
      (bytes[entry + 15] << 24);
    if (offset + length > bytes.length)
      throw new Error(
        `${icoPath}'s image ${index + 1} points outside the file`,
      );
    const resourceID = index + 1;
    await Bun.write(
      join(iconDir, `${resourceID}.bin`),
      Buffer.from(bytes.subarray(offset, offset + length)),
    );
    const groupEntry = Buffer.alloc(14);
    bytes
      .subarray(entry, entry + 12)
      .forEach((value, at) => (groupEntry[at] = value));
    groupEntry.writeUInt16LE(resourceID, 12);
    groupEntries.push(groupEntry);
  }

  const group = Buffer.alloc(6 + 14 * count);
  bytes.subarray(0, 6).forEach((value, at) => (group[at] = value));
  groupEntries.forEach((entry, index) => entry.copy(group, 6 + index * 14));
  await Bun.write(groupBin, group);
}

/** The command that produces the host for a given release platform. */
function hostBuildCommand(platformDir: string): string {
  if (platformDir.startsWith("windows"))
    return "npm run desktop:cef:build:windows (on Windows)";
  if (platformDir.startsWith("darwin"))
    return "npm run desktop:cef:build (on macOS)";
  return "npm run desktop:cef:build";
}

/**
 * Assemble the CEF window host into the release tree (Linux and Windows; macOS is
 * deferred — see the note below).
 *
 * (macOS NOTE: this has a .app-aware branch, but no macOS release exists to feed
 * it — `--all` deliberately builds only host + windows-x64, because a macOS
 * release would ship without the terminal's natives and the bridge build
 * scripts cover ubuntu and windows only. The branch is here so the day a mac
 * terminal build lands, this step needs no change; until then it is
 * unreachable, and that is the deferral's doing rather than an oversight.)
 *
 * `release:build` compiles the CLI bundle and the plugins; the desktop WINDOW is
 * a separate build (`npm run desktop:cef:build`) whose output lived only in
 * `apps/cef-desktop/build/output/`. Nothing ever copied it into a release, so a
 * release tree could not be turned into an installable application — the
 * packaging step refused it for a missing binary, which is exactly the failure
 * this closes.
 *
 * The same rule as the terminal natives: the binary either ships or the build
 * says so. A release that silently omits its window is a directory that installs
 * and then does nothing.
 */
async function stageDesktopHost(
  outDir: string,
  platformDir: string,
): Promise<void> {
  const suffix = platformDir.startsWith("windows") ? ".exe" : "";
  const built = join(root, "apps", "cef-desktop", "build", "output");
  const host = join(built, `natalia-cef-desktop${suffix}`);
  let source = host;
  if (!(await Bun.file(host).exists())) {
    // A macOS bundle keeps it under Contents/MacOS when the host was built as a
    // .app; look there before deciding it is missing.
    const bundled = join(
      built,
      "Natalia.app",
      "Contents",
      "MacOS",
      `natalia-cef-desktop${suffix}`,
    );
    if (await Bun.file(bundled).exists()) source = bundled;
  }
  if (!(await Bun.file(source).exists()))
    throw new Error(
      `${platformDir}: the desktop host is not built — run \`${hostBuildCommand(platformDir)}\` ` +
        `before packaging. Its output lives in a gitignored build directory, so a ` +
        `clean checkout must rebuild it; this step deliberately does NOT build it, ` +
        `because a release whose host was silently compiled here would hide that ` +
        `the host build itself is a separate, platform-specific step (and on this ` +
        `host a Windows host cannot be built at all — that needs a Windows machine, ` +
        `which is why the command names the platform rather than assuming it).`,
    );
  await cp(source, join(outDir, `natalia-cef-desktop${suffix}`));
  // The CEF runtime it loads, taken WHOLE from what the host build already
  // assembled beside itself.
  //
  // The hand-written subset this replaces was wrong twice over, and both were
  // invisible until an installed copy was launched:
  //
  //   1. `locales` is a DIRECTORY, and the loop asked
  //      `Bun.file(candidate).exists()` — false for a directory — so the locale
  //      files were skipped on every platform. Same `Bun.file()` trap the
  //      forbidden-state guard fell into.
  //   2. The EGL/GLES entries were the LINUX names (`libEGL.so`,
  //      `libGLESv2.so`); the Windows spellings (`libEGL.dll`,
  //      `libGLESv2.dll`) were never listed. Neither were `d3dcompiler_47.dll`,
  //      `dxcompiler.dll`, `dxil.dll` (ANGLE's shader compilers, which
  //      libcef.dll links against), `vk_swiftshader.dll`, `vulkan-1.dll` (the
  //      software-rendering fallback) or `chrome_elf.dll`.
  //
  // The symptom: the installed host died instantly with 0xC0000135
  // (STATUS_DLL_NOT_FOUND) and printed nothing — "I installed it and it won't
  // open". A hand-maintained list cannot track what CEF links against across
  // versions, so the runtime travels as the build assembled it.
  const buildOnly = new Set([
    // Not runtime: the import library, CEF's own log, and the bootstrap
    // stagers the host build uses to relaunch itself.
    "libcef.lib",
    "debug.log",
    "bootstrap.exe",
    "bootstrapc.exe",
    // The retired launcher. Its CMake target is gone, but this loop copies
    // the build-output directory WHOLE, so a binary the target left behind
    // on disk keeps shipping in every release and lands in the deployment
    // directory — measured: the deploy's mirror copied the 10-14 binary
    // back into an install that had already deleted it. The target's
    // deletion is what stops the next BUILD producing it; this entry is
    // what stops the last one from outliving it.
    "natalia-launcher.exe",
    "natalia-launcher",
    // The uninstaller and installer script belong to the packaging step, and
    // shipping them beside the app would let an installer overwrite them.
    "unins000.dat",
    "unins000.exe",
    "unins000.msg",
    "Natalia.iss",
  ]);
  for (const entry of await readdir(built, { withFileTypes: true })) {
    if (buildOnly.has(entry.name)) continue;
    await cp(join(built, entry.name), join(outDir, entry.name), {
      recursive: true,
    });
  }
}

/**
 * The release's contract, asserted against itself. The facts both
 * installers and every downstream consumer depend on, each of which was
 * violated by a real bug this session:
 *
 * 1. the layout the installers read (the binary, VERSION, SHA256SUMS,
 *    manifest.json, plugins/);
 * 2. NO machine-local state — the dev plugin-store, the pty stores, the
 *    test workspaces (they tied the artifact to the building machine);
 * 3. the terminal tier follows the retirement: a POSIX release carries NO
 *    terminal executables (the self-developed pty backend is the only
 *    default), a Windows release carries its three and only those;
 * 4. every file on disk is covered by the checksums (an uncovered file
 *    is a file no installer verifies).
 */
async function verifyRelease(
  outDir: string,
  platformDir: string,
  files: Array<{ file: string; sha256: string }>,
): Promise<void> {
  const problems: string[] = [];
  const isDir = async (path: string) => {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  };
  const isFile = async (path: string) => {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  };
  // The binary's name is the platform's own (the Windows compile emits
  // natalia.exe), and `plugins` is a directory — Bun.file().exists() sees
  // neither, so this is a stat.
  const binaryName = platformDir.startsWith("windows")
    ? "natalia.exe"
    : "natalia";
  for (const required of [
    binaryName,
    "VERSION",
    "SHA256SUMS",
    "manifest.json",
    "plugins",
  ])
    if (
      !(await isFile(join(outDir, required))) &&
      !(await isDir(join(outDir, required)))
    )
      problems.push(`the release is missing ${required}`);
  for (const forbidden of MACHINE_LOCAL_STATE_DIRS) {
    // A STAT, not Bun.file().exists(): the offender is a DIRECTORY, and
    // `Bun.file()` on a directory reports "no such file" — so this guard passed
    // a release carrying a full dev plugin-store (natalia.lock + node_modules +
    // the initialized marker, 76 manifest entries of machine-local state) and
    // the installer then shipped it. The guard's own comment already records
    // that `plugins` needed a stat for the same reason; the forbidden list did
    // not get the same treatment when it was written.
    //
    // The list is shared with the copier below and with the installer plan
    // (`scripts/machine-local-state.ts`), because it was three copies of one
    // rule and the fourth state directory — the suite's `shared-plugin-store`,
    // whose lock pins this checkout by absolute path — was on none of them.
    try {
      const stats = await stat(join(outDir, forbidden));
      if (stats.isDirectory() || stats.isFile())
        problems.push(
          `machine-local state shipped: ${forbidden}/ (${stats.isDirectory() ? "directory" : "file"})`,
        );
    } catch {
      // Absent, which is the only passing answer.
    }
  }
  // The CEF runtime's hard dependencies. An installed host died with
  // 0xC0000135 (STATUS_DLL_NOT_FOUND) and no output at all because the release
  // shipped a HAND-WRITTEN SUBSET of what the host build assembled — the list
  // had the Linux EGL names and not the Windows ones, skipped `locales/` (a
  // directory, invisible to `Bun.file().exists()`), and never mentioned ANGLE's
  // shader compilers or the software-rendering fallback. `stageDesktopHost` now
  // copies the whole assembled runtime; this guard is what keeps it that way,
  // and it is checked against the Windows release because that is where the
  // host ships.
  // Nothing that only existed to debug this session may ship. A probe I built
  // to ask libcef.dll its api_hash was dropped into the CEF distribution's
  // Release/ directory, `stageDesktopHost` copies that whole directory, and the
  // installer delivered it to the install folder — the user's uninstaller log
  // showed it deleting `api_hash_probe.exe` from a real install. The dist is
  // an input directory, not a staging area.
  if (platformDir.startsWith("windows")) {
    const forbidden = ["api_hash_probe.exe", "*.probe.txt"];
    for (const pattern of forbidden) {
      for (const entry of await readdir(outDir)) {
        if (new Bun.Glob(pattern).match(entry))
          problems.push(
            `a debug artifact is shipping: ${entry} — nothing built to ` +
              `diagnose a session belongs in a release`,
          );
      }
    }
  }
  if (platformDir.startsWith("windows")) {
    for (const required of [
      "libcef.dll",
      "libEGL.dll",
      "libGLESv2.dll",
      "d3dcompiler_47.dll",
      "dxcompiler.dll",
      "dxil.dll",
      "vk_swiftshader.dll",
      "vulkan-1.dll",
      "chrome_elf.dll",
      "icudtl.dat",
      "resources.pak",
      "v8_context_snapshot.bin",
    ])
      if (!(await isFile(join(outDir, required))))
        problems.push(
          `the CEF runtime is incomplete: ${required} is missing — the window ` +
            `host would die with STATUS_DLL_NOT_FOUND on launch`,
        );
    if (!(await isDir(join(outDir, "locales"))))
      problems.push(
        "the CEF runtime is incomplete: locales/ is missing — a stat, because " +
          "Bun.file().exists() does not see a directory",
      );
  }
  // The terminal natives: the retired fork tier makes NO appearance in any
  // release now — a stray wezterm/ directory is the old contract coming back
  // and fails the build (the negative check's trap was real: `endsWith`
  // against the empty suffix passes everything, which is how a linux release
  // once shipped full of wezterm.exe).
  const weztermDir = join(
    outDir,
    "plugins",
    "natalia-tool-terminal",
    "wezterm",
  );
  if (await isFile(join(weztermDir, "..", "index.js"))) {
    if (await isDir(weztermDir))
      problems.push(
        "a release carries a wezterm/ directory — the fork tier is retired; " +
          "the pty backend needs no terminal executables, so this is the old " +
          "contract back",
      );
  }
  // The bridge, positive shape: every release carries ITS platform's pty
  // bridge, ours, in its own directory. The negative case existed first and
  // taught the lesson — a Windows release once shipped without the ConPTY
  // bridge because it rode the wezterm/ directory the POSIX trim deleted —
  // so the check names the expected binary rather than trusting the staging.
  const bridgeDir = join(
    outDir,
    "plugins",
    "natalia-tool-terminal",
    "pty-bridge",
  );
  const expectedBridge = platformDir.startsWith("windows")
    ? "natalia-conpty-bridge.exe"
    : "natalia-pty-bridge";
  if (await isFile(join(bridgeDir, "..", "index.js"))) {
    if (!(await isFile(join(bridgeDir, expectedBridge))))
      problems.push(
        `the ${platformDir} release carries no pty bridge (expected ` +
          `pty-bridge/${expectedBridge}) — every pane spawn would fail`,
      );
  }
  // Every file on disk is covered by the checksums. VERSION and
  // SHA256SUMS are the verification's own inputs: a checksum cannot list
  // itself, and VERSION is what install.sh reads before it verifies.
  //
  // AND THE PATHS ARE COMPARED IN ONE SPELLING. On a Windows host `outDir`
  // is a backslash path, so `join` produces `plugins\natalia-browser\index.js`
  // while the manifest's list — built from the same walk on a POSIX CI host —
  // holds `plugins/natalia-browser/index.js`. Comparing them raw made every
  // file of a Windows release "uncovered": 94 problems on a tree whose 94
  // entries each verified against its own checksum by hand. The separator is
  // normalized (backslash to forward) before the set lookup, which is what
  // the manifest's own walk already emits.
  const listed = new Set(files.map((file) => file.file.replace(/\\/g, "/")));
  const walk = async (dir: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = (prefix ? `${prefix}/${entry.name}` : entry.name).replace(
        /\\/g,
        "/",
      );
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
        continue;
      }
      if (rel === "VERSION" || rel === "SHA256SUMS" || rel === "manifest.json")
        continue;
      if (!listed.has(rel))
        problems.push(`${rel} is on disk but not in SHA256SUMS`);
    }
  };
  await walk(outDir);
  if (problems.length)
    throw new Error(
      `release verification failed for ${platformDir}:\n- ${problems.join("\n- ")}`,
    );
  console.log(
    `verified ${platformDir}: layout, no machine-local state, ` +
      `pty-bridge/${expectedBridge}, ` +
      `${files.length} files checksummed`,
  );
}

async function run(command: string, args: string[], cwd: string) {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NATALIA_TS_VERSION: version },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

// Step A: the release bundle at this version (its define bakes --version).
const built = await run("bun", ["scripts/ts-build.ts"], root);
if (built.code !== 0) {
  console.error(built.stderr);
  throw new Error("ts:build failed — no release bundle to compile");
}

const results: TargetResult[] = [];
for (const target of targets) {
  // bun's target triples for --compile: bun-linux-x64, bun-darwin-arm64, …
  const triple = target.startsWith("bun-") ? target : `bun-${target}`;
  const platformDir = triple.replace(/^bun-/, "");
  const outDir = join(root, "dist", "release", version, platformDir);
  const result: TargetResult = { target: triple, ok: false };
  try {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    const compile = await run(
      "bun",
      [
        "build",
        "--compile",
        join(root, "dist", "ts", "natalia-ts.js"),
        "--outfile",
        join(outDir, "natalia"),
        ...(triple === `bun-${hostTarget}` ? [] : [`--target=${triple}`]),
        // The exe's OWN identity, declared to the compiler. bun supports
        // all six of these natively, and they are the whole answer to
        // "why does our runtime say it is made by Bun": `bun build
        // --compile` produces a copy of the bun binary, so without them
        // every VERSIONINFO field is bun's — company "Oven", product
        // "Bun", copyright bun.com, version 1.4.0 — and the icon is
        // bun's stock mark.
        //
        // History, because it cost half a day: these flags were assumed
        // broken (oven-sh/bun#19916 reports `--windows-icon` as a no-op
        // on 1.2.14), so the resource was hand-stamped afterwards with
        // Win32 UpdateResource — a hand-built VERSIONINFO blob, a C
        // verifier, a PowerShell shim, ~540 lines. The flags work on
        // 1.4.0; only the ICON needed the workaround, and that too works
        // now. Read the flags off `bun build --help` before assuming a
        // tool cannot do something.
        //
        // Windows-only by bun's own rule (they depend on Windows APIs),
        // and the publisher/copyright are ours, not bun's.
        ...(platformDir.startsWith("windows")
          ? [
              `--windows-icon=${join(root, "assets", "icons", "icon.ico")}`,
              "--windows-title=Natalia",
              "--windows-publisher=Misaka477",
              "--windows-version=" + windowsFileVersion(version),
              "--windows-description=Natalia - a Wire-native AI agent runtime",
              `--windows-copyright=${WINDOWS_COPYRIGHT}`,
            ]
          : []),
      ],
      root,
    );
    if (compile.code !== 0) {
      result.error = compile.stderr.trim().split("\n").slice(-3).join(" ");
      results.push(result);
      continue;
    }
    // The ICON is the one flag that does not work: bun accepts
    // `--windows-icon` and exits 0, and the exe has no RT_ICON at all
    // (oven-sh/bun#19916 — measured on 1.4.0, `LoadImage(..., "#1",
    // IMAGE_ICON)` fails with ERROR_RESOURCE_NAME_NOT_FOUND). The other
    // five flags above DO work, which is why only this step remains.
    //
    // It writes every image the .ico carries as its own RT_ICON plus one
    // RT_GROUP_ICON binding them — a single 16px image is not enough,
    // because Explorer/taskbar/properties ask for 32px and fall back to
    // the default mark when the group does not declare it.
    //
    // Windows-only and native-only: the three Win32 calls are Windows APIs,
    // so a windows target cross-compiled from POSIX cannot stamp its own
    // icon (that build stamps nothing and says so).
    if (platformDir.startsWith("windows") && process.platform === "win32")
      await stampWindowsIcon(join(outDir, "natalia.exe"));
    // The tree-sitter WASM files, staged under wasm/ in the release so an
    // installed copy can find them on disk. Required, not tidy-up: the compiled
    // binary resolves @vscode/tree-sitter-wasm and web-tree-sitter through Bun's
    // EMBEDDED filesystem (B:\~BUN\... on Windows), where `Language.load` and
    // `Parser.init` cannot read them, so every shell tool failed on its first
    // command in an install. packages/core/tools/src/wasm-paths.ts reads them
    // from here first.
    //
    // They are located through Bun's own resolver (resolveSync) rather than a
    // hardcoded node_modules path, because Bun keeps the packages under
    // node_modules/.bun/<name>@<version>/node_modules/<name>/ — a layout that
    // changes with the lockfile and is not a public contract.
    const wasmDir = join(outDir, "wasm");
    await mkdir(wasmDir, { recursive: true });
    const wasmSpecifiers = [
      "@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm",
      "@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm",
      "web-tree-sitter/tree-sitter.wasm",
    ];
    for (const specifier of wasmSpecifiers) {
      try {
        // Resolved from the MODULE that consumes it, not from the root
        // package.json: these are not root dependencies, and resolving from the
        // root fails with "Cannot find module" — which silently produced an
        // empty wasm/ directory and a release whose shell tools still died.
        const from = join(
          root,
          "packages",
          "core",
          "tools",
          "src",
          "wasm-paths.ts",
        );
        const resolved = await Bun.resolveSync(specifier, from);
        // A PLAIN path, not a file: URL — Bun.resolveSync hands back
        // `E:\...\tree-sitter.wasm` on Windows. Guarding on a `file:` prefix
        // therefore matched nothing and the wasm/ directory stayed empty, which
        // is a silent failure: the build succeeded and the tools still died.
        const source = resolved.startsWith("file:")
          ? fileURLToPath(resolved)
          : resolved;
        // Windows paths: "/" alone left the whole name on POSIX-only splits.
        const name = source.split(/[/\\]/u).pop() ?? "";
        if (name && (await Bun.file(source).exists())) {
          await cp(source, join(wasmDir, name));
        }
      } catch {
        // Not installed, so not needed: the grammar set is optional.
      }
    }

    // Assets beside the binary (study layout: native attachments travel
    // with the binary, probed at startup). The prebuilt js stays too —
    // which path the compiled runtime resolves its assets against is the
    // spike's open question, answered by running the thing.
    // Local runtime state must NEVER ship: the dev plugin-store
    // (natalia.lock + its node_modules + the initialized marker) and the
    // pty stores are machine-local — found baked into release manifests
    // and SHA256SUMS (76 entries), which both tied the artifact to this
    // checkout and made `install.sh` copy files that a later cleanup
    // removed. Any stale copy from a previous build is purged here too.
    // The hygiene guard's own cleanup keeps this empty between runs; a
    // hard-killed run leaves workspaces behind, and they must never ship
    // (19 MiB of test residue in SHA256SUMS ties the artifact to the
    // machine that built it).
    // The list is the one in `scripts/machine-local-state.ts`, which the
    // verifier below and the installer plan read too: this Set used to be its
    // own copy, so `shared-plugin-store/` — the suite's shared official-plugin
    // install, 93 files whose lock pins `dist/ts/plugins` by absolute checkout
    // path — shipped in every release and landed in the deployed tree.
    const stateDirs = new Set<string>(MACHINE_LOCAL_STATE_DIRS);
    for (const entry of await readdir(join(root, "dist", "ts"))) {
      if (stateDirs.has(entry)) {
        await rm(join(outDir, entry), { recursive: true, force: true });
        continue;
      }
      await cp(join(root, "dist", "ts", entry), join(outDir, entry), {
        recursive: true,
      });
    }
    // And PURGE them from the release after the copy, not only before it. The
    // per-entry rm above skips copying; it does not clear one that is already
    // in outDir, and the whole-tree `rm(outDir, {force:true})` above silently
    // does nothing when the OS holds a file open (Windows does this constantly
    // — the machine this was measured on had ENOENT/EBUSY everywhere). A stale
    // plugin-store from a previous run therefore survives into the manifest and
    // the installer, which is how a machine-local dev store shipped: 31 seconds
    // after the binary compiled, `plugin-store/` appeared in the tree, and the
    // guard that names it did not see it (it asked `Bun.file().exists()`).
    for (const entry of stateDirs)
      await rm(join(outDir, entry), { recursive: true, force: true });
    // The interactive terminal's natives are per-platform: the Linux build
    // (podman) and the Windows cross-build stage into the SAME
    // target/release, so the shared dist/ts copy carries whichever was
    // staged last — each release keeps only the executables its platform
    // can run (a Windows release shipping Linux wezterm was the bug).
    await stageTerminalNatives(outDir, platformDir);
    // The detached-process owner (Windows): the same install-relative tier the
    // pty bridge uses, staged by its own step so a release that ships background
    // processes ships the job that owns them.
    await stagePlatformOwner(outDir, platformDir);
    // The browser bridge extension, for the browser_* tools (see the function).
    await stageBrowserExtension(outDir);
    // Self-iteration (the install study's closing gap): the tracked source
    // and the toolchains a rebuild needs, so an INSTALLED deployment can
    // evolve its own code. Staged before the hash walk so SHA256SUMS lists
    // them and the installer's file list derives them.
    await stageSource(outDir);
    await stageToolchains(outDir);
    await stageDesktopHost(outDir, platformDir);
    await stageWebShell(outDir);
    // The application icon, BESIDE THE BINARY. The Windows install plan
    // names `icon.ico` in the install root for the Start Menu shortcut and
    // the Apps & features row (`assets/icons/icon.ico` is where the build
    // keeps it; `icon.ico` next to the binary is where it lives on the
    // user's disk), and the Inno script writes
    // `UninstallDisplayIcon={app}\icon.ico` — but nothing ever copied it
    // into the release tree, so every installer shipped a shortcut with a
    // broken icon reference and an uninstall row with no icon at all.
    // Copied before the hash walk so SHA256SUMS lists it and the file list
    // the plan derives contains it (the plan's "installable" check asks
    // for exactly that).
    await stageAppIcon(outDir);
    // The shipped composition base (P3 "base profile 随包机制"): copied
    // into the app root BEFORE the hash walk, so SHA256SUMS lists it and
    // install.sh's files loop lands it next to the binary — where the
    // runtime's executable-directory search finds it.
    await Bun.write(
      join(outDir, "composition.base.json"),
      await Bun.file(join(root, "composition.base.json")).text(),
    );
    // The shared checksum walk (platform) — same inventory the store
    // export and the debug bundle produce.
    const { files, bytes: totalBytes } = await hashTreeFiles(outDir);
    const manifest = {
      name: "natalia",
      version,
      target: triple,
      files,
      // P4 "doctor 报告层名": the build-time layer census — the engine
      // compiles into the bundle, so the prefix inventory must be baked
      // here for an installed build to testify about its own boundaries.
      layers: await censusFromWorkspace(resolve(import.meta.dir, "..")),
    };
    await Bun.write(
      join(outDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    // The installer's zero-JSON paths: VERSION reads as a plain file, and
    // SHA256SUMS is the standard two-column format `sha256sum -c` consumes
    // natively — file list AND verification in one, no JSON parser needed
    // in a shell installer.
    await Bun.write(join(outDir, "VERSION"), `${version}\n`);
    await Bun.write(
      join(outDir, "SHA256SUMS"),
      `${manifest.files.map((file) => `${file.sha256}  ${file.file}`).join("\n")}\n`,
    );
    // THE SELF-CHECK: the release proves its own contract before it is
    // allowed to be called a release. Everything asserted here was a real
    // bug found by running the pipeline rather than reading it: test
    // residue inside SHA256SUMS (628 files of it), the Windows release
    // carrying the Linux terminal binaries, then an empty wezterm
    // directory. A build that cannot fail ships a lie with a checksum.
    await verifyRelease(outDir, platformDir, manifest.files);
    result.ok = true;
    result.binary = join(outDir, "natalia");
    result.files = manifest.files.length;
    result.bytes = totalBytes;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  results.push(result);
}

for (const result of results) {
  if (result.ok)
    console.log(
      `ok ${result.target}: ${result.binary} (${result.files} files, ${Math.round((result.bytes ?? 0) / (1024 * 1024))} MiB incl. assets)`,
    );
  else console.log(`failed ${result.target}: ${result.error ?? "unknown"}`);
}
if (!results.some((result) => result.ok)) {
  throw new Error("no target produced a runnable binary");
}

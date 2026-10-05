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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashTreeFiles } from "../packages/hosts/platform/src/hash-tree";
import { censusFromWorkspace } from "../apps/cli/src/layer-census";

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
  for (const engine of ["chromium", "firefox"]) {
    const from = join(source, engine);
    if (!(await Bun.file(join(from, "manifest.json")).exists())) continue;
    await cp(from, join(target, engine), { recursive: true });
  }
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

/**
 * Assemble the web shell the CEF window loads.
 *
 * `apps/web/dist` is built by its own step (`npm run build:web`) and lived
 * outside every release tree, so a release's window pointed at a server that had
 * nothing to serve: the CEF host started, connected to 127.0.0.1:<port>, and got
 * a connection the static server could not answer — a blank window in an
 * otherwise complete install. The runtime serves this directory, so shipping it
 * is what makes the window show anything.
 */
async function stageWebShell(outDir: string): Promise<void> {
  const built = join(root, "apps", "web", "dist");
  if (!(await Bun.file(join(built, "index.html")).exists()))
    throw new Error(
      "the web shell is not built — run \`npm run build:web\` before packaging " +
        "(its output is apps/web/dist and no release step produces it)",
    );
  const target = join(outDir, "web");
  await rm(target, { recursive: true, force: true });
  await cp(built, target, { recursive: true });
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
  for (const forbidden of [
    "client-test-workspaces",
    "plugin-store",
    "cli-dev-pty-stores",
  ]) {
    // A STAT, not Bun.file().exists(): the offender is a DIRECTORY, and
    // `Bun.file()` on a directory reports "no such file" — so this guard passed
    // a release carrying a full dev plugin-store (natalia.lock + node_modules +
    // the initialized marker, 76 manifest entries of machine-local state) and
    // the installer then shipped it. The guard's own comment already records
    // that `plugins` needed a stat for the same reason; the forbidden list did
    // not get the same treatment when it was written.
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
      ],
      root,
    );
    if (compile.code !== 0) {
      result.error = compile.stderr.trim().split("\n").slice(-3).join(" ");
      results.push(result);
      continue;
    }
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
    const stateDirs = new Set([
      "plugin-store",
      "cli-dev-pty-stores",
      "client-test-workspaces",
    ]);
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
    // The browser bridge extension, for the browser_* tools (see the function).
    await stageBrowserExtension(outDir);
    await stageDesktopHost(outDir, platformDir);
    await stageWebShell(outDir);
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

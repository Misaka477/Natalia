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
 * Keeps only the platform's own terminal executables in the release: the
 * plugin distribution stages a whole `wezterm/` directory, and the two
 * native builds populate the same fork's target/release — both platforms'
 * files sit side by side until this trims each release to its own.
 */
/**
 * The terminal executables are per-platform: both native builds stage into
 * the same fork's target/release, and the shared dist/ts copy carries
 * whichever was staged when ts-build ran — a Windows release shipping the
 * Linux binaries was the bug, and trimming-only produced an empty dir as
 * the second attempt (the cross-build stages AFTER ts-build). Each release
 * therefore takes its own executables straight from the fork, whatever the
 * distribution happened to carry, and fails loudly when the platform's
 * build is missing (a release whose terminal cannot run is a lie).
 */
async function stageTerminalNatives(
  outDir: string,
  platformDir: string,
): Promise<void> {
  const pluginDir = join(outDir, "plugins", "natalia-tool-terminal");
  if (!(await Bun.file(join(pluginDir, "index.js")).exists())) return;
  const weztermDir = join(pluginDir, "wezterm");
  const forkRelease = join(
    root,
    "packages/plugins/native-terminal/wezterm/target/release",
  );
  const suffix = platformDir.startsWith("windows") ? ".exe" : "";
  await rm(weztermDir, { recursive: true, force: true });
  await mkdir(weztermDir, { recursive: true });
  for (const name of ["wezterm", "wezterm-gui", "wezterm-mux-server"]) {
    const executable = `${name}${suffix}`;
    if (!(await Bun.file(join(forkRelease, executable)).exists()))
      throw new Error(
        `${platformDir}: the terminal's ${executable} is not built — run the platform's wezterm build before packaging`,
      );
    await cp(join(forkRelease, executable), join(weztermDir, executable));
  }
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
 * release would ship without the terminal's natives and `build-wezterm-*.ts`
 * covers ubuntu and windows only. The branch is here so the day a mac terminal
 * build lands, this step needs no change; until then it is unreachable, and that
 * is the deferral's doing rather than an oversight.)
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
  // The CEF runtime it loads, which the host build already assembled beside
  // itself (libcef, the .pak files, locales). Without them the binary starts and
  // immediately dies on a missing shared library, so they travel together.
  for (const name of [
    "libcef.so",
    "libcef.dll",
    "libcef.dylib",
    "libEGL.so",
    "libGLESv2.so",
    "icudtl.dat",
    "chrome_100_percent.pak",
    "chrome_200_percent.pak",
    "resources.pak",
    "v8_context_snapshot.bin",
    "locales",
  ]) {
    const candidate = join(built, name);
    if (!(await Bun.file(candidate).exists())) continue;
    await cp(candidate, join(outDir, name), { recursive: true });
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
 * 3. the terminal natives are THIS platform's own executables (a Windows
 *    release with Linux wezterm, or an empty directory, are both lies);
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
  ])
    if (await Bun.file(join(outDir, forbidden)).exists())
      problems.push(`machine-local state shipped: ${forbidden}/`);
  // The terminal natives: this platform's three executables and nothing else.
  const weztermDir = join(
    outDir,
    "plugins",
    "natalia-tool-terminal",
    "wezterm",
  );
  if (await isFile(join(weztermDir, "..", "index.js"))) {
    const suffix = platformDir.startsWith("windows") ? ".exe" : "";
    const entries = await readdir(weztermDir).catch(() => []);
    if (entries.length !== 3)
      problems.push(
        `the terminal carries ${entries.length} executables, expected 3`,
      );
    const wantsWindows = platformDir.startsWith("windows");
    // The check is the POSITIVE shape: a posix release must not carry
    // an .exe, a windows release must not carry a bare one. `endsWith`
    // against the empty suffix is the trap this replaces — every string
    // "ends with" "" — which is how the first version of this check
    // passed a linux release full of wezterm.exe.
    for (const entry of entries)
      if (entry.endsWith(".exe") !== wantsWindows)
        problems.push(
          `the ${platformDir} release carries a foreign terminal binary: ${entry}`,
        );
  }
  // Every file on disk is covered by the checksums. VERSION and
  // SHA256SUMS are the verification's own inputs: a checksum cannot list
  // itself, and VERSION is what install.sh reads before it verifies.
  const listed = new Set(files.map((file) => file.file));
  const walk = async (dir: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
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
      `${platformDir.startsWith("windows") ? "windows" : "posix"} terminal natives, ` +
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
    // The interactive terminal's natives are per-platform: the Linux build
    // (podman) and the Windows cross-build stage into the SAME
    // target/release, so the shared dist/ts copy carries whichever was
    // staged last — each release keeps only the executables its platform
    // can run (a Windows release shipping Linux wezterm was the bug).
    await stageTerminalNatives(outDir, platformDir);
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

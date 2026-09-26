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

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Builds the managed WezTerm fork for Ubuntu 24.04 inside a podman container
 * and stages the executables back into the fork's own target/release.
 *
 * The fork must be built *on* Ubuntu so the executables only require the
 * Ubuntu glibc (2.39), which is what a deployed Ubuntu server runs. Building
 * on a newer-glibc host (e.g. Fedora) produces binaries that crash with
 * "GLIBC_2.x not found" on the server. The framework resolves the fork from
 * packages/plugins/native-terminal/wezterm/target/release, so the stage
 * directory is non-negotiable — everything else (CARGO_TARGET_DIR, cargo
 * cache) is kept in podman volumes so repeated builds are incremental.
 *
 * Reuses an existing `natalia-ubuntu-build` container and its cargo cache.
 */

const repoRoot = resolve(join(import.meta.dir, ".."));
const forkDir = join(
  repoRoot,
  "packages",
  "plugins",
  "native-terminal",
  "wezterm",
);
const releaseDir = join(forkDir, "target", "release");
const containerName = "natalia-ubuntu-build";
const containerForkDir = "/src/wezterm";
const binaries = ["wezterm", "wezterm-gui", "wezterm-mux-server"];
const cargoVolume = "natalia-ubuntu-cargo";
const targetVolume = "natalia-ubuntu-build-target";

await checkTool("podman");
await ensureVolumes();
await ensureContainer();
await provision();
await build();
await stage();

async function ensureVolumes() {
  for (const volume of [cargoVolume, targetVolume]) {
    const has = await podmanOk(["volume", "exists", volume]);
    if (!has) {
      console.log(`creating volume ${volume} ...`);
      if (!(await podmanOk(["volume", "create", volume])))
        throw new Error(`failed to create volume ${volume}`);
    }
  }
}

async function ensureContainer() {
  if (await podmanOk(["container", "exists", containerName])) {
    if (!(await podmanOk(["start", containerName]))) {
      // Already running.
    }
    return;
  }
  console.log(`creating ${containerName} ...`);
  const ok = await podmanOk([
    "run",
    "-d",
    "--name",
    containerName,
    "--security-opt",
    "label=disable",
    // The host proxy points at the host loopback; inside the container it is
    // a dead socket, so apt/rustup go direct.
    "-e",
    "http_proxy=",
    "-e",
    "https_proxy=",
    "-e",
    "HTTP_PROXY=",
    "-e",
    "HTTPS_PROXY=",
    "-e",
    "all_proxy=",
    "-e",
    "ALL_PROXY=",
    "-e",
    "CARGO_TARGET_DIR=/build/target",
    "-v",
    `${cargoVolume}:/root/.cargo`,
    "-v",
    `${targetVolume}:/build/target`,
    "-v",
    `${forkDir}:${containerForkDir}:ro`,
    "ubuntu:24.04",
    "sleep",
    "infinity",
  ]);
  if (!ok) throw new Error(`failed to create ${containerName}`);
  console.log(`  created ${containerName}`);
}

async function provision() {
  const ok = await podmanOk([
    "exec",
    containerName,
    "bash",
    "-lc",
    [
      "set -e",
      // curl AND git: the fork carries a git dependency (finl_unicode), and
      // cargo cannot fetch it without git in the image — rustup installs a
      // toolchain without one, so the first provision built a container
      // that failed at the fetch, not at the compile. The apt index is
      // refreshed first (the fork's get-deps installs without updating,
      // and an aged index answers every package with 'Unable to locate').
      "apt-get update -qq",
      "apt-get install -y -qq curl ca-certificates build-essential pkg-config unzip zip git",
      // The cargo bin must be ON the path of the shell that later runs
      // the fork's get-deps: rustup installs to /root/.cargo/bin, which a
      // non-login `bash -lc` in the container does not carry — without
      // this the fork's scripts answer "Rust is not installed!" and the
      // provision fails at the deps step, one host later.
      "export PATH=/root/.cargo/bin:$PATH",
      // The toolchain EXPLICITLY, then verified: a half-installed rustup
      // leaves /root/.cargo/bin/rustc as a symlink with no toolchain
      // behind it (the rustup self-update's background download dies
      // behind this host's proxy), and the fork's scripts then answer
      // 'rustup could not choose a version' — one host later. `rustup
      // default` both downloads and sets; the probe makes the failure
      // THIS step's error rather than the deps step's mystery.
      "if [ ! -x /root/.cargo/bin/rustc ] || ! rustup toolchain list | grep -q stable; then " +
        "curl -fsSL https://sh.rustup.rs -o /tmp/rustup.sh && " +
        "sh /tmp/rustup.sh -y --profile minimal --default-toolchain stable --no-modify-path; " +
        "rustup default stable; fi",
      "rustc --version",
      // The apt INDEX first: the fork's get-deps installs without
      // updating, and a container image whose index has aged out (or an
      // image built before the archive rotated) answers every package
      // with "Unable to locate" — the Ubuntu build's own failure this
      // week. The update is cheap and idempotent; the deps step is not
      // re-run once /build/get-deps.done exists.
      "apt-get update -qq",
      "if [ ! -f /build/get-deps.done ] && ! dpkg -s libxkbcommon-dev >/dev/null 2>&1; then cd " +
        containerForkDir +
        " && bash get-deps && touch /build/get-deps.done; fi",
    ].join("\n"),
  ]);
  if (!ok) throw new Error("failed to provision the build container");
}

async function build() {
  console.log("building the WezTerm fork ...");
  const ok = await podmanOk([
    "exec",
    containerName,
    "bash",
    "-lc",
    `export PATH=/root/.cargo/bin:$PATH; cd ${containerForkDir} && cargo build --release --bin wezterm --bin wezterm-gui --bin wezterm-mux-server`,
  ]);
  if (!ok) throw new Error("the fork build failed");
}

async function stage() {
  await mkdir(releaseDir, { recursive: true });
  // Also stage under deploy/wezterm-bin so the Dockerfile can COPY the three
  // executables without pulling the 2.8G cargo target into the build context.
  const deployDir = join(repoRoot, "deploy", "wezterm-bin");
  await mkdir(deployDir, { recursive: true });
  for (const bin of binaries) {
    const built = join(releaseDir, bin);
    if (
      !(await podmanOk([
        "cp",
        `${containerName}:/build/target/release/${bin}`,
        built,
      ]))
    )
      throw new Error(`failed to stage ${bin}`);
    if (!existsSync(built))
      throw new Error(`expected staged executable ${built}`);
    const staged = join(deployDir, bin);
    await Bun.write(staged, Bun.file(built));
    if (process.platform !== "win32")
      await Bun.spawn(["chmod", "+x", staged]).exited;
  }
  console.log(
    `staged ${binaries.length} Ubuntu executables in ${releaseDir} and ${deployDir}\n` +
      "The framework resolves the fork from the package target directory, so no env or config is needed.",
  );
}

async function checkTool(tool: string) {
  const ok = await podmanOk([tool, "--version"]).catch(() => false);
  if (!ok) throw new Error(`required tool '${tool}' is not available`);
}

async function podmanOk(args: string[]): Promise<boolean> {
  const child = Bun.spawn(["podman", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await child.exited) === 0;
}

import { copyFile, readdir, symlink, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Cross-compiles the managed WezTerm fork for Windows from a POSIX host.
 *
 * Three host quirks make a plain `cargo build --target` fail, so each one is
 * handled explicitly rather than left for the next person to rediscover:
 *
 * 1. An activated Conda environment exports CC/CXX/CFLAGS/AR/RANLIB pointing at
 *    a *Linux* cross compiler. Those are picked up by cc-rs and openssl-src for
 *    the Windows target, so the environment is rebuilt from scratch and the
 *    mingw compilers are named per target instead.
 * 2. `libssh-rs-sys` emits MSVC library names (`libcrypto`/`libssl`) for every
 *    Windows target, while `openssl-src` under mingw produces `libcrypto.a` and
 *    `libssl.a`. GNU ld then looks for `liblibcrypto.a`. OpenSSL is therefore
 *    built first and the expected names are provided as symlinks.
 * 3. The fork resolver looks for the executables in `target/release`, so the
 *    Windows binaries are staged next to their POSIX counterparts.
 */

const target = "x86_64-pc-windows-gnu";
const forkDir = join("packages", "plugins", "native-terminal", "wezterm");
const binaries = ["wezterm", "wezterm-gui", "wezterm-mux-server"];

const home = process.env.HOME;
if (!home) throw new Error("HOME must be set");

const cargo = join(home, ".cargo", "bin", "cargo");
if (!existsSync(cargo))
  throw new Error(
    `rustup cargo is required for cross compilation but ${cargo} is missing. Install rustup, then run: rustup target add ${target}`,
  );

for (const tool of ["gcc", "g++", "ar", "ranlib"]) {
  const path = `/usr/bin/x86_64-w64-mingw32-${tool}`;
  if (!existsSync(path))
    throw new Error(
      `the mingw cross toolchain is incomplete: ${path} is missing. Install mingw64-gcc and mingw64-gcc-c++.`,
    );
}

// A pristine environment is the only reliable way to keep an activated Conda
// toolchain from leaking into the Windows build.
const environment = {
  HOME: home,
  TERM: "dumb",
  PATH: `${join(home, ".cargo", "bin")}:/usr/bin:/bin:${join(home, ".local", "bin")}`,
  CARGO_HOME: join(home, ".cargo"),
  RUSTUP_HOME: join(home, ".rustup"),
  CC_x86_64_pc_windows_gnu: "x86_64-w64-mingw32-gcc",
  CXX_x86_64_pc_windows_gnu: "x86_64-w64-mingw32-g++",
  AR_x86_64_pc_windows_gnu: "x86_64-w64-mingw32-ar",
  RANLIB_x86_64_pc_windows_gnu: "x86_64-w64-mingw32-ranlib",
};

await run(["-p", "openssl-sys"], "building OpenSSL for the Windows target");
await aliasOpenSSLLibraries();
await run(
  binaries.flatMap((bin) => ["--bin", bin]),
  "building the Windows executables",
);

const releaseDir = join(forkDir, "target", "release");
const targetDir = join(forkDir, "target", target, "release");
for (const bin of binaries) {
  const built = join(targetDir, `${bin}.exe`);
  if (!existsSync(built)) throw new Error(`expected build output ${built}`);
  await copyFile(built, join(releaseDir, `${bin}.exe`));
}

console.log(
  `staged ${binaries.length} Windows executables in ${releaseDir}\n` +
    "Copy the fork directory to the Windows host, or set NATALIA_WEZTERM_EXECUTABLE to wezterm.exe.",
);

async function run(args: string[], description: string) {
  console.log(`${description} ...`);
  const child = Bun.spawn(
    [cargo, "build", "--release", "--target", target, ...args],
    { cwd: forkDir, env: environment, stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0)
    throw new Error(`failed while ${description}`);
}

/**
 * Provides the MSVC-style library names that `libssh-rs-sys` requests for every
 * Windows target. Symlinks are used so that a later OpenSSL rebuild stays
 * visible without repeating this step.
 */
async function aliasOpenSSLLibraries() {
  const buildDir = join(forkDir, "target", target, "release", "build");
  const entries = await readdir(buildDir).catch(() => []);
  const aliases = [
    ["libcrypto.a", "liblibcrypto.a"],
    ["libssl.a", "liblibssl.a"],
  ] as const;
  let linked = 0;
  for (const entry of entries) {
    if (!entry.startsWith("openssl-sys-")) continue;
    const libDir = join(
      buildDir,
      entry,
      "out",
      "openssl-build",
      "install",
      "lib",
    );
    if (!existsSync(join(libDir, "libcrypto.a"))) continue;
    for (const [actual, expected] of aliases) {
      const link = join(libDir, expected);
      await unlink(link).catch(() => {});
      await symlink(actual, link);
      linked += 1;
    }
  }
  if (!linked)
    throw new Error(
      "no vendored OpenSSL build was found; cannot provide the library names libssh-rs-sys expects",
    );
  console.log(`aliased ${linked} OpenSSL libraries for the mingw linker`);
}

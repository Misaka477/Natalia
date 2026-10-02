import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The CEF desktop's Windows-half pins.
 *
 * CEF itself is cross-platform; what this repository had was a Linux-only
 * wiring (a hard-coded libcef.so, X11 in the link line, a `main` entry and a
 * bash launcher). Each pin below failed before this block, and each is the
 * kind of thing a future edit silently breaks.
 */
const root = join(import.meta.dir, "..", "..", "..");
const cmake = readFileSync(
  join(root, "apps", "cef-desktop", "CMakeLists.txt"),
  "utf8",
);
const launcher = readFileSync(
  join(root, "apps", "cef-desktop", "run-cef-desktop.cmd"),
  "utf8",
);

test("the build selects a per-platform CEF SDK root and artifact names", () => {
  // A single SDK root is how a Windows build links Linux binaries.
  for (const root0 of [".cef-windows", ".cef-test", ".cef-macos"])
    expect(cmake).toContain(root0);
  // CEF 152's Windows distribution puts the prebuilt binaries in `Release/`,
  // not at the distribution root, and ships NO prebuilt wrapper — the
  // libcef_dll/ sources come with it and CEF's cmake integration builds the
  // wrapper target. Both were measured on a real Windows build (the batch that
  // produced WINDOWS-DIST-TEST-REPORT.zh-CN.md), so they replace the earlier
  // guess of a root-level libcef.lib plus a prebuilt wrapper .lib.
  expect(cmake).toContain('set(CEF_LIB "${CEF_ROOT}/Release/libcef.lib")');
  expect(cmake).toContain('set(CEF_DLL "${CEF_ROOT}/Release/libcef.dll")');
  expect(cmake).toContain('set(CEF_RESOURCE_DIR "${CEF_ROOT}/Resources")');
  expect(cmake).not.toContain('set(CEF_LIB "${CEF_ROOT}/libcef.lib")');
  expect(cmake).not.toContain(
    'set(CEF_WRAPPER_LIB "${CEF_ROOT}/libcef_dll_wrapper.lib")',
  );
  // Linux's libcef.so is the 1.4GB shared object in bin/, and lib/ holds ONLY
  // the import wrapper. The symmetry-with-Windows assumption ("lib/libcef.so")
  // was written once and the real build caught it: three objects compiled, then
  // the link failed naming a file that exists under a different name.
  expect(cmake).toContain('set(CEF_LIB "${CEF_ROOT}/bin/libcef.so")');
  expect(cmake).not.toContain('set(CEF_LIB "${CEF_ROOT}/lib/libcef.so")');
  expect(cmake).toContain(
    'set(CEF_WRAPPER_LIB "${CEF_ROOT}/lib/libcef_dll_wrapper.a")',
  );
  // POSIX-only system libraries must not reach the Windows link line.
  const winLink = cmake.slice(
    cmake.indexOf("if(WIN32)"),
    cmake.indexOf("else()", cmake.indexOf("if(WIN32)")),
  );
  expect(winLink).not.toMatch(/\bX11\b/u);
  expect(winLink).not.toMatch(/\bpthread\b/u);
  expect(winLink).not.toMatch(/\bdl\b/u);
});

test("the entry point is per-platform, so two mains never share a binary", () => {
  // Globbing src/*.cc is exactly what would put `main` and `wWinMain` in one
  // executable, and would compile the X11 files on Windows.
  expect(cmake).toContain("src/cefsimple_win.cc");
  expect(cmake).toContain("src/cefsimple_linux.cc");
  expect(cmake).not.toContain("file(GLOB NATALIA_CEF_SRCS");
  // The Windows entry takes the instance handle, the way CEF expects it.
  const entry = readFileSync(
    join(root, "apps", "cef-desktop", "src", "cefsimple_win.cc"),
    "utf8",
  );
  expect(entry).toContain("wWinMain");
  expect(entry).toContain("CefMainArgs main_args(hInstance)");
  expect(entry).toContain("settings.no_sandbox = true");
});

test("the Windows launcher starts the same three pieces the Linux one does", () => {
  for (const piece of [
    "apps\\cli\\src\\main.ts",
    "apps\\cef-desktop\\serve-web.ts",
    "natalia-cef-desktop.exe",
    "--user-data-dir=",
  ])
    expect(launcher).toContain(piece);
  // The Linux-only mechanics must NOT be here: LD_LIBRARY_PATH and the wayland
  // ozone switch are what made this script unusable on Windows. The check
  // strips the comments so the NEGATIVE pin is exact — a launcher that merely
  // mentions them in prose would pass a naive `not.toContain` and then rot.
  const commands = launcher
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("REM"))
    .join("\n");
  expect(commands).not.toContain("LD_LIBRARY_PATH");
  expect(commands).not.toContain("ozone-platform");
});

test("the Windows SDK fetch refuses a version mismatch", () => {
  // libcef is a per-platform Chromium build: a Windows archive that is not the
  // version the Linux SDK carries fails at link time with symbol errors that
  // name nothing. The fetch reads the version out of the vendored header.
  const fetcher = readFileSync(
    join(root, "scripts", "fetch-cef-windows.ts"),
    "utf8",
  );
  expect(fetcher).toContain("cef_version.h");
  expect(fetcher).toContain("windows64");
  expect(fetcher).toContain("sha256");
  expect(fetcher).toContain("the fetched distribution is");
});

test("the native build chain skips only wezterm, and says so", () => {
  // The user's rule: wezterm is the ONLY skippable native artifact (they build
  // the three executables themselves). Everything else — the confinement
  // backend, the object-store crate, the text-diff and 44 AST wasm packs — is a
  // capability the runtime actually uses, so skipping it is a different build,
  // not a faster one.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts["build:distribution"]).toContain(
    "NATALIA_BUILD_SKIP_NATIVE=1",
  );
  // The full chain exists and does NOT skip.
  expect(pkg.scripts["native:all"]).toContain("native:confinement");
  expect(pkg.scripts["native:all"]).toContain("native:object-store");
  expect(pkg.scripts["diff:build-wasm"]).toContain("build-ast-packs.ts");
  for (const chain of ["build:windows", "build:distribution:native"]) {
    const script = pkg.scripts[chain]!;
    // The native step is platform-appropriate: the Windows chain uses
    // `native:windows` (a Windows release must not build the Linux confinement
    // backend), the distribution chain uses `native:all`.
    if (chain === "build:windows") expect(script).toContain("native:windows");
    else expect(script).toContain("native:all");
    // ts:build in a full chain must run WITHOUT the skip: that is what stages
    // the wezterm executables into the plugin distribution.
    expect(script).not.toContain("SKIP_NATIVE");
    expect(script).toContain("ts-build.ts");
    expect(script).toContain("refresh:plugin-store");
  }
  // The wasm packs are a capability too, so they belong in the full chain —
  // `build:distribution:native` is the crates-only variant, and it does not
  // pretend otherwise.
  expect(pkg.scripts["build:windows"]).toContain("diff:build-wasm");
  expect(pkg.scripts["build:distribution:native"]).not.toContain(
    "diff:build-wasm",
  );
});

test("the wasm builds carry no POSIX-only shell or path", () => {
  // `cp` and `${VAR:-default}` are bash; npm runs scripts through the host
  // shell, which is cmd.exe on Windows. The whole step is a bun script now.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts["diff:build-wasm"]).not.toMatch(/\bcp\b/u);
  expect(pkg.scripts["diff:build-wasm"]).not.toContain(":-");
  // The builders' own paths: no hard-coded /tmp anywhere, and no /opt without a
  // platform branch beside it.
  for (const script of ["build-ast-packs.ts", "build-text-diff-wasm.ts"]) {
    const source = readFileSync(join(root, "scripts", script), "utf8");
    expect(source, `${script} must not hard-code /tmp`).not.toContain(
      'join("/tmp"',
    );
    expect(source, `${script} must use the OS temp dir`).toContain("tmpdir()");
  }
  // Only the AST pack builder needs the WASI SDK; its root is env-overridable
  // with a per-platform default. The POSIX default is fine — what must not
  // exist is a /opt path with no platform branch beside it.
  const astPacks = readFileSync(
    join(root, "scripts", "build-ast-packs.ts"),
    "utf8",
  );
  expect(astPacks).toContain("process.env.WASI_SDK");
  expect(astPacks).toContain('process.platform === "win32"');
  const wasiLines = astPacks
    .split("\n")
    .filter((line) => line.includes("/opt/wasi-sdk"));
  expect(
    wasiLines,
    "every /opt default sits in the platform branch",
  ).toHaveLength(1);
  expect(wasiLines[0]).toContain("win32");
  // And the cargo home lands outside the checkout.
  const textDiff = readFileSync(
    join(root, "scripts", "build-text-diff-wasm.ts"),
    "utf8",
  );
  expect(textDiff).toContain("tmpdir()");
  expect(textDiff).not.toContain('join(root, ".cargo-home")');
});

test("ts-build reads the wezterm executables from the fork's release dir", () => {
  // The pin that keeps the two wezterm drop directories honest: the distribution
  // build stages from `wezterm/target/release/` and fails loudly on a miss,
  // while the RUNTIME resolves through the prebuilt drop. They are different
  // consumers, so "I dropped the exe in prebuilt" does not satisfy the packager.
  const source = readFileSync(join(root, "scripts", "ts-build.ts"), "utf8");
  expect(source).toContain('join(root, "wezterm/target/release")');
  expect(source).toContain("missing terminal executable");
  // And the skip is explicit, not an accident of a missing file.
  expect(source).toContain("NATALIA_BUILD_SKIP_NATIVE");
});

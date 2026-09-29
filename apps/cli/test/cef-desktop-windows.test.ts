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
  expect(cmake).toContain('set(CEF_LIB "${CEF_ROOT}/libcef.lib")');
  expect(cmake).toContain('set(CEF_LIB "${CEF_ROOT}/lib/libcef.so")');
  expect(cmake).toContain(
    'set(CEF_WRAPPER_LIB "${CEF_ROOT}/libcef_dll_wrapper.lib")',
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

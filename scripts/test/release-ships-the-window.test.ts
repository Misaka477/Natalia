import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The release carries the window.
 *
 * `release:build` compiles the CLI bundle and the plugins. The desktop WINDOW is
 * a separate build, and for a long time nothing copied it into a release tree — so
 * a release could not be turned into an installable application, and the packaging
 * step refused it for a binary that was never there. That gap was found by running
 * the packaging against a REAL release instead of a hand-written fixture, which is
 * why this pin lives at the build script rather than in the packager.
 *
 * A hand-written fixture could not have caught it: the fixtures always contained
 * `natalia-cef-desktop`, because that is the file the packager was written to
 * require.
 */
const root = join(import.meta.dir, "..", "..");
const script = () =>
  readFileSync(join(root, "scripts", "build-standalone.ts"), "utf8");

test("the release tree assembles the desktop host", () => {
  const source = script();
  // The step exists and is called from the same loop that stages the terminal
  // natives — the one place every platform's tree is completed.
  expect(source).toContain("async function stageDesktopHost(");
  expect(source).toContain("await stageDesktopHost(outDir, platformDir);");
});

test("a missing host fails the build rather than shipping an empty app", () => {
  // The same rule the terminal natives follow: the binary either ships or the
  // build says so. A release that silently omits its window installs and then
  // does nothing.
  const source = script();
  expect(source).toContain("the desktop host is not built");
  // And it points at the command that produces it.
  expect(source).toContain("desktop:cef:build");
});

test("the CEF runtime travels with the binary", () => {
  // libcef without its .pak files and locales starts and immediately dies on a
  // missing resource, so the host build's own output is what gets copied.
  const source = script();
  for (const required of [
    "libcef.so",
    "libcef.dll",
    "libcef.dylib",
    "icudtl.dat",
    "locales",
  ])
    expect(source, `missing ${required}`).toContain(required);
});

test("the web shell ships too, or the window has nothing to show", () => {
  // The same gap one layer out: `apps/web/dist` was built by its own step and
  // never entered a release tree, so the CEF host started, connected, and got a
  // static server with no files — a blank window inside an otherwise complete
  // install. Found by building a REAL release and listing what it could serve.
  const source = script();
  expect(source).toContain("async function stageWebShell(");
  expect(source).toContain("await stageWebShell(outDir);");
  // And it refuses rather than shipping an app whose window is blank.
  expect(source).toContain("the web shell is not built");
  expect(source).toContain("build:web");
});

test("the packaging chain builds its own prerequisites", async () => {
  // `package:linux` used to assume the CEF host was already built — a
  // gitignored build directory, so a clean checkout failed at `cd build`. It now
  // names all four steps a Linux installable needs, in dependency order.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const chain = pkg.scripts["package:linux"]!;
  for (const step of [
    "desktop:cef:build",
    "build:distribution",
    "build:web",
    "release:build",
    "appimage",
  ])
    expect(chain, `missing ${step}`).toContain(step);
  // In order: the host, then the distribution, then the shell, then the tree,
  // then the packer.
  const order = [
    chain.indexOf("desktop:cef:build"),
    chain.indexOf("build:distribution"),
    chain.indexOf("build:web"),
    chain.indexOf("release:build"),
    chain.indexOf("appimage"),
  ];
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("the Windows chain builds its prerequisites too", async () => {
  // Linux's chain was assuming a gitignored CEF build directory existed; the
  // Windows one would have made the same mistake, so it names all four
  // prerequisites in dependency order before reaching the renderer.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const chain = pkg.scripts["package:windows"]!;
  for (const step of [
    "desktop:cef:build:windows",
    "build:distribution",
    "build:web",
    "release:build",
    "windows:installer-inputs",
  ])
    expect(chain, `missing ${step}`).toContain(step);
  // And the host build it names is the WINDOWS one: on this host a Windows host
  // cannot be built at all, which is why the command names the platform.
  expect(pkg.scripts["desktop:cef:build:windows"]).toContain(
    "build-cef-windows.ps1",
  );
});

test("a cross-platform release names the host build ITS platform needs", () => {
  // The error used to say "run npm run desktop:cef:build" for every target —
  // which on a Windows release is the Linux build, and cannot ever satisfy it.
  const source = script();
  expect(source).toContain("function hostBuildCommand(");
  expect(source).toContain("desktop:cef:build:windows (on Windows)");
  expect(source).toContain("desktop:cef:build (on macOS)");
});

test("a posix release carries no terminal executables — the tier is retired", () => {
  // The interactive terminal's default is the self-developed pty controller;
  // the fork's three binaries were dead weight on POSIX (measured: the whole
  // terminal suite passes with them hidden). The release now states that
  // contract instead of shipping 240 MB nobody runs.
  const source = script();
  // The staging skips the fork's three on POSIX after trimming whatever the
  // shared dist carried (the bridge is staged per platform either way — see
  // the pty-bridge pin below).
  const staging = source.slice(
    source.indexOf("async function stageTerminalNatives"),
    source.indexOf("async function stageDesktopHost"),
  );
  expect(staging).toContain("if (!isWindows) return;");
  // And the verifier treats a surviving directory as the retired tier coming
  // back, not as a platform accident: the message names the retirement.
  expect(source).toContain("a posix release carries a wezterm/ directory");
  expect(source).toContain("the pty backend");
});

test("ts-build stages the fork's trio on a Windows build only", () => {
  // Same retirement, one layer down: the distribution's plugin package must
  // not advertise a wezterm tier on POSIX. The trio is Windows-only now.
  const source = readFileSync(join(root, "scripts", "ts-build.ts"), "utf8");
  expect(source).toContain('process.platform === "win32"');
  // The trio is named on the Windows side of the fork condition.
  const condition = source.slice(
    source.indexOf("const forkExecutables = ("),
    source.indexOf(");", source.indexOf("const forkExecutables = (")),
  );
  for (const name of ['"wezterm"', '"wezterm-gui"', '"wezterm-mux-server"'])
    expect(condition, `${name} belongs on the Windows list`).toContain(name);
  // And the empty POSIX list still trims a stale directory, so the plugin's
  // release files can say the tier does not exist.
  expect(source).toContain("distribution mode — the native executables");
});

test("our own pty bridges ride their own directory, not the fork's", () => {
  // The bug this pins: the ConPTY bridge used to be staged into `wezterm/`
  // beside the fork's trio, and the retirement's POSIX trim of that directory
  // deleted it — a Windows release shipped with no bridge at all, measured.
  // The bridges now ride `pty-bridge/`, staged per platform from prebuilt.
  const source = readFileSync(join(root, "scripts", "ts-build.ts"), "utf8");
  expect(source).toContain('join(packageOutdir, "pty-bridge")');
  expect(source).toContain('"natalia-pty-bridge"');
  expect(source).toContain('"natalia-conpty-bridge.exe"');
  // And the release builder re-stages them from the same prebuilt drop, with
  // the positive-shape check that names the expected binary — the negative
  // check (a stray wezterm/ directory) existed first, and it was the missing
  // positive one that let the bridge-less release out.
  const standalone = readFileSync(
    join(root, "scripts", "build-standalone.ts"),
    "utf8",
  );
  expect(standalone).toContain("expectedBridge");
  expect(standalone).toContain("pty-bridge");
});

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

test("the tray is Windows-only, self-contained Shell_NotifyIcon, and dies with the window", () => {
  const tray = readFileSync(
    new URL("../../cef-desktop/src/simple_tray_win.cc", import.meta.url),
    "utf8",
  );
  const app = readFileSync(
    new URL("../../cef-desktop/src/simple_app.cc", import.meta.url),
    "utf8",
  );
  const cmake = readFileSync(
    new URL("../../cef-desktop/CMakeLists.txt", import.meta.url),
    "utf8",
  );

  // Pure Win32. A third-party tray library is the one thing that cannot happen
  // here: it is the reason the Linux tray is blocked on a system package.
  expect(tray).toContain("Shell_NotifyIconW");
  expect(tray).not.toMatch(/#include\s+<(ayatana|gtk|wx|qt)/iu);

  // The icon's callback goes to a message-only window, NOT a subclass of the
  // browser's — CEF's views framework owns that window's procedure.
  expect(tray).toContain("HWND_MESSAGE");
  expect(tray).toContain("kWindowClassName");
  // A class nobody registers is a CreateWindowExW that fails silently.
  expect(tray).toContain("RegisterClassExW");
  // Explorer restarting drops the icon; the documented fix is re-adding.
  expect(tray).toContain("kTaskbarCreatedMessage");

  // The menu carries both actions: back in, and back out.
  expect(tray).toContain("kCommandShow");
  expect(tray).toContain("kCommandQuit");
  expect(tray).toContain("SetForegroundWindow");

  // The icon is created only while the window is HIDDEN. A visible window plus a
  // tray icon is a second way to do the same thing.
  expect(app).toContain("EnsureTray");
  expect(app).toContain("window_ = window;");
  // And it is destroyed before the shell forgets the window, or a ghost lingers
  // in the tray after the process exits.
  expect(app).toContain("delete tray_;");

  // Only the Windows target compiles it, and links the shell library it calls.
  // The source-list block, not the CEF-root block that also begins with
  // `if(WIN32)` — slicing the first match would test the wrong thing.
  const listWin = cmake.indexOf("list(APPEND NATALIA_CEF_SRCS");
  expect(cmake.slice(listWin, cmake.indexOf("else()", listWin))).toContain(
    "simple_tray_win.cc",
  );
  expect(cmake).toContain("shell32");
  // Linux's source list must NOT gain it.
  expect(cmake.slice(cmake.indexOf("else()", listWin))).not.toContain(
    "simple_tray_win.cc",
  );
});

/**
 * The tray's own failure path, run as a binary.
 *
 * The test above pins CMake text — necessary (a machine without libappindicator must
 * still configure) but it does not run anything. What execution once established
 * about the tray lived in a comment with nothing behind it, and on a machine that DID
 * have a usable display the tray could be broken outright without a test noticing.
 *
 * `natalia-tray-probe` calls `TrayIcon::Create` and prints which of the two outcomes
 * it saw. It is built inside the appindicator branch, so its absence means "no
 * libappindicator here" and the test says so rather than failing — the same
 * distinction the tray itself makes between `Create` returning nullptr and crashing.
 *
 * Two ways this could lie, and how each is avoided: an exit code alone would pass on
 * a binary that never reached `Create` (observed — stdout was buffered and lost
 * through a pipe while the process still exited 0), so the assertion is on the printed
 * outcome, not the status. And a run with no panel is not a failure, so the probe is
 * asked what it saw instead of being asked to succeed.
 */
test("the Linux tray probe runs and reports what Create actually did", () => {
  const probe = resolve(
    import.meta.dir,
    "..",
    "..",
    "cef-desktop",
    "build",
    "natalia-tray-probe",
  );
  if (!existsSync(probe)) {
    // Loud, not silent. CI does not build the CEF host, so on every CI run this test
    // would find no binary — and returning quietly there means a pass in the summary
    // and no signal if the probe is later deleted, or stops being built at all. A
    // guard that cannot be seen failing is the failure this whole file is about, so
    // the two situations are told apart by the machine rather than assumed: a real
    // tray machine has libappindicator, and no binary then means it broke.
    const hasAppIndicator =
      Bun.spawnSync(["pkg-config", "--exists", "appindicator3-0.1"])
        .exitCode === 0;
    if (hasAppIndicator) {
      throw new Error(
        "libappindicator is present but natalia-tray-probe was not built: run " +
          "`cmake --build build --target natalia-tray-probe`. The tray would be " +
          "unprotected silently otherwise.",
      );
    }
    console.warn(
      "skipped: no libappindicator on this machine, so the tray is compiled out",
    );
    return;
  }
  const result = Bun.spawnSync([probe], { stderr: "ignore" });
  const stdout = result.stdout.toString();
  // Whatever it saw, it said so. An empty report means the probe did not reach its
  // own print, which is the failure worth catching — not a missing panel.
  expect(stdout, "the probe must report an outcome").toMatch(
    /TRAY_CREATED|TRAY_CREATE_RETURNED_NULL/,
  );
  if (stdout.includes("TRAY_CREATED")) {
    // Created here means the callbacks were armed and the object disposed — the
    // lifecycle the comment claimed, now checked rather than remembered.
    expect(stdout).toContain("CALLBACKS_ARMED show=0 quit=0");
    // And the exit entry the goal names: the menu the tray built carries both
    // commands, and activating them — what a click does — fires the callbacks.
    // A tray whose Quit is missing or un wired would fail HERE rather than at a
    // user's click, which is the whole point of asking the binary.
    expect(stdout, "the menu must carry the show and quit entries").toContain(
      "MENU_ENTRIES_FOUND",
    );
    expect(stdout).toContain("SHOW_CALLBACK_FIRED=1");
    expect(stdout).toContain("QUIT_CALLBACK_FIRED=1");
    expect(stdout).toContain("PASS");
    expect(stdout).toContain("DISPOSED_CLEANLY");
  }
});

test("the Linux tray is a detected system package, never a hard link", () => {
  // What execution established, so the structural pins below are not mistaken for
  // the whole story. Two probes, both on this Linux host:
  //   1. the tray class itself: TrayIcon::Create -> a GTK main-loop iteration ->
  //      dispose, clean exit, no crash. A StatusNotifier host IS alive on this host
  //      (`dbus-send … ListNames` shows org.kde.StatusNotifierWatcher and its
  //      Host-4374 items, and the probe run reports TRAY_CREATED against it) — the
  //      XEmbed SYSTEM_TRAY_S0 being empty is the older protocol and says nothing
  //      about this one. What is still NOT claimed: that the icon is visible on the
  //      panel. Registration is machine-checkable; pixels are a human's to confirm.
  //   2. the menu mechanism the tray depends on: a GtkMenuItem wired through
  //      g_signal_connect_swapped to a std::function fires both callbacks on
  //      activate, with no display (shows=1, quits=1).
  // What is NOT verified: that a panel shows the icon, and that a real human click
  // on it reaches the process. The probe activates the entries programmatically —
  // it pins the wiring from the visible entry to the callback, not the click.
  const cmake = readFileSync(
    new URL("../../cef-desktop/CMakeLists.txt", import.meta.url),
    "utf8",
  );
  const linuxTray = readFileSync(
    new URL("../../cef-desktop/src/simple_tray_linux.cc", import.meta.url),
    "utf8",
  );

  // A machine without the library must still build. That is the whole difference
  // from Windows, where Shell_NotifyIcon is always present: here the source is
  // compiled OUT when nothing is found, so there is no third state where the
  // link fails.
  expect(cmake).toContain("pkg_check_modules");
  expect(cmake).toContain("FindPkgConfig");
  // Both spellings must be in the SEARCH LIST, not merely named somewhere in the
  // file. Removing the Ayatana fork from the candidates while leaving it in the
  // STREQUAL comparison was a live mutation that the first version of this pin
  // did not catch — it only asserted the string appeared.
  const candidates = cmake.match(/set\(_AI_CANDIDATES\s+"([^"]+)"\)/u)![1]!;
  expect(candidates.split(";")).toEqual([
    "appindicator3-0.1",
    "ayatana-appindicator3-0.1",
  ]);
  expect(cmake).toContain("STREQUAL ayatana-appindicator3-0.1");

  // The tray module is checked TOGETHER with gtk+-3.0. Its own .pc Requires it,
  // and glib's headers arrive through that chain — checking the tray alone left
  // gdkconfig.h unable to find glib.h, which is how this was learned.
  expect(cmake).toMatch(
    /pkg_check_modules\(\s*_AI\s+\$\{_pkg\}\s+gtk\+-3\.0\s*\)/u,
  );

  // The define has to reach the COMPILER, not just CMake: setting the variable
  // alone compiled the file with the ifdef false and the tray silently absent.
  expect(cmake).toContain(
    "target_compile_definitions(natalia-cef-desktop PRIVATE NATALIA_HAVE_APPINDICATOR",
  );

  // The whole implementation is behind one ifdef, so the rest of the binary does
  // not know whether a tray exists.
  expect(linuxTray).toContain("#if defined(NATALIA_HAVE_APPINDICATOR)");
  expect(linuxTray).toContain("gtk_init_check");
  // PASSIVE, not simply going away: that is what removes the item from the panel.
  expect(linuxTray).toContain("APP_INDICATOR_STATUS_PASSIVE");
});

test("P23's fix re-applies the viewport before any output can flow", () => {
  const bridge = readFileSync(
    new URL(
      "../../../packages/plugins/native-terminal/src/win/natalia-conpty-bridge.cc",
      import.meta.url,
    ),
    "utf8",
  );

  // The mute pane: the console's init sequence arrives, then nothing. The child
  // is alive and blocked at zero CPU. The report's ranked direction was to
  // re-apply the spec's size once the child exists, because the host side of the
  // ConPTY viewport negotiation never ran.
  expect(bridge).toContain("ResizePseudoConsole(g_pseudoConsole, size)");

  // It must be BEFORE the output pump starts: a resize issued after the reader
  // is already blocked on the pipe is what failed, not a fix. The pump's CALL
  // SITE, not its definition — the function is defined earlier in the file, so
  // comparing against the definition made this assertion meaningless.
  const resizeAt = bridge.indexOf(
    "ResizePseudoConsole(g_pseudoConsole, size);",
  );
  const pumpAt = bridge.indexOf("CreateThread(nullptr, 0, pumpConsoleOutput");
  expect(resizeAt).toBeGreaterThan(0);
  expect(pumpAt).toBeGreaterThan(resizeAt);

  // And it must be AFTER the child exists: resizing before CreateProcessW is a
  // resize with nothing to negotiate.
  const createAt = bridge.indexOf("CreateProcessW(");
  expect(createAt).toBeGreaterThan(0);
  expect(resizeAt).toBeGreaterThan(createAt);

  // The handshake reports itself, so the next Windows run can confirm or refute
  // this in one run instead of re-deriving it from a silent pane.
  expect(bridge).toContain("viewport handshake requested");

  // The bridge must NOT silently drop the spec's env overlay while pretending it
  // applies it. The divergence from the POSIX bridge is real, and it is stated.
  const controller = readFileSync(
    new URL(
      "../../../packages/plugins/native-terminal/src/pty-terminal-controller.ts",
      import.meta.url,
    ),
    "utf8",
  );
  // The POSIX bridge honours the spec's env overlay; the ConPTY one does not.
  expect(controller).toContain('env.update(spec.get("env") or {})');
  expect(bridge).toContain("DIVERGENCE");
  // The ConPTY bridge is the Windows default, and this is the pin that says so:
  // no env request may stand between the controller and it. (The mute pane
  // that once justified the opt-in is fixed and CI-verified on the runner.)
  expect(controller).toContain("spawnWithConptyBridge(options)");
  expect(controller).not.toContain("NATALIA_TERMINAL_CONPTY");
});

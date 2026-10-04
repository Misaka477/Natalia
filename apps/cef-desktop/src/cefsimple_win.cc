// Copyright (c) 2013 The Chromium Embedded Framework Authors. All rights
// reserved. Use of this source code is governed by a BSD-style license that
// can be found in the LICENSE file.

// The Windows entry point, the counterpart of cefsimple_linux.cc.
//
// The Linux build enters through `main(argc, argv)`; on Windows a GUI
// subsystem process must enter through `wWinMain` — CEF's sub-processes are
// relaunched from the same executable, and the instance handle is what
// `CefMainArgs` carries there. The rest of the program is the same: the
// application code (simple_app/simple_handler) is CEF-152 views-framework code
// and platform-agnostic, with its X11-only parts already guarded by
// `#if defined(CEF_X11)`.
//
// Only this file is Windows-specific, which is why CMakeLists selects it per
// platform instead of globbing `src/*.cc`.

#include "simple_app.h"

#include <windows.h>
#include <shlobj.h>
#include <string>

#include "include/base/cef_logging.h"
#include "include/cef_command_line.h"

// When generating projects with CMake the CEF_USE_SANDBOX value will be defined
// automatically. Pass -DUSE_SANDBOX=OFF to the CMake command-line to disable
// use of the sandbox.
#if defined(CEF_USE_SANDBOX)
#include "include/cef_sandbox_win.h"

// The cef_sandbox.lib object file name is
// "<cef_binary>/lib/<configuration>/cef_sandbox.lib". It is intentionally NOT
// linked here: this build passes `-DUSE_SANDBOX=OFF` on purpose (see
// CMakeLists.txt for why a declared-but-uninitialized sandbox is worse than
// none). Declaring the pointer without linking keeps the reference honest if
// the flag is ever turned back on.
void* cef_sandbox_info = nullptr;
#else
// No_sandbox is the intended posture (see CMakeLists.txt). A declared but
// uninitialized sandbox puts the sub-processes under the seccomp policy with no
// broker, and every temp-file create comes back EPERM.
#endif

// Entry point function for all processes. The command-line parameter is
// spelled LPWSTR (not LPTSTR): `wWinMain`'s prototype in the Windows headers
// is always wide, and the UNICODE define that would widen LPTSTR is not
// guaranteed on this target — an LPTSTR here is a signed-vs-wide clash.
int APIENTRY wWinMain(HINSTANCE hInstance,
                      HINSTANCE hPrevInstance,
                      LPWSTR lpCmdLine,
                      int nCmdShow) {
  UNREFERENCED_PARAMETER(hPrevInstance);
  UNREFERENCED_PARAMETER(lpCmdLine);
  UNREFERENCED_PARAMETER(nCmdShow);

  // RUNTIME bisection switch, same binary both ways.
  //
  // The FIRST version of this switch read an ENVIRONMENT VARIABLE
  // (NATALIA_CEF_PROBE), and that produced a result too strange to leave alone:
  // the same binary, the same call site, initialised CEF with the variable set
  // and failed without it. So the switch is now a COMMAND-LINE ARGUMENT, which
  // cannot be read by libcef's own startup — if the outcome still follows the
  // flag, the flag's presence in the process environment block is what matters;
  // if it does not, then libcef was reading that environment variable and
  // changing its behaviour, and the fix is to stop setting it.
  // RUNTIME bisection switch, same binary both ways. ONE flag, ONE path: the
  // only place this acts is at the real CefInitialize call site below, so the
  // two runs differ in nothing except whether the call's result is reported and
  // the function returns there.
  //
  // (An earlier version also had an early-return probe block with its own
  // settings, which CONFOUNDED the experiment: with the flag set it returned
  // before ever reaching the real call site, so "the flag made it succeed" was
  // really "a different, simpler call succeeded". That early block is deleted;
  // this is the only probe left.)
  const bool probe_mode =
      ::GetCommandLineW() != nullptr &&
      wcsstr(::GetCommandLineW(), L"--natalia-probe") != nullptr;

#ifdef NATALIA_CEF_PROBE_ONLY
  // BISECTION PROBE, compiled in only with -DNATALIA_CEF_PROBE_ONLY=1.
  //
  // Everything is linked exactly as the shipping host links it — every
  // translation unit, every static initialiser, every constructor — and the only
  // thing skipped is the app's own startup (the browser, the window, the message
  // loop). So:
  //   still exits 38  => the fault is LINKED-IN: a static initialiser or
  //                      constructor that touches CEF state before main runs.
  //   reaches OK      => the fault is in the startup path this skipped.
  //
  // Measured, in order: probe with a null app -> OK; probe with SimpleApp -> OK.
  // So the linked-in code and SimpleApp are both innocent, and what is left is
  // the pair the real host does and this probe does not.
  {
    // BISECTION STEP 2: the cache_path is now the SAME directory the shipping
    // host uses (%LOCALAPPDATA%\Natalia\CEF), because "CEF-probe" was one of the
    // two remaining differences and this removes it. If the probe now fails, the
    // fault is state in that directory; if it still succeeds, the remaining
    // difference is the startup code after CefInitialize (command_line parsing,
    // the rest of settings, CefRunMessageLoop).
    CefMainArgs probe_args(hInstance);
    CefSettings probe;
    probe.no_sandbox = true;
    wchar_t probe_cache[MAX_PATH] = {0};
    if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, 0,
                                   probe_cache)) &&
        probe_cache[0] != 0) {
      std::wstring root(probe_cache);
      root += L"\\Natalia\\CEF";
      CreateDirectoryW(root.c_str(), nullptr);
      CefString(&probe.cache_path).FromWString(root);
    }
    // The app, created before the subprocess hand-off and passed to BOTH calls,
    // which is the documented shape. The real host passes nullptr to
    // CefExecuteProcess and the app only to CefInitialize.
    CefRefPtr<SimpleApp> probe_app(new SimpleApp);
    const int hand_off =
        CefExecuteProcess(probe_args, probe_app.get(), nullptr);
    if (hand_off >= 0)
      return hand_off;
    // BISECTION STEP 3: the one block the real host runs between the hand-off
    // and CefInitialize — it creates the GLOBAL command line and initialises it
    // from the process command line BEFORE CEF does. CEF initialises that same
    // global object itself, so doing it first is a candidate for the CHECK.
    CefRefPtr<CefCommandLine> probe_line =
        CefCommandLine::CreateCommandLine();
    probe_line->InitFromString(::GetCommandLineW());
    const bool ok =
        CefInitialize(probe_args, probe, probe_app.get(), nullptr);
    MessageBoxW(
        nullptr,
        ok ? L"CefInitialize OK (probe build)" : L"CefInitialize FAILED (probe build)",
        L"natalia-cef probe", MB_OK);
    return ok ? 0 : static_cast<int>(CefGetExitCode());
  }
#endif

  // Provide CEF with command-line arguments. On Windows the instance handle
  // travels here (Linux passes argc/argv instead).
  CefMainArgs main_args(hInstance);

  // Where the startup trace goes. Declared here, filled once the cache root is
  // known, because an installed host exited with code 38 and NOTHING said why:
  // no window, no child process, no stdout, and a CEF log holding one unrelated
  // warning. Every step below stamps a line here, which survives the exit.
  std::wstring trace_path;
  auto trace = [&trace_path](const char* step) {
    if (trace_path.empty()) return;
    HANDLE file = CreateFileW(trace_path.c_str(), FILE_APPEND_DATA,
                              FILE_SHARE_READ, nullptr, OPEN_ALWAYS,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return;
    std::string line(step);
    line += "\n";
    DWORD written = 0;
    WriteFile(file, line.data(), static_cast<DWORD>(line.size()), &written,
              nullptr);
    CloseHandle(file);
  };

  trace("entered wWinMain");
  // The app, created BEFORE the subprocess hand-off and passed to BOTH calls.
  //
  // This is the fix for the exit-38 crash, and it was found by bisection, not by
  // reading: passing `nullptr` here while passing `app.get()` to CefInitialize
  // made CefInitialize fail with a Chromium CHECK (STATUS_BREAKPOINT at one fixed
  // offset in libcef.dll, CefGetExitCode() == 38, no window, no message). The
  // probe build — same sources, same link, same libcef — initialised fine the
  // moment the app was given to this call too. A null app makes CEF install its
  // own default app for the hand-off, and the later CefInitialize with a
  // different one contradicts it.
  CefRefPtr<SimpleApp> app(new SimpleApp);

  // CEF applications have multiple sub-processes (render, GPU, etc) that share
  // the same executable. This function checks the command-line and, if this is
  // a sub-process, executes the appropriate logic.
  int exit_code = CefExecuteProcess(main_args, app.get(), nullptr);
  trace("CefExecuteProcess returned");
  if (exit_code >= 0) {
    // The sub-process has completed so return here.
    trace("subprocess path; returning its code");
    return exit_code;
  }

  // Parse command-line arguments for use in this method.
  CefRefPtr<CefCommandLine> command_line =
      CefCommandLine::CreateCommandLine();
  command_line->InitFromString(::GetCommandLineW());

  // Specify CEF global settings here.
  CefSettings settings;

  // The cache root is PER-USER, not per-install-directory. CEF's default is
  // derived from the executable's own location, which is exactly the case its
  // startup warning names ("Please customize CefSettings.root_cache_path ...
  // may lead to unintended process singleton behavior"): two installations, or
  // an install directory a non-admin user cannot write, share one cache root
  // and the singleton logic decides the second launcher should hand off to the
  // first — so `CefInitialize` fails, `CefGetExitCode()` is returned, and the
  // program exits with no window and no message. That is the exit 38 an
  // installed copy died with.
  //
  // `%LOCALAPPDATA%` is per-user and always writable; the subdirectory keeps
  // this app's cache separate from the dev build's, which still runs from a
  // checkout and would otherwise collide on the default path.
  wchar_t cache_root[MAX_PATH] = {0};
  if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, 0,
                                 cache_root)) &&
      cache_root[0] != 0) {
    std::wstring root(cache_root);
    root += L"\\Natalia\\CEF";
    CreateDirectoryW(root.c_str(), nullptr);
    // cache_path — the browser's user-data directory, and the thing Chromium's
    // ProcessSingleton keys on. Setting it to a per-user path is what keeps two
    // installs (or an install and the dev build) from fighting over one lock.
    //
    // The history here is worth keeping: setting `root_cache_path` INSTEAD made
    // CefInitialize return false with exit code 38 and an empty CEF log, and the
    // verbose log then showed why — Chromium's ProcessSingleton found a lock it
    // believed belonged to a live instance, ran `RunDeElevated` to notify it,
    // and got ACCESS_DENIED (0x5), so init gave up. That is the process-singleton
    // hand-off path CEF's own comment warns about, and with no cache_path the
    // singleton's directory was not the one being cleaned between runs. CEF's
    // examples set cache_path; this does too.
    CefString(&settings.cache_path).FromWString(root);
    CefString(&settings.cache_path).FromWString(root);
    trace_path = root + L"\\startup-trace.txt";
  }

#if !defined(CEF_USE_SANDBOX)
  settings.no_sandbox = true;
#else
  settings.no_sandbox = false;
  CefString(&settings.cache_path).FromString(".\\cache");
#endif

  // SimpleApp implements application-level callbacks for the browser process.
  // It will create the first browser instance in OnContextInitialized() after
  // CEF has initialized. (The instance itself is created above, before
  // CefExecuteProcess — see the comment there for why that ordering matters.)

  // Initialize the CEF browser process. May return false if initialization
  // fails or if early exit is desired (for example, due to process singleton
  // relaunch behavior).
  trace("before CefInitialize");
  // RUNTIME PROBE AT THE REAL CALL SITE: the greatest narrowing possible — same
  // function, same variables, same everything, and only the message box after.
  // If THIS fails, the arguments themselves are the fault and the message box
  // names which one; the earlier standalone-probe block above is then only
  // useful for the steps before this point.
  if (probe_mode) {
    const bool ok = CefInitialize(main_args, settings, app.get(),
#if defined(CEF_USE_SANDBOX)
                                  cef_sandbox_info
#else
                                  nullptr
#endif
    );
    const wchar_t* verdict = ok ? L"CefInitialize OK at the real call site"
                                : L"CefInitialize FAILED at the real call site";
    MessageBoxW(nullptr, verdict, L"natalia-cef runtime probe", MB_OK);
    return ok ? 0 : static_cast<int>(CefGetExitCode());
  }
  const bool cef_initialized =
      CefInitialize(main_args, settings, app.get(),
#if defined(CEF_USE_SANDBOX)
                    cef_sandbox_info
#else
                    nullptr
#endif
      );
  trace(cef_initialized ? "CefInitialize ok" : "CefInitialize FAILED");
  if (!cef_initialized) {
    const int code = CefGetExitCode();
    char line[96] = {0};
    _snprintf_s(line, sizeof(line), _TRUNCATE,
                "CefGetExitCode=%d; returning it", code);
    trace(line);
    return code;
  }

  // Run the CEF message loop. This will block until CefQuitMessageLoop() is
  // called.
  trace("entering CefRunMessageLoop");
  CefRunMessageLoop();
  trace("CefRunMessageLoop returned");

  // Shut down CEF.
  CefShutdown();
  trace("CefShutdown done");

  return 0;
}

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

  // Provide CEF with command-line arguments. On Windows the instance handle
  // travels here (Linux passes argc/argv instead).
  CefMainArgs main_args(hInstance);

  // CEF applications have multiple sub-processes (render, GPU, etc) that share
  // the same executable. This function checks the command-line and, if this is
  // a sub-process, executes the appropriate logic.
  int exit_code = CefExecuteProcess(main_args, nullptr, nullptr);
  if (exit_code >= 0) {
    // The sub-process has completed so return here.
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
    CefString(&settings.root_cache_path).FromWString(root);
    CefString(&settings.cache_path).FromWString(root + L"\\cache");
    // The log file, so a future failure has somewhere to say what happened
    // instead of exiting silently.
    CefString(&settings.log_file).FromWString(root + L"\\cef.log");
    settings.log_severity = LOGSEVERITY_WARNING;
  }

#if !defined(CEF_USE_SANDBOX)
  settings.no_sandbox = true;
#else
  settings.no_sandbox = false;
  CefString(&settings.cache_path).FromString(".\\cache");
#endif

  // SimpleApp implements application-level callbacks for the browser process.
  // It will create the first browser instance in OnContextInitialized() after
  // CEF has initialized.
  CefRefPtr<SimpleApp> app(new SimpleApp);

  // Initialize the CEF browser process. May return false if initialization
  // fails or if early exit is desired (for example, due to process singleton
  // relaunch behavior).
  if (!CefInitialize(main_args, settings, app.get(),
#if defined(CEF_USE_SANDBOX)
                     cef_sandbox_info
#else
                     nullptr
#endif
                     )) {
    return CefGetExitCode();
  }

  // Run the CEF message loop. This will block until CefQuitMessageLoop() is
  // called.
  CefRunMessageLoop();

  // Shut down CEF.
  CefShutdown();

  return 0;
}

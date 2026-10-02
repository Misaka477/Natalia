// Copyright (c) 2013 The Chromium Embedded Framework Authors. All rights
// reserved. Use of this source code is governed by a BSD-style license that
// can be found in the LICENSE file.

#include "simple_app.h"

#include <string>

#include "include/cef_browser.h"
#include "include/cef_command_line.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_window.h"
#include "include/wrapper/cef_helpers.h"
#include "simple_handler.h"

#include <cstdlib>

#if defined(OS_WIN)
#include "simple_tray_win.h"
#include <shellapi.h>
#elif defined(NATALIA_HAVE_APPINDICATOR)
// The tray is a detected system package, not a requirement: this ifdef is how
// the same source builds on a machine without it.
#include "simple_tray_linux.h"
#endif

namespace {

// The close policy, read once per window so a torn-down environment cannot
// flip it between the ask and the answer.
//
// NATALIA_MINIMISE_ON_CLOSE=1 turns the window's close button into "hide and
// keep running", which is the only mode in which a relaunch has a window to
// bring back. Unset (the default) means the ordinary application behaviour:
// closing the window exits the process and the launcher's trap releases the
// runtime with it. The policy's wording lives in window-policy.ts, mirror with
// the tests that pin it.
//
// This delegate is the CROSS-PLATFORM one (CefWindowDelegate), so all three
// platforms share this decision. The per-platform residue, and why each is not
// here:
//
//   Linux/X11   nothing further: refusing CanClose keeps the browser alive.
//   Windows     nothing further: refusing CanClose keeps the process; the
//               launcher's Job Object only fires once the process really ends.
//   macOS       MORE IS REQUIRED AND NOT YET DONE. Cocoa's
//               `applicationShouldTerminateAfterLastWindowClosed` defaults to
//               true, so closing the LAST window ends the process even when
//               CanClose says no. Intercepting it means an NSApplicationDelegate
//               override (Objective-C++), which needs a macOS toolchain to build
//               and verify. Until that exists, the minimise mode is honest on
//               macOS only while SOME window remains open.
bool MinimiseOnClose() {
  const char* raw = std::getenv("NATALIA_MINIMISE_ON_CLOSE");
  if (raw == nullptr) return false;
  std::string value(raw);
  return value == "1" || value == "true" || value == "yes" || value == "on";
}

}  // namespace

namespace {

// When using the Views framework this object provides the delegate
// implementation for the CefWindow that hosts the Views-based browser.
class SimpleWindowDelegate : public CefWindowDelegate {
 public:
  SimpleWindowDelegate(CefRefPtr<CefBrowserView> browser_view,
                       cef_runtime_style_t runtime_style,
                       cef_show_state_t initial_show_state)
      : browser_view_(browser_view),
        runtime_style_(runtime_style),
        initial_show_state_(initial_show_state) {}

  SimpleWindowDelegate(const SimpleWindowDelegate&) = delete;
  SimpleWindowDelegate& operator=(const SimpleWindowDelegate&) = delete;

  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    // Add the browser view and show the window.
    window->AddChildView(browser_view_);
    window_ = window;

    if (initial_show_state_ != CEF_SHOW_STATE_HIDDEN) {
      window->Show();
    }
  }

  void OnWindowDestroyed(CefRefPtr<CefWindow> window) override {
    window_ = nullptr;
#if defined(OS_WIN) || defined(NATALIA_HAVE_APPINDICATOR)
    // The icon must go before the shell forgets the window, or a ghost lingers
    // in the panel after the process exits.
    delete tray_;
    tray_ = nullptr;
#endif
    browser_view_ = nullptr;
  }

  bool CanClose(CefRefPtr<CefWindow> window) override {
    if (MinimiseOnClose()) {
      // Hide, do not dispose: the runtime is the app's memory and the
      // single-instance lock is what a relaunch talks to, so a hidden window
      // still has somewhere to come back to. Refusing the close keeps CEF from
      // tearing the browser down behind us.
      window->Hide();
      minimised_ = true;
#if defined(OS_WIN)
      EnsureTray(window);
#elif defined(NATALIA_HAVE_APPINDICATOR)
      EnsureTray();
#endif
      return false;
    }
    // Allow the window to close if the browser says it's OK.
    CefRefPtr<CefBrowser> browser = browser_view_->GetBrowser();
    if (browser) {
      return browser->GetHost()->TryCloseBrowser();
    }
    return true;
  }

  /** Show a hidden window again (a relaunch's "bring it back"). */
  void ShowWindow(CefRefPtr<CefWindow> window) {
    if (minimised_ && window) {
      window->Show();
      minimised_ = false;
    }
  }

  bool IsMinimised() const { return minimised_; }

  CefSize GetPreferredSize(CefRefPtr<CefView> view) override {
    return CefSize(800, 600);
  }

  cef_show_state_t GetInitialShowState(CefRefPtr<CefWindow> window) override {
    return initial_show_state_;
  }

  cef_runtime_style_t GetWindowRuntimeStyle() override {
    return runtime_style_;
  }

#if defined(OS_WIN)
  // The tray exists ONLY while the window is hidden: a visible window plus a
  // tray icon is a second way to do the same thing, and the icon's whole purpose
  // is to be the way back into a window the user cannot see.
  void EnsureTray(CefRefPtr<CefWindow> window) {
    if (tray_) return;
    CefWindowHandle native = window->GetWindowHandle();
    HICON icon = reinterpret_cast<HICON>(::GetClassLongPtrW(native, GCLP_HICON));
    tray_ = natalia::TrayIcon::Create(
        icon, L"Natalia",
        natalia::TrayCallbacks{
            [this]() {
              if (window_) {
                window_->Show();
                minimised_ = false;
              }
            },
            [this]() {
              // The user's explicit exit: the browser closes for real, which
              // ends the message loop and so the process. This is deliberately
              // NOT CanClose — that path would hide again.
              if (window_) window_->Close();
            },
        });
  }
#endif

#if defined(NATALIA_HAVE_APPINDICATOR)
  void EnsureTray() {
    if (tray_) return;
    tray_ = natalia::TrayIcon::Create(
        "Natalia",
        natalia::TrayCallbacks{
            [this]() {
              if (window_) {
                window_->Show();
                minimised_ = false;
              }
            },
            [this]() { if (window_) window_->Close(); },
        });
  }
#endif

 private:
  CefRefPtr<CefBrowserView> browser_view_;
  CefRefPtr<CefWindow> window_;
  const cef_runtime_style_t runtime_style_;
  const cef_show_state_t initial_show_state_;
  bool minimised_ = false;
#if defined(OS_WIN) || defined(NATALIA_HAVE_APPINDICATOR)
  // Windows and Linux call the same two-function class by the same name through
  // deliberately identical headers; nothing here needs to know which one it is.
  natalia::TrayIcon* tray_ = nullptr;
#endif

  IMPLEMENT_REFCOUNTING(SimpleWindowDelegate);
};

class SimpleBrowserViewDelegate : public CefBrowserViewDelegate {
 public:
  explicit SimpleBrowserViewDelegate(cef_runtime_style_t runtime_style)
      : runtime_style_(runtime_style) {}

  SimpleBrowserViewDelegate(const SimpleBrowserViewDelegate&) = delete;
  SimpleBrowserViewDelegate& operator=(const SimpleBrowserViewDelegate&) =
      delete;

  bool OnPopupBrowserViewCreated(CefRefPtr<CefBrowserView> browser_view,
                                 CefRefPtr<CefBrowserView> popup_browser_view,
                                 bool is_devtools) override {
    // Create a new top-level Window for the popup. It will show itself after
    // creation.
    CefWindow::CreateTopLevelWindow(new SimpleWindowDelegate(
        popup_browser_view, runtime_style_, CEF_SHOW_STATE_NORMAL));

    // We created the Window.
    return true;
  }

  cef_runtime_style_t GetBrowserRuntimeStyle() override {
    return runtime_style_;
  }

 private:
  const cef_runtime_style_t runtime_style_;

  IMPLEMENT_REFCOUNTING(SimpleBrowserViewDelegate);
};

}  // namespace

SimpleApp::SimpleApp() = default;

void SimpleApp::OnContextInitialized() {
  CEF_REQUIRE_UI_THREAD();

  CefRefPtr<CefCommandLine> command_line =
      CefCommandLine::GetGlobalCommandLine();

  // Check if Alloy style will be used.
  cef_runtime_style_t runtime_style = CEF_RUNTIME_STYLE_DEFAULT;
  bool use_alloy_style = command_line->HasSwitch("use-alloy-style");
  if (use_alloy_style) {
    runtime_style = CEF_RUNTIME_STYLE_ALLOY;
  }

  // SimpleHandler implements browser-level callbacks.
  CefRefPtr<SimpleHandler> handler(new SimpleHandler(use_alloy_style));

  // Specify CEF browser settings here.
  CefBrowserSettings browser_settings;

  std::string url;

  // Check if a "--url=" value was provided via the command-line. If so, use
  // that instead of the default URL.
  url = command_line->GetSwitchValue("url");
  if (url.empty()) {
    url = "http://127.0.0.1:5178/";
  }

  // Views is enabled by default (add `--use-native` to disable).
  const bool use_views = !command_line->HasSwitch("use-native");

  // If using Views create the browser using the Views framework, otherwise
  // create the browser using the native platform framework.
  if (use_views) {
    // Create the BrowserView.
    CefRefPtr<CefBrowserView> browser_view = CefBrowserView::CreateBrowserView(
        handler, url, browser_settings, nullptr, nullptr,
        new SimpleBrowserViewDelegate(runtime_style));

    // Optionally configure the initial show state.
    cef_show_state_t initial_show_state = CEF_SHOW_STATE_NORMAL;
    const std::string& show_state_value =
        command_line->GetSwitchValue("initial-show-state");
    if (show_state_value == "minimized") {
      initial_show_state = CEF_SHOW_STATE_MINIMIZED;
    } else if (show_state_value == "maximized") {
      initial_show_state = CEF_SHOW_STATE_MAXIMIZED;
    }
#if defined(OS_MAC)
    // Hidden show state is only supported on MacOS.
    else if (show_state_value == "hidden") {
      initial_show_state = CEF_SHOW_STATE_HIDDEN;
    }
#endif

    // Create the Window. It will show itself after creation.
    CefWindow::CreateTopLevelWindow(new SimpleWindowDelegate(
        browser_view, runtime_style, initial_show_state));
  } else {
    // Information used when creating the native window.
    CefWindowInfo window_info;

#if defined(OS_WIN)
    // On Windows we need to specify certain flags that will be passed to
    // CreateWindowEx().
    window_info.SetAsPopup(nullptr, "cefsimple");
#endif

    // Alloy style will create a basic native window. Chrome style will create a
    // fully styled Chrome UI window.
    window_info.runtime_style = runtime_style;

    // Create the first browser window.
    CefBrowserHost::CreateBrowser(window_info, handler, url, browser_settings,
                                  nullptr, nullptr);
  }
}

CefRefPtr<CefClient> SimpleApp::GetDefaultClient() {
  // Called when a new browser window is created via Chrome style UI.
  return SimpleHandler::GetInstance();
}

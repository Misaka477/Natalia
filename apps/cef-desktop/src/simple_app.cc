// Copyright (c) 2013 The Chromium Embedded Framework Authors. All rights
// reserved. Use of this source code is governed by a BSD-style license that
// can be found in the LICENSE file.

#include "simple_app.h"

#include <string>

#include "app_icon_png.h"
#include "include/cef_browser.h"
#include "include/cef_command_line.h"
#include "include/cef_image.h"
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
// ONE EXIT IS NOT THE POLICY'S TO SWALLOW: the tray's Quit. The tray exists
// only while the window is hidden, which only happens in minimise mode, so
// without an override the one state where the exit entry is visible is the one
// state where it does nothing — CEF calls CanClose for `CefWindow::Close()`
// too ("user-initiated window close actions and when CefWindow::Close() is
// called", cef_window_delegate.h), so a Quit that closes the window lands in
// the minimise branch and hides again. `quit_requested_` is set before that
// Close(), and checked FIRST in CanClose. window-policy.ts mirrors the same
// rule ("tray-quit" overrides the policy) and a test compares the two.
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

// The app's own icon on the RUNNING window — the title bar, the taskbar
// button, the alt-tab entry, and (on Windows, through the window class) the
// tray that simple_tray_win.cc reads back.
//
// Why bytes and not a file: the icon's location differs between a checkout and
// an installed copy, and a missing icon file degrades silently to the platform
// default. The binary always has itself, so the PNG (assets/icons/icon-128.png,
// generated into app_icon_png.h) travels inside the executable.
CefRefPtr<CefImage> AppIconImage() {
  CefRefPtr<CefImage> image = CefImage::CreateImage();
  if (!image->AddPNG(1.0f, natalia::kAppIconPng, natalia::kAppIconPngSize)) {
    return nullptr;
  }
  return image;
}

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

    // The app icon, before the first paint: a window that appears without it
    // shows the platform default for as long as it is on screen. App icon
    // (taskbar/alt-tab) and window icon (title bar) are separate calls in
    // CEF, and both want the same image.
    if (CefRefPtr<CefImage> icon = AppIconImage()) {
      window->SetWindowAppIcon(icon);
      window->SetWindowIcon(icon);
    }

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
    // The tray's explicit quit, checked FIRST: it is the one close the minimise
    // policy must not answer with a hide. See the policy comment above for why
    // this ordering is the whole fix.
    if (quit_requested_) return true;
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
              // ends the message loop and so the process, and the launcher's
              // trap releases the runtime with it. The flag is what makes it
              // "for real" — CEF routes CefWindow::Close() through CanClose
              // (see cef_window_delegate.h), and without it this click would
              // land in the minimise branch and hide the very window whose
              // tray was just used to ask for the exit.
              quit_requested_ = true;
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
            [this]() {
              // Same two steps as Windows: the explicit exit sets the flag
              // CanClose checks first, so the minimise policy cannot swallow
              // the tray's own Quit.
              quit_requested_ = true;
              if (window_) window_->Close();
            },
        });
  }
#endif

 private:
  CefRefPtr<CefBrowserView> browser_view_;
  CefRefPtr<CefWindow> window_;
  const cef_runtime_style_t runtime_style_;
  const cef_show_state_t initial_show_state_;
  bool minimised_ = false;
  /**
   * Set by the tray's Quit before it closes the window, and checked first in
   * CanClose. It exists because the tray only exists while the window is
   * hidden, which only happens under the minimise policy — without this the
   * explicit exit would be answered with another hide.
   */
  bool quit_requested_ = false;
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
  // Remembered so GetDefaultClient can answer without building a handler at a
  // point where building one is illegal (see simple_app.h).
  default_client_ = handler;

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
  //
  // NEVER the singleton. `SimpleHandler::GetInstance()` builds a handler the
  // first time it is asked, and CEF asks during CefInitialize — before the UI
  // thread, before OnContextInitialized, before anything that handler is
  // allowed to touch. Returning it there is what made every launch of the
  // installed host die inside CefInitialize with a Chromium CHECK:
  // STATUS_BREAKPOINT at one fixed offset, CefGetExitCode() == 38, no window,
  // no message.
  //
  // The evidence, by bisection: a minimal control app with this same interface
  // and GetDefaultClient() returning nullptr reaches "CefInitialize OK" and
  // stays up; this host with an EMPTY OnContextInitialized (creating nothing at
  // all) still exits 38 — so the browser creation was never the problem, this
  // return was. The handler that OnContextInitialized creates is the one that
  // owns the window, and it is stored here so a later Chrome-style popup still
  // finds a client.
  return default_client_;
}

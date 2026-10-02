// Copyright (c) 2026 The Natalia Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
//
// The Windows tray icon.
//
// A window that hides on close (the minimise policy) leaves the process running
// with nothing on screen, which is a trap unless the user can get back in — and
// back out. This is the "back in and out": a notification-area icon with a menu
// holding Show and Quit.
//
// It is built on Shell_NotifyIcon/Win32 only. No third-party tray library, which
// is the whole reason it can exist here at all: the Linux counterpart needs
// libayatana-appindicator and the macOS one needs NSStatusItem, and neither of
// those has a Windows equivalent worth adding a dependency for.
//
// The callback arrives on a dedicated MESSAGE-ONLY window rather than the CEF
// window. CEF's views framework owns that window's procedure, and subclassing it
// to catch a callback message is how a shell extension ends up fighting a
// renderer. A private HWND_MESSAGE keeps the icon's lifetime and the CEF
// window's lifetime independent, which also means a failed icon cannot take the
// browser down with it.

#ifndef CEF_TESTS_CEFSIMPLE_SIMPLE_TRAY_WIN_H_
#define CEF_TESTS_CEFSIMPLE_SIMPLE_TRAY_WIN_H_

#include <functional>
#include <string>

#include <windows.h>

namespace natalia {

// The actions the tray's menu can request. The owner decides what Show and Quit
// mean for its own window and runtime.
struct TrayCallbacks {
  std::function<void()> on_show;
  std::function<void()> on_quit;
};

// One notification-area icon. Created with a tooltip and the two menu commands;
// destroyed by the destructor, which removes the icon before the window goes so
// a stale ghost cannot linger in the tray after the process exits.
class TrayIcon {
 public:
  TrayIcon(const TrayIcon&) = delete;
  TrayIcon& operator=(const TrayIcon&) = delete;

  // Returns nullptr only when the message-only window could not be created; an
  // icon the SHELL refuses still returns an object whose destructor removes the
  // window, so a caller that checks non-null gets a tray that merely never
  // appears — which is the honest degradation.
  static TrayIcon* Create(HICON icon,
                          const std::wstring& tooltip,
                          const TrayCallbacks& callbacks);

  ~TrayIcon();

  // Re-adds the icon after a TaskbarCreated broadcast (Explorer restarting),
  // which is the documented case where the shell silently drops it.
  void RestoreAfterTaskbarCreated();

 private:
  TrayIcon() = default;

  static LRESULT CALLBACK WindowProc(HWND hwnd,
                                     UINT message,
                                     WPARAM w_param,
                                     LPARAM l_param);

  bool RegisterIcon();
  void ShowContextMenu();

  HWND hwnd_ = nullptr;
  NOTIFYICONDATA icon_data_ = {};
  HICON icon_ = nullptr;
  std::wstring tooltip_;
  TrayCallbacks callbacks_;
  bool registered_ = false;
};

}  // namespace natalia

#endif  // CEF_TESTS_CEFSIMPLE_SIMPLE_TRAY_WIN_H_

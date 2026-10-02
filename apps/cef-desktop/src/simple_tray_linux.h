// Copyright (c) 2026 The Natalia Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
//
// The Linux tray icon.
//
// The same contract as the Windows one (simple_tray_win.h): a window that hides
// on close leaves the process running with nothing on screen, and this is the
// way back in and out. See simple_app.cc's minimise branch, which creates it in
// the same place.
//
// It is a StatusNotifierItem via libappindicator, which is the protocol every
// modern Linux desktop understands — GNOME (with an extension), KDE, XFCE, MATE,
// Cinnamon. The alternative, the raw freedesktop XEmbed tray, predates all of
// them and is invisible on GNOME by design.
//
// WHY THIS IS NOT A HARD DEPENDENCY, and why that matters more here than on
// Windows: libappindicator is a system package, so a machine without it must
// still build and run. CMake looks for either spelling of it — the original
// `appindicator3-0.1` and the maintained Ayatana fork
// `ayatana-appindicator3-0.1`, whose API is identical — and compiles this file
// out when neither is found. There is no third option where the link fails.
//
// The whole implementation is behind one ifdef, so the rest of the binary does
// not need to know whether a tray exists.

#ifndef CEF_TESTS_CEFSIMPLE_SIMPLE_TRAY_LINUX_H_
#define CEF_TESTS_CEFSIMPLE_SIMPLE_TRAY_LINUX_H_

#if defined(NATALIA_HAVE_APPINDICATOR)

#include <functional>

#include <gtk/gtk.h>

#if defined(NATALIA_AYATANA_APPINDICATOR)
#include <libayatana-appindicator/app-indicator.h>
#else
#include <libappindicator/app-indicator.h>
#endif

namespace natalia {

struct TrayCallbacks {
  std::function<void()> on_show;
  std::function<void()> on_quit;
};

// One indicator. Created with a title and the two menu commands; the destructor
// sets the status to PASSIVE, which is what removes it from the panel.
class TrayIcon {
 public:
  TrayIcon(const TrayIcon&) = delete;
  TrayIcon& operator=(const TrayIcon&) = delete;

  // Returns nullptr when GTK itself cannot start, which is a machine without a
  // display — the caller then works window-only.
  static TrayIcon* Create(const char* title, const TrayCallbacks& callbacks);

  ~TrayIcon();

 private:
  TrayIcon() = default;

  AppIndicator* indicator_ = nullptr;
  GtkWidget* menu_ = nullptr;
};

}  // namespace natalia

#endif  // NATALIA_HAVE_APPINDICATOR
#endif  // CEF_TESTS_CEFSIMPLE_SIMPLE_TRAY_LINUX_H_

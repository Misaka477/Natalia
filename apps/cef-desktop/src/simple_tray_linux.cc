// Copyright (c) 2026 The Natalia Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
//
// The Linux tray icon — see simple_tray_linux.h for why the library is detected
// rather than required.

#include "simple_tray_linux.h"

#if defined(NATALIA_HAVE_APPINDICATOR)

namespace natalia {

TrayIcon* TrayIcon::Create(const char* title,
                           const TrayCallbacks& callbacks) {
  // GTK must be initialised exactly once per process, and it must be the SAME
  // initialisation CEF uses. CEF's Linux browser already initialises GTK (the
  // file dialogs need it), so calling gtk_init_check here rather than gtk_init
  // avoids double-initialisation and, unlike the hard variant, does not abort
  // the process when it fails.
  if (!gtk_init_check(nullptr, nullptr)) return nullptr;

  auto* tray = new TrayIcon();
  tray->indicator_ = app_indicator_new(
      "natalia", "indicator-messages", APP_INDICATOR_CATEGORY_APPLICATION_STATUS);
  if (!tray->indicator_) {
    delete tray;
    return nullptr;
  }
  app_indicator_set_title(tray->indicator_, title);

  tray->menu_ = gtk_menu_new();
  GtkWidget* show = gtk_menu_item_new_with_label("Show Natalia");
  gtk_menu_shell_append(GTK_MENU_SHELL(tray->menu_), show);
  gtk_menu_shell_append(GTK_MENU_SHELL(tray->menu_),
                        gtk_separator_menu_item_new());
  GtkWidget* quit = gtk_menu_item_new_with_label("Quit");
  gtk_menu_shell_append(GTK_MENU_SHELL(tray->menu_), quit);

  // The callbacks are copied into the closure: the menu outlives the CefWindow
  // that created it only if the owner keeps the TrayIcon alive, which
  // SimpleWindowDelegate does (it deletes it in OnWindowDestroyed).
  auto* on_show = new std::function<void()>(callbacks.on_show);
  auto* on_quit = new std::function<void()>(callbacks.on_quit);
  g_signal_connect_swapped(
      show, "activate", G_CALLBACK(+[](gpointer data) {
        (*static_cast<std::function<void()>*>(data))();
      }),
      on_show);
  g_signal_connect_swapped(
      quit, "activate", G_CALLBACK(+[](gpointer data) {
        (*static_cast<std::function<void()>*>(data))();
      }),
      on_quit);
  // Unref'd on destroy: the closures own themselves once handed to GTK, and the
  // menu's finaliser releases them.
  g_object_ref(tray->menu_);
  gtk_widget_show_all(tray->menu_);
  app_indicator_set_menu(tray->indicator_, GTK_MENU(tray->menu_));

  // ACTIVE, not ATTENTION: the icon belongs in the panel while the window is
  // hidden, not as a transient highlight.
  app_indicator_set_status(tray->indicator_, APP_INDICATOR_STATUS_ACTIVE);
  return tray;
}

TrayIcon::~TrayIcon() {
  // PASSIVE removes the item from the panel. Doing this in the destructor is the
  // whole reason the delegate deletes the tray before the process exits: without
  // it the item lingers until the panel notices the DeathPing.
  if (indicator_) {
    app_indicator_set_status(indicator_, APP_INDICATOR_STATUS_PASSIVE);
    g_object_unref(indicator_);
    indicator_ = nullptr;
  }
  if (menu_) {
    g_object_unref(menu_);
    menu_ = nullptr;
  }
}

}  // namespace natalia

#endif  // NATALIA_HAVE_APPINDICATOR

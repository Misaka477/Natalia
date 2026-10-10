// Copyright (c) 2026 The Natalia Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
//
// The Linux tray icon — see simple_tray_linux.h for why the library is detected
// rather than required.

#include "simple_tray_linux.h"

#if defined(NATALIA_HAVE_APPINDICATOR)

// g_stat / GStatBuf: gtk.h does not pull in gstdio.h, and the icon cache is
// stat-ed before it is trusted.
#include <glib/gstdio.h>

#include "app_icon_png.h"

namespace {

// The tray's icon, as a GTK icon theme the panel can resolve.
//
// A StatusNotifierItem is identified to the panel by icon NAME, and the panel
// resolves the name in an icon theme — which is why the stock call passes
// "indicator-messages" (a name every theme has) and why shipping our own icon
// means giving the theme a place to find it. libappindicator sends the path
// given to app_indicator_new_with_path to the panel as the StatusNotifierItem
// IconThemePath property (verified: the property and its NewIconThemePath
// signal are in the library), and the panel adds it to its own search path.
// So the path is a SEARCH-PATH ENTRY, which is what fixes the layout below.
//
// The embedded PNG (assets/icons/icon-128.png, generated into app_icon_png.h)
// is written into the user's cache dir rather than next to the binary, because
// the binary's location differs between a checkout and an installed copy while
// the cache dir is the one writable place both share.
//
// The layout is the freedesktop one — <root>/hicolor/128x128/apps/<name>.png —
// with the hicolor level present because the panel looks the name up under
// each theme it knows, hicolor among them. The 128x128 directory matches the
// image's real size, and the index.theme declares it Scalable over 16..512:
// a panel asks for its own panel size (typically 16-32px), which a
// Threshold-128 directory would not match, while GTK happily scales this
// bitmap down from 128. The index.theme itself is not optional — without it
// GTK skips the directory entirely (measured: zero icons listed).
const char* kThemeRootRel = "natalia/tray-icon";
const char* kIconThemeIndex =
    "[Icon Theme]\n"
    "Name=hicolor\n"
    "Directories=128x128/apps\n"
    "\n"
    "[128x128/apps]\n"
    "Size=128\n"
    "Context=Applications\n"
    "Type=Scalable\n"
    "MinSize=16\n"
    "MaxSize=512\n";

/** The theme root with the icon materialized in it, or nullptr on failure. */
gchar* MaterialiseIconTheme() {
  const gchar* cache = g_get_user_cache_dir();
  if (cache == nullptr || cache[0] == '\0') return nullptr;

  gchar* root = g_build_filename(cache, kThemeRootRel, nullptr);
  gchar* icon_dir = g_build_filename(root, "hicolor", "128x128", "apps", nullptr);
  if (g_mkdir_with_parents(icon_dir, 0700) != 0) {
    g_free(icon_dir);
    g_free(root);
    return nullptr;
  }

  gchar* icon_path = g_build_filename(icon_dir, "natalia.png", nullptr);
  // Idempotent: the bytes are the same every run, so an existing file of the
  // right size needs no rewrite — a tray created and destroyed repeatedly
  // (minimise, restore, minimise) must not redo the I/O each time.
  bool ok = false;
  if (g_file_test(icon_path, G_FILE_TEST_EXISTS)) {
    GStatBuf st{};
    ok = g_stat(icon_path, &st) == 0 &&
         static_cast<size_t>(st.st_size) == natalia::kAppIconPngSize;
  } else {
    ok = g_file_set_contents(icon_path,
                             reinterpret_cast<const char*>(natalia::kAppIconPng),
                             natalia::kAppIconPngSize, nullptr) != 0;
  }
  g_free(icon_path);

  // The index.theme is tiny; it is rewritten every time so a layout change
  // reaches an existing cache instead of being skipped as "already there".
  if (ok) {
    gchar* index_path = g_build_filename(root, "hicolor", "index.theme", nullptr);
    ok = g_file_set_contents(index_path, kIconThemeIndex, -1, nullptr) != 0;
    g_free(index_path);
  }
  g_free(icon_dir);
  if (!ok) {
    g_free(root);
    return nullptr;
  }
  return root;
}

}  // namespace

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

  // The app's own icon, when the theme could be materialized. The fallback is
  // the stock name the tray has always carried — a tray that exists with the
  // generic mark beats no tray at all, which is the same degrade-not-fail
  // posture as the library detection above.
  gchar* theme_root = MaterialiseIconTheme();
  if (theme_root != nullptr) {
    tray->indicator_ = app_indicator_new_with_path(
        "natalia", "natalia", APP_INDICATOR_CATEGORY_APPLICATION_STATUS,
        theme_root);
    g_free(theme_root);
  }
  if (tray->indicator_ == nullptr) {
    tray->indicator_ = app_indicator_new(
        "natalia", "indicator-messages", APP_INDICATOR_CATEGORY_APPLICATION_STATUS);
  }
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

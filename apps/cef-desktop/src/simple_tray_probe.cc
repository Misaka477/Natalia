// A run-time probe for the Linux tray's failure path.
//
// Why this exists: the tray's only test asserted CMake text, so nothing ran. What
// execution once established — that Create runs, disposes, exits cleanly — lived in
// a comment with no regression behind it. And the one property that does not need a
// panel, that `Create` returns nullptr instead of crashing when GTK cannot start,
// was unverified even though every CI machine is exactly that machine.
//
// What this pins:
//   * with no usable display (or none at all), `Create` returns nullptr and the
//     process survives;
//   * where a panel exists, `Create` succeeds AND the menu it builds contains the
//     two commands — and activating them reaches the callbacks. The activation is
//     programmatic (gtk_widget_activate), so it needs GTK, not a click: what is
//     being pinned is the wiring from the entry a user sees to the code that runs.
//
// What it cannot pin: that a panel shows the icon, and that a real click reaches
// the process. Those need a human at a tray; a probe that runs everywhere cannot
// have one. (On a machine whose StatusNotifierWatcher is alive the indicator does
// register — that is the panel side's best machine-checkable fact, and it is a
// separate question from the wiring pinned here.)

#include "simple_tray_linux.h"

#include <gtk/gtk.h>

#include <string>

#include <cstdio>

namespace {

/** Every menu item under `menu`, in the order the shell would show them. */
GList* menuItems(GtkMenu* menu) {
  return gtk_container_get_children(GTK_CONTAINER(menu));
}

const char* labelOf(GtkWidget* item) {
  return GTK_IS_MENU_ITEM(item)
           ? gtk_menu_item_get_label(GTK_MENU_ITEM(item))
           : nullptr;
}

}  // namespace

int main(int argc, char** argv) {
  const bool wantPanel = argc > 1 && std::string(argv[1]) == "--expect-panel";

  int shows = 0;
  int quits = 0;
  natalia::TrayCallbacks callbacks;
  callbacks.on_show = [&shows] { shows++; };
  callbacks.on_quit = [&quits] { quits++; };

  natalia::TrayIcon* tray =
      natalia::TrayIcon::Create("natalia-tray-probe", callbacks);

  if (!tray) {
    // The documented degradation. A frame around the call matters: the point is
    // that the process is still alive to print this, which is what "does not
    // crash" means as a check.
    std::printf("TRAY_CREATE_RETURNED_NULL\n");
    if (wantPanel) {
      std::printf("FAIL: a panel was expected and Create returned nullptr\n");
      return 1;
    }
    return 0;
  }

  // Created. Without a panel the indicator exists but is visible nowhere, so this
  // says only that the object lives and disposes — not that it registered.
  std::printf("TRAY_CREATED\n");
  std::printf("CALLBACKS_ARMED show=%d quit=%d\n", shows, quits);

  // The menu Create built. The tray owns it privately; GTK tracks it as a
  // toplevel (a GtkMenu is a GtkWindow), so it is reachable without widening the
  // production type for a test's convenience.
  GtkWidget* showItem = nullptr;
  GtkWidget* quitItem = nullptr;
  GList* items = menuItems(GTK_MENU(tray->menu()));
  for (GList* item = items; item; item = item->next) {
    const char* label = labelOf(GTK_WIDGET(item->data));
    if (g_strcmp0(label, "Show Natalia") == 0)
      showItem = GTK_WIDGET(item->data);
    if (g_strcmp0(label, "Quit") == 0) quitItem = GTK_WIDGET(item->data);
  }
  g_list_free(items);

  if (!showItem || !quitItem) {
    // A tray with no exit entry is the goal's "explicit exit" missing, and a
    // silent one — the panel would show a menu with nothing that leaves.
    std::printf("FAIL: the menu lacks an entry (show=%p quit=%p)\n",
                (void*)showItem, (void*)quitItem);
    delete tray;
    return 1;
  }
  std::printf("MENU_ENTRIES_FOUND\n");

  // Activate each entry the way a click does — by emitting the signal the item
  // answers to. The loop drains what the emission queues, so a callback that
  // runs on an idle would still be counted.
  gtk_widget_activate(showItem);
  while (gtk_events_pending()) gtk_main_iteration();
  std::printf("SHOW_CALLBACK_FIRED=%d\n", shows);
  gtk_widget_activate(quitItem);
  while (gtk_events_pending()) gtk_main_iteration();
  std::printf("QUIT_CALLBACK_FIRED=%d\n", quits);

  const int failures = (shows != 1) + (quits != 1);
  delete tray;
  std::printf("DISPOSED_CLEANLY\n");
  if (failures != 0) {
    std::printf("FAIL: %d callback(s) did not fire\n", failures);
    return 1;
  }
  std::printf("PASS\n");
  return 0;
}

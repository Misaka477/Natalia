// A run-time probe for the Linux tray's failure path.
//
// Why this exists: the tray's only test asserted CMake text, so nothing ran. What
// execution once established — that Create runs, disposes, exits cleanly — lived in
// a comment with no regression behind it. And the one property that does not need a
// panel, that `Create` returns nullptr instead of crashing when GTK cannot start,
// was unverified even though every CI machine is exactly that machine.
//
// What this pins: with no usable display (or none at all), `Create` returns nullptr
// and the process survives. On a machine that DOES have a panel the call succeeds,
// and that is asserted too — so the probe says which of the two it saw rather than
// assuming one.
//
// What it cannot pin: that a panel shows the icon, and that a click reaches the
// process. Those need a real tray, and a probe that runs everywhere cannot have one.

#include "simple_tray_linux.h"

#include <string>

#include <cstdio>

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
  delete tray;
  std::printf("DISPOSED_CLEANLY\n");
  return 0;
}

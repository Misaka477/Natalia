/**
 * The window's close policy.
 *
 * The C++ side (simple_app.cc) reads the same variable through
 * `MinimiseOnClose()`, in the one CROSS-PLATFORM delegate, so the three hosts
 * share this decision. macOS carries one piece of residue that is NOT shared and
 * NOT yet done: Cocoa's `applicationShouldTerminateAfterLastWindowClosed`
 * defaults to true, so closing the LAST window ends the process even when the
 * close is refused. Until an NSApplicationDelegate override exists (which needs
 * a macOS toolchain to build and verify), the minimise mode is honest on macOS
 * only while some window stays open.
 *
 * Closing a window means two different things to two different users, and an
 * application that guesses wrong is unusable either way:
 *
 *   - "quit"        — the human is done; the app should exit and release its
 *                     runtime (a stateful SQLite session store) with it.
 *   - "minimise"    — the human wants the window out of the way but the app
 *                     alive, so a relaunch (a second icon click, the launcher
 *                     entry) brings the window back instead of starting a copy.
 *
 * The default is "minimise": closing the window hides it, the app keeps
 * running, and the tray icon's Quit is the explicit exit. The variable opts
 * OUT (`NATALIA_MINIMISE_ON_CLOSE=0|false|no|off`) — the same set the C++ side
 * matches — because a window that exits on close takes the running turn, the
 * attached terminals and the runtime's warm state with it, and a single
 * mis-click is not a request to end all that.
 *
 * The state lives in one place so the two directions (window → runtime, and
 * relaunch → window) cannot disagree: a relaunch asks the RUNNING instance to
 * show its window, which is what makes "it never went away" true rather than a
 * claim.
 */

/** What the window should do when the human closes it. */
export type CloseAction = "quit" | "minimise";

/** Where a close came from. */
export type CloseSource =
  /** The window's own close button (or the platform's equivalent gesture). */
  | "window-button"
  /** The tray's Quit — the explicit exit, present while the window is hidden. */
  | "tray-quit";

/** Where the window currently is, for the launcher entry to act on. */
export type WindowState = "open" | "hidden";

export type ClosePolicy = {
  action: CloseAction;
  /**
   * Why the decision is what it is. Rendered into the window's title bar and
   * the launcher's tooltip, so "am I still running?" is answerable without
   * reading a log.
   */
  reason: string;
};

/**
 * Read the close action from the environment.
 *
 * The default is "minimise" — matching `MinimiseOnClose()` in simple_app.cc,
 * which returns true unless the value is one of the four opt-outs. Only those
 * four quit; anything else, including a typo, keeps the window's contents
 * alive, because the failure of the other direction is unrecoverable.
 */
export function closeActionFromEnv(
  env: Record<string, string | undefined> = process.env,
): ClosePolicy {
  // Trimmed but NOT lower-cased: the C++ side compares the raw bytes
  // (value == "0" || ...), and a TS mirror that accepted "NO" would promise a
  // behaviour the product does not have. A test comparing the two keeps it so.
  const raw = (env.NATALIA_MINIMISE_ON_CLOSE ?? "").trim();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off")
    return {
      action: "quit",
      reason: "the window exits on close (NATALIA_MINIMISE_ON_CLOSE)",
    };
  return {
    action: "minimise",
    reason:
      "the window hides on close; the app keeps running — quit from the tray icon",
  };
}

/**
 * What a relaunch of the same app should do, given the window's state.
 *
 * A hidden window is shown; an open one is asked to come forward. Either way the
 * answer is "show", never "start another" — the single-instance lock makes the
 * relaunch a request, and this is the request's meaning.
 */
export function relaunchActionFor(window: WindowState): "show" {
  return "show";
}

/** The launcher entry's tooltip while the app runs without a visible window. */
export function statusLineFor(
  policy: ClosePolicy,
  window: WindowState,
): string {
  if (window === "open") return policy.reason;
  return `${policy.reason}; the window is hidden — relaunching brings it back`;
}

/**
 * Does the process have to keep running after the window hides?
 *
 * Yes for minimise (the runtime is the app's memory), and undefined for quit
 * (nothing is expected to observe it). Spelled out so a caller cannot forget
 * which one it is handling.
 */
export function processSurvivesWindowClose(action: CloseAction): boolean {
  return action === "minimise";
}

/**
 * What the window should do for a close from `source`, given the policy.
 *
 * The tray's Quit is the explicit exit, and it OVERRIDES the minimise policy:
 * the tray only exists while the window is hidden, which only happens under
 * minimise — so without the override the one state where the exit entry is
 * visible is the one state where it does nothing. The C++ side carries the
 * same rule (`quit_requested_`, checked first in CanClose — see the policy
 * comment in simple_app.cc), and the parity test compares the two.
 *
 * The window's close button is the policy's to answer: minimise by default,
 * quit when the variable opts out.
 */
export function closeActionFor(
  source: CloseSource,
  policy: ClosePolicy,
): CloseAction {
  if (source === "tray-quit") return "quit";
  return policy.action;
}

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  closeActionFromEnv,
  closeActionFor,
  processSurvivesWindowClose,
  relaunchActionFor,
  statusLineFor,
  type CloseAction,
} from "../src/window-policy";

/**
 * The close policy's promise.
 *
 * An application's close button is not a place for a guess. This pins the two
 * directions that have to agree: what the window does when closed, and what a
 * relaunch does when the window is (or is not) already there.
 */

test("the default hides the window and keeps the app running", () => {
  // The product decision, and the C++ side's default: `MinimiseOnClose()`
  // returns true unless the value is one of the four opt-outs. A closed window
  // takes the running turn, the attached terminals and the runtime's warm state
  // with it, so quitting is the explicit action, not the accidental one.
  for (const value of [undefined, "", "  ", "maybe", "2", "MINIMISE", "TRUE"]) {
    const policy = closeActionFromEnv({ NATALIA_MINIMISE_ON_CLOSE: value });
    expect(policy.action, String(value)).toBe("minimise");
  }
  // The whole environment absent is the shipping case.
  expect(closeActionFromEnv({}).action).toBe("minimise");
});

test("an explicit opt-out quits, and says which setting did it", () => {
  // The C++ side compares raw bytes, so uppercase spellings are NOT accepted;
  // the cross-check test below is what keeps these two lists in step.
  for (const value of ["0", "false", "no", "off"]) {
    const policy = closeActionFromEnv({
      NATALIA_MINIMISE_ON_CLOSE: value,
    });
    expect(policy.action, value).toBe("quit");
    // The reason must name the setting: an exit that happens because a variable
    // was set has to be traceable to that variable.
    expect(policy.reason).toContain("NATALIA_MINIMISE_ON_CLOSE");
  }
});

test("a relaunch asks the running instance to show, never to start another", () => {
  // The two states a relaunch can find, and both mean "show".
  for (const window of ["open", "hidden"] as const)
    expect(relaunchActionFor(window)).toBe("show");
});

test("the process survives only when the action is minimise", () => {
  const cases: Array<[CloseAction, boolean]> = [
    ["quit", false],
    ["minimise", true],
  ];
  for (const [action, survives] of cases)
    expect(processSurvivesWindowClose(action)).toBe(survives);
});

test("the tray's Quit exits even under the minimise policy", () => {
  // The regression this pins: the tray exists only while the window is hidden,
  // which only happens under minimise — so a Quit answered with another hide
  // is an exit entry that works in every state except the one it appears in.
  const minimise = closeActionFromEnv({});
  expect(minimise.action).toBe("minimise");
  expect(closeActionFor("tray-quit", minimise)).toBe("quit");
  expect(
    processSurvivesWindowClose(closeActionFor("tray-quit", minimise)),
  ).toBe(false);
  // The window's own close button is still the policy's to answer.
  expect(closeActionFor("window-button", minimise)).toBe("minimise");
  // And with the policy opted out, both sources agree on quit — the exit
  // button and the variable say the same thing.
  const quit = closeActionFromEnv({ NATALIA_MINIMISE_ON_CLOSE: "0" });
  expect(quit.action).toBe("quit");
  expect(closeActionFor("tray-quit", quit)).toBe("quit");
  expect(closeActionFor("window-button", quit)).toBe("quit");
});

test("a hidden window's status answers 'am I still running?'", () => {
  const policy = closeActionFromEnv({ NATALIA_MINIMISE_ON_CLOSE: "1" });
  const open = statusLineFor(policy, "open");
  const hidden = statusLineFor(policy, "hidden");
  expect(open).not.toContain("hidden");
  expect(hidden).toContain("hidden");
  // And it says what to do about it.
  expect(hidden).toContain("relaunching brings it back");
  // While the default policy never claims the window is hidden.
  expect(statusLineFor(closeActionFromEnv({}), "open")).not.toContain("hidden");
});

test("the C++ policy and the TS mirror agree on every input", () => {
  // The two implementations are real, and only one of them is the product: the
  // C++ `MinimiseOnClose()` is what CanClose calls, and this TS module is what the
  // tests can reach. Nothing makes them drift loudly — a change on one side leaves
  // the other green — so the equality is asserted here instead of trusted.
  const cxx = readFileSync(
    new URL("../src/simple_app.cc", import.meta.url),
    "utf8",
  );
  // The C++ side's accepted values, read out of its own comparison. The
  // comparison spans two source lines, so it is matched across the file rather
  // than on one line: the previous form found "the line containing
  // `value == \"1\"`", and when the policy flipped to opt-OUT that line stopped
  // existing — the test died on `undefined` instead of reporting a mismatch it
  // did not exist to catch.
  // The `\b` matters: without it the pattern also matches the substring
  // `value == "` inside `show_state_value == "minimized"`, and the reader would
  // be told the close policy accepts "minimized".
  const accepted = [...cxx.matchAll(/\bvalue == "([^"]+)"/gu)].map((m) => m[1]);
  expect(accepted).toEqual(["0", "false", "no", "off"]);

  // Opting out is the ONLY way to quit; every other value — including anything
  // unrecognised — keeps the C++ default, which is what its `!( … )` returns.
  for (const value of accepted)
    expect(
      closeActionFromEnv({ NATALIA_MINIMISE_ON_CLOSE: value }).action,
      value,
    ).toBe("quit");
  for (const value of [
    "",
    "   ",
    "1",
    "true",
    "yes",
    "on",
    "2",
    "MINIMISE",
    "TRUE",
  ])
    expect(
      closeActionFromEnv({ NATALIA_MINIMISE_ON_CLOSE: value }).action,
      value,
    ).toBe("minimise");
});

test("the C++ quit override exists, and it is checked first", () => {
  // The tray's Quit closes the window through CefWindow::Close(), and CEF routes
  // that through CanClose (cef_window_delegate.h: "called for user-initiated
  // window close actions and when CefWindow::Close() is called"). So the
  // override's whole value is ORDERING: the flag must be answered before the
  // minimise branch, and set before the Close() it is meant to survive. This
  // asserts the order in the one file that is the product.
  const cxx = readFileSync(
    new URL("../src/simple_app.cc", import.meta.url),
    "utf8",
  );

  const canCloseStart = cxx.indexOf("bool CanClose");
  expect(canCloseStart).toBeGreaterThan(-1);
  const canCloseEnd = cxx.indexOf("\n  }", canCloseStart);
  const canClose = cxx.slice(canCloseStart, canCloseEnd);
  // Answered first: the flag check precedes the policy branch.
  expect(canClose.indexOf("quit_requested_")).toBeGreaterThan(-1);
  expect(canClose.indexOf("quit_requested_")).toBeLessThan(
    canClose.indexOf("MinimiseOnClose()"),
  );

  // Both tray quit callbacks (Windows and Linux) set the flag before closing,
  // and nothing else in the file closes the window without it.
  const closes = [...cxx.matchAll(/window_->Close\(\)/gu)];
  expect(closes.length).toBe(2);
  for (const close of closes) {
    const at = close.index!;
    const lambda = cxx.lastIndexOf("[this]()", at);
    expect(lambda).toBeGreaterThan(-1);
    // The most recent flag-set before this Close() is inside this very lambda
    // and precedes the call: the quit is what sets it, and it is set first.
    const lastSet = cxx.lastIndexOf("quit_requested_ = true;", at);
    expect(lastSet).toBeGreaterThanOrEqual(lambda);
    expect(lastSet).toBeLessThan(at);
  }
});

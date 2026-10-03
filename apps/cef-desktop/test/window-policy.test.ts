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

test("an unset variable means quit — the default users already know", () => {
  for (const value of [undefined, "", "  ", "maybe", "2", "minimise"]) {
    const policy = closeActionFromEnv({ NATALIA_MINIMISE_ON_CLOSE: value });
    expect(policy.action, String(value)).toBe("quit");
  }
  // The whole environment absent is the shipping case.
  expect(closeActionFromEnv({}).action).toBe("quit");
});

test("an explicit opt-in means minimise, and says so", () => {
  // The C++ side compares raw bytes, so uppercase spellings are NOT accepted;
  // the cross-check test below is what keeps these two lists in step.
  for (const value of ["1", "true", "yes", "on"]) {
    const policy = closeActionFromEnv({
      NATALIA_MINIMISE_ON_CLOSE: value,
    });
    expect(policy.action, value).toBe("minimise");
    // The reason must name the setting, because a window that vanishes on close
    // with no explanation is indistinguishable from a crash.
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
  const minimise = closeActionFromEnv({ NATALIA_MINIMISE_ON_CLOSE: "1" });
  expect(minimise.action).toBe("minimise");
  expect(closeActionFor("tray-quit", minimise)).toBe("quit");
  expect(
    processSurvivesWindowClose(closeActionFor("tray-quit", minimise)),
  ).toBe(false);
  // The window's own close button is still the policy's to answer.
  expect(closeActionFor("window-button", minimise)).toBe("minimise");
  // And under the default policy both sources agree on quit anyway.
  const quit = closeActionFromEnv({});
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
  // The C++ side's accepted values, read out of its own comparison.
  const line = cxx.split("\n").find((entry) => entry.includes('value == "1"'))!;
  const accepted = [...line.matchAll(/value == "([^"]+)"/gu)].map((m) => m[1]);
  expect(accepted).toEqual(["1", "true", "yes", "on"]);

  // Every value the C++ side accepts must minimise, and everything else must quit.
  for (const value of accepted)
    expect(
      closeActionFromEnv({ NATALIA_MINIMISE_ON_CLOSE: value }).action,
    ).toBe("minimise");
  for (const value of ["", "   ", "no", "off", "2", "MINIMISE", "TRUE"])
    expect(
      closeActionFromEnv({ NATALIA_MINIMISE_ON_CLOSE: value }).action,
      value,
    ).toBe("quit");
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

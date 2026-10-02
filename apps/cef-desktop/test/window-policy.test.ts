import { expect, test } from "bun:test";
import {
  closeActionFromEnv,
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
  for (const value of ["1", "true", "TRUE", "yes", "On"]) {
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

import { expect, test } from "bun:test";
import {
  DOCK_MODES,
  DOCK_MODE_LABEL_KEYS,
  isDockMode,
  nextDockMode,
} from "../src/terminal/dock";

test("the three modes are the architecture's three", () => {
  expect([...DOCK_MODES]).toEqual(["tab", "split", "float"]);
});

test("one control walks all three modes", () => {
  expect(nextDockMode("tab")).toBe("split");
  expect(nextDockMode("split")).toBe("float");
  expect(nextDockMode("float")).toBe("tab");
});

test("an unknown value is not a mode", () => {
  expect(isDockMode("tab")).toBe(true);
  expect(isDockMode("float")).toBe(true);
  expect(isDockMode("docked")).toBe(false);
  expect(isDockMode(undefined)).toBe(false);
});

test("every mode has a label key for the control", () => {
  for (const mode of DOCK_MODES) {
    expect(DOCK_MODE_LABEL_KEYS[mode]).toStartWith("dock.mode.");
  }
});

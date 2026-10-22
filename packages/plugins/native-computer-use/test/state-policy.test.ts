/**
 * The state object's policy: what the model is shown, and what changed.
 *
 * These are the decisions that replace screenshots, so they are tested with
 * hand-built trees and no desktop — the same split the page-scan policy
 * uses, for the same reason: everything worth asserting about what a reader
 * sees is decided here.
 */
import { expect, test } from "bun:test";
import type { UiaElement } from "../src/win32/uia";
import {
  buildState,
  diffStates,
  selectControls,
  selectText,
  toControl,
  type DesktopState,
} from "../src/state-policy";

function node(over: Partial<UiaElement> = {}): UiaElement {
  return {
    pointer: 1,
    name: "",
    controlType: 50004,
    controlTypeName: "edit",
    className: "",
    rect: { x: 0, y: 0, w: 100, h: 20 },
    enabled: true,
    focusable: true,
    focused: false,
    offscreen: false,
    isPassword: false,
    ...over,
  };
}

test("a control needs a name or a value, and must be on screen", () => {
  // Chrome: a divider, a spacer, an unnamed pane. It costs context and
  // answers nothing.
  expect(toControl(node({ name: "" }))).toBeUndefined();
  // A value with no name is still a field worth showing.
  expect(toControl(node({ name: "", value: "typed" }))?.value).toBe("typed");
  // Off-screen is not on the screen the model is looking at.
  expect(toControl(node({ name: "隐藏", offscreen: true }))).toBeUndefined();
});

test("controls are ranked so the useful ones come first, and capped", () => {
  const nodes = [
    node({
      name: "inert",
      focusable: false,
      rect: { x: 0, y: 0, w: 10, h: 10 },
    }),
    node({
      name: "disabled",
      enabled: false,
      rect: { x: 0, y: 10, w: 10, h: 10 },
    }),
    node({ name: "second", rect: { x: 0, y: 40, w: 10, h: 10 } }),
    node({ name: "first", rect: { x: 0, y: 20, w: 10, h: 10 } }),
  ];
  const selected = selectControls(nodes, 10).map((control) => control.name);
  // Enabled and focusable first, then reading order (top to bottom).
  expect(selected).toEqual(["first", "second", "disabled", "inert"]);
  // The cap is the budget: a 700-node tree becomes a handful.
  expect(selectControls(nodes, 2)).toHaveLength(2);
});

test("the text is deduplicated, paged and honest about being cut", () => {
  const nodes = [
    node({ controlTypeName: "text", name: "第一行" }),
    node({ controlTypeName: "text", name: "第一行" }),
    node({ controlTypeName: "text", name: "第二行" }),
    node({ controlTypeName: "button", name: "按钮" }),
  ];
  const first = selectText(nodes, { maxText: 100, offset: 0 });
  expect(first.text).toBe("第一行\n第二行");
  expect(first.truncated).toBe(false);
  expect(first.nextOffset).toBeUndefined();
  // A page that stops early says where the next one starts.
  const page = selectText(nodes, { maxText: 4, offset: 0 });
  expect(page.text).toBe("第一行\n");
  expect(page.truncated).toBe(true);
  expect(page.nextOffset).toBe(4);
  // And the second page continues from there.
  const next = selectText(nodes, { maxText: 100, offset: 4 });
  expect(next.text).toBe("第二行");
});

test("the diff reports added, removed and changed values — by identity, not address", () => {
  const control = (name: string, value?: string) => ({
    name,
    type: "edit",
    ...(value === undefined ? {} : { value }),
    enabled: true,
    focusable: true,
    focused: false,
  });
  const previous: DesktopState = {
    window: { hwnd: "1", title: "t", foreground: true },
    focus: null,
    controls: [control("kept", "old"), control("gone")],
    text: "",
    textTruncated: false,
  };
  const next: DesktopState = {
    window: { hwnd: "1", title: "t", foreground: true },
    focus: null,
    controls: [control("kept", "new"), control("fresh")],
    text: "",
    textTruncated: false,
  };
  const diff = diffStates(previous, next);
  expect(diff?.added.map((entry) => entry.name)).toEqual(["fresh"]);
  expect(diff?.removed.map((entry) => entry.name)).toEqual(["gone"]);
  expect(diff?.valueChanges).toEqual([
    { name: "kept", from: "old", to: "new" },
  ]);
  // No previous state means no diff, not an empty one.
  expect(diffStates(undefined, next)).toBeUndefined();
});

test("the state object names the focus and carries the window's geometry", () => {
  const nodes = [
    node({ name: "box", focused: true, rect: { x: 10, y: 20, w: 30, h: 40 } }),
    node({ name: "other" }),
  ];
  const state = buildState({
    window: {
      hwnd: "42",
      title: "t",
      foreground: true,
      clientOrigin: { x: 5, y: 6 },
      clientSize: { w: 800, h: 600 },
    },
    nodes,
    options: {},
  });
  expect(state.focus?.name).toBe("box");
  expect(state.focus?.focused).toBe(true);
  expect(state.window.clientOrigin).toEqual({ x: 5, y: 6 });
  // Controls are in reading order, so the one higher up the screen comes`n  // first even though the focus is elsewhere.`n  expect(state.controls.map((control) => control.name)).toEqual(["other", "box"]);
  expect(state.diff).toBeUndefined();
});

test("the second read of a window carries a diff of the first", () => {
  const first = buildState({
    window: { hwnd: "42", title: "t", foreground: true },
    nodes: [node({ name: "box", value: "" })],
    options: {},
  });
  const second = buildState({
    window: { hwnd: "42", title: "t", foreground: true },
    nodes: [node({ name: "box", value: "hello" })],
    options: { previous: first },
  });
  expect(second.diff?.valueChanges).toEqual([
    { name: "box", from: "", to: "hello" },
  ]);
});

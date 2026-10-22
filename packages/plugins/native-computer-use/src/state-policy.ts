/**
 * The state object's policy: what the model is shown, and what changed.
 *
 * The scan that motivated this layer burned eleven full-screen screenshots
 * looking for one input box. The state object replaces that with one call
 * that answers three questions at once: what is here, where is the focus,
 * and what changed since last time — so "did my click do anything" never
 * needs a second image to answer.
 *
 * Pure over its inputs: the raw read is the native layer's job, and every
 * decision about what a reader sees of it is made here, where the tests can
 * drive it with hand-built trees and no desktop exists.
 */
import type { UiaElement, UiaRect } from "./win32/uia";

/** One addressable thing on the screen. */
export type StateControl = {
  name: string;
  type: string;
  value?: string;
  enabled: boolean;
  focusable: boolean;
  focused: boolean;
  rect?: UiaRect;
  hwnd?: number;
};

/** What changed between two reads of the same window. */
export type StateDiff = {
  added: StateControl[];
  removed: StateControl[];
  /** Controls whose value changed, with both values named. */
  valueChanges: Array<{ name: string; from: string; to: string }>;
};

export type DesktopState = {
  window: {
    hwnd: string;
    title: string;
    foreground: boolean;
    clientOrigin?: { x: number; y: number };
    clientSize?: { w: number; h: number };
  };
  focus: StateControl | null;
  controls: StateControl[];
  /** The window's visible text, bounded and pageable. */
  text: string;
  textTruncated: boolean;
  nextTextOffset?: number;
  diff?: StateDiff;
};

export type StateOptions = {
  maxControls?: number;
  maxText?: number;
  textOffset?: number;
  /** The previous state of the SAME window, when there is one. */
  previous?: DesktopState;
};

/** A control's identity for the diff: what it is, not where it is. */
function controlKey(control: StateControl): string {
  return `${control.type}|${control.name}`;
}

/** A node becomes a control when it is something a reader could act on. */
export function toControl(node: UiaElement): StateControl | undefined {
  // A control with no name and no value is chrome: a divider, a spacer, an
  // unnamed pane. It costs context and answers nothing.
  if (!node.name && node.value === undefined) return undefined;
  // Off-screen nodes are not on the screen the model is looking at.
  if (node.offscreen) return undefined;
  return {
    name: node.name,
    type: node.controlTypeName,
    ...(node.value === undefined ? {} : { value: node.value }),
    enabled: node.enabled,
    focusable: node.focusable,
    focused: node.focused,
    ...(node.rect ? { rect: node.rect } : {}),
    ...(node.hwnd ? { hwnd: node.hwnd } : {}),
  };
}

/**
 * The controls a reader is shown.
 *
 * Ordered so the useful ones come first: focusable before inert, on-screen
 * before off, named before anonymous, and then by reading order (top-left
 * first). A 700-node tree collapses to the handful of things that can be
 * clicked or typed into, which is the difference between a state object and
 * a dump.
 */
export function selectControls(
  nodes: UiaElement[],
  maxControls: number,
): StateControl[] {
  const controls = nodes
    .map(toControl)
    .filter((control): control is StateControl => control !== undefined);
  const rank = (control: StateControl): number =>
    (control.focusable ? 0 : 4) +
    (control.enabled ? 0 : 2) +
    (control.name.length > 0 ? 0 : 1);
  const position = (control: StateControl): number =>
    control.rect
      ? control.rect.y * 100000 + control.rect.x
      : Number.MAX_SAFE_INTEGER;
  return controls
    .sort((left, right) => {
      const byRank = rank(left) - rank(right);
      if (byRank !== 0) return byRank;
      return position(left) - position(right);
    })
    .slice(0, Math.max(1, maxControls));
}

/** The window's text, bounded and pageable. */
export function selectText(
  nodes: UiaElement[],
  options: { maxText: number; offset: number },
): { text: string; truncated: boolean; nextOffset?: number } {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const node of nodes) {
    const text = node.name.trim();
    // Text nodes carry their content as their name; everything else's name
    // is a label the controls already show.
    if (node.controlTypeName !== "text" || !text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
  }
  const whole = lines.join("\n");
  const end = Math.min(whole.length, options.offset + options.maxText);
  const text = whole.slice(options.offset, end);
  return {
    text,
    truncated: end < whole.length,
    ...(end < whole.length ? { nextOffset: end } : {}),
  };
}

/**
 * What changed since the previous read of the same window.
 *
 * Identity is type+name, never a pointer: a node's address is reused by the
 * next node the allocator hands out, and a diff keyed on it would report
 * the whole window as new on every read.
 */
export function diffStates(
  previous: DesktopState | undefined,
  next: DesktopState,
): StateDiff | undefined {
  if (!previous) return undefined;
  const before = new Map(
    previous.controls.map((control) => [controlKey(control), control]),
  );
  const after = new Map(
    next.controls.map((control) => [controlKey(control), control]),
  );
  const added: StateControl[] = [];
  const removed: StateControl[] = [];
  const valueChanges: StateDiff["valueChanges"] = [];
  for (const [key, control] of after) if (!before.has(key)) added.push(control);
  for (const [key, control] of before)
    if (!after.has(key)) removed.push(control);
  for (const [key, control] of after) {
    const was = before.get(key);
    if (!was) continue;
    if (was.value !== control.value)
      valueChanges.push({
        name: control.name,
        from: was.value ?? "",
        to: control.value ?? "",
      });
  }
  return { added, removed, valueChanges };
}

/** Assemble the state object the tool answers with. */
export function buildState(input: {
  window: DesktopState["window"];
  nodes: UiaElement[];
  options: StateOptions;
}): DesktopState {
  const maxControls = input.options.maxControls ?? 40;
  const maxText = input.options.maxText ?? 4000;
  const textOffset = input.options.textOffset ?? 0;
  const controls = selectControls(input.nodes, maxControls);
  const text = selectText(input.nodes, { maxText, offset: textOffset });
  const focus =
    input.nodes.map(toControl).find((control) => control?.focused === true) ??
    null;
  const state: DesktopState = {
    window: input.window,
    focus,
    controls,
    text: text.text,
    textTruncated: text.truncated,
    ...(text.nextOffset === undefined
      ? {}
      : { nextTextOffset: text.nextOffset }),
  };
  const diff = diffStates(input.options.previous, state);
  return diff ? { ...state, diff } : state;
}

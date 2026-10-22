/**
 * Input: the pointer and the keyboard, in physical pixels.
 *
 * Every coordinate is physical, because the process is DPI aware — the same
 * grid a screenshot is captured on, which is what makes "click the button
 * at 120,40 in this screenshot" a true statement rather than an
 * approximation.
 *
 * Text goes through the Unicode key events rather than the clipboard: the
 * clipboard is shared state the user owns, and a paste that lands in the
 * wrong window (or over something the user copied a moment ago) is damage
 * this tool has no way to undo.
 */
import { desktopLibraries } from "./ffi";
import { parseKeySpec, type KeyStep } from "../keys";

/** KEYEVENTF_KEYUP / KEYEVENTF_UNICODE, from winuser.h. */
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;

/** Move the pointer. No click: a move alone is how a hover menu opens. */
export function moveCursor(x: number, y: number): void {
  const libs = desktopLibraries();
  libs.user32.SetCursorPos(x, y);
}

/** Press and release the left button where the pointer already is. */
export function clickPointer(button: "left" | "right" = "left"): void {
  const libs = desktopLibraries();
  const down = button === "left" ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_RIGHTDOWN;
  const up = button === "left" ? MOUSEEVENTF_LEFTUP : MOUSEEVENTF_RIGHTUP;
  libs.user32.mouse_event(down, 0, 0, 0, null);
  libs.user32.mouse_event(up, 0, 0, 0, null);
}

/** Press a mouse button WITHOUT releasing it (a drag's first half). */
export function mouseDown(button: "left" | "right" = "left"): void {
  const libs = desktopLibraries();
  libs.user32.mouse_event(
    button === "left" ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_RIGHTDOWN,
    0,
    0,
    0,
    null,
  );
}

/** Release a mouse button (a drag's second half). */
export function mouseUp(button: "left" | "right" = "left"): void {
  const libs = desktopLibraries();
  libs.user32.mouse_event(
    button === "left" ? MOUSEEVENTF_LEFTUP : MOUSEEVENTF_RIGHTUP,
    0,
    0,
    0,
    null,
  );
}

/**
 * Click at a physical point.
 *
 * The move comes first, as its own call: a pointer that teleports into a
 * hover target without ever arriving is a pointer the hover never opened
 * for. The events carry no coordinates of their own — the cursor is
 * already where it was told to be.
 */
export function clickAt(
  x: number,
  y: number,
  button: "left" | "right" = "left",
): void {
  moveCursor(x, y);
  clickPointer(button);
}

/** Type text through the Unicode key events, one UTF-16 unit at a time. */
export function typeText(text: string): number {
  const libs = desktopLibraries();
  // Unit by unit, not code point by code point: a character outside the
  // BMP arrives as a surrogate pair, and the keyboard event takes the pair
  // as the two units it is.
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    libs.user32.keybd_event(0, unit, KEYEVENTF_UNICODE, null);
    libs.user32.keybd_event(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, null);
  }
  return text.length;
}

/** Replay one key spec's press order. */
export function sendKeySpec(spec: string): KeyStep[] {
  const libs = desktopLibraries();
  const steps = parseKeySpec(spec);
  for (const step of steps)
    libs.user32.keybd_event(step.vk, 0, step.up ? KEYEVENTF_KEYUP : 0, null);
  return steps;
}

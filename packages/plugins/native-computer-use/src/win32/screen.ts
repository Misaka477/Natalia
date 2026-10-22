/**
 * The screen itself: metrics and DPI awareness.
 *
 * `ensureDpiAware` is the one call that makes everything else true. Until
 * a process declares itself DPI aware, Win32 answers its geometry questions
 * in LOGICAL pixels — a 4K display at 150% reports itself as half its real
 * size — and every coordinate the model computes against a screenshot lands
 * at half the intended distance. After it, the metrics and the rectangles
 * are physical, and a pixel in a screenshot is a pixel on the screen.
 *
 * The call is process-wide and one-way, so it happens once and is then a
 * fact rather than a decision.
 */
import { desktopLibraries, pointBuffer } from "./ffi";

/** Virtual-screen metrics (SM_*), in physical pixels once DPI aware. */
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

export type ScreenBounds = { x: number; y: number; w: number; h: number };

let dpiAware = false;

/** Declare the process DPI aware. Returns whether it now is. */
export function ensureDpiAware(): boolean {
  if (dpiAware) return true;
  const libs = desktopLibraries();
  // A second call fails (the awareness is already set, or the host set
  // its own); either way the metrics are physical from here on.
  libs.user32.SetProcessDPIAware();
  dpiAware = true;
  return true;
}

/**
 * The virtual screen: every monitor's union, in physical pixels.
 *
 * A window dragged onto a second monitor has coordinates outside the
 * primary screen's rectangle, so the capture and the region clipper both
 * work against this rather than against the primary display.
 */
export function virtualScreen(): ScreenBounds {
  const libs = desktopLibraries();
  return {
    x: libs.user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
    y: libs.user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
    w: libs.user32.GetSystemMetrics(SM_CXVIRTUALSCREEN),
    h: libs.user32.GetSystemMetrics(SM_CYVIRTUALSCREEN),
  };
}

/** Where the pointer is right now, in physical pixels. */
export function cursorPosition(): { x: number; y: number } {
  const libs = desktopLibraries();
  const point = pointBuffer();
  libs.user32.GetCursorPos(point.buffer);
  return point.read();
}

/**
 * Screen geometry, in physical pixels.
 *
 * Every number this plugin hands the native layer or the model is PHYSICAL:
 * the process marks itself per-monitor DPI aware once, and after that the
 * Win32 metrics and window rectangles describe real device pixels. A
 * screenshot's pixel at (x, y) and the click at (x, y) are then the same
 * point on the same screen, which is the whole reason the screenshot and
 * the click can be trusted together.
 *
 * The functions here are pure so the arithmetic a click depends on is
 * tested without a display: region clamping, containment, clipping. What is
 * deliberately NOT here is the frame-to-screen translation: the model does
 * that one, adding a window screenshot's reported client origin to the
 * point it read, and the tool descriptions plus the shipped skill are where
 * that rule lives.
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };

/** The centre of a rectangle, rounded to a pixel. */
export function centerOf(rect: Rect): Point {
  return {
    x: Math.round(rect.x + rect.w / 2),
    y: Math.round(rect.y + rect.h / 2),
  };
}

export function rectContains(rect: Rect, x: number, y: number): boolean {
  return (
    x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
  );
}

/**
 * The square region around a point, clipped to the screen.
 *
 * Returns undefined when the point is outside the screen entirely — a
 * caller that clicks off-screen gets told, rather than capturing a
 * zero-width region and reporting a meaningless diff.
 */
export function regionAround(
  x: number,
  y: number,
  radius: number,
  bounds: Rect,
): Rect | undefined {
  if (!rectContains(bounds, x, y)) return undefined;
  const left = Math.max(bounds.x, x - radius);
  const top = Math.max(bounds.y, y - radius);
  const right = Math.min(bounds.x + bounds.w, x + radius + 1);
  const bottom = Math.min(bounds.y + bounds.h, y + radius + 1);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The overlap of two rectangles, or undefined when they are disjoint. */
export function intersect(a: Rect, b: Rect): Rect | undefined {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Clip a requested capture region to the screen.
 *
 * A window dragged half off-screen asks for pixels that do not exist; the
 * capture returns the part that does, and the caller reports the region it
 * really got so the model never maps a coordinate against a frame that was
 * silently padded.
 */
export function clipToBounds(rect: Rect, bounds: Rect): Rect | undefined {
  return intersect(rect, bounds);
}

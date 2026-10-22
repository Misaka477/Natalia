/**
 * Did the click do anything? The pixels answer.
 *
 * An action that returns "ok" because the call returned is a lie waiting to
 * be discovered: the click landed on a different element, the window moved,
 * a dialog opened over the target, or the coordinates named a pixel of
 * empty background. Comparing the region around the click point before and
 * after turns that guess into a measurement, and the verdict below turns
 * the measurement into the advice the model needs.
 *
 * Pure over two buffers: no display, no native call, so the rule that
 * decides "verified" is the rule the tests check.
 */

export type PixelDiff = {
  /** Fraction of sampled pixels that changed, 0..1. */
  changedRatio: number;
  changedPixels: number;
  total: number;
  /** The changed pixels' bounding box, inside the sampled region. */
  box?: { x: number; y: number; w: number; h: number };
};

export type ClickVerdict = {
  verified: boolean;
  note: string;
};

/** How much one channel may differ before a pixel counts as changed. */
const CHANNEL_THRESHOLD = 24;

/** A change this small is noise: a caret, a hover tint, a clock. */
const MIN_VERIFIED_RATIO = 0.004;

export function diffRegion(
  before: Uint8Array,
  after: Uint8Array,
  width: number,
  height: number,
): PixelDiff {
  const total = Math.max(
    0,
    Math.min(width * height, Math.floor(before.length / 3)),
  );
  if (total === 0 || after.length < total * 3)
    return { changedRatio: 0, changedPixels: 0, total };
  let changed = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0; index < total; index += 1) {
    const at = index * 3;
    const delta =
      Math.abs(before[at]! - after[at]!) +
      Math.abs(before[at + 1]! - after[at + 1]!) +
      Math.abs(before[at + 2]! - after[at + 2]!);
    if (delta <= CHANNEL_THRESHOLD) continue;
    changed += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const box =
    maxX >= 0
      ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
      : undefined;
  return {
    changedRatio: total === 0 ? 0 : changed / total,
    changedPixels: changed,
    total,
    ...(box ? { box } : {}),
  };
}

/**
 * The verdict a click's diff earns.
 *
 * A verified click is reported as such with the change's size, so the model
 * knows the screen answered. An unverified one is reported with WHAT to
 * check — the coordinate transform first, because that is the failure that
 * looks like "the click did nothing" — and never as a bare failure, and
 * never with a retry: clicking the same wrong pixel again is the mistake
 * this exists to stop.
 */
export function clickVerdict(
  diff: PixelDiff,
  coordinates: { x: number; y: number },
): ClickVerdict {
  if (diff.total === 0)
    return {
      verified: false,
      note:
        "the click region could not be sampled (the point is outside the screen); " +
        "re-enumerate with computer_windows and pick a coordinate inside a window",
    };
  if (diff.changedRatio >= MIN_VERIFIED_RATIO)
    return {
      verified: true,
      note:
        `the screen changed: ${diff.changedPixels} of ${diff.total} sampled pixels ` +
        `(${(diff.changedRatio * 100).toFixed(1)}%)`,
    };
  if (diff.changedPixels > 0)
    return {
      verified: false,
      note:
        `only ${diff.changedPixels} of ${diff.total} sampled pixels changed ` +
        `(${(diff.changedRatio * 100).toFixed(2)}%) — that is noise (a caret, a hover ` +
        `tint), not a response. Check the coordinate transform before clicking again: ` +
        `a screenshot's coordinates are relative to the window's client-area origin, ` +
        `and (${coordinates.x},${coordinates.y}) is a physical screen point.`,
    };
  return {
    verified: false,
    note:
      `nothing changed around (${coordinates.x},${coordinates.y}). The click reached ` +
      `the screen but the page did not answer it. Check, in order: the coordinate ` +
      `transform (a screenshot's point is relative to the window's client origin), ` +
      `whether another window is in front, and whether the target is disabled. ` +
      "Do not click the same pixel again — re-scan first.",
  };
}

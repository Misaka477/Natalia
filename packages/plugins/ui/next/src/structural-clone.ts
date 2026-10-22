/**
 * Structural clone: the same detached snapshot the worker clone produces, with
 * the branches that did not change KEPT BY REFERENCE from the previous
 * snapshot.
 *
 * WHY. The transcript's rows are Solid `<For>` entries, and `<For>` keys by
 * element identity. A full deep clone of the projection state per animation
 * frame hands every row a brand-new object each frame, so every visible row is
 * destroyed and rebuilt while the model streams — measured as the card toolbar
 * (copy / fork / rollback) flickering under the cursor, a click landing on a
 * node that was replaced between mousedown and mouseup (so the image preview
 * never opened and buttons "sometimes did nothing"), and the media loader
 * re-running on every remount.
 *
 * The reference harness solves this at the source: its store's writes are
 * immer-draft transforms, so an unchanged branch keeps its object identity and
 * `getSnapshot()` returns the same reference until the fact moves
 * (`packages/client/store/src/contract.ts`). Our projection mutates one plain
 * object in place — including element-level mutations such as flipping a user
 * row's `status` — so identity alone cannot decide what changed. THIS clone
 * decides by VALUE instead: a branch deep-equal to the previous snapshot is
 * reused from it, and only what actually differs is copied. The result is
 * still fully detached from the live state (every reused branch came from the
 * previous CLONE, never from the live object), so Solid's immutability
 * expectation holds.
 *
 * Cost is lower than the full clone it replaces: an unchanged branch is one
 * comparison and no copy.
 */

/** JSON-shaped values the projection state is made of. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Whether two JSON-shaped values are equal, with the cheap comparisons first.
 *
 * Strings compare by value; two equal strings are the common case in a frame
 * where one row streamed, and a differing pair exits at the first character.
 */
function jsonEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === "string" || typeof right === "string")
    return left === right;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1)
      if (!jsonEquals(left[index], right[index])) return false;
    return true;
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) return false;
    if (!jsonEquals(left[key], right[key])) return false;
  }
  return true;
}

/**
 * Clones `next` into a fresh graph, reusing `previous`'s objects wherever the
 * two are equal.
 *
 * @param previous - the snapshot handed out last frame, or undefined for the
 *   first frame (which is a full clone).
 * @param next - the live state to snapshot.
 * @returns a detached snapshot whose unchanged branches are the previous
 *   snapshot's own objects.
 */
export function structuralClone<T>(previous: T | undefined, next: T): T {
  if (previous === undefined) return cloneValue(next) as T;
  if (jsonEquals(previous, next)) return previous;
  if (Array.isArray(previous) && Array.isArray(next)) {
    const out: unknown[] = new Array(next.length);
    for (let index = 0; index < next.length; index += 1) {
      const before = index < previous.length ? previous[index] : undefined;
      out[index] = structuralClone(before, next[index]);
    }
    return out as unknown as T;
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(next)) {
      out[key] = structuralClone(
        Object.hasOwn(previous, key) ? previous[key] : undefined,
        next[key],
      );
    }
    return out as unknown as T;
  }
  return cloneValue(next) as T;
}

/** Deep copy of one value, used where no previous snapshot exists. */
function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = cloneValue(value[key]);
    return out;
  }
  return value;
}

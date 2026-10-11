/**
 * The kit's inline glyphs, in the house style: a 16×16 grid drawn at 14px,
 * filled with `currentColor` so a button's color drives them (the same way
 * the workspace menu's dots are drawn).
 *
 * Drawn rather than sourced or emoji: a pictograph renders differently on
 * every platform and reads as a draft, and these two carry the only
 * human-signal entry in the product (the transcript's rating buttons), so
 * they are worth their own strokes.
 */

/** Thumbs up: the thumb nub upper left, the fist, the wrist below. */
export function ThumbsUpIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M3.5 1.6h.7a1.3 1.3 0 0 1 1.3 1.3v2.6a1.3 1.3 0 0 1-1.3 1.3h-.7a1.3 1.3 0 0 1-1.3-1.3V2.9a1.3 1.3 0 0 1 1.3-1.3Z M6 4.4h5.6a1.4 1.4 0 0 1 1.4 1.4v3.6a1.4 1.4 0 0 1-1.4 1.4H6a1.4 1.4 0 0 1-1.4-1.4V5.8A1.4 1.4 0 0 1 6 4.4Z M7.2 10.8h1.6a.8.8 0 0 1 .8.8v1.8a.8.8 0 0 1-.8.8H7.2a.8.8 0 0 1-.8-.8v-1.8a.8.8 0 0 1 .8-.8Z"
      />
    </svg>
  );
}

/** Thumbs down: the up glyph mirrored on the y axis. */
export function ThumbsDownIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M3.5 9.2h.7a1.3 1.3 0 0 1 1.3 1.3v2.2a1.3 1.3 0 0 1-1.3 1.3h-.7a1.3 1.3 0 0 1-1.3-1.3v-2.2a1.3 1.3 0 0 1 1.3-1.3Z M6 5.2h5.6a1.4 1.4 0 0 1 1.4 1.4v3.6a1.4 1.4 0 0 1-1.4 1.4H6a1.4 1.4 0 0 1-1.4-1.4V6.6A1.4 1.4 0 0 1 6 5.2Z M7.2 1.8h1.6a.8.8 0 0 1 .8.8v1.8a.8.8 0 0 1-.8.8H7.2a.8.8 0 0 1-.8-.8V2.6a.8.8 0 0 1 .8-.8Z"
      />
    </svg>
  );
}

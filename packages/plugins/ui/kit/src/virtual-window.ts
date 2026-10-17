/**
 * The rows a virtual window covers, as the transcript's OWN message objects.
 *
 * `<For>` keys by ELEMENT IDENTITY. `@tanstack/solid-virtual`'s `getVirtualItems()`
 * builds fresh `{index, start, size, key}` objects on every recompute, so keying
 * the transcript's rows by them destroyed and rebuilt every visible row on every
 * measurement, every scroll and every projection tick. Measured on the deployed
 * build: a tool card went away and came back as a DIFFERENT DOM node while the app
 * sat idle with nobody touching it —
 *
 *   idle 1.5s, no input → cardSurvived: false, childList mutations: 0
 *   one click on "展开全部" → the pressed <button> came back detached
 *
 * which is why the fold button "sometimes did nothing" (the browser dispatches no
 * `click` when mousedown and mouseup land on different nodes) and why every
 * re-mount re-ran the media loader into an RPC storm that made the transcript
 * unscrollable.
 *
 * `slice` hands back the SAME element references, so a recompute covering the
 * same rows reuses them and nothing is rebuilt. The reference implementation's
 * rule — a row's identity is its durable id, never its position — expressed for
 * Solid's array diffing.
 *
 * @param messages - the full transcript row list.
 * @param items - the virtualizer's window, in order.
 * @returns the covered rows, identity-preserved; empty when the window is.
 */
export function windowedMessages<T>(
  messages: readonly T[],
  items: readonly { index: number }[],
): T[] {
  if (items.length === 0) return [];
  const first = items[0]!.index;
  const last = items[items.length - 1]!.index;
  if (first < 0 || last < first) return [];
  return messages.slice(first, last + 1);
}

/**
 * The virtual index of a row inside a windowed slice.
 *
 * @param items - the virtualizer's window, in order.
 * @param position - the row's position within {@link windowedMessages}.
 * @returns the row's index in the full list.
 */
export function windowedIndex(
  items: readonly { index: number }[],
  position: number,
): number {
  return (items[0]?.index ?? 0) + position;
}

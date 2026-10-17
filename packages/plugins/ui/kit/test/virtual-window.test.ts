/**
 * A virtual window must hand `<For>` the SAME row objects.
 *
 * The transcript keyed its virtual rows by `virtualItems()` — fresh objects on
 * every recompute — so Solid's reference-keyed `<For>` destroyed and rebuilt every
 * visible row on every measurement, scroll and projection tick. Measured on the
 * deployed build while the app sat IDLE: a tool card came back as a different DOM
 * node, and one click on its fold button left the pressed `<button>` detached —
 * which is the "sometimes the expand does nothing" report, and the re-mount storm
 * that made the transcript unscrollable.
 */
import { expect, test } from "bun:test";
import { windowedIndex, windowedMessages } from "../src/virtual-window";

const rows = Array.from({ length: 6 }, (_, index) => ({ id: `row_${index}` }));

test("the windowed slice keeps the transcript's own row objects", () => {
  const window = [
    { index: 2, start: 200, size: 100, key: 2 },
    { index: 3, start: 300, size: 100, key: 3 },
  ];
  const slice = windowedMessages(rows, window);
  expect(slice.map((row) => row.id)).toEqual(["row_2", "row_3"]);
  // IDENTITY, not equality: this is what stops the rebuild.
  expect(slice[0]).toBe(rows[2]!);
  expect(slice[1]).toBe(rows[3]!);
  // Two windows covering the same rows return the same references again.
  const again = windowedMessages(rows, [
    { index: 2, start: 210, size: 90, key: 2 },
    { index: 3, start: 310, size: 90, key: 3 },
  ]);
  expect(again[0]).toBe(slice[0]!);
});

test("a row's virtual index is its position in the full list", () => {
  const window = [{ index: 4, start: 400, size: 100, key: 4 }];
  expect(windowedIndex(window, 0)).toBe(4);
  // A row's index comes from the window, not from the slice's position alone.
  expect(windowedIndex(window, 0)).toBe(windowedIndex(window, 0));
  expect(windowedIndex([], 0)).toBe(0);
});

test("an empty or inverted window yields no rows", () => {
  expect(windowedMessages(rows, [])).toEqual([]);
  expect(windowedMessages(rows, [{ index: 3 }, { index: 1 }])).toEqual([]);
  // A window past the end is empty rather than an exception: the list can shrink
  // under a measurement.
  expect(windowedMessages(rows, [{ index: 9 }])).toEqual([]);
});

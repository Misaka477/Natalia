import { expect, test } from "bun:test";
import { Virtualizer } from "@tanstack/solid-virtual";

function virtualizerFor(initialOffset = 0) {
  const rowHeight = 64;
  const viewportHeight = 600;
  return new Virtualizer<Element, Element>({
    count: 1_000,
    getScrollElement: () => null,
    estimateSize: () => rowHeight,
    overscan: 8,
    initialRect: { width: 800, height: viewportHeight },
    initialOffset,
    observeElementRect: (_instance, callback) => {
      callback({ width: 800, height: viewportHeight });
      return () => {};
    },
    observeElementOffset: (_instance, callback) => {
      callback(initialOffset, false);
      return () => {};
    },
    scrollToFn: () => {},
  });
}

test("transcript virtualization bounds mounted rows for 1000 messages", () => {
  const virtualizer = virtualizerFor();
  expect(virtualizer.getTotalSize()).toBe(64_000);
  const mounted = virtualizer.getVirtualItems();
  expect(mounted[0]?.index).toBe(0);
  expect(mounted.length).toBeLessThan(40);
  expect(mounted.at(-1)?.end).toBeLessThanOrEqual((64_000 / 64) * 64);
});

test("transcript virtualization moves the mounted window with scroll", () => {
  const rowHeight = 64;
  const virtualizer = virtualizerFor(20 * rowHeight);
  const mounted = virtualizer.getVirtualItems();
  expect(mounted[0]?.index).toBeGreaterThan(0);
  expect(mounted[0]?.index).toBeLessThanOrEqual(20);
  expect(mounted.at(-1)?.index).toBeGreaterThan(20);
  expect(mounted.length).toBeLessThan(40);
});

function pinnedVirtualizer() {
  const rowHeight = 100;
  const viewportHeight = 600;
  const count = 100;
  const initialOffset = count * rowHeight - viewportHeight;
  const state = { offset: initialOffset, scrollCalls: 0 };
  const virtualizer = new Virtualizer<Element, Element>({
    count,
    getScrollElement: () => null,
    estimateSize: () => rowHeight,
    overscan: 0,
    initialRect: { width: 800, height: viewportHeight },
    initialOffset,
    observeElementRect: (_instance, callback) => {
      callback({ width: 800, height: viewportHeight });
      return () => {};
    },
    observeElementOffset: (_instance, callback) => {
      callback(state.offset, false);
      return () => {};
    },
    scrollToFn: (offset, options) => {
      state.offset = offset + (options?.adjustments ?? 0);
      state.scrollCalls += 1;
    },
    anchorTo: "end",
    // This is the TrajectoryTable contract the Transcript follows: the
    // virtualizer's own end anchor compensates estimate-to-measure deltas
    // while pinned. Without it a larger initial measurement above the fold
    // grows total size but leaves scrollTop over the old bottom.
    scrollEndThreshold: 2,
  });
  return { virtualizer, state };
}

test("pinned transcript virtualization compensates dynamic row growth", () => {
  const { virtualizer, state } = pinnedVirtualizer();
  const before = state.offset;
  expect(virtualizer.getVirtualItems().at(-1)?.index).toBe(99);

  // A row above the fold is measured far larger than its estimate after the
  // initial scroll-to-end. The dynamic-height compensation must keep the
  // scrollport pinned to the true bottom; otherwise Natalia starts up above
  // the latest transcript and only "jump to bottom" recovers it.
  virtualizer.resizeItem(10, 200);

  expect(virtualizer.getTotalSize()).toBe(10_100);
  expect(state.offset).toBe(before + 100);
  expect(state.scrollCalls).toBe(1);
  expect(virtualizer.getVirtualItems().at(-1)?.index).toBe(99);
});

import { expect, test } from "bun:test";
import { createScrollAutoAppend } from "../src/auto-append";

/**
 * A fake scrollport: the geometry the appender's guards read. Tests drive it
 * through the exact same code path the UI does (a scroll handler plus a
 * row-count effect), so the append/re-arm rules are pinned without a DOM.
 */
function fakeScrollport(height: number) {
  return {
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: height,
  };
}

function makeAppender(
  el: ReturnType<typeof fakeScrollport>,
  rowCount: () => number,
) {
  // `more` models remaining data: it stays true until a test exhausts it, the
  // way a real owner gates `moreAvailable` on its own page state.
  let more = true;
  const appended: number[] = [];
  const appender = createScrollAutoAppend({
    scrollEl: () => el,
    moreAvailable: () => more,
    rowCount,
    append: () => appended.push(rowCount()),
  });
  return {
    appended,
    check: appender.check,
    isNearBottom: appender.isNearBottom,
    setMore: (value: boolean) => {
      more = value;
    },
  };
}

test("scrolling into the end zone appends exactly one page", () => {
  const el = fakeScrollport(400);
  el.scrollHeight = 4_000;
  const { appended, check } = makeAppender(el, () => 400);
  el.scrollTop = 3_500; // 100px from the bottom: inside the 240px end zone
  check();
  expect(appended).toHaveLength(1);
  // No new rows arrived, so a second scroll event must not re-fire.
  check();
  expect(appended).toHaveLength(1);
});

test("scrolling away from the end re-arms the appender for the next page", () => {
  const el = fakeScrollport(400);
  el.scrollHeight = 4_000;
  let rows = 400;
  const { appended, check } = makeAppender(el, () => rows);
  el.scrollTop = 3_500;
  check();
  expect(appended).toHaveLength(1);
  // The next page lands: taller content, the reader has moved up.
  rows = 800;
  el.scrollHeight = 8_000;
  el.scrollTop = 1_000;
  check();
  expect(appended).toHaveLength(1); // still re-armed only after leaving the zone
  el.scrollTop = 7_800; // back inside the end zone
  check();
  expect(appended).toHaveLength(2);
});

test("a page too short to scroll self-extends while the reader stays near the end", () => {
  const el = fakeScrollport(600);
  el.scrollHeight = 500; // underfilled: nothing is scrollable
  let rows = 20;
  const { appended, check, setMore } = makeAppender(el, () => rows);
  check();
  expect(appended).toHaveLength(1);
  // The appended page still keeps the reader inside the end zone (100px left),
  // so the chain continues instead of leaving a stub list.
  rows = 60;
  el.scrollHeight = 700;
  check();
  expect(appended).toHaveLength(2);
  // Exhausted data ends the chain.
  setMore(false);
  check();
  expect(appended).toHaveLength(2);
});

test("no appends happen when nothing more is available", () => {
  const el = fakeScrollport(400);
  el.scrollHeight = 4_000;
  el.scrollTop = 3_900;
  const { appended, check, setMore } = makeAppender(el, () => 400);
  setMore(false);
  check();
  expect(appended).toHaveLength(0);
});

test("isNearBottom tracks the scrollport", () => {
  const el = fakeScrollport(400);
  el.scrollHeight = 4_000;
  const { isNearBottom } = makeAppender(el, () => 0);
  el.scrollTop = 0;
  expect(isNearBottom()).toBe(false);
  el.scrollTop = 3_400;
  expect(isNearBottom()).toBe(true);
});

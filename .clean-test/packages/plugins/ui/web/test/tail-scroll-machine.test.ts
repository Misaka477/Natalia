import { expect, test } from "bun:test";
import {
  evaluateTailScroll,
  initialTailScrollState,
  type TailScrollInput,
} from "@natalia/ui-kit";

function input(overrides: Partial<TailScrollInput> = {}): TailScrollInput {
  return {
    count: 10,
    firstKey: "t1",
    historyLoading: false,
    virtualize: true,
    virtualReady: true,
    ...overrides,
  };
}

test("history loading blocks tail initialization", () => {
  const first = evaluateTailScroll(
    initialTailScrollState(),
    input({ historyLoading: true }),
  );
  expect(first.state.initialized).toBe(false);
  expect(first.effect.type).toBe("none");
});

test("virtualized tail waits for a measured window", () => {
  const first = evaluateTailScroll(
    initialTailScrollState(),
    input({ virtualReady: false }),
  );
  expect(first.state.initialized).toBe(false);
  expect(first.effect.type).toBe("none");

  const second = evaluateTailScroll(first.state, input());
  expect(second.state.initialized).toBe(true);
  expect(second.effect.type).toBe("measure-and-scroll-end");
});

test("later growth follows only while the reader is pinned", () => {
  let state = evaluateTailScroll(initialTailScrollState(), input()).state;
  const followed = evaluateTailScroll(state, input({ count: 11 }));
  expect(followed.effect.type).toBe("scroll-end");

  state = { ...state, following: false };
  const notFollowed = evaluateTailScroll(state, input({ count: 12 }));
  expect(notFollowed.effect.type).toBe("none");
});

test("prepend restores the older anchor and leaves follow", () => {
  let state = evaluateTailScroll(initialTailScrollState(), input()).state;
  state = {
    ...state,
    olderAnchor: {
      startKey: "t1",
      scrollHeight: 1000,
      scrollTop: 100,
      visibleKey: "t3",
      visibleTop: 24,
    },
  };
  const result = evaluateTailScroll(
    state,
    input({ firstKey: "t0", count: 20 }),
  );
  expect(result.effect).toEqual({
    type: "restore-anchor",
    anchor: state.olderAnchor!,
  });
  expect(result.state.following).toBe(false);
  expect(result.state.olderAnchor).toBeNull();
});

test("whole transcript replacement reinitializes the tail", () => {
  let state = evaluateTailScroll(initialTailScrollState(), input()).state;
  state = { ...state, following: false };
  const replaced = evaluateTailScroll(
    state,
    input({ firstKey: "other", count: 5 }),
  );
  expect(replaced.state.initialized).toBe(true);
  expect(replaced.effect.type).toBe("measure-and-scroll-end");
});

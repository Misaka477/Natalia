import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { maxLiveSessionEvents, windowRuntimeEvents } from "@anthelia/substrate";

function submitted(id: string): RuntimeEvent {
  return {
    type: "turn.submitted",
    id,
    text: "hi",
    byteLength: 2,
    lineCount: 1,
    sha256: "x",
  };
}

function delta(id: string, text: string): RuntimeEvent {
  return { type: "content.delta", id, text };
}

test("windowRuntimeEvents is a no-op when disabled or under the cap", () => {
  const events = [submitted("t1"), delta("t1", "a")];
  expect(windowRuntimeEvents(events, 0)).toBe(events);
  expect(windowRuntimeEvents(events, 10)).toBe(events);
});

test("windowRuntimeEvents keeps the newest events aligned to a turn boundary", () => {
  const events = [
    submitted("t1"),
    delta("t1", "a"),
    delta("t1", "b"),
    submitted("t2"),
    delta("t2", "c"),
    delta("t2", "d"),
    submitted("t3"),
    delta("t3", "e"),
  ];
  const atBoundary = (list: RuntimeEvent[]) =>
    list.map((event) => (event as { id: string }).id);
  // 4 keeps the tail; the first turn boundary at/after the cut is t3.
  expect(atBoundary(windowRuntimeEvents(events, 4))).toEqual(["t3", "t3"]);
  // 6 reaches the t2 submission exactly, so t2 is included whole.
  expect(atBoundary(windowRuntimeEvents(events, 6))).toEqual([
    "t2",
    "t2",
    "t2",
    "t3",
    "t3",
  ]);
});

test("windowRuntimeEvents keeps everything when no boundary is reachable", () => {
  const events = [delta("t1", "a"), delta("t1", "b")];
  expect(windowRuntimeEvents(events, 1)).toBe(events);
});

test("maxLiveSessionEvents reads a positive env override and defaults to off", () => {
  const previous = process.env.NATALIA_MAX_LIVE_SESSION_EVENTS;
  try {
    process.env.NATALIA_MAX_LIVE_SESSION_EVENTS = "1234";
    expect(maxLiveSessionEvents()).toBe(1234);
    process.env.NATALIA_MAX_LIVE_SESSION_EVENTS = "0";
    expect(maxLiveSessionEvents()).toBe(0);
    delete process.env.NATALIA_MAX_LIVE_SESSION_EVENTS;
    expect(maxLiveSessionEvents()).toBe(0);
  } finally {
    if (previous === undefined)
      delete process.env.NATALIA_MAX_LIVE_SESSION_EVENTS;
    else process.env.NATALIA_MAX_LIVE_SESSION_EVENTS = previous;
  }
});

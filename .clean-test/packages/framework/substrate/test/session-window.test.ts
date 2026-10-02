import { expect, test } from "bun:test";
import {
  SessionWindow,
  createRuntimeEventWindowLoader,
  type SessionWindowPage,
} from "@anthelia/substrate";

type Event = { seq: number; text: string };

function event(seq: number): Event {
  return { seq, text: `event-${seq}` };
}

function page(events: Event[], hasMore: boolean): SessionWindowPage<Event> {
  return { events, hasMore };
}

test("session window opens on a contiguous tail page", async () => {
  const window = new SessionWindow<Event>({
    loader: {
      loadTail: async () => page([event(3), event(4), event(5)], true),
      loadBefore: async () => page([], false),
    },
  });
  await window.open();
  expect(window.openState).toBe("open");
  expect(window.eventsView.map((item) => item.seq)).toEqual([3, 4, 5]);
  expect(window.baseSeq).toBe(3);
  expect(window.tailSeq).toBe(5);
  expect(window.hasMore).toBe(true);
});

test("session window prepends one contiguous older page", async () => {
  const before: number[] = [];
  const window = new SessionWindow<Event>({
    loader: {
      loadTail: async () => page([event(4), event(5)], true),
      loadBefore: async (beforeSeq) => {
        before.push(beforeSeq);
        return page([event(2), event(3)], false);
      },
    },
  });
  await window.open();
  expect(await window.loadOlder()).toBe(true);
  expect(before).toEqual([4]);
  expect(window.eventsView.map((item) => item.seq)).toEqual([2, 3, 4, 5]);
  expect(window.baseSeq).toBe(2);
  expect(window.hasMore).toBe(false);
});

test("session window rejects a discontinuous older page", async () => {
  const window = new SessionWindow<Event>({
    loader: {
      loadTail: async () => page([event(5), event(6)], true),
      loadBefore: async () => page([event(2), event(4)], true),
    },
  });
  await window.open();
  expect(await window.loadOlder()).toBe(false);
  expect(window.eventsView.map((item) => item.seq)).toEqual([5, 6]);
  expect(window.hasMore).toBe(false);
});

test("session window appends in-order live events and drops overlap", async () => {
  const window = new SessionWindow<Event>({
    loader: {
      loadTail: async () => page([event(1), event(2)], false),
      loadBefore: async () => page([], false),
    },
  });
  await window.open();
  expect(window.acceptLive(event(3))).toBe(true);
  expect(window.acceptLive(event(2))).toBe(false);
  expect(window.eventsView.map((item) => item.seq)).toEqual([1, 2, 3]);
  expect(window.tailSeq).toBe(3);
});

test("session window repairs a live gap and stitches buffered events", async () => {
  let tailCalls = 0;
  const gaps: number[] = [];
  const window = new SessionWindow<Event>({
    loader: {
      loadTail: async () => {
        tailCalls += 1;
        return tailCalls === 1
          ? page([event(1), event(2)], true)
          : page([event(3), event(4)], true);
      },
      loadBefore: async () => page([], false),
    },
    onGap: (item) => gaps.push(item.seq),
  });
  await window.open();
  expect(window.acceptLive(event(4))).toBe(false);
  expect(gaps).toEqual([4]);
  await Bun.sleep(0);
  expect(window.eventsView.map((item) => item.seq)).toEqual([3, 4]);
  expect(window.baseSeq).toBe(3);
  expect(window.bufferedCount).toBe(0);
});

test("session window resync clears the old window before reopening", async () => {
  let tailCalls = 0;
  const window = new SessionWindow<Event>({
    loader: {
      loadTail: async () => {
        tailCalls += 1;
        return tailCalls === 1
          ? page([event(1), event(2)], false)
          : page([event(8), event(9)], false);
      },
      loadBefore: async () => page([], false),
    },
  });
  await window.open();
  await window.resync();
  expect(window.eventsView.map((item) => item.seq)).toEqual([8, 9]);
  expect(window.baseSeq).toBe(8);
});

test("runtime event window loader preserves the per-session cursor", async () => {
  const calls: Array<{ beforeSeq?: number; limit?: number }> = [];
  const runtime = {
    async eventWindow(options?: {
      beforeSeq?: number;
      limit?: number;
      sessionID?: string;
    }) {
      calls.push({ beforeSeq: options?.beforeSeq, limit: options?.limit });
      if (options?.beforeSeq === undefined)
        return {
          events: [
            { seq: 30, sessionSeq: 3, event: event(3) },
            { seq: 40, sessionSeq: 4, event: event(4) },
          ],
          hasMore: true,
        };
      return {
        events: [
          { seq: 10, sessionSeq: 1, event: event(1) },
          { seq: 20, sessionSeq: 2, event: event(2) },
        ],
        hasMore: false,
      };
    },
  };
  const loader = createRuntimeEventWindowLoader(
    runtime as never,
    "ses_window",
    2,
  );
  const tail = await loader.loadTail();
  expect(tail.events.map((entry) => entry.seq)).toEqual([3, 4]);
  expect(tail.hasMore).toBe(true);
  const older = await loader.loadBefore(3);
  expect(older.events.map((entry) => entry.seq)).toEqual([1, 2]);
  expect(calls).toEqual([
    { beforeSeq: undefined, limit: 2 },
    { beforeSeq: 3, limit: 2 },
  ]);
});

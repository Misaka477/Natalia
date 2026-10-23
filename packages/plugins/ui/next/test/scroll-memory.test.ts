import { describe, expect, test } from "bun:test";

import {
  TranscriptScrollMemory,
  anchorIndexFor,
  readTranscriptAnchor,
} from "../src/controllers/scroll-memory";

/** A container with the rows the reader sees, in the order they render. */
function makeContainer(
  rows: Array<{ id: string; top: number; height: number }>,
) {
  const container = {
    dataset: {} as Record<string, string>,
    getBoundingClientRect: () => ({ top: 0, bottom: 600, height: 600 }),
    querySelectorAll: <T>(selector: string) => {
      if (selector !== "[data-message-id]") return [] as unknown as T;
      return rows.map((row) => ({
        dataset: { messageId: row.id },
        getBoundingClientRect: () => ({
          top: row.top,
          bottom: row.top + row.height,
          height: row.height,
        }),
      })) as unknown as T;
    },
  };
  return container as unknown as HTMLElement;
}

describe("TranscriptScrollMemory", () => {
  test("remembers and recalls an anchor per session", () => {
    const memory = new TranscriptScrollMemory();
    memory.remember("s1", {
      messageID: "m1",
      offsetInRow: 12,
      following: false,
    });
    expect(memory.recall("s1")).toEqual({
      messageID: "m1",
      offsetInRow: 12,
      following: false,
    });
    expect(memory.recall("s2")).toBeUndefined();
  });

  test("a session's newer anchor replaces its older one", () => {
    const memory = new TranscriptScrollMemory();
    memory.remember("s1", { messageID: "m1", offsetInRow: 0, following: true });
    memory.remember("s1", {
      messageID: "m9",
      offsetInRow: 4,
      following: false,
    });
    expect(memory.size).toBe(1);
    expect(memory.recall("s1")?.messageID).toBe("m9");
  });

  test("forgetting one session leaves the others", () => {
    const memory = new TranscriptScrollMemory();
    memory.remember("s1", { messageID: "m1", offsetInRow: 0, following: true });
    memory.remember("s2", { messageID: "m2", offsetInRow: 0, following: true });
    memory.forget("s1");
    expect(memory.recall("s1")).toBeUndefined();
    expect(memory.recall("s2")?.messageID).toBe("m2");
  });

  test("the oldest session is evicted past the cap", () => {
    const memory = new TranscriptScrollMemory();
    for (let i = 0; i < 40; i++) {
      memory.remember(`s${i}`, {
        messageID: `m${i}`,
        offsetInRow: 0,
        following: true,
      });
    }
    // The cap holds; the first sessions remembered are the first gone.
    expect(memory.size).toBe(32);
    expect(memory.recall("s0")).toBeUndefined();
    expect(memory.recall("s39")?.messageID).toBe("m39");
  });

  test("re-visiting a session refreshes its recency", () => {
    const memory = new TranscriptScrollMemory();
    for (let i = 0; i < 32; i++) {
      memory.remember(`s${i}`, {
        messageID: `m${i}`,
        offsetInRow: 0,
        following: true,
      });
    }
    memory.remember("s0", { messageID: "m0", offsetInRow: 0, following: true });
    memory.remember("s32", {
      messageID: "m32",
      offsetInRow: 0,
      following: true,
    });
    // s0 was re-remembered, so it survives and the next-oldest goes instead.
    expect(memory.recall("s0")?.messageID).toBe("m0");
    expect(memory.recall("s1")).toBeUndefined();
  });

  test("clear drops everything", () => {
    const memory = new TranscriptScrollMemory();
    memory.remember("s1", { messageID: "m1", offsetInRow: 0, following: true });
    memory.clear();
    expect(memory.size).toBe(0);
  });
});

describe("readTranscriptAnchor", () => {
  test("reads the first row that reaches the viewport's top edge", () => {
    const container = makeContainer([
      { id: "m1", top: -200, height: 100 },
      { id: "m2", top: -100, height: 100 },
      { id: "m3", top: 0, height: 100 },
      { id: "m4", top: 100, height: 100 },
    ]);
    expect(readTranscriptAnchor(container, false)).toEqual({
      messageID: "m3",
      offsetInRow: 0,
      following: false,
    });
  });

  test("a row straddling the edge reads as being at that row's top", () => {
    const container = makeContainer([
      { id: "m1", top: -200, height: 100 },
      { id: "m2", top: -60, height: 100 },
      { id: "m3", top: 40, height: 100 },
    ]);
    // m1's bottom (-100) is above the edge, so m2 is the row the reader is
    // in — and because m2's own top is also above the edge, the reader is at
    // that row's top, not partway into it.
    expect(readTranscriptAnchor(container, false)).toEqual({
      messageID: "m2",
      offsetInRow: 0,
      following: false,
    });
  });

  test("reports how far below the edge a fully visible row starts", () => {
    const container = makeContainer([
      { id: "m1", top: -200, height: 100 },
      { id: "m2", top: 50, height: 100 },
    ]);
    // m1 is entirely above the edge; m2 starts 50px below it.
    expect(readTranscriptAnchor(container, false)).toEqual({
      messageID: "m2",
      offsetInRow: 50,
      following: false,
    });
  });

  test("a row that straddles the edge is the anchor", () => {
    const container = makeContainer([
      { id: "m1", top: -30, height: 100 },
      { id: "m2", top: 70, height: 100 },
    ]);
    expect(readTranscriptAnchor(container, true)).toEqual({
      messageID: "m1",
      offsetInRow: 0,
      following: true,
    });
  });

  test("every row above the edge reads as the last row", () => {
    const container = makeContainer([
      { id: "m1", top: -300, height: 100 },
      { id: "m2", top: -200, height: 100 },
    ]);
    expect(readTranscriptAnchor(container, false)?.messageID).toBe("m2");
  });

  test("an empty transcript has no position to remember", () => {
    expect(readTranscriptAnchor(makeContainer([]), false)).toBeUndefined();
    expect(readTranscriptAnchor(undefined, false)).toBeUndefined();
  });
});

describe("anchorIndexFor", () => {
  test("finds the remembered message in the new list", () => {
    expect(
      anchorIndexFor({ messageID: "m7", offsetInRow: 0, following: false }, [
        "m1",
        "m2",
        "m7",
        "m8",
      ]),
    ).toBe(2);
  });

  test("a message no longer present means the caller falls back to the tail", () => {
    expect(
      anchorIndexFor({ messageID: "gone", offsetInRow: 0, following: false }, [
        "m1",
        "m2",
      ]),
    ).toBe(-1);
  });

  test("no anchor at all means the same fallback", () => {
    expect(anchorIndexFor(undefined, ["m1"])).toBe(-1);
  });
});

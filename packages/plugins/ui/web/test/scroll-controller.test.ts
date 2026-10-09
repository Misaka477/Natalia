import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TailScrollController,
  estimateMessageHeight,
  fixedRowHeight,
  type Message,
} from "@natalia/ui-kit";

function rect(top: number, height = 100) {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 800,
    width: 800,
    height,
  } as DOMRect;
}

interface FakeRowState {
  key: string;
  top: number;
  height?: number;
}

function createFakeScrollElement(options?: {
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  rows?: FakeRowState[];
}) {
  const state = {
    scrollTop: options?.scrollTop ?? 400,
    scrollHeight: options?.scrollHeight ?? 1_000,
    clientHeight: options?.clientHeight ?? 600,
    rows: [...(options?.rows ?? [])],
  };
  const rows = () => state.rows;
  const rowElement = (row: FakeRowState) => ({
    dataset: { messageId: row.key },
    getBoundingClientRect: () => rect(row.top, row.height ?? 100),
  });
  const matchesKey = (selector: string, key: string) =>
    selector.includes(`data-message-id="${key}"`) ||
    selector.includes(`data-message-id=\\"${key}\\"`);
  const element = {
    get scrollTop() {
      return state.scrollTop;
    },
    set scrollTop(value: number) {
      state.scrollTop = value;
    },
    get scrollHeight() {
      return state.scrollHeight;
    },
    set scrollHeight(value: number) {
      state.scrollHeight = value;
    },
    get clientHeight() {
      return state.clientHeight;
    },
    getBoundingClientRect: () => ({
      top: 0,
      bottom: state.clientHeight,
      left: 0,
      right: 800,
      width: 800,
      height: state.clientHeight,
    }),
    querySelectorAll: () => rows().map(rowElement),
    querySelector: (selector: string) => {
      const found = rows().find((row) => matchesKey(selector, row.key));
      return found ? rowElement(found) : null;
    },
  } as unknown as HTMLElement;
  return { element, state, rowElement };
}

function scrollEvent(element: HTMLElement): Event {
  return { currentTarget: element } as unknown as Event;
}

test("follow state only toggles at the 2px threshold and user intent wins", () => {
  const { element } = createFakeScrollElement({ scrollTop: 398 });
  const changes: boolean[] = [];
  const controller = new TailScrollController({
    getScrollElement: () => element,
    onFollowChange: (following) => changes.push(following),
  });

  controller.onScroll(scrollEvent(element));
  expect(controller.isFollowing()).toBe(true);

  element.scrollTop = 350;
  controller.onScroll(scrollEvent(element));
  expect(controller.isFollowing()).toBe(false);

  controller.scrollToBottom({ behavior: "auto" });
  expect(controller.isFollowing()).toBe(true);

  controller.onUserIntent();
  expect(controller.isFollowing()).toBe(false);
  expect(changes).toContain(false);

  element.scrollTop = 400;
  controller.reconcile();
  expect(controller.isFollowing()).toBe(true);
});

test("data changes only follow while followTail is true", async () => {
  const { element, state } = createFakeScrollElement({ scrollTop: 200 });
  let endCalls = 0;
  const controller = new TailScrollController({
    getScrollElement: () => element,
    scrollToEnd: () => {
      endCalls += 1;
      state.scrollTop = state.scrollHeight;
    },
  });

  controller.breakFollow();
  controller.notifyDataChanged();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(endCalls).toBe(0);
  expect(state.scrollTop).toBe(200);

  controller.scrollToBottom();
  expect(endCalls).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(endCalls).toBeGreaterThanOrEqual(2);
});

test("older history restores the first visible message by key", () => {
  const { element, state } = createFakeScrollElement({
    scrollTop: 300,
    rows: [
      { key: "older", top: -120 },
      { key: "anchor", top: 24 },
      { key: "newer", top: 140 },
    ],
  });
  const controller = new TailScrollController({
    getScrollElement: () => element,
  });

  const anchor = controller.captureOlderAnchor();
  expect(anchor?.key).toBe("anchor");
  expect(anchor?.top).toBe(24);
  expect(controller.isFollowing()).toBe(false);

  state.scrollTop = 120;
  state.rows = [
    { key: "ancient", top: -160 },
    { key: "older", top: -40 },
    { key: "anchor", top: 64 },
    { key: "newer", top: 180 },
  ];

  controller.restoreOlderAnchor();
  expect(state.scrollTop).toBe(160);
});

test("older history falls back to scrollHeight delta when the anchor is gone", () => {
  const { element, state } = createFakeScrollElement({
    scrollTop: 300,
    scrollHeight: 1_000,
    rows: [],
  });
  const controller = new TailScrollController({
    getScrollElement: () => element,
  });

  controller.captureOlderAnchor();
  state.scrollHeight = 1_300;

  controller.restoreOlderAnchor();
  expect(state.scrollTop).toBe(600);
});

test("tool output estimates account for the payload instead of content length", () => {
  const base: Message = {
    id: "short",
    role: "assistant",
    content: "hello",
  };
  const huge = estimateMessageHeight({
    ...base,
    id: "huge",
    content: "",
    toolCalls: [
      {
        name: "shell",
        output: "x".repeat(10_000),
        status: "done",
      },
    ],
  });

  expect(estimateMessageHeight(base)).toBeLessThan(120);
  // Large tool output is collapsed by default, so its estimate must stay
  // bounded instead of reserving space for the full 10k-character payload.
  expect(huge).toBeGreaterThan(200);
  expect(huge).toBeLessThan(600);
});

test("a row's height is its content's height, with no ceiling (2026-10-10 ruling)", () => {
  // The user's ruling on 2026-10-10: no fixed height, no inner scrollbar,
  // render naturally. The clamp this replaces (a 40-line body budget and a
  // 1200px ceiling) also broke the tail-follow — a row that renders 6000px was
  // reported as 1200px, so the pane's total size came up short and the follow
  // landed above the true bottom: a large answer could not be scrolled to.
  const small: Message = { id: "s", role: "assistant", content: "hi" };
  const fortyLines: Message = {
    ...small,
    id: "forty",
    content: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"),
  };
  const fortyThousandLines: Message = {
    ...small,
    id: "huge",
    content: Array.from({ length: 40_000 }, (_, i) => `line ${i}`).join("\n"),
  };
  // The height grows with the body instead of being clamped to a constant.
  expect(fixedRowHeight(fortyLines)).toBeGreaterThan(fixedRowHeight(small));
  expect(fixedRowHeight(fortyThousandLines)).toBeGreaterThan(
    fixedRowHeight(fortyLines) * 100,
  );
  // No ceiling: a 40,000-line body is NOT reported as 1200px.
  expect(fixedRowHeight(fortyThousandLines)).toBeGreaterThan(1200);
  // Deterministic: the same message always measures the same.
  expect(fixedRowHeight(fortyThousandLines)).toBe(
    fixedRowHeight(fortyThousandLines),
  );
});

test("fixedRowHeight collapses large tool output to its preview height", () => {
  const base: Message = { id: "b", role: "assistant", content: "" };
  const small: Message = {
    ...base,
    id: "small-out",
    toolCalls: [{ name: "shell", output: "ok", status: "done" }],
  };
  const huge: Message = {
    ...base,
    id: "huge-out",
    toolCalls: [{ name: "shell", output: "x".repeat(50_000), status: "done" }],
  };
  // Same message -> same height (deterministic, no DOM measurement).
  expect(fixedRowHeight(huge)).toBe(fixedRowHeight(huge));
  // Large output is collapsed to a bounded preview, not the full payload.
  expect(fixedRowHeight(huge)).toBeGreaterThan(fixedRowHeight(small));
  expect(fixedRowHeight(huge)).toBeLessThan(600);
});

test("a message's own body carries no height bound and no inner scrollbar", () => {
  // The 2026-10-10 ruling, twice over: "no fixed height, no inner scrollbar,
  // render naturally". The row-height clamp was the first half (a 6000px row
  // reported as 1200px); this is the second — `.natalia-message-text pre` had
  // `max-height: 420px; overflow: auto`, so any block markdown parsed into a
  // <pre> (an indented quote, a fenced block) became a fixed box the reader
  // had to scroll INSIDE, in the middle of a reply.
  //
  // The reference implementation's markdown payload carries no height bound at
  // all — one scrollbar for the whole conversation, which is the pane's.
  const css = readFileSync(
    join(import.meta.dir, "..", "src", "styles", "base.ts"),
    "utf8",
  );
  const rule = (selector: string) => {
    const at = css.indexOf(selector);
    expect(at, `${selector} must exist`).toBeGreaterThan(-1);
    const body = css.slice(at, css.indexOf("}", at));
    return body;
  };
  for (const selector of [
    ".natalia-message-text pre",
    ".natalia-thinking-text pre",
  ]) {
    const block = rule(selector);
    expect(block, `${selector} must not clamp a height`).not.toContain(
      "max-height",
    );
    // Wrapped, not scrolled: a wide line reflows instead of growing a
    // scrollbar inside the reply.
    expect(block).toContain("white-space: pre-wrap");
    expect(block).not.toContain("overflow: auto");
    expect(block).not.toContain("overflow-y");
  }
  // The message body itself is unconstrained too.
  const body = rule(".natalia-message-body");
  expect(body).not.toContain("max-height");
  expect(body).not.toContain("overflow");
  // AND there is exactly one rule for it. The 2026-10-10 hunt's last trap: a
  // SECOND `.natalia-message-text` rule sat later in the sheet with
  // `max-height: 860px; overflow-y: auto`, overriding the first — so fixing the
  // first changed nothing on screen. A rule that only holds when it is the only
  // one is not a rule; the count is pinned.
  // The rule that survives is the one just checked (it is grouped with
  // `.natalia-thinking-text`), and no other standalone one exists.
  const standalone = css.split(".natalia-message-text {").length - 1;
  expect(standalone).toBe(0);
  expect(css).not.toContain("max-height: 860px");
  expect(css).not.toContain("max-height: 420px");
  // The composer is the one box that legitimately bounds itself (the input
  // grows to a cap, the way the reference implementation's does).
  expect(rule(".natalia-composer-textarea")).toContain("max-height");
});

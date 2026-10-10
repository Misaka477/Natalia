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

test("a reader gesture clears follow; a bare scroll event only re-arms it", () => {
  // The contract, stated once: `onScroll` cannot tell our own follow-scroll
  // from the reader's, so it never CLEARS follow — it re-arms when the reader
  // lands at the bottom and otherwise leaves the flag alone. Clearing is the
  // reader's decision, and it arrives as a gesture (`onUserIntent`). A bare
  // mid-transcript scroll event used to clear it, which is what let our own
  // follow-scroll detach the transcript on a burst of output.
  const { element, state } = createFakeScrollElement({ scrollTop: 398 });
  const changes: boolean[] = [];
  const controller = new TailScrollController({
    getScrollElement: () => element,
    scrollToEnd: () => {
      state.scrollTop = state.scrollHeight;
    },
    onFollowChange: (following) => changes.push(following),
  });

  controller.onScroll(scrollEvent(element));
  expect(controller.isFollowing()).toBe(true);

  // Mid-transcript with no follow-scroll in flight: that scroll event is
  // the reader's, and it detaches them.
  element.scrollTop = 350;
  controller.onScroll(scrollEvent(element));
  expect(controller.isFollowing()).toBe(false);

  // A gesture detaches too, and is the authoritative signal when one is in
  // flight (the wheel handler fires it before the scroll event arrives).
  controller.scrollToBottom({ behavior: "auto" });
  expect(controller.isFollowing()).toBe(true);
  controller.onUserIntent();
  expect(controller.isFollowing()).toBe(false);
  expect(changes).toContain(false);

  // And landing back at the bottom re-arms.
  element.scrollTop = state.scrollHeight;
  controller.onScroll(scrollEvent(element));
  expect(controller.isFollowing()).toBe(true);

  // The explicit jump re-arms too, and the gesture still wins over it.
  controller.onUserIntent();
  expect(controller.isFollowing()).toBe(false);
  controller.scrollToBottom({ behavior: "auto" });
  expect(controller.isFollowing()).toBe(true);

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

test("a streaming frame cannot re-arm follow the reader just broke", () => {
  // The reported bug: while the model streams, scrolling up did nothing —
  // the reader was locked to the bottom. The cause was a data-driven
  // follow that RE-ARMED the flag it was supposed to consult: the reader's
  // scroll cleared `followTail`, the next streaming frame's follow call set
  // it straight back and jumped to the end. The reference harness has one
  // ref for this, written by `onScroll` and read by the layout effect, and
  // no helper that writes it back to true.
  const { element, state } = createFakeScrollElement({ scrollTop: 400 });
  const followChanges: boolean[] = [];
  let endCalls = 0;
  const controller = new TailScrollController({
    getScrollElement: () => element,
    scrollToEnd: () => {
      endCalls += 1;
      state.scrollTop = state.scrollHeight;
    },
    onFollowChange: (following) => followChanges.push(following),
  });

  // The reader wheels up while the model streams. The gesture is the
  // reader's decision; a bare scroll event is not (it cannot be told apart
  // from our own follow-scroll).
  element.scrollTop = 200;
  controller.onUserIntent();
  expect(controller.isFollowing()).toBe(false);

  // The next frame's follow must be a no-op: no jump, no re-arm.
  controller.followTailNow();
  expect(endCalls).toBe(0);
  expect(controller.isFollowing()).toBe(false);
  expect(state.scrollTop).toBe(200);
  expect(followChanges).not.toContain(true);

  // And every later frame stays a no-op — one scroll-up is not undone by the
  // next delta.
  for (let frame = 0; frame < 5; frame++) {
    state.scrollHeight += 50; // the stream grew the content
    controller.followTailNow();
  }
  expect(endCalls).toBe(0);
  expect(controller.isFollowing()).toBe(false);
  expect(state.scrollTop).toBe(200);

  // The reader's own "go to bottom" still works, and re-arms follow.
  controller.scrollToBottom();
  expect(endCalls).toBe(1);
  expect(controller.isFollowing()).toBe(true);
  expect(state.scrollTop).toBe(state.scrollHeight);
  // And from there the frames follow again, as they should.
  controller.followTailNow();
  expect(endCalls).toBe(2);
});

test("the transcript feeds the controller's live flag to the tail machine", () => {
  // The other half of the same bug, at the wiring level. The controller's
  // flag is only authoritative if the layout effect READS it: this used to
  // feed the machine a `following` field of its own state, which the
  // reader's scroll never reached. The machine test proves a false input
  // yields no follow; this proves the transcript passes the live one.
  const source = readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "ui",
      "kit",
      "src",
      "transcript.tsx",
    ),
    "utf8",
  );
  // The machine's input is the controller's live flag.
  expect(source).toContain("following: controller?.isFollowing() ?? true,");
  // The data-driven branch is a follow, not the re-arming jump.
  expect(source).toContain("controller?.followTailNow()");
  // And no second copy of the flag is kept anywhere.
  expect(source).not.toMatch(
    /tailState\s*=\s*\{\s*\.\.\.tailState,\s*following/u,
  );
  expect(source).not.toMatch(/following:\s*tailState/u);
});

test("a follow-scroll's own scroll event cannot break follow when content grew", () => {
  // The other half of the bug, and the one a large burst of output hits: the
  // follow writes scrollTop at the bottom of the content as it was, the
  // scroll event is dispatched afterwards, and by then a streaming chunk has
  // grown scrollHeight again — so the event reports "not at the bottom" and
  // `setFollowing(isAtBottom)` cleared follow. Every later frame was then a
  // no-op and the transcript detached for good.
  const { element, state } = createFakeScrollElement({ scrollTop: 400 });
  let endCalls = 0;
  const controller = new TailScrollController({
    getScrollElement: () => element,
    scrollToEnd: () => {
      endCalls += 1;
      state.scrollTop = state.scrollHeight;
    },
  });
  expect(controller.isFollowing()).toBe(true);

  // A streaming frame follows, and lands at the bottom.
  controller.followTailNow();
  expect(endCalls).toBe(1);
  expect(state.scrollTop).toBe(state.scrollHeight);

  // The burst: more content lands BEFORE the scroll event is dispatched.
  state.scrollHeight += 500;
  controller.onScroll(scrollEvent(element));
  // Our own event must not have broken follow, even though the pane is no
  // longer at the bottom.
  expect(controller.isFollowing()).toBe(true);

  // And the next frame catches up — which is what "keeps scrolling" means.
  controller.followTailNow();
  expect(endCalls).toBe(2);
  expect(state.scrollTop).toBe(state.scrollHeight);
});

test("only a reader gesture clears follow; landing at the bottom re-arms it", () => {
  // `onScroll` cannot tell our own follow-scroll from the reader's, so it
  // does not try: it re-arms at the bottom and otherwise leaves the flag
  // alone. Clearing is the reader's decision and arrives as a gesture.
  //
  // The stub below clamps `scrollTop` the way a browser does
  // (`scrollHeight - clientHeight`), so `isAtBottom` sees real geometry: a
  // stub that wrote the full `scrollHeight` would make every position look
  // like the bottom and hide exactly the case this test is about.
  const { element, state } = createFakeScrollElement({ scrollTop: 400 });
  const scrollToEnd = () => {
    state.scrollTop = Math.max(0, state.scrollHeight - state.clientHeight);
  };
  const controller = new TailScrollController({
    getScrollElement: () => element,
    scrollToEnd,
  });

  // The reader wheels up.
  element.scrollTop = 120;
  controller.onUserIntent();
  expect(controller.isFollowing()).toBe(false);

  // Streaming frames do nothing while they are away.
  state.scrollHeight += 200;
  controller.followTailNow();
  expect(state.scrollTop).toBe(120);

  // A scroll event from the middle of the transcript does not re-arm.
  controller.onScroll(scrollEvent(element));
  expect(controller.isFollowing()).toBe(false);

  // The reader drags the scrollbar back to the bottom: the scroll event
  // re-arms, and the next frame follows again.
  scrollToEnd();
  controller.onScroll(scrollEvent(element));
  expect(controller.isFollowing()).toBe(true);
  state.scrollHeight += 50;
  controller.followTailNow();
  expect(state.scrollTop).toBe(state.scrollHeight - state.clientHeight);

  // A gesture that ENDS while a burst has already grown the content must not
  // clear follow either: `reconcile` re-arms, it never detaches. (The reader
  // tapped at the bottom, the stream kept going, and the pane is briefly not
  // at the bottom — that is not the reader leaving.)
  state.scrollHeight += 400;
  expect(state.scrollHeight - state.clientHeight - state.scrollTop).toBe(400);
  controller.reconcile();
  expect(controller.isFollowing()).toBe(true);
  controller.followTailNow();
  expect(state.scrollTop).toBe(state.scrollHeight - state.clientHeight);
});

test("a burst of output does not detach the pane from the bottom", () => {
  // The reported symptom: a large answer arriving in one piece stops the
  // auto-scroll and the pane detaches for good. The mechanism is attribution:
  // the follow writes scrollTop at the bottom of the content as it was, the
  // scroll event is dispatched afterwards, and by then the burst has grown
  // scrollHeight again — so the event reports "not at the bottom". Treating
  // that as the reader's scroll broke follow, and every later frame was then
  // a no-op.
  const { element, state } = createFakeScrollElement({ scrollTop: 400 });
  const scrollToEnd = () => {
    state.scrollTop = Math.max(0, state.scrollHeight - state.clientHeight);
  };
  let frames = 0;
  const controller = new TailScrollController({
    getScrollElement: () => element,
    scrollToEnd: () => {
      frames += 1;
      scrollToEnd();
    },
  });

  // One streaming frame follows and lands at the bottom.
  controller.followTailNow();
  expect(frames).toBe(1);
  const landed = state.scrollTop;

  // The burst lands BEFORE the scroll event is dispatched.
  state.scrollHeight += 2_000;
  controller.onScroll(scrollEvent(element));
  // Ours: the pane is still exactly where our write left it, so follow
  // survives even though the pane is no longer at the bottom.
  expect(controller.isFollowing()).toBe(true);

  // And the next frame catches up, repeatedly — which is what "keeps
  // scrolling" means for a long answer.
  for (let burst = 0; burst < 5; burst++) {
    state.scrollHeight += 500;
    controller.followTailNow();
    controller.onScroll(scrollEvent(element));
  }
  expect(controller.isFollowing()).toBe(true);
  expect(state.scrollTop).toBe(state.scrollHeight - state.clientHeight);
  expect(state.scrollTop).toBeGreaterThan(landed);

  // The reader's own wheel-up is still honoured: it moves the pane ABOVE
  // where our write left it, which is the part that is theirs.
  state.scrollTop -= 300;
  controller.onScroll(scrollEvent(element));
  expect(controller.isFollowing()).toBe(false);
  controller.followTailNow();
  expect(state.scrollTop).toBe(state.scrollHeight - state.clientHeight - 300);
});

test("a dead clone worker is never handed work again, and a hung one times out", () => {
  // The "it worked for a while and then nothing renders" report: a worker
  // that has errored does not error AGAIN for a later postMessage — the
  // message is silently dropped and the promise never settles. The caller
  // awaited forever, `setState` was never called, and the UI froze on the
  // last projected frame while the model kept streaming.
  const source = readFileSync(
    join(import.meta.dir, "..", "src", "clone-state-worker-client.ts"),
    "utf8",
  );
  // A worker that errored is retired, not reused.
  expect(source).toContain("dead.add(instance)");
  expect(source).toContain("instance.terminate()");
  expect(source).toContain("if (!dead.has(candidate)) return candidate;");
  // And a request that never answers fails on its own, so the caller reaches
  // the synchronous fallback it already has.
  expect(source).toContain("CLONE_TIMEOUT_MS");
  expect(source).toMatch(/clone-state worker did not answer within/u);
});

test("a clone request that never answers fails on its own", async () => {
  // The timeout is what lets the caller reach the synchronous fallback it
  // already has. A worker that has errored once does not error again for a
  // later postMessage — the message is dropped and the promise never
  // settles — so without a ceiling the renderer awaits forever and the UI
  // freezes on the last projected frame.
  const { setCloneStateWorkerFactory, cloneStateInWorker } = await import(
    "../src/clone-state-worker-client"
  );
  const silent = {
    addEventListener: () => {},
    postMessage: () => {},
    terminate: () => {},
    unref: () => {},
  } as unknown as Worker;
  setCloneStateWorkerFactory(() => silent);
  try {
    // The real ceiling is 5s; this only proves the promise SETTLES (rejects)
    // rather than hanging, which is the property that matters.
    const started = Date.now();
    await expect(
      cloneStateInWorker({} as never).then(
        () => "resolved",
        () => "rejected",
      ),
    ).resolves.toBe("rejected");
    expect(Date.now() - started).toBeLessThan(20_000);
  } finally {
    setCloneStateWorkerFactory(() => silent);
  }
});

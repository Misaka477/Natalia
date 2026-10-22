/**
 * The page-scan policy: the perception the browser_* tools read a page
 * through.
 *
 * The shared script is a plain file that assigns one object to globalThis,
 * so importing it runs it exactly the way an extension injects it into a
 * page. What is tested here is the PURE half — the policy over a collected
 * model — driven with hand-built trees, because that is where every
 * decision about what the model gets to see is made.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

await import("../src/extension/shared/page-scan.js");

type PageNode = {
  tag: string;
  id: string;
  cls: string[];
  role: string;
  attrs: Record<string, string>;
  text: string;
  rect: { x: number; y: number; w: number; h: number };
  z: number;
  visible: boolean;
  children: PageNode[];
};

type PageScanApi = {
  simplifyPageModel(
    model: { root: PageNode | null },
    options?: { textOnly?: boolean; maxlen?: number; offset?: number },
  ): {
    text: string;
    html: string;
    totalTextLength: number;
    totalHtmlLength: number;
    truncated: boolean;
    textOnly: boolean;
    hiddenRemoved: number;
    listHints: string[];
  };
  clickAt(
    document: unknown,
    x: number,
    y: number,
  ): { ok: boolean; clicked?: { tag: string; id: string; text: string } };
  typeIntoActive(
    document: unknown,
    text: string,
  ): {
    ok: boolean;
    via: string;
    tag: string;
    length: number;
  };
};

const pageScan = (globalThis as unknown as { NataliaPageScan: PageScanApi })
  .NataliaPageScan;

function node(over: Partial<PageNode> = {}): PageNode {
  return {
    tag: "div",
    id: "",
    cls: [],
    role: "",
    attrs: {},
    text: "",
    rect: { x: 0, y: 0, w: 300, h: 50 },
    z: 0,
    visible: true,
    children: [],
    ...over,
  };
}

/** A page the way the walker hands it over: one root, stacked children. */
function page(children: PageNode[]): { root: PageNode } {
  return {
    root: node({
      tag: "body",
      rect: { x: 0, y: 0, w: 1000, h: 2000 },
      children,
    }),
  };
}

test("invisible and fully covered siblings are dropped, interactive ones are not", () => {
  const model = page([
    node({ text: "visible text", rect: { x: 0, y: 0, w: 300, h: 50 } }),
    node({
      text: "hidden text",
      visible: false,
      rect: { x: 0, y: 50, w: 300, h: 50 },
    }),
    // The dialog below covers this one entirely, later sibling, no
    // interactive content of its own.
    node({ text: "behind the dialog", rect: { x: 0, y: 100, w: 300, h: 100 } }),
    node({
      tag: "div",
      cls: ["dialog"],
      text: "Dialog",
      rect: { x: 0, y: 100, w: 300, h: 100 },
    }),
    // An interactive element under an overlay still works, so it stays.
    node({
      tag: "button",
      attrs: { type: "submit" },
      text: "Save",
      rect: { x: 0, y: 100, w: 80, h: 30 },
    }),
  ]);
  const result = pageScan.simplifyPageModel(model, { textOnly: true });
  expect(result.text).toContain("visible text");
  expect(result.text).toContain("Dialog");
  expect(result.text).not.toContain("hidden text");
  expect(result.text).not.toContain("behind the dialog");
  expect(result.hiddenRemoved).toBe(1);
});

test("interactive elements render as markers carrying their attributes", () => {
  const model = page([
    node({
      tag: "input",
      attrs: { name: "q", type: "text", placeholder: "search" },
      rect: { x: 0, y: 0, w: 200, h: 30 },
    }),
    node({
      tag: "a",
      id: "home",
      attrs: { href: "https://example.com/very/long/path/that/costs/tokens" },
      text: "Home",
      rect: { x: 0, y: 40, w: 200, h: 30 },
    }),
  ]);
  const result = pageScan.simplifyPageModel(model, { textOnly: true });
  expect(result.text).toContain('[input name=q type=text "search"]');
  expect(result.text).toContain('[a #home href=__link__ "Home"]');
});

test("a long repeated list collapses to samples plus a selector hint", () => {
  const rows = Array.from({ length: 9 }, (_, index) =>
    node({
      tag: "li",
      cls: ["row"],
      text: `row ${index} ${"x".repeat(200)}`,
      rect: { x: 0, y: index * 60, w: 900, h: 50 },
    }),
  );
  const result = pageScan.simplifyPageModel(page(rows), { textOnly: true });
  expect(result.listHints).toHaveLength(1);
  expect(result.listHints[0]).toContain('selector: "li.row"');
  expect(result.listHints[0]).toContain("6 more items hidden");
  // Three rows survive before the hint; the hint itself names samples of
  // what was hidden, so the count is taken from the part before it.
  const [before] = result.text.split("[FAKE ELEMENT]");
  expect(before?.match(/row \d+ /g)?.length).toBe(3);
  expect(result.text).toContain("[FAKE ELEMENT]");
  expect(result.text).toContain('hidden items: "row 3');
});

test("the render stays inside the budget and reports the whole page's size", () => {
  const long = node({
    text: "y".repeat(5000),
    rect: { x: 0, y: 0, w: 900, h: 2000 },
  });
  const result = pageScan.simplifyPageModel(page([long]), {
    textOnly: true,
    maxlen: 100,
  });
  expect(result.text.length).toBeLessThanOrEqual(100);
  expect(result.totalTextLength).toBeGreaterThan(100);
  expect(result.truncated).toBe(true);
  // The second page continues where the first stopped.
  const next = pageScan.simplifyPageModel(page([long]), {
    textOnly: true,
    maxlen: 100,
    offset: 100,
  });
  expect(next.text.startsWith("y")).toBe(true);
  expect(next.offset).toBe(100);
});

test("the same model earns the same answer twice", () => {
  const model = page([
    node({ text: "one", rect: { x: 0, y: 0, w: 300, h: 50 } }),
    node({ tag: "button", text: "two", rect: { x: 0, y: 60, w: 300, h: 50 } }),
  ]);
  const first = pageScan.simplifyPageModel(model, { textOnly: true });
  const second = pageScan.simplifyPageModel(model, { textOnly: true });
  expect(second).toEqual(first);
});

test("html mode writes whitelisted attributes and self-closes void elements", () => {
  const model = page([
    node({ text: "body text", rect: { x: 0, y: 0, w: 300, h: 50 } }),
    node({
      tag: "input",
      attrs: { name: "q", type: "text", value: "typed" },
      rect: { x: 0, y: 60, w: 300, h: 30 },
    }),
  ]);
  const result = pageScan.simplifyPageModel(model, { textOnly: false });
  expect(result.text).toBe("");
  expect(result.html).toContain("body text");
  expect(result.html).toContain('<input name="q" type="text" value="typed">');
  expect(result.html).not.toContain("</input>");
});

test("a page with no root degrades to an empty answer, not a throw", () => {
  const result = pageScan.simplifyPageModel({ root: null }, { textOnly: true });
  expect(result.text).toBe("");
  expect(result.html).toBe("");
  expect(result.truncated).toBe(false);
  expect(result.listHints).toEqual([]);
});

test("a click walks the pointer sequence and reports what it hit", () => {
  // The page environment the module expects: the test supplies it.
  class FakeEvent {
    type: string;
    constructor(type: string, init: Record<string, unknown> = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  }
  (globalThis as unknown as Record<string, unknown>).PointerEvent = FakeEvent;
  (globalThis as unknown as Record<string, unknown>).MouseEvent = FakeEvent;

  const events: string[] = [];
  const element = {
    tagName: "BUTTON",
    id: "save",
    textContent: " Save ",
    dispatchEvent: (event: FakeEvent) => events.push(event.type),
    click: () => events.push("click"),
    focus: () => events.push("focus"),
  };
  const document = {
    defaultView: {},
    elementFromPoint: (x: number, y: number) =>
      x === 12 && y === 34 ? element : null,
  };
  const result = pageScan.clickAt(document, 12, 34);
  expect(result.ok).toBe(true);
  expect(result.clicked).toEqual({ tag: "button", id: "save", text: "Save" });
  // The sequence a real pointer produces, in order: arrive, press, focus,
  // release, activate. A bare click() alone leaves hover-opened components
  // closed.
  expect(events).toEqual([
    "pointerover",
    "mouseover",
    "mousemove",
    "pointerdown",
    "mousedown",
    "focus",
    "pointerup",
    "mouseup",
    "click",
  ]);
});

test("a click at empty coordinates reports the miss instead of throwing", () => {
  const document = { defaultView: {}, elementFromPoint: () => null };
  expect(pageScan.clickAt(document, 5, 5)).toMatchObject({
    ok: false,
    reason: "no_element",
  });
});

test("typing writes through the prototype's setter and fires the event pair", () => {
  // A framework-controlled input tracks its value through the input event,
  // and a direct `el.value =` assignment never fires one — so the write
  // goes through the prototype's own setter, which the framework's
  // listener is wired to.
  const prototype: Record<string, unknown> = {};
  let written: string | undefined;
  Object.defineProperty(prototype, "value", {
    set(value: string) {
      written = value;
    },
    get: () => "",
  });
  const element = Object.create(prototype) as Record<string, unknown>;
  element.tagName = "INPUT";
  const events: string[] = [];
  element.dispatchEvent = (event: { type: string }) => events.push(event.type);
  const document = { activeElement: element, body: {} };
  const result = pageScan.typeIntoActive(document, "hello world");
  expect(result).toMatchObject({ ok: true, via: "native-setter", length: 11 });
  expect(written).toBe("hello world");
  expect(events).toEqual(["input", "change"]);
});

test("typing with no active element says so", () => {
  const document = { activeElement: null, body: {} };
  expect(pageScan.typeIntoActive(document, "text")).toMatchObject({
    ok: false,
    reason: "no_active_element",
  });
});

test("the shared script ships where both engines inject it from", () => {
  // Chromium injects it as a file beside the engine directories, Firefox
  // fetches it from the same place; a release that stages one without the
  // other ships an extension whose scan fails on a missing global.
  const shared = join(import.meta.dir, "..", "src", "extension", "shared");
  expect(existsSync(join(shared, "page-scan.js"))).toBe(true);
});

/**
 * Page scan: the perception layer the browser_* tools read a page through.
 *
 * This file is a plain script (no imports, no exports): it assigns one
 * object to globalThis so BOTH extension backgrounds can inject the same
 * code into a page — Chromium through `scripting.executeScript({files})`
 * plus a `func` that calls the global, Firefox through one concatenated
 * `tabs.executeScript({code})` call — and so the repository's test suite
 * can import it directly and drive the PURE parts with hand-built models.
 *
 * The split is deliberate and is the whole design:
 *
 *   collectPageModel(document, window)  — the DOM walker. The only part
 *                                        that touches a live document.
 *   simplifyPageModel(model, options)   — the policy. Pure: a model in, a
 *                                        simplified model out. No DOM, no
 *                                        window, no globals. Everything the
 *                                        model sees about a page is decided
 *                                        here, so everything worth testing
 *                                        is testable.
 *
 * The policy is what makes the scan usable instead of a raw innerText dump:
 * invisible nodes are dropped, fully covered siblings are dropped, repeated
 * list siblings collapse to a few samples plus a hint, interactive elements
 * survive with their attributes, and the render is bounded by a budget.
 */
globalThis.NataliaPageScan = (function () {
  "use strict";

  /** Tags that never carry perceivable content for a reader. */
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "LINK",
    "META",
    "BASE",
    "COLGROUP",
    "COL",
    "PARAM",
    "SOURCE",
    "TRACK",
    "SVG",
    "PATH",
    "HEAD",
    "TITLE",
  ]);

  /** Attributes worth spending tokens on, per element. */
  const KEEP_ATTRS = [
    "id",
    "class",
    "name",
    "type",
    "placeholder",
    "href",
    "alt",
    "role",
    "aria-label",
    "aria-expanded",
    "aria-hidden",
    "aria-live",
    "disabled",
    "checked",
    "selected",
    "readonly",
    "required",
    "multiple",
    "for",
    "action",
    "method",
    "target",
    "colspan",
    "rowspan",
    "contenteditable",
    "title",
  ];

  /** Elements a reader can act on; they survive simplification. */
  const INTERACTIVE_TAGS = new Set([
    "A",
    "BUTTON",
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "SUMMARY",
    "LABEL",
    "DETAILS",
  ]);

  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "menuitem",
    "checkbox",
    "radio",
    "tab",
    "textbox",
    "combobox",
    "option",
    "switch",
    "searchbox",
    "slider",
    "spinbutton",
  ]);

  /** How many repeated siblings a list may keep before collapsing. */
  const LIST_KEEP = 3;
  /** A repeated group smaller than this is not a list. */
  const LIST_MIN_ITEMS = 5;
  /** A list item whose rendered form is shorter than this is not worth collapsing. */
  const LIST_MIN_ITEM_CHARS = 160;
  /** A sibling covers another when this much of its area is overlapped. */
  const COVER_RATIO = 0.9;

  function isInteractive(node) {
    if (!node || typeof node !== "object") return false;
    // Upper-case, because the walker normalizes there; the compare is
    // case-insensitive so a hand-built model is read the same way.
    if (INTERACTIVE_TAGS.has(String(node.tag ?? "").toUpperCase())) return true;
    const role = node.role || "";
    return INTERACTIVE_ROLES.has(String(role).toLowerCase());
  }

  function hasInteractiveDescendant(node) {
    if (!node || !Array.isArray(node.children)) return false;
    for (const child of node.children) {
      if (isInteractive(child)) return true;
      if (hasInteractiveDescendant(child)) return true;
    }
    return false;
  }

  function nodeText(node) {
    if (!node || typeof node !== "object") return "";
    return typeof node.text === "string" ? node.text : "";
  }

  /** The text a node contributes to the rendered text stream. */
  function ownText(node) {
    if (!node || typeof node !== "object") return "";
    let text = nodeText(node);
    for (const child of node.children ?? [])
      text += ` ${ownText(child)}`.replace(/^\s+/, " ");
    return text.replace(/\s+/g, " ").trim();
  }

  function areaOf(rect) {
    if (!rect) return 0;
    return Math.max(0, rect.w) * Math.max(0, rect.h);
  }

  /** How much of `inner` is overlapped by `outer`, as a 0..1 area ratio. */
  function coverRatio(outer, inner) {
    if (!outer || !inner) return 0;
    const x1 = Math.max(outer.x, inner.x);
    const y1 = Math.max(outer.y, inner.y);
    const x2 = Math.min(outer.x + outer.w, inner.x + inner.w);
    const y2 = Math.min(outer.y + outer.h, inner.y + inner.h);
    if (x2 <= x1 || y2 <= y1) return 0;
    const innerArea = areaOf(inner);
    if (innerArea <= 0) return 0;
    return (x2 - x1) * (y2 - y1) / innerArea;
  }

  /**
   * Drop fully covered siblings: a later (or higher-stacked) sibling that
   * hides an earlier one entirely removes it, unless the covered node holds
   * something the reader can act on — an interactive element under a
   * dialog is usually the dialog's own control that still works.
   */
  function dropCovered(node) {
    if (!node || !Array.isArray(node.children)) return;
    const children = node.children;
    for (let i = 0; i < children.length; i += 1) {
      const covered = children[i];
      if (!covered || covered.visible === false) continue;
      if (hasInteractiveDescendant(covered)) continue;
      const coveredArea = areaOf(covered.rect);
      if (coveredArea <= 0) continue;
      for (let j = 0; j < children.length; j += 1) {
        if (j === i) continue;
        const other = children[j];
        if (!other || other.visible === false) continue;
        const otherArea = areaOf(other.rect);
        if (otherArea < coveredArea) continue;
        const laterOrHigher =
          j > i || (other.z ?? 0) > (covered.z ?? 0) || other.fixed === true;
        if (!laterOrHigher) continue;
        if (coverRatio(other.rect, covered.rect) >= COVER_RATIO) {
          covered.visible = false;
          break;
        }
      }
    }
    for (const child of children) dropCovered(child);
  }

  /** Drop invisible nodes and containers that carry nothing at all. */
  function dropEmpty(node) {
    if (!node || !Array.isArray(node.children)) return;
    node.children = node.children.filter((child) => child && child.visible !== false);
    for (const child of node.children) dropEmpty(child);
    node.children = node.children.filter(
      (child) =>
        isInteractive(child) ||
        hasInteractiveDescendant(child) ||
        ownText(child).length > 0,
    );
  }

  /** A repeated-sibling group's signature: same tag and same class list. */
  function listSignature(node) {
    const cls = Array.isArray(node.cls) ? node.cls.join(" ") : "";
    return `${node.tag}|${cls}`;
  }

  /**
   * Collapse long repeated lists: the first few items stay, the rest become
   * one hint line naming the selector and sampling what was hidden. A page
   * with 200 search results renders three of them plus the fact that 197
   * more exist behind a selector the model can query precisely.
   */
  function collapseLists(node, hints) {
    if (!node || !Array.isArray(node.children)) return;
    const children = node.children;
    const groups = new Map();
    for (const child of children) {
      if (!child || child.visible === false) continue;
      const signature = listSignature(child);
      const group = groups.get(signature);
      if (group) group.push(child);
      else groups.set(signature, [child]);
    }
    for (const group of groups.values()) {
      if (group.length < LIST_MIN_ITEMS) continue;
      const sample = renderHtml(group[0]);
      if (sample.length < LIST_MIN_ITEM_CHARS) continue;
      const kept = group.slice(0, LIST_KEEP);
      const hidden = group.slice(LIST_KEEP);
      const selector =
        group[0].tag.toLowerCase() +
        (Array.isArray(group[0].cls) && group[0].cls.length
          ? `.${group[0].cls.join(".")}`
          : "");
      const samples = hidden
        .slice(0, 5)
        .map((item) => ownText(item).slice(0, 40))
        .filter((text) => text.length > 0);
      const hint = {
        tag: "div",
        cls: [],
        text:
          `[FAKE ELEMENT] ${hidden.length} more items hidden, selector: "${selector}"` +
          (samples.length ? `; hidden items: ${samples.map((t) => `"${t}"`).join(", ")}` : ""),
        rect: { x: 0, y: 0, w: 0, h: 0 },
        z: 0,
        visible: true,
        children: [],
        fake: true,
      };
      hints.push(hint.text);
      const keptSet = new Set(kept);
      node.children = node.children.filter(
        (child) => !group.includes(child) || keptSet.has(child),
      );
      const lastKept = kept[kept.length - 1];
      const at = node.children.indexOf(lastKept);
      node.children.splice(at + 1, 0, hint);
    }
    for (const child of node.children) collapseLists(child, hints);
  }

  /** Escape text for the html render. */
  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll('"', "&quot;");
  }

  /**
   * Long attribute values cost tokens and say nothing: a URL past thirty
   * characters is a path nobody reads, so it collapses to a marker, and any
   * other value past a hundred and twenty is cut. The policy owns this —
   * the walker collects what the element holds, the policy decides what
   * the reader sees.
   */
  function shortAttrValue(name, value) {
    const text = String(value);
    if (name === "href" || name === "src" || name === "action")
      return text.length > 30 ? "__link__" : text;
    return text.length > 120 ? `${text.slice(0, 100)}...` : text;
  }

  /** Elements with no closing tag; the html render writes them self-closed. */
  const VOID_TAGS = new Set([
    "AREA",
    "BASE",
    "BR",
    "COL",
    "EMBED",
    "HR",
    "IMG",
    "INPUT",
    "LINK",
    "META",
    "PARAM",
    "SOURCE",
    "TRACK",
    "WBR",
  ]);

  /** One node's html, with the model's whitelisted attributes only. */
  function renderHtml(node) {
    if (!node || typeof node !== "object") return "";
    const tag = String(node.tag || "div").toLowerCase();
    const attrs = [];
    if (node.id) attrs.push(`id="${escapeAttr(node.id)}"`);
    if (Array.isArray(node.cls) && node.cls.length)
      attrs.push(`class="${escapeAttr(node.cls.join(" "))}"`);
    for (const [key, value] of Object.entries(node.attrs ?? {})) {
      if (key === "id" || key === "class") continue;
      attrs.push(`${key}="${escapeAttr(shortAttrValue(key, value))}"`);
    }
    const open = attrs.length ? `${tag} ${attrs.join(" ")}` : tag;
    if (VOID_TAGS.has(String(node.tag ?? "").toUpperCase())) return `<${open}>`;
    const inner = renderChildrenHtml(node);
    return `<${open}>${inner}</${tag}>`;
  }

  function renderChildrenHtml(node) {
    let out = nodeText(node) ? escapeHtml(nodeText(node)) : "";
    for (const child of node.children ?? []) {
      if (child.fake) {
        out += `${out ? " " : ""}<div>${escapeHtml(child.text)}</div>`;
        continue;
      }
      const rendered = renderHtml(child);
      out += rendered;
    }
    return out;
  }

  /** One node's text, with a marker for every interactive element. */
  function renderText(node, out) {
    if (!node || typeof node !== "object") return out;
    if (node.fake) {
      out.push(nodeText(node));
      return out;
    }
    const text = nodeText(node);
    if (text) out.push(text);
    for (const child of node.children ?? []) {
      if (isInteractive(child)) {
        out.push(interactiveMarker(child));
        continue;
      }
      renderText(child, out);
    }
    return out;
  }

  /** The `[tag attr "text"]` marker an interactive element renders as. */
  function interactiveMarker(node) {
    const tag = String(node.tag || "").toLowerCase();
    const attrs = node.attrs ?? {};
    const parts = [tag];
    if (node.id) parts.push(`#${node.id}`);
    if (attrs.name) parts.push(`name=${attrs.name}`);
    if (attrs.type) parts.push(`type=${attrs.type}`);
    if (attrs.role) parts.push(`role=${attrs.role}`);
    if (attrs.href)
      parts.push(`href=${shortAttrValue("href", attrs.href)}`);
    if (attrs.disabled !== undefined) parts.push("disabled");
    if (attrs.checked !== undefined) parts.push("checked");
    if (attrs["aria-expanded"] !== undefined)
      parts.push(`expanded=${attrs["aria-expanded"]}`);
    if (attrs.placeholder)
      parts.push(`"${shortAttrValue("placeholder", attrs.placeholder)}"`);
    const text = ownText(node);
    if (text) parts.push(`"${text.slice(0, 80)}"`);
    return `[${parts.join(" ")}]`;
  }

  /**
   * The policy: a collected model in, the simplified render out.
   *
   * Pure over the model — the same model always earns the same answer — so
   * the tests drive it with hand-built trees and no DOM exists anywhere in
   * this function.
   */
  function simplifyPageModel(model, options = {}) {
    const textOnly = options.textOnly !== false;
    const maxlen = Math.max(1, Number(options.maxlen) || 35000);
    const offset = Math.max(0, Number(options.offset) || 0);
    // Cloned first: the policy marks nodes as it goes, and a model handed
    // in twice must earn the same answer twice.
    const root = model && model.root ? cloneModel(model.root) : null;
    const hints = [];
    let hiddenRemoved = 0;
    if (!root) {
      return {
        text: "",
        html: "",
        totalTextLength: 0,
        totalHtmlLength: 0,
        offset,
        maxlen,
        truncated: false,
        textOnly,
        hiddenRemoved: 0,
        listHints: [],
      };
    }
    // Count what the walker already dropped, then run the policy's own passes.
    hiddenRemoved = countHidden(root);
    dropCovered(root);
    dropEmpty(root);
    collapseLists(root, hints);
    const text = renderText(root, []).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    const html = renderHtml(root);
    const totalTextLength = text.length;
    const totalHtmlLength = html.length;
    const slice = (value) => {
      const end = Math.min(value.length, offset + maxlen);
      return value.slice(offset, end);
    };
    return {
      text: textOnly ? slice(text) : "",
      html: textOnly ? "" : slice(html),
      totalTextLength,
      totalHtmlLength,
      offset,
      maxlen,
      truncated: offset + maxlen < totalTextLength || offset + maxlen < totalHtmlLength,
      textOnly,
      hiddenRemoved,
      listHints: hints,
    };
  }

  function countHidden(node) {
    if (!node || typeof node !== "object") return 0;
    let count = node.visible === false ? 1 : 0;
    for (const child of node.children ?? []) count += countHidden(child);
    return count;
  }

  /** A model is plain data, so a JSON round-trip is a faithful copy. */
  function cloneModel(node) {
    return JSON.parse(JSON.stringify(node));
  }

  /* ------------------------------------------------------------------ *
   * The DOM walker: a live document in, a model out. Thin on purpose —
   * every decision belongs to simplifyPageModel, which is pure.
   * ------------------------------------------------------------------ */

  function collectPageModel(document, window) {
    const root =
      document?.body ??
      (document?.documentElement ? document.documentElement : null);
    if (!root) return { root: null, url: "", title: "" };
    return {
      root: walk(root, document, window, 0),
      url: String(window?.location?.href ?? ""),
      title: String(document?.title ?? ""),
    };
  }

  const MAX_DEPTH = 60;

  function walk(element, document, window, depth) {
    if (depth > MAX_DEPTH || !element || element.nodeType !== 1) return null;
    const tag = String(element.tagName || "").toUpperCase();
    if (SKIP_TAGS.has(tag)) return null;
    const style = safeStyle(element, window);
    const rect = safeRect(element);
    const visible = isVisible(style, rect);
    if (element.getAttribute?.("aria-hidden") === "true" && !visible) return null;
    const children = [];
    collectChildren(element, document, window, depth, children);
    if (tag === "IFRAME") {
      try {
        const inner = element.contentDocument?.body;
        if (inner) collectChildren(inner, document, window, depth, children);
      } catch {
        // A cross-origin iframe's document is not readable; its position
        // still matters, so the node itself is kept.
      }
    }
    const cls = String(element.getAttribute?.("class") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    const node = {
      tag,
      id: String(element.getAttribute?.("id") ?? ""),
      cls,
      role: String(element.getAttribute?.("role") ?? ""),
      attrs: collectAttrs(element, tag),
      text: directText(element),
      rect,
      z: style && style.position !== "static" ? zIndexOf(style) : 0,
      fixed: style?.position === "fixed",
      visible,
      children,
    };
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (element.value) node.attrs.value = String(element.value).slice(0, 120);
      if (element.checked) node.attrs.checked = "";
      if (element.disabled) node.attrs.disabled = "";
      if (element.readOnly) node.attrs.readonly = "";
      if (element.required) node.attrs.required = "";
      try {
        if (element.matches(":-webkit-autofill")) {
          node.attrs["data-autofilled"] = "true";
          if (!element.value) node.attrs.value = "protected";
        }
      } catch {
        // matches() rejects unknown pseudo-classes on some engines.
      }
    }
    if (tag === "SELECT" && element.value)
      node.attrs["data-selected"] = String(element.value).slice(0, 120);
    return node;
  }

  function collectChildren(element, document, window, depth, out) {
    for (const child of element.children ?? []) {
      const node = walk(child, document, window, depth + 1);
      if (node) out.push(node);
    }
    let shadow = null;
    try {
      shadow = element.shadowRoot;
    } catch {
      shadow = null;
    }
    if (shadow) collectChildren(shadow, document, window, depth + 1, out);
  }

  function safeStyle(element, window) {
    try {
      return window?.getComputedStyle?.(element) ?? null;
    } catch {
      return null;
    }
  }

  function safeRect(element) {
    try {
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x ?? rect.left ?? 0),
        y: Math.round(rect.y ?? rect.top ?? 0),
        w: Math.round(rect.width ?? 0),
        h: Math.round(rect.height ?? 0),
      };
    } catch {
      return { x: 0, y: 0, w: 0, h: 0 };
    }
  }

  function isVisible(style, rect) {
    if (!style) return rect.w > 1 && rect.h > 1;
    if (style.display === "none" || style.visibility === "hidden") return false;
    const opacity = Number.parseFloat(style.opacity);
    if (Number.isFinite(opacity) && opacity <= 0) return false;
    return rect.w > 1 && rect.h > 1;
  }

  function zIndexOf(style) {
    const value = Number.parseInt(style.zIndex, 10);
    return Number.isFinite(value) ? value : 0;
  }

  function collectAttrs(element, tag) {
    const attrs = {};
    for (const name of KEEP_ATTRS) {
      if (name === "id" || name === "class") continue;
      const value = element.getAttribute?.(name);
      if (value === null || value === undefined || value === "") continue;
      // Collected raw: the policy decides what a reader sees of it.
      attrs[name] = value;
    }
    if (tag === "INPUT" && element.getAttribute?.("type") === "hidden") return {};
    return attrs;
  }

  function directText(element) {
    let text = "";
    for (const node of element.childNodes ?? []) {
      if (node.nodeType === 3) text += node.textContent ?? "";
    }
    return text.replace(/\s+/g, " ").trim().slice(0, 400);
  }

  /* ------------------------------------------------------------------ *
   * Actions: the same discipline the scan follows, applied to input.
   * ------------------------------------------------------------------ */

  /**
   * Click at viewport coordinates with the full event sequence.
   *
   * A bare `el.click()` synthesizes one click event and nothing else, so a
   * component that opens on hover (a menu, a tooltip-triggered control)
   * never sees the pointer arrive. The sequence below is move, press,
   * release, click, with focus in the middle.
   */
  function clickAt(document, x, y) {
    const element = document.elementFromPoint(x, y);
    if (!element) return { ok: false, reason: "no_element", x, y };
    const options = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: document.defaultView ?? null,
      clientX: x,
      clientY: y,
      button: 0,
    };
    // The pointer events first: a component that opens on hover never sees
    // the pointer arrive if only a click is synthesized. Focus lands on the
    // press, the way a real pointer does.
    const sequence = [
      "pointerover",
      "mouseover",
      "mousemove",
      "pointerdown",
      "mousedown",
    ];
    for (const name of sequence) {
      try {
        const Ctor = name.startsWith("pointer") ? PointerEvent : MouseEvent;
        element.dispatchEvent(new Ctor(name, options));
      } catch {
        // An engine without the constructor (or a target without
        // dispatchEvent) still gets the events it can take.
      }
    }
    try {
      element.focus?.();
    } catch {
      // A non-focusable target keeps its own focus.
    }
    for (const name of ["pointerup", "mouseup"]) {
      try {
        const Ctor = name.startsWith("pointer") ? PointerEvent : MouseEvent;
        element.dispatchEvent(new Ctor(name, options));
      } catch {
        // See above.
      }
    }
    // One activation, never two: click() when the target has it, the event
    // when it does not.
    let activated = false;
    try {
      if (typeof element.click === "function") {
        element.click();
        activated = true;
      }
    } catch {
      activated = false;
    }
    if (!activated) {
      try {
        element.dispatchEvent(new MouseEvent("click", options));
      } catch {
        // Nothing left to try; the press and release were delivered.
      }
    }
    return {
      ok: true,
      x,
      y,
      clicked: {
        tag: String(element.tagName || "").toLowerCase(),
        id: String(element.id || ""),
        text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
      },
    };
  }

  /**
   * Type into the active element through its own value setter.
   *
   * Assigning `el.value` directly sets the property and tells the page
   * nothing, so a framework that tracks the value through the input event
   * (every controlled component does) never learns the text arrived. The
   * prototype's setter is the write the framework's own listener is wired
   * to.
   */
  function typeIntoActive(document, text) {
    const element = document.activeElement;
    if (!element || element === document.body)
      return { ok: false, reason: "no_active_element" };
    const value = String(text ?? "");
    let used = "direct";
    try {
      const proto = Object.getPrototypeOf(element);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(element, value);
        used = "native-setter";
      } else {
        element.value = value;
      }
    } catch {
      element.value = value;
    }
    const dispatch = (name) => {
      try {
        element.dispatchEvent(new Event(name, { bubbles: true, cancelable: true }));
      } catch {
        // A target without dispatchEvent still holds the value.
      }
    };
    dispatch("input");
    dispatch("change");
    return {
      ok: true,
      via: used,
      tag: String(element.tagName || "").toLowerCase(),
      length: value.length,
    };
  }

  /**
   * The scan the extensions call: walk, simplify, shape the answer.
   *
   * The document and window come from the page the function is injected
   * into; the extensions pass this through `func`/`code` so the same file
   * serves both engines.
   */
  function scan(document, window, options = {}) {
    const model = collectPageModel(document, window);
    const simplified = simplifyPageModel(model, options);
    return {
      url: model.url,
      title: model.title,
      ...simplified,
    };
  }

  return {
    collectPageModel,
    simplifyPageModel,
    clickAt,
    typeIntoActive,
    scan,
  };
})();


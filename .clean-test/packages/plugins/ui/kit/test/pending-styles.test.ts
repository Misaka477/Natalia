import { expect, test } from "bun:test";
import {
  ensurePendingBadgeStyles,
  PENDING_BADGE_STYLES,
} from "../src/pending-styles";

/**
 * The badge-style regression's pin. The rail renders the tab badges from
 * the kit; the rule used to live in a lazily-loaded plugin's sheet and
 * the count arrived as unstyled text ("治理2"). The rule now ships with
 * the component, and this pins the injection: once per document, and
 * nothing without a document.
 */

/** A document stub recording the injections (the module's doc seam). */
function fakeDocument(existing: boolean) {
  const appended: Array<{
    attrs: Record<string, string>;
    textContent: string;
  }> = [];
  return {
    appended,
    doc: {
      querySelector: (selectors: string) =>
        selectors.includes("data-natalia-pending-badge") && existing
          ? ({} as unknown)
          : null,
      createElement: () => {
        const node = {
          attrs: {} as Record<string, string>,
          textContent: "",
          setAttribute(name: string, value: string) {
            this.attrs[name] = value;
          },
        };
        return node;
      },
      head: {
        append: (node: (typeof appended)[number]) => appended.push(node),
      },
    },
  };
}

test("the badge's styles land once per document", () => {
  const fresh = fakeDocument(false);
  ensurePendingBadgeStyles(fresh.doc as never);
  expect(fresh.appended).toHaveLength(1);
  expect(fresh.appended[0]!.attrs["data-natalia-pending-badge"]).toBe("true");
  expect(fresh.appended[0]!.textContent).toContain(".natalia-pending-badge");
  // A document that already carries the sheet gets no second copy.
  const existing = fakeDocument(true);
  ensurePendingBadgeStyles(existing.doc as never);
  expect(existing.appended).toHaveLength(0);
});

test("a non-browser import injects nothing and throws nothing", () => {
  // The kit is imported everywhere; a missing document is a no-op.
  expect(() => ensurePendingBadgeStyles(undefined)).not.toThrow();
});

test("the rule paints a bubble, not bare text", () => {
  // The regression's exact shape: the count beside the label used to be
  // unstyled text.
  expect(PENDING_BADGE_STYLES).toContain("background:var(--neu-accent)");
  expect(PENDING_BADGE_STYLES).toContain("border-radius:8px");
  expect(PENDING_BADGE_STYLES).toContain("min-width:16px");
});

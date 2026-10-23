import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const srcRoot = join(import.meta.dir, "..", "src");

function readSrc(...parts: string[]): string {
  return readFileSync(join(srcRoot, ...parts), "utf8");
}

test("the sidebar renders our brand image in both wide and collapsed rail states", () => {
  const sidebar = readSrc("controllers", "sidebar.tsx");
  expect(sidebar).toContain('src="/brand.png"');
  expect(sidebar).not.toContain("<span class={styles.brandMark}>N</span>");
  // Collapsed rail swaps the brand mark with the panel toggle icon on hover.
  expect(sidebar).toContain("styles.railMark");
  expect(sidebar).toContain("styles.panelIcon");
  expect(sidebar).toContain("styles.collapsed");
});

test("the workspace browser header exposes inline search, view options, and add workspace", () => {
  const tree = readSrc("controllers", "session-tree.tsx");
  expect(tree).toContain("styles.sectionHeader");
  expect(tree).toContain("styles.searchSlot");
  expect(tree).toContain("styles.viewOptionsMenu");
  expect(tree).toContain("sessionVisible(");
  expect(tree).toContain("compactRelativeTime(");
});

test("sidebar.module.css defines distinct classes for header actions and row hover actions", () => {
  const css = readSrc("styles", "sidebar.module.css");
  expect(css).toContain(".headerActions {");
  expect(css).toContain(".rowActions {");
  // Header actions must stay visible (display: flex), never overridden by rowActions (display: none).
  const headerIdx = css.indexOf(".headerActions {");
  const headerRule = css.slice(headerIdx, css.indexOf("}", headerIdx));
  expect(headerRule).toContain("display: flex");
});

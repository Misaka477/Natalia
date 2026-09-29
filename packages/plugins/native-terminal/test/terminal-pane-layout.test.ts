import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The pane-layout pins. The xterm host's box must be layout-driven, never
 * content-driven, or the pane stops following the sidebar it lives in.
 *
 * The failure this guards against was reported from the field: widening the
 * terminal worked, narrowing it back did not, and the terminal's height stayed
 * at its initial size while the pane grew around it. Both are the same CSS
 * defect — `min-width: auto` (the flex default) makes a flex item refuse to
 * shrink below its min-content width, and xterm's min-content width IS its
 * rendered width (columns * cell), so the host's floor rose with every refit
 * and the split cell could no longer shrink below the terminal it contained.
 */

const css = readFileSync(
  join(import.meta.dir, "..", "src", "ui", "styles.css"),
  "utf8",
);

/** The rule block for one selector, as written in the sheet. */
function ruleOf(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing rule: ${selector}`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

test("the xterm host's box is layout-driven, so the pane can narrow", () => {
  const host = ruleOf(".web-terminal");
  // Without min-width:0 the host cannot shrink below xterm's rendered width,
  // which is ceil(columns * cellWidth) — so widening the pane permanently
  // locked the pane's minimum width.
  expect(host).toContain("min-width: 0");
  expect(host).toContain("min-height: 0");
  // An explicit box makes the host's size the cell's size, so the ResizeObserver
  // that refits the terminal measures the pane rather than the terminal's own
  // feedback.
  expect(host).toMatch(/width:\s*100%/u);
  expect(host).toMatch(/height:\s*100%/u);
  expect(host).toContain("overflow: hidden");
});

test("the host's parent chain lets the pane drive both axes", () => {
  // The split cell must be allowed to shrink in both directions; without these
  // the pane's own width/height becomes a floor the sidebar cannot cross.
  const cell = ruleOf(".terminal-split-cell");
  expect(cell).toContain("min-width: 0");
  expect(cell).toContain("min-height: 0");
  // The pane layer the observer also watches must be exactly pane-sized.
  const layer = ruleOf(".terminal-xterm-host");
  expect(layer).toContain("position: absolute");
  expect(layer).toContain("inset: 0");
});

test("the pane root stretches to the panel slot instead of resolving a percentage", () => {
  // The field report: the terminal box was ~430px inside a ~900px sidebar, with
  // the rest empty. The pane root had `height: 100%`, its mount slot was a plain
  // block, so the percentage resolved to auto and the pane's height became
  // mutually dependent on the terminal's own content — it settled at its
  // content height and stopped. `flex: 1` against a slot that is a flex column
  // gives it the slot's height instead.
  const root = ruleOf(".terminal-pane");
  expect(root).toContain("flex: 1 1 auto");
  expect(root).toContain("min-height: 0");
  expect(root).toContain("overflow: hidden");
  expect(root).toContain("flex-direction: column");
});

test("the plugin mount slot is a flex column so a plugin root can stretch", () => {
  // The slot is the last definite link in the chain. Without a definite basis
  // here, every plugin root that sizes itself in percentages resolves to auto.
  // native-terminal/test -> repo root -> packages/plugins/ui/web.
  const sheet = readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "packages",
      "plugins",
      "ui",
      "web",
      "src",
      "styles",
      "base.ts",
    ),
    "utf8",
  );
  const start = sheet.indexOf(".neu-side-panel-host {");
  if (start < 0) throw new Error("missing rule: .neu-side-panel-host");
  const rule = sheet.slice(start, sheet.indexOf("}", start));
  expect(rule).toContain("display: flex");
  expect(rule).toContain("flex-direction: column");
  expect(rule).toContain("min-height: 0");
});

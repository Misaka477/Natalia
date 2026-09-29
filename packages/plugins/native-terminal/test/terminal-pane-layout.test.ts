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

test("the pane root stretches to the panel slot the host mounts into", () => {
  // The plugin is mounted into `.neu-side-panel-host` (height:100%), so a pane
  // root that sized itself to content would cap the whole chain — the terminal
  // then stayed at its spawn geometry while the sidebar grew.
  const root = ruleOf(".terminal-pane");
  expect(root).toMatch(/height:\s*100%/u);
  expect(root).toContain("overflow: hidden");
  expect(root).toContain("flex-direction: column");
});

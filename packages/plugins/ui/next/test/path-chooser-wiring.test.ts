/**
 * EVERY path a human would otherwise type has a chooser beside it.
 *
 * The first pass wired the settings panel's rows and stopped there, which is
 * why the workspace panel, the plan panel and the three governance path rows
 * still asked for a typed path. This walks the sources and fails on a path
 * surface with no chooser, so the next one added cannot be forgotten either.
 *
 * The second pass replaced every panel's own button with ONE shared
 * `PathBrowseButton`: the app's `onBrowse` forwarding is gone (that spelling
 * was itself a bug — `<Show when={props.onBrowse}>` calls a function `when`,
 * so the workspace panel ran the chooser on every render), and the settings
 * rows feed the shared edit dialog a browse MODE instead of calling the
 * picker themselves. The pins below follow that shape.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// test -> web -> ui -> plugins -> packages -> repo root
const repoRoot = join(import.meta.dir, "..", "..", "..", "..", "..");

function source(relative: string): string {
  return readFileSync(join(repoRoot, relative), "utf8");
}

/** Every source that renders a path input, and how many rows it has. */
const PATH_SURFACES = [
  {
    // The rows feed the shared edit dialog: a row's chooser is the browse
    // mode it hands `openEdit`, and the dialog renders the ONE
    // PathBrowseButton for whichever mode is open.
    file: "packages/plugins/ui/next/src/settings-panel.tsx",
    rows: 3,
    pattern: /^\s*"(?:file|directory)",$/gmu,
  },
  {
    // Every other surface renders the shared button itself, with the runtime
    // it already has — no callback forwarding through the app.
    file: "packages/plugins/ui/next/src/workspace-panel.tsx",
    rows: 1,
    pattern: /<PathBrowseButton/gu,
  },
  {
    file: "packages/plugins/ui/next/src/plan-panel.tsx",
    rows: 1,
    pattern: /<PathBrowseButton/gu,
  },
  {
    file: "packages/plugins/ui/next/src/governance-panel.tsx",
    rows: 3,
    pattern: /<PathBrowseButton/gu,
  },
] as const;

test("every path surface calls the runtime's chooser", () => {
  for (const surface of PATH_SURFACES) {
    const text = source(surface.file);
    const calls = text.match(surface.pattern) ?? [];
    expect(
      calls.length,
      `${surface.file} has ${surface.rows} path row(s) but ${calls.length} chooser call(s)`,
    ).toBeGreaterThanOrEqual(surface.rows);
  }
});

test("each panel renders the shared chooser with the runtime it has", () => {
  // The app used to forward an `onBrowse` callback to the workspace panel;
  // that spelling is gone, and was itself the bug (`<Show when={...}>` calls
  // a function `when`, so the chooser ran on every render). Each panel now
  // renders the one shared button with the runtime it already holds.
  for (const file of [
    "packages/plugins/ui/next/src/workspace-panel.tsx",
    "packages/plugins/ui/next/src/plan-panel.tsx",
    "packages/plugins/ui/next/src/governance-panel.tsx",
  ]) {
    const text = source(file);
    expect(text, `${file} renders no chooser`).toContain("<PathBrowseButton");
    expect(text, `${file} gives the chooser no runtime`).toMatch(
      /runtime=\{props\.runtime\}/u,
    );
  }
  // And the shared button is the ONE call site for the chooser itself: one
  // place names the runtime's pickers, not one per panel.
  const button = source("packages/plugins/ui/next/src/path-browse-button.tsx");
  expect(button).toContain("props.runtime?.pickDirectory?.()");
  expect(button).toContain("props.runtime?.pickFile?.()");
});

test("the governance panel appends rather than replaces", () => {
  // Three path rows, all comma-separated lists: a chooser that replaced the
  // field would drop every path already configured the moment a human browsed
  // for a second one.
  const text = source("packages/plugins/ui/next/src/governance-panel.tsx");
  const appends = text.match(/\[\.\.\.existing, chosen\]\.join\(","\)/gu) ?? [];
  expect(appends.length).toBe(3);
});

test("the chooser shares the action row instead of adding one", () => {
  // A second `neu-form-actions` between the field and the buttons added a whole
  // line to every dialog that got one.
  for (const file of [
    "packages/plugins/ui/next/src/settings-panel.tsx",
    "packages/plugins/ui/next/src/workspace-panel.tsx",
  ]) {
    const text = source(file);
    // Anchored on the element, because a comment elsewhere also says 浏览.
    const at = text.indexOf("<PathBrowseButton");
    expect(at, `${file} renders no chooser`).toBeGreaterThan(0);
    const closeAt =
      text.indexOf('t("common.cancel")', at) > 0
        ? text.indexOf('t("common.cancel")', at)
        : text.indexOf("取消", at);
    const between = text.slice(at, closeAt);
    expect(
      between,
      `${file} opens a new action row after the chooser`,
    ).not.toContain('<div class="neu-form-actions">');
  }
});

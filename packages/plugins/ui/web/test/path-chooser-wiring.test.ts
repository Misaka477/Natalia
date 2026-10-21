/**
 * EVERY path a human would otherwise type has a chooser beside it.
 *
 * The first pass wired the settings panel's rows and stopped there, which is
 * why the workspace panel, the plan panel and the three governance path rows
 * still asked for a typed path. This walks the sources and fails on a path
 * surface with no chooser, so the next one added cannot be forgotten either.
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
    file: "packages/plugins/ui/web/src/settings-panel.tsx",
    rows: 3,
  },
  {
    // The workspace panel takes its chooser as a prop, which `app-neu` wires
    // to the runtime — so the call is counted in the app, not here.
    file: "packages/plugins/ui/web/src/workspace-panel.tsx",
    rows: 1,
    call: "props.onBrowse",
  },
  {
    file: "packages/plugins/ui/web/src/plan-panel.tsx",
    rows: 1,
  },
  {
    file: "packages/plugins/ui/web/src/governance-panel.tsx",
    rows: 3,
  },
] as const;

test("every path surface calls the runtime's chooser", () => {
  for (const surface of PATH_SURFACES) {
    const text = source(surface.file);
    const pattern =
      "call" in surface
        ? new RegExp(surface.call.replace(/[.?]/gu, "\\$&"), "gu")
        : /props\.runtime\?\.pick(?:Directory|File)\?\.\(\)/gu;
    const calls = text.match(pattern) ?? [];
    expect(
      calls.length,
      `${surface.file} has ${surface.rows} path row(s) but ${calls.length} chooser call(s)`,
    ).toBeGreaterThanOrEqual(surface.rows);
  }
});

test("the app wires the workspace panel's chooser to the runtime", () => {
  const app = source("packages/plugins/ui/web/src/app-neu.tsx");
  expect(app).toContain("onBrowse={async () =>");
  expect(app).toContain("props.ctx.runtime.pickDirectory?.()");
});

test("the governance panel appends rather than replaces", () => {
  // Three path rows, all comma-separated lists: a chooser that replaced the
  // field would drop every path already configured the moment a human browsed
  // for a second one.
  const text = source("packages/plugins/ui/web/src/governance-panel.tsx");
  const appends = text.match(/\[\.\.\.existing, chosen\]\.join\(","\)/gu) ?? [];
  expect(appends.length).toBe(3);
});

test("the chooser shares the action row instead of adding one", () => {
  // A second `neu-form-actions` between the field and the buttons added a whole
  // line to every dialog that got one.
  for (const file of [
    "packages/plugins/ui/web/src/settings-panel.tsx",
    "packages/plugins/ui/web/src/workspace-panel.tsx",
  ]) {
    const text = source(file);
    // Anchored on the JSX text node, because a comment elsewhere in the file
    // also says 浏览.
    const at = text.indexOf("浏览…\n");
    expect(at, `${file} has no 浏览 button`).toBeGreaterThan(0);
    const between = text.slice(at, text.indexOf("取消", at));
    expect(between, `${file} opens a new action row after 浏览`).not.toContain(
      '<div class="neu-form-actions">',
    );
  }
});

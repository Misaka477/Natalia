/**
 * Every path a human would otherwise type has a chooser beside it.
 *
 * The dialog is the runtime's, on the user's machine — a page has no host
 * channel — so each row reaches it through `props.runtime.pickDirectory` or
 * `pickFile`. The pins here are the wiring: which kind each row asks for, that
 * the text box survives beside the button, and that a list row appends rather
 * than replaces.
 *
 * There is no DOM harness in this repository (no jsdom or happy-dom
 * dependency, and adding one is not this change's business), so the guard is
 * the source wiring itself — the same pattern the settings-panel wiring test
 * uses.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..", "..", "..");

function source(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

const panel = source("packages/plugins/ui/web/src/settings-panel.tsx");
const workspace = source("packages/plugins/ui/web/src/workspace-panel.tsx");
const app = source("packages/plugins/ui/web/src/app-neu.tsx");

test("the editor offers a chooser, and the kind is the row's to say", () => {
  // `openEdit` takes the kind as its fourth argument, so a row names a FILE or
  // a DIRECTORY rather than the dialog guessing.
  expect(panel).toContain('browse?: "directory" | "file"');
  expect(panel).toContain("setEditFieldBrowse(browse)");
  // The button is conditional: a row with no chooser shows no button, so the
  // affordance is never advertised where it does nothing.
  expect(panel).toContain("<Show when={editFieldBrowse()}>");
  expect(panel).toContain("浏览…");
});

test("the two shell path rows ask for a FILE", () => {
  // The rows name bash.exe and pwsh.exe. A directory chooser there would be
  // the wrong question. Matched on the row's own slice rather than one
  // spelling, because prettier decides where the argument wraps.
  const bashAt = panel.indexOf('"Git Bash 路径"');
  const pwshAt = panel.indexOf('"PowerShell 路径"');
  expect(bashAt).toBeGreaterThan(0);
  expect(pwshAt).toBeGreaterThan(bashAt);
  expect(panel.slice(bashAt, pwshAt)).toMatch(/"file"/u);
  expect(panel.slice(pwshAt, pwshAt + 1200)).toMatch(/"file"/u);
});

test("the checkpoint row appends rather than replaces", () => {
  // The field is a comma-separated LIST. A shared "put the answer in the box"
  // action would replace the whole list with one picked entry, silently
  // dropping every directory already configured — so this row installs its own
  // browse action that appends.
  const at = panel.indexOf('"Checkpoint 目录"');
  expect(at).toBeGreaterThan(0);
  const row = panel.slice(at, at + 1600);
  expect(row).toMatch(/"directory"/u);
  expect(row).toContain("browseFieldAction = async () => {");
  // The append itself, matched on the operands: prettier wraps the spread.
  expect(row).toMatch(/additionalDirs:\s*\[\.\.\.existing,\s*picked\]/u);
  // And the default action is cleared when an editor opens, so one row's
  // action cannot leak into the next.
  expect(panel).toContain("browseFieldAction = undefined;");
});

test("the workspace panel offers a chooser beside its text box", () => {
  expect(workspace).toContain("onBrowse?: () => Promise<string | null>");
  expect(workspace).toContain("浏览…");
  // The text box stays: a path the chooser cannot express is still enterable.
  expect(workspace).toContain('placeholder="工作区路径');
});

test("the app wires the workspace chooser to the runtime", () => {
  expect(app).toContain("onBrowse={async () =>");
  expect(app).toContain("props.ctx.runtime.pickDirectory?.()");
});

test("the browse action reaches the runtime, not a local guess", () => {
  expect(panel).toContain("props.runtime?.pickDirectory?.()");
  expect(panel).toContain("props.runtime?.pickFile?.()");
});

/**
 * A turn must not re-mount ANY right-rail panel — and neither must switching
 * tabs.
 *
 * Two field reports, one root cause. The rail's slots were keyed on scope
 * values that move during a turn (a workspace id looked up in the debounced
 * session list, falling back to the projection's own active workspace, plus the
 * session twice), and a keyed `<Show>` rebuilds its subtree whenever its key
 * changes. So sending a message — or switching the permission, which emits a
 * system message — re-mounted the panel: the terminal lost its xterm instance,
 * its socket and its scrollback, and the file editor lost open tabs and UNSAVED
 * buffers.
 *
 * The rail's panels are therefore not keyed at all and are not re-created: each
 * mounts on first activation and is afterwards only shown or hidden, so what
 * lives inside them survives both an event and a tab switch. They stay correct
 * without a shell-provided key because each one subscribes to the projection
 * itself (the file editor compares the workspace key; the terminal's effect keys
 * on sessionID+runtimeURL).
 *
 * The five shell-owned panels keep `rightPanelScopeKey()`, because they hold
 * session-scoped cursors and editors that MUST be rebuilt with the session —
 * but that key is now a pure function of one source (`panel-scope.ts`).
 *
 * There is no DOM harness here, so the guard is the wiring itself.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(
  join(import.meta.dir, "..", "src", "app-neu.tsx"),
  "utf8",
);

// The right rail moved into its own controller; the guards below read the
// file the markup actually lives in.
const rail = readFileSync(
  join(import.meta.dir, "..", "src", "controllers", "workbench.tsx"),
  "utf8",
);

/** The rail's own slot markup, from its <For> to the closing </For>. */
function railSlot(): string {
  const start = rail.indexOf("<For each={sidePanels()}>");
  expect(start).toBeGreaterThan(-1);
  const end = rail.indexOf("</For>", start);
  return rail.slice(start, end);
}

/**
 * The same slice with `//` comment lines removed. The assertions below are
 * about the MARKUP; the slot's comment deliberately names the `<Show>` and the
 * key it replaced, and a guard that reads comments is a guard that fails on its
 * own explanation.
 */
function railMarkup(): string {
  return railSlot().replace(/^\s*\/\/.*$/gmu, "");
}

test("the plugin rail is never keyed and never rebuilt", () => {
  expect(app).not.toContain("sidePanelScopeKey");
  const markup = railMarkup();
  // No <Show> wrapper at all: a keyed one destroyed the panels on scope churn,
  // and even an unkeyed one would unmount them on a tab switch.
  expect(markup).not.toContain("<Show");
  expect(markup).not.toContain("rightPanelScopeKey");
  // Mounted once, then shown or hidden — the panel keeps its own state.
  expect(markup).toContain("everShown");
  expect(markup).toContain('display: "none"');
  expect(markup).toContain("mountPanel(");
});

test("first activation, not eagerness: mounting the terminal would start a pane", () => {
  // `loadTabs` creates a terminal when none runs, so mounting every panel up
  // front would spawn a shell for a tab the user never opened.
  const slot = railSlot();
  expect(slot).toContain("if (active) everShown = true;");
  expect(slot).toContain(
    "if (!everShown || !container || mounted || mounting)",
  );
});

test("every shell-owned rail panel keeps the session-scoped key", () => {
  // Three of them now: diff, plan and governance. Nia and the team used
  // to be rail tabs and are pane agents — the pane's switcher reaches
  // them — so the rail hosts the shell's three review surfaces plus
  // whatever panels plugins register.
  expect(rail.match(/rightPanelScopeKey\(\)/gu)?.length).toBe(3);
  // One source, computed by the pure helper — no session-list lookup mixed in.
  expect(app).toContain("panelScopeKey({");
  expect(app).toContain("workspaceID: state().activeWorkspaceID,");
  expect(app).toContain("sessionID: selectedSessionID() || state().sessionID,");
});

test("collapsing the rail hides it instead of unmounting it", () => {
  // The collapse toggle used to be `{rightVisible() ? (<aside…>) : (button)}`,
  // so collapsing destroyed every panel the rail hosts — including an editor's
  // unsaved buffers. It is a CSS display toggle now.
  expect(rail).not.toContain("{rightVisible() ? (");
  expect(rail).toContain('display: rightVisible() ? "contents" : "none"');
  // The way back is still offered while it is hidden.
  expect(app).toContain("{rightVisible() ? null : (");
  expect(app).toContain("neu-collapsed-rail neu-right-rail");
});

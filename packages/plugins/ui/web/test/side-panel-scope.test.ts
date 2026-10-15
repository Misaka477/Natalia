/**
 * A turn must not re-mount the plugin rail.
 *
 * The report: sending a message — or switching the permission, which emits a
 * system message — refreshed the whole terminal tab. The rail's slot was keyed
 * on the same four-part scope as the shell-owned panels (workspace, active
 * workspace, selected session, active session), and those parts move during a
 * turn. The remount destroys the xterm instance, its socket and its
 * scrollback and repaints the pane from nothing.
 *
 * A pane belongs to the WORKSPACE: the terminal receives the session as a
 * prop and reloads its own rows when it changes (its effect keys on
 * sessionID+runtimeURL), so a session change needs no remount — and a
 * workspace change still gets one. The five shell-owned panels keep the full
 * key, because they hold session-scoped cursors and editors that must be
 * rebuilt with the session.
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

test("the plugin rail keys on the workspace alone", () => {
  expect(app).toContain("const sidePanelScopeKey = createMemo(");
  // The rail's slot uses it, and nothing else does.
  expect(app.match(/sidePanelScopeKey\(\)/gu)?.length).toBe(1);
  // ...while the five shell-owned panels keep the full scope key: five uses,
  // and the memo's own definition does not call itself.
  expect(app.match(/rightPanelScopeKey\(\)/gu)?.length).toBe(5);
});

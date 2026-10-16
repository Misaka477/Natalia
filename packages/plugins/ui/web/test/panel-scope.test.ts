/**
 * The re-mount key must be a function of its inputs ALONE (audit: the right
 * rail re-mounted on ordinary events).
 *
 * The old key mixed a session-list lookup with a projection fallback, so it
 * could differ between two calls with nothing real changed — and a keyed
 * `<Show>` rebuilds its whole subtree when its key changes. These cases pin the
 * property that makes that impossible: equal workspace and session give an
 * equal key, and only a real change of either gives a different one.
 */
import { expect, test } from "bun:test";
import { panelScopeKey } from "../src/panel-scope";

test("equal inputs give an equal key, however often it is computed", () => {
  const first = panelScopeKey({ workspaceID: "ws_a", sessionID: "ses_1" });
  const second = panelScopeKey({ workspaceID: "ws_a", sessionID: "ses_1" });
  expect(second).toBe(first);
  // A projection snapshot re-created on every event has the same VALUES; the
  // key must therefore not carry identity, ordering or a timestamp.
  expect(panelScopeKey({ sessionID: "ses_1", workspaceID: "ws_a" })).toBe(
    first,
  );
});

test("a real workspace or session change is the only thing that changes it", () => {
  const base = panelScopeKey({ workspaceID: "ws_a", sessionID: "ses_1" });
  expect(panelScopeKey({ workspaceID: "ws_b", sessionID: "ses_1" })).not.toBe(
    base,
  );
  expect(panelScopeKey({ workspaceID: "ws_a", sessionID: "ses_2" })).not.toBe(
    base,
  );
});

test("an unattached session is its own stable bucket", () => {
  const before = panelScopeKey({ workspaceID: "ws_a" });
  expect(panelScopeKey({ workspaceID: "ws_a", sessionID: "" })).toBe(before);
  expect(before).toBe(panelScopeKey({ workspaceID: "ws_a" }));
  // And it cannot collide with a session that is literally called `none`: the
  // marker for "nothing attached" is a NUL, which no id can contain.
  expect(before).not.toBe(
    panelScopeKey({ workspaceID: "ws_a", sessionID: "none" }),
  );
});

test("the two fields cannot bleed into each other", () => {
  // A separator that appears inside an id must not make two different scopes
  // compare equal — the reason the joiner is a NUL rather than ":".
  expect(panelScopeKey({ workspaceID: "a:b", sessionID: "c" })).not.toBe(
    panelScopeKey({ workspaceID: "a", sessionID: "b:c" }),
  );
});

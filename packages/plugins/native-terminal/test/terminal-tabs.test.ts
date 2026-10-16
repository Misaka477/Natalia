/**
 * The tab reconciliation rules — the front end's half of "the terminal must not
 * reload while the user works".
 *
 * Measured on the deployed app: switching to the terminal, sending a message and
 * switching a permission profile each rebuilt the panel's tab objects, so Solid
 * tore the xterm host down and rebuilt it — a new socket, a replayed screen and
 * a new pane (`terminal_d222c5d3…` became `terminal_e070a4a5…`). The rules below
 * are what keeps a pane where the user left it, and they are pure so they can be
 * tested without a DOM harness (this repo has none).
 */
import { expect, test } from "bun:test";
import {
  reconcileTabs,
  sameTabs,
  type TerminalTab,
} from "../src/ui/terminal-tabs";

function counter() {
  let next = 0;
  return () => `new_${++next}`;
}

const tab = (id: string, cells = [id]): TerminalTab => ({
  id,
  cells,
  layout: "horizontal",
});

test("an unchanged pane list keeps every tab object", () => {
  const previous = [tab("pane_a"), tab("pane_b")];
  const next = reconcileTabs({
    previous,
    running: ["pane_a", "pane_b"],
    known: ["pane_a", "pane_b"],
    newPaneID: counter(),
  });
  // Same objects, in the same order: `<For>` sees no key change, so the xterm
  // hosts, their sockets and their scrollback survive the reconciliation.
  expect(next[0]).toBe(previous[0]);
  expect(next[1]).toBe(previous[1]);
  expect(sameTabs(next, previous)).toBe(true);
});

test("a split tab survives as one tab with its layout", () => {
  const split = {
    ...tab("pane_a"),
    cells: ["pane_a", "pane_b"],
    layout: "vertical" as const,
  };
  const previous = [split, tab("pane_c")];
  const next = reconcileTabs({
    previous,
    // The backend lists panes flat; the tab's grouping is the front end's.
    running: ["pane_a", "pane_b", "pane_c"],
    known: ["pane_a", "pane_b", "pane_c"],
    newPaneID: counter(),
  });
  expect(next).toHaveLength(2);
  expect(next[0]).toBe(split);
  expect(next[0]?.layout).toBe("vertical");
  expect(next[1]).toBe(previous[1]);
});

test("a pane the backend started elsewhere arrives as its own tab", () => {
  const previous = [tab("pane_a")];
  const next = reconcileTabs({
    previous,
    running: ["pane_a", "pane_b"],
    known: ["pane_a", "pane_b"],
    newPaneID: counter(),
  });
  expect(next.map((entry) => entry.id)).toEqual(["pane_a", "pane_b"]);
  // The tab that was already on screen is untouched.
  expect(next[0]).toBe(previous[0]);
});

test("a pane that exited gets a fresh pane in the same tab", () => {
  const previous = [tab("pane_a"), tab("pane_b")];
  const next = reconcileTabs({
    // `pane_a` is still known to the backend but no longer running: it exited.
    previous,
    running: ["pane_b"],
    known: ["pane_a", "pane_b"],
    newPaneID: counter(),
  });
  // The exited tab keeps its place on screen and gets a live pane; the tab that
  // is running is handed on untouched.
  expect(next).toHaveLength(2);
  expect(next[0]?.cells).toEqual(["new_1"]);
  expect(next[1]).toBe(previous[1]);
});

test("a session's first load builds one tab per running pane", () => {
  const next = reconcileTabs({
    previous: [],
    running: ["pane_a", "pane_b"],
    known: ["pane_a", "pane_b"],
    newPaneID: counter(),
  });
  expect(next.map((entry) => entry.id)).toEqual(["pane_a", "pane_b"]);
});

test("a pane the backend forgot reattaches instead of being replaced", () => {
  const previous = [tab("pane_a")];
  const next = reconcileTabs({
    // A runtime/bridge restart empties the registry: nothing is running and
    // nothing is known. Minting a new id here would leave this tab showing a
    // dead pane and open a second terminal beside it — the reported reload.
    previous,
    running: [],
    known: [],
    newPaneID: counter(),
  });
  expect(next).toHaveLength(1);
  expect(next[0]).toBe(previous[0]);
  expect(next[0]?.cells).toEqual(["pane_a"]);
  expect(sameTabs(next, previous)).toBe(true);
});

test("a session with no tabs and no panes gets exactly one placeholder", () => {
  const next = reconcileTabs({
    previous: [],
    running: [],
    known: [],
    newPaneID: counter(),
  });
  expect(next).toEqual([
    { id: "new_1", cells: ["new_1"], layout: "horizontal" },
  ]);
});

/**
 * Terminal tab reconciliation — ui/terminal-tabs.ts.
 *
 * The panel's tab objects are the keys Solid's `<For>` uses, so an object that
 * is rebuilt is an xterm host that is rebuilt: a new DOM node, a new socket and
 * a replayed screen. The front end used to rebuild every tab from the backend's
 * flat pane list on every `terminal.*` event, which is what the user saw as the
 * terminal reloading while they typed a message or switched a permission
 * profile. Reconciliation here is therefore BY PANE ID and keeps the previous
 * object whenever the pane is still running.
 *
 * The rules, in one place so they can be tested without a DOM (this repo has no
 * DOM harness):
 *
 *   - a running pane the tabs already show keeps its tab object, its cells and
 *     its split layout — the flat list is grouped back into the user's tabs
 *     instead of exploding every split pane into a tab of its own;
 *   - a running pane no tab shows arrives as a new tab, in backend order;
 *   - a pane the backend still knows but no longer runs has EXITED: its cell
 *     gets a fresh pane id, because a dead screen is not what a tab is for;
 *   - a pane the backend does not know at all was torn down under us (a runtime
 *     or bridge restart): the cell keeps its id and reattaches, because that is
 *     the pane the user is looking at — minting a new id there leaves the tab
 *     behind and opens a second terminal beside it;
 *   - a tab is never dropped by reconciliation, and a session with no tabs and
 *     no running pane gets one fresh placeholder tab.
 */
export type TerminalTab = {
  id: string;
  cells: string[];
  layout: "vertical" | "horizontal";
};

/** Element-wise identity: two tab lists that differ nowhere must not re-render. */
export function sameTabs(left: TerminalTab[], right: TerminalTab[]) {
  return (
    left.length === right.length &&
    left.every((tab, index) => tab === right[index])
  );
}

export function reconcileTabs(input: {
  /** The tabs on screen, when they belong to the same session. */
  previous: readonly TerminalTab[];
  /** Ids of the panes the backend reports as running, in its order. */
  running: readonly string[];
  /** Every pane id the backend still knows, running or not. */
  known: readonly string[];
  newPaneID: () => string;
}): TerminalTab[] {
  const { running, known, newPaneID } = input;
  const previous = [...input.previous];

  if (!previous.length) {
    // Nothing on screen yet: one tab per running pane, or a single placeholder
    // whose id the backend creates when the pane connects.
    if (running.length)
      return running.map((id) => ({
        id,
        cells: [id],
        layout: "horizontal" as const,
      }));
    const id = newPaneID();
    return [{ id, cells: [id], layout: "horizontal" }];
  }

  const runningIDs = new Set(running);
  const knownIDs = new Set(known);
  // A tab the user arranged is never dropped, and its cells are reconciled one
  // by one: a cell that is still running stays exactly as it is; a cell the
  // backend still knows but does not run has exited and gets a fresh pane (a
  // dead screen is not what a tab is for); a cell the backend does not know at
  // all was torn down under us (a runtime or bridge restart) and keeps its id,
  // because reattaching to it restarts the shell the user was looking at where
  // minting a fresh id opens a second terminal beside it.
  const kept = previous.map((tab) => {
    const cells = tab.cells.map((cellID) =>
      runningIDs.has(cellID) || !knownIDs.has(cellID) ? cellID : newPaneID(),
    );
    return cells.some((cellID, index) => cellID !== tab.cells[index])
      ? { ...tab, cells }
      : tab;
  });
  const covered = new Set(kept.flatMap((tab) => tab.cells));
  const arrived = running
    .filter((id) => !covered.has(id))
    .map((id) => ({ id, cells: [id], layout: "horizontal" as const }));
  return [...kept, ...arrived];
}

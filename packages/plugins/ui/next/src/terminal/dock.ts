/**
 * The terminal's three dock modes.
 *
 * The terminal is an independent frame: where it lives is the reader's
 * choice, and the choice is a preference rather than a layout the shell
 * hard-codes. The modes:
 *
 *   tab     a right-rail tab, as it has always been — the rail's own
 *           scrollback, beside the review panes
 *   split   beside the transcript, its own column — the pane a reader
 *           watches a command in without leaving the conversation
 *   float   a free frame over the shell — the one that survives a
 *           collapsed rail and a narrow window
 *
 * The mode itself is pure state here; the shell owns where each mode
 * actually puts the frame, and the entry rides a preference so the
 * choice survives a restart.
 */

export const DOCK_MODES = ["tab", "split", "float"] as const;

export type DockMode = (typeof DOCK_MODES)[number];

/** The preference key the choice persists under. */
export const DOCK_MODE_PREFERENCE_KEY = "uiTerminalDockMode";

export function isDockMode(value: unknown): value is DockMode {
  return (
    typeof value === "string" &&
    (DOCK_MODES as readonly string[]).includes(value)
  );
}

/** The next mode in the cycle, so one control walks all three. */
export function nextDockMode(current: DockMode): DockMode {
  const index = DOCK_MODES.indexOf(current);
  return DOCK_MODES[(index + 1) % DOCK_MODES.length]!;
}

/** The dictionary key naming each mode, for the control's label. */
export const DOCK_MODE_LABEL_KEYS: Record<DockMode, string> = {
  tab: "dock.mode.tab",
  split: "dock.mode.split",
  float: "dock.mode.float",
};

/** One line per mode, for the control's tooltip. */
export const DOCK_MODE_HINT_KEYS: Record<DockMode, string> = {
  tab: "dock.hint.tab",
  split: "dock.hint.split",
  float: "dock.hint.float",
};

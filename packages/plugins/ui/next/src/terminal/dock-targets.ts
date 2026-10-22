/**
 * Where the terminal's independent frame currently lives, by mode.
 *
 * The shell renders one container per non-tab mode and registers it
 * here; the right rail's panel host asks for the current mode's
 * container and appends itself into it. A holder rather than a prop
 * chain, because the container is created by the shell's layout while
 * the panel host is created by the rail — and neither should own the
 * other's element.
 */

import type { DockMode } from "./dock";

export interface DockTargets {
  /** The column beside the transcript, for `split`. */
  split?: HTMLElement | undefined;
  /** The floating frame's body, for `float`. */
  float?: HTMLElement | undefined;
}

const targets: DockTargets = {};

/** The shell registers the container a mode renders. */
export function registerDockTarget(
  mode: "split" | "float",
  element: HTMLElement | undefined,
): void {
  targets[mode] = element;
}

/**
 * The container the current mode names, or undefined for `tab` — the
 * panel host stays where the rail put it.
 */
export function dockTargetFor(mode: DockMode): HTMLElement | undefined {
  if (mode === "split") return targets.split;
  if (mode === "float") return targets.float;
  return undefined;
}

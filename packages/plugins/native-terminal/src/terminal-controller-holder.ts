/**
 * The live terminal controllers, kept across plugin instances — ONE PER
 * WORKSPACE ROOT.
 *
 * WHY THIS EXISTS. The terminal plugin is `scope: "session"` and one of the four
 * plugins that require a host input (`terminal.input`, `localTools.input`,
 * `mcp.input`, `skills.input`). Measured on the deployed runtime, writing a
 * permission setting unloaded and reloaded exactly those four:
 *
 *     +785ms  terminal.action/exit   actor:"system"     (every pane killed)
 *     +886ms  plugin.update natalia-tool-terminal unloaded
 *     +905ms  plugin.update natalia-tool-terminal loaded
 *
 * and the plugin's `dispose()` called `controller.close()`, which kills every
 * pane in the PROCESS — the controller holds all sessions' panes, not one
 * session's. The front end then saw an empty pane list for the tab it was
 * showing and built a new pane with a new xterm, which the user saw as the
 * terminal reloading on every message and every permission change.
 *
 * Panes are not plugin state. The reference implementation keeps terminal
 * sessions in a service whose lifetime is not a plugin reload (a process-local
 * service that owns the sessions and gives their cleanup to itself, with
 * backends owning only the mechanics), and its subprocess layer kills live
 * terminals synchronously from the host's own exit event rather than from a
 * plugin's disposal (`terminateForHostExit`).
 *
 * SO: a plugin instance ADOPTS the held controller when the construction input
 * still matches, because the panes, their ptys, their screens and their
 * scrollback live inside it. `dispose()` only releases the instance's reference
 * — the service binding is released by the plugin API, as the registry requires
 * — and the one thing that really closes the controllers is the host process
 * exiting, through {@link closeTerminalControllerForShutdown}.
 *
 * WHY PER ROOT. One process runs SEVERAL workspace runtimes side by side: the
 * workspace manager starts each workspace's client lazily and never disposes the
 * others on an activation (`activate()` only flips the marker). With ONE
 * process-global slot, the second workspace's terminal plugin saw a different
 * `workspaceRoot` and took the "construction change" branch — which
 * force-closed the FIRST workspace's live controller. Measured on a live
 * session: switching sessions across workspaces published
 *
 *     terminal.timeline actor:"system" action=exit     (the other workspace's pane)
 *     rpc drift.findings failed: session not found: ses_…
 *
 * and every later terminal open in the first workspace died with
 * "terminal controller is closed" (`terminal-ws error terminal controller is
 * closed` on stderr), because its runtime's service directory still provided
 * the corpse. A root's controller belongs to that root, so the slot is keyed by
 * root: another root's plugin instance never touches it.
 */
import type { RuntimeEvent } from "@anthelia/contracts";
import type { TerminalController } from "@anthelia/runtime-services";

/** The construction input the controller is built from. */
export type TerminalControllerInputs = {
  workspaceRoot: string;
  publish(event: RuntimeEvent): void;
  onPerformance(name: string, durationMs: number): void;
  runtimeID(): string;
  userRuntimeHome(): string | undefined;
  maxPerSession?: number;
  idleMs?: number;
  settlement?: unknown;
  /**
   * The framework's storage for a session's saved pane layout. Carried through
   * the holder like the rest of the construction input: the adopted controller
   * keeps the hooks its first instance was given, which is the same instance's
   * closures (a plugin reload does not change them).
   */
  loadPaneLayout?: unknown;
  savePaneLayout?: unknown;
};

type HeldController = {
  controller: TerminalController & {
    forceCloseSync?(): void;
    isClosed?(): boolean;
  };
  inputs: TerminalControllerInputs;
};

/**
 * One entry per workspace root. The map is the holder: a root's controller is
 * adopted by that root's next plugin instance and by nobody else.
 */
const held = new Map<string, HeldController>();

/** The entry the most recent adoption used (the test seam's view). */
let lastKey: string | undefined;

/**
 * The fields that decide whether a held controller can serve a new plugin
 * instance. The closures (`publish`, `runtimeID`, …) are stable
 * for the lifetime of a runtime and are deliberately not compared — only the
 * VALUES a pane is built from are, because those are what a stale controller
 * would get wrong: a pane's default working directory and the PTY budgets.
 */
function sameConstructionInputs(
  left: TerminalControllerInputs,
  right: TerminalControllerInputs,
): boolean {
  return (
    left.workspaceRoot === right.workspaceRoot &&
    left.maxPerSession === right.maxPerSession &&
    left.idleMs === right.idleMs
  );
}

/**
 * Whether the held controller has already been closed.
 *
 * A runtime that shuts down closes the controller it was given (the framework's
 * own teardown), while this module-level holder still remembers it. Adopting it
 * afterwards handed the next runtime a controller whose `init` throws
 * "terminal controller is closed" — measured as 14 failures across the suite,
 * every one of them a case that opens a pane after another case's runtime had
 * closed its controller in the same process. A closed controller is spent; it is
 * never adopted and never closed twice.
 */
function isSpent(heldController: HeldController): boolean {
  try {
    return heldController.controller.isClosed?.() === true;
  } catch {
    // A controller that cannot answer is treated as usable: the alternative is
    // discarding a live one (and its panes) on a guess.
    return false;
  }
}

/**
 * Takes the held controller for THIS workspace root when its construction input
 * still matches, and builds a fresh one otherwise.
 *
 * A construction change (a different workspace root, different PTY budgets) is
 * the one case where a root's panes cannot be carried over: they were built for
 * the environment the controller no longer describes. Only THAT root's
 * controller is replaced — another root's entry is untouched, because its panes
 * belong to a runtime that is still alive and still providing them.
 *
 * @param inputs - the construction input the new plugin instance received.
 * @param create - the controller factory.
 * @returns the adopted controller and whether it was reused.
 */
export function adoptTerminalController(
  inputs: TerminalControllerInputs,
  create: (inputs: TerminalControllerInputs) => TerminalController,
): { controller: TerminalController; adopted: boolean } {
  const key = inputs.workspaceRoot;
  const existing = held.get(key);
  if (existing && sameConstructionInputs(existing.inputs, inputs)) {
    if (!isSpent(existing)) {
      // The new instance's input replaces the old one so later releases compare
      // against what this instance was given, not against the first one's.
      held.set(key, { controller: existing.controller, inputs });
      lastKey = key;
      return { controller: existing.controller, adopted: true };
    }
    // Spent: drop the corpse for this root and build a replacement below.
    held.delete(key);
  }
  if (existing) {
    // A budget change within the same root: that root's panes end, exactly as
    // they did before. Another root's controller is NOT reached.
    try {
      existing.controller.forceCloseSync?.();
    } catch {
      // The host's exit path is already tearing the process down.
    }
    held.delete(key);
  }
  const controller = create(inputs) as HeldController["controller"];
  held.set(key, { controller, inputs });
  lastKey = key;
  return { controller, adopted: false };
}

/**
 * Drops this plugin instance's reference to the controller WITHOUT closing it:
 * the panes stay alive for the next instance to adopt. Called from `dispose()`.
 */
export function releaseTerminalController(
  controller: TerminalController,
): void {
  for (const [key, entry] of held) {
    if (entry.controller !== controller) continue;
    // The entry stays: the panes outlive the instance, and the next instance of
    // this root adopts them.
    held.set(key, { controller: entry.controller, inputs: entry.inputs });
    return;
  }
}

/** The controller the most recent adoption handed out (test seam). */
export function heldTerminalController(): TerminalController | undefined {
  return lastKey === undefined ? undefined : held.get(lastKey)?.controller;
}

/**
 * Closes every held controller for real, killing every pane's pty synchronously.
 *
 * Registered on the host process's `exit` event by
 * {@link adoptTerminalController}'s caller, which is the shape the reference
 * implementation uses for the same job (`terminateForHostExit`): Node runs only
 * synchronous work during `exit`, and killing a pty is one call.
 */
export function closeTerminalControllerForShutdown(): void {
  const entries = [...held.values()];
  held.clear();
  lastKey = undefined;
  for (const entry of entries) {
    try {
      entry.controller.forceCloseSync?.();
    } catch {
      // Nothing left to report to; the process is going away.
    }
  }
}

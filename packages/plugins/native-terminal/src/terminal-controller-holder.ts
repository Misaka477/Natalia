/**
 * The live terminal controller, kept across plugin instances.
 *
 * WHY THIS EXISTS. The terminal plugin is `scope: "session"` and one of the four
 * plugins that require a host input (`terminal.input`, `localTools.input`,
 * `mcp.input`, `skills.input`). Measured on the deployed runtime, writing a
 * permission setting unloaded and reloaded exactly those four:

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
 * sessions in a service whose lifetime is not a plugin reload (`dsh-terminal`
 * declares sessions process-local and gives their cleanup to the service, with
 * backends owning only the mechanics), and its subprocess package kills live
 * terminals synchronously from the host's own exit event rather than from a
 * plugin's disposal (`LocalTerminalHandle.terminateForHostExit`).
 *
 * SO: a plugin instance ADOPTS the held controller when the construction input
 * still matches, because the panes, their ptys, their screens and their
 * scrollback live inside it. `dispose()` only releases the instance's reference
 * — the service binding is released by the plugin API, as the registry requires
 * — and the one thing that really closes the controller is the host process
 * exiting, through {@link closeTerminalControllerForShutdown}.
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
  windowMode(): "auto" | "windowless" | "window";
  maxPerSession?: number;
  idleMs?: number;
  settlement?: unknown;
};

type HeldController = {
  controller: TerminalController & {
    forceCloseSync?(): void;
    isClosed?(): boolean;
  };
  inputs: TerminalControllerInputs;
};

let held: HeldController | undefined;

/**
 * The fields that decide whether a held controller can serve a new plugin
 * instance. The closures (`publish`, `runtimeID`, `windowMode`, …) are stable
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
 * Takes the held controller when its construction input still matches, and
 * builds a fresh one otherwise (closing the one it replaces, which is a real
 * workspace/configuration change rather than a plugin reload).
 *
 * @param inputs - the construction input the new plugin instance received.
 * @param create - the controller factory.
 * @returns the adopted controller and whether it was reused.
 */
export function adoptTerminalController(
  inputs: TerminalControllerInputs,
  create: (inputs: TerminalControllerInputs) => TerminalController,
): { controller: TerminalController; adopted: boolean } {
  if (held && sameConstructionInputs(held.inputs, inputs) && !isSpent(held)) {
    const controller = held.controller;
    // The new instance's input replaces the old one so later releases compare
    // against what this instance was given, not against the first one's.
    held = { controller: held.controller, inputs };
    return { controller, adopted: true };
  }
  if (held && !isSpent(held)) {
    // A construction change (a different workspace root, different PTY budgets)
    // is the one case where the panes cannot be carried over: they were built
    // for the environment the controller no longer describes.
    try {
      held.controller.forceCloseSync?.();
    } catch {
      // The host's exit path is already tearing the process down.
    }
  }
  held = undefined;
  const controller = create(inputs) as HeldController["controller"];
  held = { controller, inputs };
  return { controller, adopted: false };
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
 * Drops this plugin instance's reference to the controller WITHOUT closing it:
 * the panes stay alive for the next instance to adopt. Called from `dispose()`.
 */
export function releaseTerminalController(
  controller: TerminalController,
): void {
  if (held?.controller !== controller) return;
  held = { controller: held.controller, inputs: held.inputs };
}

/** Whether a controller is currently held (test seam). */
export function heldTerminalController(): TerminalController | undefined {
  return held?.controller;
}

/**
 * Closes the held controller for real, killing every pane's pty synchronously.
 *
 * Registered on the host process's `exit` event by
 * {@link adoptTerminalController}'s caller, which is the shape the reference
 * implementation uses for the same job (`terminateForHostExit`): Node runs only
 * synchronous work during `exit`, and killing a pty is one call.
 */
export function closeTerminalControllerForShutdown(): void {
  const current = held;
  held = undefined;
  try {
    current?.controller.forceCloseSync?.();
  } catch {
    // Nothing left to report to; the process is going away.
  }
}

/**
 * A pane outlives a plugin reload.
 *
 * The user's report, traced: a permission write reloads the plugins that require
 * a host input, and the terminal plugin is one of the four — measured as
 * `plugin.update natalia-tool-terminal unloaded` immediately after
 * `config.update`, with every pane killed in the process (`controller.close()`
 * clears the whole registry). The front end then built a fresh pane for the tab
 * it was showing, which is the terminal that "reloaded" on every message and
 * every permission change.
 *
 * The contract this pins: the controller — with its panes, ptys and screen
 * contents — is handed on to the next plugin instance, and only a real
 * construction change (or the host's exit) ends the panes.
 */
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import type { TerminalController } from "@anthelia/runtime-services";
import {
  createPtyTerminalController,
  type PtyFactory,
  type PtyProcess,
} from "../src";
import {
  adoptTerminalController,
  closeTerminalControllerForShutdown,
  heldTerminalController,
  releaseTerminalController,
  type TerminalControllerInputs,
} from "../src/terminal-controller-holder";

function fakePty(): { factory: PtyFactory; processes: PtyProcess[] } {
  const processes: PtyProcess[] = [];
  const factory: PtyFactory = () => {
    const dataListeners = new Set<(data: string) => void>();
    const process: PtyProcess & { emit(data: string): void } = {
      pid: 1000 + processes.length,
      write(data) {
        for (const listener of dataListeners) listener(data);
      },
      resize() {},
      kill() {
        process.exited = true;
      },
      onData(listener) {
        dataListeners.add(listener);
        return { dispose: () => dataListeners.delete(listener) };
      },
      onExit() {
        return { dispose: () => undefined };
      },
      exited: false,
      emit(data) {
        for (const listener of dataListeners) listener(data);
      },
    } as PtyProcess & { emit(data: string): void; exited: boolean };
    processes.push(process);
    return process;
  };
  return { factory, processes };
}

function inputs(
  root: string,
  spawn: PtyFactory,
  extra: Partial<TerminalControllerInputs> = {},
): TerminalControllerInputs {
  return {
    workspaceRoot: root,
    publish: (_event: RuntimeEvent) => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "runtime-test",
    userRuntimeHome: () => undefined,
    windowMode: () => "windowless" as const,
    spawn,
    ...extra,
  } as TerminalControllerInputs & { spawn: PtyFactory };
}

const create = (value: TerminalControllerInputs) =>
  createPtyTerminalController(value as never) as TerminalController;

test("a plugin reload adopts the controller and keeps the pane running", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-terminal-adopt-"));
  const { factory, processes } = fakePty();

  const first = adoptTerminalController(inputs(root, factory), create);
  expect(first.adopted).toBe(false);
  await first.controller.init();
  const pane = await first.controller.start({
    command: "pwsh",
    cwd: root,
    id: "term_keep",
    sessionID: "ses_one",
  });
  expect(pane.id).toBe("term_keep");

  // The plugin is unloaded and loaded again (what a config write does).
  releaseTerminalController(first.controller);
  const second = adoptTerminalController(inputs(root, factory), create);

  expect(second.adopted).toBe(true);
  expect(second.controller).toBe(first.controller);
  // The pane is still there, with the same id — the controller was not closed.
  const listed = await second.controller.list("ses_one");
  expect(listed.map((entry) => entry.id)).toEqual(["term_keep"]);
  expect(processes[0]?.exited).toBe(false);

  closeTerminalControllerForShutdown();
  expect(processes[0]?.exited).toBe(true);
});

test("a construction change replaces the controller instead of serving stale pans", async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), "natalia-terminal-root-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "natalia-terminal-root-b-"));
  const { factory, processes } = fakePty();

  const first = adoptTerminalController(inputs(firstRoot, factory), create);
  await first.controller.init();
  await first.controller.start({
    command: "pwsh",
    cwd: firstRoot,
    id: "term_old_root",
    sessionID: "ses_one",
  });

  // A different workspace root is a real change: the held controller's panes
  // were built for the old environment, so they end and a new controller serves.
  const second = adoptTerminalController(inputs(secondRoot, factory), create);
  expect(second.adopted).toBe(false);
  expect(second.controller).not.toBe(first.controller);
  expect(processes[0]?.exited).toBe(true);
  expect(await second.controller.list("ses_one")).toEqual([]);

  const third = adoptTerminalController(inputs(secondRoot, factory), create);
  expect(third.adopted).toBe(true);

  closeTerminalControllerForShutdown();
});

test("the holder keeps exactly one controller and forgets it on shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-terminal-holder-"));
  const { factory } = fakePty();
  const adopted = adoptTerminalController(inputs(root, factory), create);
  expect(heldTerminalController()).toBe(adopted.controller);
  releaseTerminalController(adopted.controller);
  // Releasing keeps it available for the next instance.
  expect(heldTerminalController()).toBe(adopted.controller);
  closeTerminalControllerForShutdown();
  expect(heldTerminalController()).toBeUndefined();
});

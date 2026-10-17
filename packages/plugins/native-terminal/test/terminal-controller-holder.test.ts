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

/** The fake pty the assertions read: the pane's liveness is its `exited` flag. */
type FakePtyProcess = PtyProcess & {
  emit(data: string): void;
  exited: boolean;
};

function fakePty(): { factory: PtyFactory; processes: FakePtyProcess[] } {
  const processes: FakePtyProcess[] = [];
  const factory: PtyFactory = () => {
    const dataListeners = new Set<(data: string) => void>();
    const process: FakePtyProcess = {
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
    };
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

test("another workspace root's plugin instance never closes this root's panes", async () => {
  // The measured defect: one process runs several workspace runtimes, and the
  // workspace manager starts a workspace's client lazily without disposing the
  // others. With ONE process-global slot, the second workspace's terminal plugin
  // took the "construction change" branch and force-closed the FIRST workspace's
  // live controller — the pane died (actor:"system" exit published into the
  // victim's store) and every later terminal open in that workspace failed with
  // "terminal controller is closed". Switching sessions across workspaces is
  // what triggered it.
  const firstRoot = await mkdtemp(join(tmpdir(), "natalia-terminal-root-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "natalia-terminal-root-b-"));
  const { factory, processes } = fakePty();

  const first = adoptTerminalController(inputs(firstRoot, factory), create);
  await first.controller.init();
  await first.controller.start({
    command: "pwsh",
    cwd: firstRoot,
    id: "term_first_root",
    sessionID: "ses_one",
  });

  // The OTHER workspace's terminal plugin instance loads (its runtime started).
  const second = adoptTerminalController(inputs(secondRoot, factory), create);
  expect(second.adopted).toBe(false);
  expect(second.controller).not.toBe(first.controller);
  // The first workspace's pane is untouched: it belongs to a live runtime.
  expect(processes[0]?.exited).toBe(false);
  expect(
    (await first.controller.list("ses_one")).map((entry) => entry.id),
  ).toEqual(["term_first_root"]);

  // And the first root's next plugin instance still adopts ITS controller.
  const firstAgain = adoptTerminalController(
    inputs(firstRoot, factory),
    create,
  );
  expect(firstAgain.adopted).toBe(true);
  expect(firstAgain.controller).toBe(first.controller);

  // A budget change inside one root still replaces that root's controller.
  const third = adoptTerminalController(
    inputs(secondRoot, factory, { maxPerSession: 9 }),
    create,
  );
  expect(third.adopted).toBe(false);
  expect(third.controller).not.toBe(second.controller);
  // The replacement is adopted by the next instance that carries the SAME
  // budgets — and a third budget is another change, not a silent mismatch.
  const thirdAgain = adoptTerminalController(
    inputs(secondRoot, factory, { maxPerSession: 9 }),
    create,
  );
  expect(thirdAgain.adopted).toBe(true);
  expect(thirdAgain.controller).toBe(third.controller);

  closeTerminalControllerForShutdown();
  // The host's exit is the one path that kills a pane: every root's.
  expect(processes[0]?.exited).toBe(true);
});

test("a controller that was closed is never adopted", async () => {
  // The measured failure: a runtime that shuts down closes its controller while
  // the module-level holder still remembers it, and the NEXT runtime in the same
  // process adopts the corpse — every pane start then dies with "terminal
  // controller is closed". 14 suite failures, all of them a case that opens a
  // pane after another case's runtime closed its controller.
  const root = await mkdtemp(join(tmpdir(), "natalia-terminal-spent-"));
  const { factory, processes } = fakePty();

  const first = adoptTerminalController(inputs(root, factory), create);
  await first.controller.init();
  await first.controller.start({
    command: "pwsh",
    cwd: root,
    id: "term_before_close",
    sessionID: "ses_one",
  });
  // The framework's own teardown, not the holder's: the holder is left holding a
  // controller nobody can use again.
  await first.controller.close();
  expect(first.controller.isClosed?.()).toBe(true);
  expect(heldTerminalController()).toBe(first.controller);

  const second = adoptTerminalController(inputs(root, factory), create);
  expect(second.adopted).toBe(false);
  expect(second.controller).not.toBe(first.controller);
  // And the replacement really works: a fresh controller initializes and starts
  // a pane, which is exactly what the adopted corpse could not do.
  await second.controller.init();
  const pane = await second.controller.start({
    command: "pwsh",
    cwd: root,
    id: "term_after_close",
    sessionID: "ses_one",
  });
  expect(pane.id).toBe("term_after_close");
  // The spent controller's panes were already gone with its close.
  expect(processes[0]?.exited).toBe(true);
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

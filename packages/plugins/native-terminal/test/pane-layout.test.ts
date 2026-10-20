/**
 * A session's terminal comes back after a runtime restart.
 *
 * Section C's second half. The runtime that owns a session's panes is gone when
 * the app restarts, so "the terminal is still there" has to be rebuilt: the
 * layout the controller saved (pane ids, working directories, the command each
 * pane was started with) is replayed by the next runtime, id-first — which is
 * what also brings each pane's ↑/↓ history back, because that lives in a file
 * named after the pane.
 *
 * Driven through the controller's own hooks, with a fake pty, so the test is
 * about the layout's meaning and not about a real shell.
 */
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import type { TerminalController } from "@anthelia/runtime-services";
import {
  createPtyTerminalController,
  type PaneLayoutRecord,
  type PtyFactory,
  type PtyProcess,
} from "../src";

type FakePty = PtyProcess & {
  spawn: { file: string; cwd: string };
  /** Feeds the pane's output stream: how a shell's markers reach the controller. */
  emit(data: string): void;
};

function fakePty(): { factory: PtyFactory; spawned: FakePty[] } {
  const spawned: FakePty[] = [];
  const factory: PtyFactory = (options) => {
    const listeners = new Set<(chunk: string) => void>();
    const process: FakePty = {
      pid: 4000 + spawned.length,
      spawn: { file: options.file, cwd: options.cwd },
      write() {},
      resize() {},
      kill() {},
      onData(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      onExit() {
        return { dispose: () => undefined };
      },
      emit(data) {
        for (const listener of listeners) listener(data);
      },
    };
    spawned.push(process);
    return process;
  };
  return { factory, spawned };
}

/** The framework's side: a map standing in for the session store's metadata. */
function layoutStore() {
  const saved = new Map<string, PaneLayoutRecord>();
  return {
    saved,
    hooks: {
      loadPaneLayout: async (sessionID: string) => saved.get(sessionID),
      savePaneLayout: async (sessionID: string, layout: PaneLayoutRecord) => {
        saved.set(sessionID, layout);
      },
    },
  };
}

test("a shell that walks to another directory moves the saved layout with it", async () => {
  // Measured live before this: the layout kept the SPAWN directory, so a session
  // that `cd`-ed into a subdirectory and restarted came back at the workspace
  // root. The pane's live directory arrives as OSC 7, and a change to it is a
  // change to the session's terminal.
  const root = await mkdtemp(join(tmpdir(), "natalia-pane-layout-cwd-"));
  const sessionID = "ses_layout_cwd";
  const store = layoutStore();
  const fake = fakePty();
  const runtime = controllerWith(root, fake.factory, store.hooks);
  await runtime.init();
  await runtime.start({
    command: "pwsh",
    cwd: root,
    id: "term_walked",
    sessionID,
  });
  await settle();
  expect(store.saved.get(sessionID)?.panes[0]?.cwd).toBe(root);

  // The shell reports where it is, exactly as the integration script does: OSC 7
  // with a file:// URL. (The live directory is what the layout must carry, so the
  // marker's own spelling is exercised here too.)
  const subdirectory = join(root, "sub");
  fake.spawned[0]!.emit(
    `\u001b]7;file://localhost/${subdirectory.replaceAll("\\", "/").replace(/^\//u, "")}\u0007`,
  );
  await settle();
  const walked = store.saved.get(sessionID)?.panes[0]?.cwd ?? "";
  expect(walked.replaceAll("\\", "/").replace(/^\//u, "")).toBe(
    subdirectory.replaceAll("\\", "/").replace(/^\//u, ""),
  );
  await runtime.close();
});

function controllerWith(
  root: string,
  factory: PtyFactory,
  hooks: ReturnType<typeof layoutStore>["hooks"],
): TerminalController {
  return createPtyTerminalController({
    workspaceRoot: root,
    publish: (_event: RuntimeEvent) => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "runtime-test",
    userRuntimeHome: () => root,
    spawn: factory,
    ...hooks,
  } as never) as TerminalController;
}

const settle = () => Bun.sleep(400);

test("a session's panes come back with their ids, directories and order", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pane-layout-"));
  const sessionID = "ses_layout";
  const store = layoutStore();
  const first = fakePty();
  const runtime = controllerWith(root, first.factory, store.hooks);
  await runtime.init();
  await runtime.start({
    command: "pwsh",
    cwd: join(root, "one"),
    id: "term_one",
    sessionID,
  });
  await runtime.start({
    command: "pwsh",
    cwd: join(root, "two"),
    id: "term_two",
    sessionID,
  });
  await settle();
  expect(store.saved.get(sessionID)).toEqual({
    panes: [
      { id: "term_one", cwd: join(root, "one"), command: "pwsh" },
      { id: "term_two", cwd: join(root, "two"), command: "pwsh" },
    ],
  });

  // A confined pane is the model's, not a tab: it must not enter the layout,
  // because restoring it through the panel's own start path would come back
  // unconfined. The confinement seam needs a binary that EXISTS (it fails closed
  // on a missing one), and this test never runs it.
  const fakeConfinement = join(root, "fake-confinement.exe");
  await writeFile(fakeConfinement, "");
  await runtime.start({
    command: "pwsh",
    cwd: join(root, "three"),
    id: "term_model",
    sessionID,
    confinement: { mode: "read-only", binaryPath: fakeConfinement },
  });
  await settle();
  expect(store.saved.get(sessionID)?.panes.map((pane) => pane.id)).toEqual([
    "term_one",
    "term_two",
  ]);
  await runtime.close();

  // The runtime is gone (a restart). A new one shares the same storage and is
  // asked to rebuild the session's terminal.
  const second = fakePty();
  const restarted = controllerWith(root, second.factory, store.hooks);
  await restarted.init();
  expect(await restarted.list(sessionID)).toEqual([]);
  await restarted.restoreSaved?.(sessionID);
  const restored = await restarted.list(sessionID);
  expect(restored.map((pane) => pane.id)).toEqual(["term_one", "term_two"]);
  expect(second.spawned.map((pane) => pane.spawn.cwd)).toEqual([
    join(root, "one"),
    join(root, "two"),
  ]);
  // And asking again starts nothing: the restore is idempotent, so the panel may
  // ask on every attach.
  const spawnedBefore = second.spawned.length;
  await restarted.restoreSaved?.(sessionID);
  expect(second.spawned.length).toBe(spawnedBefore);
  await restarted.close();
});

test("a pane that exited is not part of the layout that comes back", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pane-layout-exit-"));
  const sessionID = "ses_layout_exit";
  const store = layoutStore();
  const fake = fakePty();
  const runtime = controllerWith(root, fake.factory, store.hooks);
  await runtime.init();
  await runtime.start({
    command: "pwsh",
    cwd: root,
    id: "term_kept",
    sessionID,
  });
  await runtime.start({
    command: "pwsh",
    cwd: root,
    id: "term_closed",
    sessionID,
  });
  await settle();
  await runtime.stop("term_closed", "human", sessionID);
  await settle();
  expect(store.saved.get(sessionID)?.panes.map((pane) => pane.id)).toEqual([
    "term_kept",
  ]);
  await runtime.close();
});

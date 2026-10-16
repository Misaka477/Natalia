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

type FakePty = PtyProcess & { spawn: { file: string; cwd: string } };

function fakePty(): { factory: PtyFactory; spawned: FakePty[] } {
  const spawned: FakePty[] = [];
  const factory: PtyFactory = (options) => {
    const process: FakePty = {
      pid: 4000 + spawned.length,
      spawn: { file: options.file, cwd: options.cwd },
      write() {},
      resize() {},
      kill() {},
      onData() {
        return { dispose: () => undefined };
      },
      onExit() {
        return { dispose: () => undefined };
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
    windowMode: () => "windowless",
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

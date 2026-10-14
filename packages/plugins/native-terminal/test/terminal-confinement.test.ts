import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPtyTerminalController,
  type PtyFactory,
  type PtyProcess,
  type PtySpawnOptions,
} from "../src";

/**
 * The pane's confinement: a pane is a REAL shell, so the spawn itself
 * carries the mode. Without it, one `interactive_terminal_start` approval
 * bought an unlimited live shell — the worst of the sandbox holes (the
 * main doc's escape-surface list). The wrap happens at the one spawn seam
 * every backend goes through, so all four backends are covered by shape.
 */

function fakePty(): { factory: PtyFactory; spawns: PtySpawnOptions[] } {
  const spawns: PtySpawnOptions[] = [];
  const factory: PtyFactory = (options) => {
    spawns.push(options);
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: { exitCode: number }) => void>();
    const process: PtyProcess = {
      pid: 4242,
      write() {},
      resize() {},
      kill() {},
      onData(listener) {
        dataListeners.add(listener);
        return {
          dispose() {
            dataListeners.delete(listener);
          },
        };
      },
      onExit(listener) {
        exitListeners.add(listener);
        return {
          dispose() {
            exitListeners.delete(listener);
          },
        };
      },
    };
    return process;
  };
  return { factory, spawns };
}

/** A stand-in confinement backend: present, executable, and named. */
function fakeBackend(): string {
  const path = join(
    mkdtempSync(join(tmpdir(), "natalia-terminal-confinement-")),
    "confinement-exec",
  );
  writeFileSync(path, '#!/bin/sh\nexec "$@"\n');
  chmodSync(path, 0o755);
  return path;
}

async function controllerWith(root: string) {
  const { factory, spawns } = fakePty();
  const controller = createPtyTerminalController({
    workspaceRoot: root,
    publish: () => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "runtime-test",
    userRuntimeHome: () => undefined,
    windowMode: () => "windowless" as const,
    spawn: factory,
  });
  return { controller, spawns };
}

test("a workspace-write pane spawns THROUGH the confinement wrapper", async () => {
  const root = mkdtempSync(join(tmpdir(), "natalia-terminal-conf-"));
  const { controller, spawns } = await controllerWith(root);
  await controller.start({
    command: "cat",
    cwd: root,
    confinement: {
      mode: "workspace-write",
      workspaceRoot: root,
      binaryPath: fakeBackend(),
    },
  });
  // The pane's process IS the wrapper: the shell rides as its argv, and
  // the writable roots ride as the wrapper's flags — everything typed
  // into the pane afterwards inherits them.
  expect(spawns).toHaveLength(1);
  const spawn = spawns[0]!;
  expect(spawn.file).toContain("confinement-exec");
  expect(spawn.args).toContain("--read-write");
  expect(spawn.args).toContain(root);
  // The pane's command rides LAST — but its SPELLING is the platform's, so
  // the last element is only exactly `cat` where the derivation is POSIX.
  // Windows derives through PowerShell: one `-Command` script whose tail is
  // the command itself (the UTF-8 encoding preamble rides in front of it),
  // so the command is the tail of the last argv element rather than its own
  // element. The confinement shape under test — the wrapper in front, the
  // pane's command last — is the same on both; asserting the POSIX spelling
  // unconditionally is what made this red on Windows.
  if (process.platform === "win32") {
    expect(spawn.args.at(-1)?.endsWith("cat")).toBe(true);
  } else {
    expect(spawn.args.at(-1)).toBe("cat");
  }
  await controller.close();
});

test("a danger-full-access pane spawns the raw argv — no wrapper", async () => {
  const root = mkdtempSync(join(tmpdir(), "natalia-terminal-conf-"));
  const { controller, spawns } = await controllerWith(root);
  await controller.start({
    command: "cat",
    cwd: root,
    confinement: { mode: "danger-full-access", workspaceRoot: root },
  });
  // The raw pane argv (whatever the shell derivation produces) — the
  // point is that the confinement binary is NOT in front of it.
  expect(spawns[0]!.file).not.toContain("confinement-exec");
  expect(spawns[0]!.args.some((arg) => arg.includes("confinement-exec"))).toBe(
    false,
  );
  await controller.close();
});

test("a confined pane with no backend REFUSES to start — never an unconfined pane", async () => {
  const root = mkdtempSync(join(tmpdir(), "natalia-terminal-conf-"));
  const { controller, spawns } = await controllerWith(root);
  // A named backend that does not exist is the fail-closed case: the wrap
  // must not silently degrade to the raw argv.
  await expect(
    controller.start({
      command: "cat",
      cwd: root,
      confinement: {
        mode: "read-only",
        workspaceRoot: root,
        binaryPath: join(root, "no-such-backend"),
      },
    }),
  ).rejects.toThrow(/no usable backend/);
  // And nothing spawned.
  expect(spawns).toHaveLength(0);
  await controller.close();
});

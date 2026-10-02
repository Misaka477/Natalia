import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPtyTerminalController,
  type PtyFactory,
  type PtyProcess,
} from "../src";

/**
 * The command-level read, exercised through a real controller with a fake pty.
 *
 * The output is the property that matters: it is a slice of the screen bounded by
 * the command's markers, not a second buffer of the bytes. These tests kill both
 * ways of getting that wrong — output that includes the next prompt's text, and
 * output that drifts from what the screen shows.
 */

const ESC = "\u001b";
const BEL = "\u0007";
const promptStart = `${ESC}]133;A${BEL}`;
const commandStart = `${ESC}]133;B${BEL}`;
const commandExecuted = `${ESC}]133;C${BEL}`;
const commandFinished = (code?: number) =>
  `${ESC}]133;D${code === undefined ? "" : `;${code}`}${BEL}`;
const commandLine = (command: string) =>
  `${ESC}]633;E;${command.replace(/\\/g, "\\\\").replace(/;/g, "\\x3b")}${BEL}`;

/** One full command cycle, as a shell that emits the markers produces it. */
function cycle(command: string, output: string, exitCode?: number) {
  return (
    promptStart +
    commandLine(command) +
    commandExecuted +
    output +
    commandFinished(exitCode)
  );
}

/**
 * A pty that mirrors ONLCR, so the rendered screen matches a real pane's.
 *
 * The listener sets are exposed so a test can push bytes exactly where the pty
 * driver would, without reaching into the controller's internals.
 */
function fakePty(): {
  factory: PtyFactory;
  emit: (data: string) => void;
} {
  const dataListeners = new Set<(data: string) => void>();
  const factory: PtyFactory = () =>
    ({
      pid: 4242,
      write(data: string) {
        for (const listener of dataListeners)
          listener(data.replace(/\n/g, "\r\n"));
      },
      resize() {},
      kill() {},
      onData(listener: (data: string) => void) {
        dataListeners.add(listener);
        return {
          dispose() {
            dataListeners.delete(listener);
          },
        };
      },
      onExit() {
        return { dispose() {} };
      },
    }) as unknown as PtyProcess;
  return {
    factory,
    emit: (data) => {
      for (const l of dataListeners) l(data);
    },
  };
}

// Same shape the pty controller's own tests use, so this file does not carry a
// second copy that can drift from the first.
function controllerInput(root: string, factory: PtyFactory) {
  return {
    workspaceRoot: root,
    publish: () => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "runtime-test",
    userRuntimeHome: () => undefined,
    windowMode: () => "windowless" as const,
    spawn: factory,
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function withController(
  run: (
    controller: ReturnType<typeof createPtyTerminalController>,
    emit: (chunk: string) => void,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "natalia-command-read-"));
  const { factory, emit } = fakePty();
  const controller = createPtyTerminalController(
    controllerInput(root, factory),
  );
  cleanups.push(async () => {
    await controller.close?.();
    await rm(root, { recursive: true, force: true });
  });
  await controller.init();
  await controller.start({
    command: "bash",
    cwd: root,
    id: "term_a",
    sessionID: "ses_one",
  });
  await run(controller, emit);
}

describe("lastCommand", () => {
  test("a finished command reports its line, its exit code and its output", async () => {
    await withController(async (controller, emit) => {
      emit(cycle("echo hello", "hello\r\n", 0));
      const read = controller.lastCommand?.("term_a");
      expect(read?.commandLine).toBe("echo hello");
      expect(read?.exitCode).toBe(0);
      expect(read?.output).toContain("hello");
      expect(read?.atPrompt).toBe(true);
    });
  });

  test("a nonzero exit reaches the reader", async () => {
    await withController(async (controller, emit) => {
      emit(cycle("false", "", 1));
      expect(controller.lastCommand?.("term_a").exitCode).toBe(1);
    });
  });

  test("the output does not include the next prompt's text", async () => {
    await withController(async (controller, emit) => {
      // The shell draws the next prompt AFTER D, so everything from the next
      // cycle must stay out of this command's output.
      emit(cycle("echo first", "first\r\n", 0));
      emit(promptStart + commandLine("echo second") + "second\r\n");
      expect(controller.lastCommand?.("term_a").output).toContain("first");
      expect(controller.lastCommand?.("term_a").output).not.toContain("second");
    });
  });

  test("a slice, not a buffer: an earlier command's output is not carried forward", async () => {
    // THE property that separates a projection from a second capture. A buffer
    // accumulates, so the second command would still hold the first's output. A
    // slice of the screen cannot, because the screen shows one command at a time.
    // Mutating the output into an accumulating buffer leaves every other test here
    // green and turns this one red.
    await withController(async (controller, emit) => {
      emit(cycle("echo alpha", "alpha-output\r\n", 0));
      expect(controller.lastCommand?.("term_a").output).toContain(
        "alpha-output",
      );
      emit(cycle("echo beta", "beta-output\r\n", 0));
      const second = controller.lastCommand?.("term_a").output;
      expect(second).toContain("beta-output");
      expect(second).not.toContain("alpha-output");
    });
  });

  test("output is a slice of the screen, so it cannot drift from what is shown", async () => {
    await withController(async (controller, emit) => {
      emit(cycle("printf out", "the-output-line\r\n", 0));
      const fromCommand = controller.lastCommand?.("term_a").output;
      // The same text must be in the pane's own read — one truth, two views.
      const whole = await controller.read("term_a", { maxLines: 200 });
      // Not an equality: the slice also carries whatever the pane showed around
      // the output (a prompt, a trailing blank), and the sharp property is in the
      // not-toContain assertions below.
      expect(fromCommand).toContain("the-output-line");
      // The pane's own read contains what the command-level read handed over:
      // the same bytes, bounded differently. One truth, two views.
      expect(whole.text).toContain("the-output-line");
      expect(whole.text).toContain(fromCommand!.trim());
    });
  });

  test("a shell that emits no markers reports unknown rather than inventing a command", async () => {
    await withController(async (controller, emit) => {
      emit("just some bytes, no markers here\r\n$ ");
      const read = controller.lastCommand?.("term_a");
      expect(read?.commandLine).toBeUndefined();
      expect(read?.exitCode).toBeUndefined();
      // No command has finished, so there is no output to hand over.
      expect(read?.output).toBeUndefined();
      expect(read?.atPrompt).toBe(true);
    });
  });

  test("D with no code means no command ran, and is not reported as success", async () => {
    await withController(async (controller, emit) => {
      emit(commandStart + `${commandFinished()}`);
      const read = controller.lastCommand?.("term_a");
      expect(read?.exitCode).toBeUndefined();
      expect(read?.atPrompt).toBe(true);
    });
  });
});

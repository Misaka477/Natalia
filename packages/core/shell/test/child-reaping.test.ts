/**
 * A command this process started does not outlive it.
 *
 * Measured defect this pins: a foreground `run_shell` whose caller went away — a
 * window closed, the host stopped — left its child running. On Windows a child is
 * not in a job object, so nothing takes it with the parent, and the only path
 * that ever terminated one was the abort/timeout branch of `run()`. A model that
 * started a dev server and then lost its window left the server holding the port.
 *
 * The seam now keeps the children it spawned and terminates them, whole trees, on
 * the way out (`process.once("exit")`), and the same entry point is what this
 * test drives.
 */
import { expect, test } from "bun:test";
import { selectExecutor, terminateShellChildren } from "../src";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executor = selectExecutor();
const slow = process.platform === "win32" ? "Start-Sleep 30" : "sleep 30";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("terminateShellChildren stops a command still running", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "shell-reap-"));
  const spec = executor.resolve({
    command: slow,
    workdir: cwd,
    timeoutMs: 60_000,
  });
  const started = await executor.start(spec, {
    command: slow,
    workspaceRoot: cwd,
  });
  const pid = started.pid;
  expect(pid).toBeDefined();
  // A detached POSIX child is in its own group; the Windows child is a real
  // process id. Either way it is alive before we reap it.
  await Bun.sleep(200);
  expect(alive(pid!)).toBe(true);

  const stopped = terminateShellChildren();
  expect(stopped).toBeGreaterThanOrEqual(1);
  // The tree is gone within a moment (taskkill /T is asynchronous on Windows).
  let running = true;
  for (let attempt = 0; attempt < 40 && running; attempt += 1) {
    await Bun.sleep(50);
    running = alive(pid!);
  }
  expect(running).toBe(false);
  started.kill();
}, 60_000);

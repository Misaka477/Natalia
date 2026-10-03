import { expect, test } from "bun:test";

import { BashLocalExecutor } from "../src/bash-local";
import {
  WRAPPER_FAILURE_SIGNATURE,
  WRAPPER_REFUSAL_EXIT,
  type ShellExecRequest,
} from "../src/types";

/**
 * Telling "the command failed" from "the sandbox could not run".
 *
 * The wrapper exits 2 with a signature on stderr when IT refuses, and a command is
 * free to exit 2 for its own reasons. The classification has to hold both apart,
 * and it is what `sandbox.runnerFailed` reports.
 */

const confined = (command: string): ShellExecRequest => ({
  command,
  env: { PATH: process.env.PATH },
  confinement: "workspace-write",
  workspaceRoot: process.cwd(),
});

test("a command's own exit 2 stays the command's", async () => {
  // The whole point of the change: exit 2 alone is not a refusal.
  const bash = new BashLocalExecutor();
  const request = confined("exit 2");
  const run = await bash.run(bash.resolve(request), request);

  expect(run.exitCode).toBe(2);
  expect(run.outcome).toBe("exited");
  expect(run.sandbox).toEqual({ mode: "workspace-write", runnerFailed: false });
  expect(run.confinementRefusal).toBeUndefined();
});

test("a command that prints the wrapper's signature still exits as itself", async () => {
  // The other half: the signature alone is not a refusal either. A command is free
  // to print anything, so believing the text without the code would take a real
  // exit away from a real command.
  const bash = new BashLocalExecutor();
  const request = confined(
    `echo '${WRAPPER_FAILURE_SIGNATURE} something convincing' >&2; exit 7`,
  );
  const run = await bash.run(bash.resolve(request), request);

  expect(run.exitCode).toBe(7);
  expect(run.outcome).toBe("exited");
  expect(run.sandbox?.runnerFailed).toBe(false);
  expect(run.confinementRefusal).toBeUndefined();
});

test("a wrapper refusal is reported as a sandbox failure, not a command exit", async () => {
  // What a refusal looks like to this seam: the wrapper's exit code and its
  // signature together. The command never ran, so there is no exit code for it.
  const bash = new BashLocalExecutor();
  const request = confined(
    `echo '${WRAPPER_FAILURE_SIGNATURE} landlock ABI 0: no backend' >&2; exit ${WRAPPER_REFUSAL_EXIT}`,
  );
  const run = await bash.run(bash.resolve(request), request);

  expect(run.outcome).toBe("spawn-failed");
  expect(run.exitCode).toBeNull();
  expect(run.confinementRefusal).toContain("landlock");
  expect(run.sandbox).toEqual({ mode: "workspace-write", runnerFailed: true });
});

test("an unconfined run carries no sandbox facts", async () => {
  // Absent, not `{mode: ..., runnerFailed: false}` on a run that was never
  // confined — a caller must be able to tell "no sandbox was involved".
  const bash = new BashLocalExecutor();
  const request: ShellExecRequest = {
    command: "exit 3",
    env: { PATH: process.env.PATH },
  };
  const run = await bash.run(bash.resolve(request), request);

  expect(run.exitCode).toBe(3);
  expect(run.sandbox).toBeUndefined();
});

/**
 * The fail-closed path: `wrapConfinedCommand` returns nothing when the mode needs a
 * backend and none is usable. The command must not run, and the result must say the
 * sandbox could not run rather than that a command failed.
 */
test("a missing confinement backend fails closed with a runner failure", async () => {
  const bash = new BashLocalExecutor();
  const request = confined("echo should-not-run");
  // A binary that does not exist is the shape "no usable backend" takes at the
  // wrapper boundary, without needing to unset anything on this machine.
  const spec = bash.resolve(request);
  const run = await bash.run(
    { ...spec, command: "/nonexistent/confinement-exec" },
    request,
  );

  // The command did not run: whatever the wrapper said, the model must be told the
  // sandbox could not run it.
  expect(run.stdout).not.toContain("should-not-run");
  expect(run.sandbox?.runnerFailed).toBe(true);
});

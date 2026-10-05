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

/**
 * A request whose confinement backend cannot be found.
 *
 * Named rather than simulated by rewriting the resolved argv: overriding
 * `spec.command` with a missing path only makes the DISCOVERED wrapper fail its
 * own `exec`, which is a refusal WITH text (`confinement-exec: exec failed: ...`)
 * and not the silent one. Reaching "no usable backend" needs the lookup itself to
 * come back empty, which is what naming a missing binary does — the same injection
 * `wrapConfinedCommand({ binaryPath })` already takes, one layer up. No machine
 * state is touched, and no test has to know where the real binary lives.
 */
const withoutBackend = (command: string): ShellExecRequest => ({
  ...confined(command),
  confinementBinaryPath: "/nonexistent/confinement-exec",
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
  const request = withoutBackend("echo should-not-run");
  const spec = bash.resolve(request);
  const run = await bash.run(spec, request);

  // The command did not run: whatever the wrapper said, the model must be told the
  // sandbox could not run it.
  expect(run.stdout).not.toContain("should-not-run");
  expect(run.outcome).toBe("spawn-failed");
  expect(run.sandbox?.runnerFailed).toBe(true);
});

test("a missing backend says WHY, so the caller is not left with a bare refusal", async () => {
  // The other half of the same case, and the one that cost a debugging session:
  // there is no exit code, no stderr and no wrapper signature to classify here, so
  // a refusal without words reaches the model as the information-free "the command
  // could not be started" — no mode, no reason, no way out. The shell choice was
  // suspected and re-fixed while the real cause sat one layer down.
  const bash = new BashLocalExecutor();
  const request = withoutBackend("echo should-not-run");
  const run = await bash.run(bash.resolve(request), request);

  // It names the mode that could not run, names what is missing, and says what a
  // caller can do about it.
  expect(run.confinementRefusal).toBeDefined();
  expect(run.confinementRefusal).not.toBe("the command could not be started");
  expect(run.confinementRefusal).toContain("workspace-write");
  expect(run.confinementRefusal).toContain("confinement-exec");
  expect(run.confinementRefusal).toContain("danger-full-access");
});

test("a missing backend refuses a background start with the same words", async () => {
  // `start` is the other caller of that bare string, and a detached caller gets no
  // result object at all: the refusal text is the only thing it can report.
  const bash = new BashLocalExecutor();
  const request = withoutBackend("echo should-not-run");
  const spec = bash.resolve(request);
  await expect(bash.start(spec, request)).rejects.toThrow(/confinement-exec/u);
  await expect(bash.start(spec, request)).rejects.not.toThrow(
    "the command could not be started",
  );
});

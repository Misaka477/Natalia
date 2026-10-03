import { expect, test } from "bun:test";

import { BashLocalExecutor } from "../src/bash-local";
import { ShellEnvRegistry } from "../src/shell-env";
import type { ShellExecRequest } from "../src/types";

/**
 * The gap this closes, asserted end to end.
 *
 * The shell tool's environment is an allowlist. It was correct policy and it had a
 * consequence nobody chose: `NATALIA_HOME` was not in it, so a command run by a
 * model could not find the harness's own home unless an operator allowlisted it by
 * hand. A registry that holds the value proves nothing about that; only spawning a
 * command that reads it does.
 *
 * So this runs a REAL bash command — `printenv` — rather than inspecting a spec.
 */
test("a model's command sees NATALIA_HOME without it being allowlisted", async () => {
  const registry = new ShellEnvRegistry("/natalia-home-from-registry");
  const executor = new BashLocalExecutor();
  const request: ShellExecRequest = {
    command:
      "printenv NATALIA_HOME && printenv NATALIA_SHELL && printenv NATALIA_SESSION_ID",
    // The allowlist, and deliberately NOT containing any NATALIA_* name.
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    shellEnv: registry.collect({ sessionID: "ses_e2e" }),
  };
  const spec = executor.resolve(request);
  const run = await executor.run(spec, request);

  expect(run.outcome).toBe("exited");
  expect(run.exitCode).toBe(0);
  expect(run.stdout.trim().split("\n")).toEqual([
    "/natalia-home-from-registry",
    "1",
    "ses_e2e",
  ]);
});

/**
 * The other half of the contract: a caller cannot displace a managed fact, and a
 * stale value from the harness process cannot leak in. Both are the same mechanism
 * (ambient drop, then merge), and both are worth a command rather than a unit
 * assertion because the mechanism lives in the spawn path.
 */
test("a caller's NATALIA_HOME cannot displace the harness's", async () => {
  const registry = new ShellEnvRegistry("/the-real-home");
  const executor = new BashLocalExecutor();
  const request: ShellExecRequest = {
    command: "printenv NATALIA_HOME",
    env: { PATH: process.env.PATH, NATIALIA_HOME: "/callers-guess" },
    shellEnv: registry.collect({}),
  };
  const run = await executor.run(executor.resolve(request), request);

  expect(run.exitCode).toBe(0);
  expect(run.stdout.trim()).toBe("/the-real-home");
});

/**
 * And confinement facts now ride the result: a caller can tell "the command failed"
 * from "the sandbox could not run" without parsing stderr for a signature.
 */
test("a confined run reports the mode it ran under, independently of the exit", async () => {
  const executor = new BashLocalExecutor();
  const request: ShellExecRequest = {
    command: "exit 3",
    env: { PATH: process.env.PATH },
    confinement: "workspace-write",
    workspaceRoot: process.cwd(),
  };
  const run = await executor.run(executor.resolve(request), request);

  // A nonzero exit is the COMMAND's, and the sandbox facts say so.
  expect(run.exitCode).toBe(3);
  expect(run.outcome).toBe("exited");
  expect(run.sandbox).toEqual({ mode: "workspace-write", runnerFailed: false });
});

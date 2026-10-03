import { clampTimeout, selectExecutor } from "@anthelia/shell";
import { ShellEnvRegistry } from "@anthelia/shell";
import type { ToolExecutionContext } from "./types";
import { safeToolEnv } from "./child-process";

/** The confinement wrapper's refusal prefix (its own stderr dialect). */
const WRAPPER_FAILURE_SIGNATURE = "confinement-exec:";

/**
 * The harness-owned environment facts a model's command sees.
 *
 * `NATALIA_HOME` is the reason this exists: the allowlist in `safeToolEnv` is
 * correct policy and it excluded every `NATALIA_*` name, so a command run by a model
 * could not find the harness's own home unless an operator happened to allowlist it.
 * Facts the harness owns are now injected rather than opted into.
 *
 * Built once here because this process is the harness: a second registry would
 * answer "which home did that command see" differently from this one.
 */
const shellEnv = new ShellEnvRegistry(process.env.NATALIA_HOME ?? "");

/**
 * Runs one shell command inside the workspace with output capture.
 *
 * Lives here rather than in `@natalia/plugin-tool-shell` because it is a shared
 * execution primitive, not shell-plugin-specific: `@natalia/plugin-tool-web` runs the
 * headless browser through it. A tool plugin may use it without statically
 * depending on another tool plugin's package.
 *
 * The shell is a RUNTIME choice through the seam: `BashLocalExecutor` supplies
 * the argv, and everything after that — confinement, the timeout, the abort, the
 * output assembly, the wrapper-refusal classification — is shared by every shell
 * and lives above the seam. Adding PowerShell is a new executor, not an edit
 * here.
 */
const shell = selectExecutor();

export async function runShell(
  command: string,
  context: ToolExecutionContext,
  timeoutSec: number,
) {
  const spec = shell.resolve({
    command,
    workdir: context.workspaceRoot,
    timeoutMs: timeoutSec * 1000,
    confinement: context.confinement,
    workspaceRoot: context.workspaceRoot,
    signal: context.signal,
    // The allowlist is policy and stays here; the seam carries its result. This
    // is what stops a command from reading the runtime's whole environment, and
    // it was missing between the seam's introduction and now — typecheck found it
    // as an unused type, and nothing else would have.
    env: safeToolEnv(context.settings?.envAllowlist),
    // Merged after the allowlist by the executor, so it displaces nothing a
    // caller's policy chose to include and cannot be displaced itself.
    shellEnv: shellEnv.collect({
      sessionID: context.sessionID,
    }),
  });
  const run = await shell.run(spec, {
    command,
    confinement: context.confinement,
    workspaceRoot: context.workspaceRoot,
    signal: context.signal,
  });

  if (run.outcome === "spawn-failed")
    throw new Error(
      run.confinementRefusal ?? "the command could not be started",
    );
  if (run.outcome === "aborted")
    throw context.signal?.reason ?? new Error("command cancelled");
  if (run.outcome === "timeout")
    throw new Error(`command timed out after ${timeoutSec}s`);

  const stdout = run.stdout;
  const stderr = run.stderr;
  const output = [
    `exit=${run.exitCode}`,
    stdout && `stdout:\n${stdout}`,
    stderr && `stderr:\n${stderr}`,
  ]
    .filter(Boolean)
    .join("\n");
  if (run.exitCode === 0) return output;
  throw new Error(output);
}

export { clampTimeout };

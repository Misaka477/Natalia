import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
  // Where the COMPLETE streams go. The tail the model reads is a page; without a
  // file behind it the head of a long build is gone rather than merely unread,
  // and no pager can walk back to it.
  const spill = spillTargets(context.workspaceRoot);
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
    ...(spill ? { spillTo: spill } : {}),
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
    // The bound, said out loud. A tail that lost its head must say so: the
    // model reads "the command produced 60KB and you are seeing the last
    // 20KB" rather than mistaking the tail for the whole output and acting
    // on a page it was never told was a page.
    ...truncationNotes(run, spill),
  ]
    .filter(Boolean)
    .join("\n");
  // A NON-ZERO EXIT IS THE COMMAND'S ANSWER, not a failure of the call: the
  // exit status and the output are the result, carried as one value. Throwing
  // here used to turn "the tests are red" into an error string, so the caller
  // could only recover the code by matching prose — and the failure path
  // skipped redaction and the output bound entirely. Only the three outcomes
  // above throw, because each means the command never got to answer.
  return output;
}

/**
 * The truncation note per stream, or nothing when the stream was whole. The
 * wording names the remedy the way the other capped readers do — re-run
 * narrower — because this command surface has no page parameter to offer.
 */
function truncationNotes(
  run: {
    outputBytes?: {
      stdout: { served: number; total: number };
      stderr: { served: number; total: number };
    };
  },
  spill?: { stdout: string; stderr: string },
): string[] {
  const bounds = run.outputBytes;
  if (!bounds) return [];
  const notes: string[] = [];
  for (const [name, bound, path] of [
    ["stdout", bounds.stdout, spill?.stdout],
    ["stderr", bounds.stderr, spill?.stderr],
  ] as const) {
    if (bound.total <= bound.served) continue;
    notes.push(
      path
        ? `[${name} truncated: showing the last ${bound.served} of ${bound.total} bytes; the complete stream is at ${path} — read it with offset/limit]`
        : `[${name} truncated: showing the last ${bound.served} of ${bound.total} bytes; re-run narrower to see the rest]`,
    );
  }
  return notes;
}

/**
 * The two files a run's complete output is written to, or undefined when the
 * workspace cannot hold them (a read-only sandbox): the bound then degrades to
 * the old re-run-narrower advice instead of losing the command.
 */
function spillTargets(
  workspaceRoot: string,
): { stdout: string; stderr: string } | undefined {
  try {
    const dir = join(workspaceRoot, ".natalia", "tool-output");
    mkdirSync(dir, { recursive: true });
    const stem = join(dir, `stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    return { stdout: `${stem}.stdout.log`, stderr: `${stem}.stderr.log` };
  } catch {
    return undefined;
  }
}

export { clampTimeout };

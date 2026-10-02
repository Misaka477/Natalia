/**
 * The configured completion check, run before a model claims a goal complete.
 *
 * A goal used to be complete because whoever reported it said so, which left the
 * authority entirely in the model's own claim. A configured command makes that
 * claim checkable: the model says "done", and the workspace gets to answer.
 *
 * The command runs in the workspace root with a bounded output capture, because
 * the result is shown to the model rather than to a log reader — an unbounded
 * dump would spend the context it is trying to protect. A timeout is reported as
 * a failure rather than swallowed, so a hanging check cannot look like a pass.
 */

import { spawnSync } from "node:child_process";

/** How long the check may run before it is treated as failed. */
const COMPLETION_CHECK_TIMEOUT_MS = 120_000;

/** How much of the check's output is shown to the model. */
const COMPLETION_CHECK_OUTPUT_CHARS = 4_000;

export interface CompletionCheckResult {
  ok: boolean;
  command?: string;
  detail?: string;
}

/**
 * Runs the configured command and reports whether it succeeded.
 *
 * `undefined` means no command is configured, which is the case that must behave
 * exactly as before: a completion check nobody asked for is not a safety net, it
 * is a way to fail workspaces that have no test suite.
 */
export function runCompletionCheck(input: {
  workspaceRoot: string;
  command?: string;
}): CompletionCheckResult | undefined {
  if (!input.command) return undefined;
  const result = spawnSync(input.command, {
    cwd: input.workspaceRoot,
    shell: true,
    timeout: COMPLETION_CHECK_TIMEOUT_MS,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const status = result.status;
  const ok = result.error === undefined && status === 0;
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const bounded =
    combined.length > COMPLETION_CHECK_OUTPUT_CHARS
      ? `${combined.slice(0, COMPLETION_CHECK_OUTPUT_CHARS)}\\n… (${combined.length - COMPLETION_CHECK_OUTPUT_CHARS} more characters)`
      : combined;
  const detail = result.error
    ? `The check could not run: ${result.error.message}`
    : ok
      ? undefined
      : `Exit code ${status ?? "unknown"}${bounded ? `\\n${bounded}` : ""}`;
  return { ok, command: input.command, ...(detail ? { detail } : {}) };
}

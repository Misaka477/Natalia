import type { ShellExecutor } from "@anthelia/shell";
import { selectExecutor } from "@anthelia/shell";
import { redactToolOutput } from "./redaction";

// The platform's own shell, resolved once per process: bash on POSIX, pwsh on
// Windows. The validation command is the USER's command — a `bun test`, a
// build step — and it must run under the shell the host actually has. This
// used to spawn `/bin/bash` unconditionally, which on Windows is not a path
// that exists: every record_validation failed with ENOENT and the evidence
// it recorded said "validation runner failed" for a command that was never
// attempted.
const executor: ShellExecutor = selectExecutor();

/**
 * The default wall-clock budget for one validation run, in seconds, and the
 * ceiling a model-supplied or config-supplied value is clamped to.
 *
 * A DEFAULT, not a wall: the tool declares the pair so the runtime's deadline
 * guard can clamp a per-call `timeoutSec`, and the deployment moves both from
 * `runtime.tools.validationTimeoutSec` / `validationMaxTimeoutSec`.
 */
export const DEFAULT_VALIDATION_TIMEOUT_SEC = 120;
export const MAX_VALIDATION_TIMEOUT_SEC = 1800;

/**
 * How a validation command ended.
 *
 * ONE vocabulary for "did it pass": `exited` carries the status the command
 * reported (zero or not), and the three others each mean the command never got
 * to answer. `timed_out` exists because collapsing it into `failed` — or worse,
 * into `passed` — is a lie about the evidence: a run that was killed at its
 * budget established nothing.
 */
export type ValidationOutcome =
  | "exited"
  | "timed_out"
  | "aborted"
  | "spawn-failed";

export type ValidationRun = {
  outcome: ValidationOutcome;
  /** The status the command reported; absent unless the outcome is `exited`. */
  exitCode?: number;
  /** Redacted, bounded tails of both streams, with a truncation note. */
  safeSummary: string;
  /** The same text, complete enough to persist as an evidence artifact. */
  artifactText: string;
  /** Everything the command wrote, before the tail bound. */
  totalBytes: number;
};

/**
 * Run one validation command through the shell seam.
 *
 * Through the SEAM, not hand-rolled: the seam terminates the whole process TREE
 * on timeout or abort (measured on this host: a bare kill of the wrapper left
 * the runner alive and the pipes open forever), counts the bytes it discards,
 * and reports an outcome instead of an exit code it cannot vouch for.
 *
 * The hand-rolled version here spawned the shell directly, killed only the
 * wrapper, read both pipes to EOF (so a surviving child held the call open
 * indefinitely), and turned a killed run into `exitCode ?? 0` — a timed-out
 * validation was recorded as PASSED.
 */
export async function runValidationCommand(
  command: string,
  cwd: string,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<ValidationRun> {
  const seconds = Math.max(1, timeoutSec);
  const spec = executor.resolve({
    command,
    workdir: cwd,
    timeoutMs: seconds * 1000,
  });
  const run = await executor.run(spec, {
    command,
    workspaceRoot: cwd,
    ...(signal ? { signal } : {}),
  });
  const totalBytes =
    (run.outputBytes?.stdout.total ?? 0) + (run.outputBytes?.stderr.total ?? 0);
  const served = [run.stdout, run.stderr ? `[stderr]\n${run.stderr}` : ""]
    .filter((part) => part.length > 0)
    .join("\n");
  const redacted = redactToolOutput(served, true);
  const bounded = redacted.slice(0, 20_000);
  const note =
    totalBytes > Buffer.byteLength(bounded, "utf8")
      ? `\n[output truncated; showing ${Buffer.byteLength(bounded, "utf8")} of ${totalBytes} bytes]`
      : "";
  const safeSummary = `${bounded}${note}`.slice(0, 2_000);
  const outcome: ValidationOutcome =
    run.outcome === "timeout"
      ? "timed_out"
      : run.outcome === "aborted"
        ? "aborted"
        : run.outcome === "spawn-failed"
          ? "spawn-failed"
          : "exited";
  return {
    outcome,
    ...(outcome === "exited" && typeof run.exitCode === "number"
      ? { exitCode: run.exitCode }
      : {}),
    safeSummary:
      outcome === "timed_out"
        ? `validation command killed at its ${seconds}s budget${note}`
        : safeSummary,
    artifactText: `${bounded}${note}`,
    totalBytes,
  };
}

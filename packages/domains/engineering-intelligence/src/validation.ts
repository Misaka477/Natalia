import { selectExecutor } from "@anthelia/shell";
import { redactToolOutput } from "./redaction";

// The platform's own shell, resolved once per process: bash on POSIX, pwsh on
// Windows. The validation command is the USER's command — a `bun test`, a
// build step — and it must run under the shell the host actually has. This
// used to spawn `/bin/bash` unconditionally, which on Windows is not a path
// that exists: every record_validation failed with ENOENT and the evidence
// it recorded said "validation runner failed" for a command that was never
// attempted. The executor is the same seam the shell tool uses, so the
// platform choice is made in one place.
const executor = selectExecutor();

export async function runValidationCommand(
  command: string,
  cwd: string,
  timeoutSec: number,
): Promise<{
  exitCode: number;
  safeSummary: string;
  /**
   * EI E2: the redacted output (bounded) so the caller can persist it as an
   * artifact and reference it from the evidence when it exceeds the summary.
   */
  fullOutput: string;
}> {
  const spec = executor.resolve({
    command,
    workdir: cwd,
    timeoutMs: Math.max(1, timeoutSec) * 1000,
  });
  const process = Bun.spawn([spec.command, ...spec.args], {
    cwd: spec.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(
    () => {
      try {
        process.kill();
      } catch {
        // already gone
      }
    },
    Math.max(1, timeoutSec) * 1000,
  );
  const [stdout, stderr] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  await process.exited;
  clearTimeout(timer);
  const exitCode = process.exitCode ?? 0;
  const combined = `${stdout}\n${stderr}`.slice(0, 20_000);
  const redacted = redactToolOutput(combined.trim(), true);
  const safeSummary = redacted.slice(0, 2000);
  return { exitCode, safeSummary, fullOutput: redacted.slice(0, 20_000) };
}

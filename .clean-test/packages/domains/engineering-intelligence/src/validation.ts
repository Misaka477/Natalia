import { redactToolOutput } from "./redaction";

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
  const process = Bun.spawn(["/bin/bash", "-c", command], {
    cwd,
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

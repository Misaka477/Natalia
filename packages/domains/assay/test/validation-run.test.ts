/**
 * A killed validation run must not look like a passing one.
 *
 * Measured defect this pins: the old runner read `process.exitCode ?? 0` after
 * killing the process at its budget, so a timed-out validation reported exit
 * code 0 and `record_validation` recorded it as `passed` — a run that
 * established nothing became evidence that the work was verified.
 *
 * It also pins the seam's involvement: the run goes through `ShellExecutor.run`,
 * which terminates the whole process TREE and reports an outcome, rather than
 * spawning the shell here and killing only the wrapper (measured: the wrapper
 * died, its child kept the pipes open, and the call never returned).
 */
import { describe, expect, test } from "bun:test";
import { runValidationCommand } from "../src/validation";

const slow = process.platform === "win32" ? "Start-Sleep 5" : "sleep 5";
const fail = process.platform === "win32" ? "exit 3" : "exit 3";
const printOk =
  process.platform === "win32"
    ? "[Console]::Out.Write('all good'); exit 0"
    : "echo 'all good'; exit 0";

describe("runValidationCommand", () => {
  test("a passing command exits with zero and keeps its output", async () => {
    const run = await runValidationCommand(printOk, process.cwd(), 30);
    expect(run.outcome).toBe("exited");
    expect(run.exitCode).toBe(0);
    expect(run.safeSummary).toContain("all good");
  }, 60_000);

  test("a failing command is an exit status, not an outcome of its own", async () => {
    const run = await runValidationCommand(fail, process.cwd(), 30);
    expect(run.outcome).toBe("exited");
    expect(run.exitCode).toBe(3);
  }, 60_000);

  test("a run killed at its budget reports timed_out and NO exit code", async () => {
    const run = await runValidationCommand(slow, process.cwd(), 1);
    expect(run.outcome).toBe("timed_out");
    // The absence is the point: a killed process has no status to report, and
    // defaulting it to 0 is what turned a timeout into a pass.
    expect(run.exitCode).toBeUndefined();
    expect(run.safeSummary).toContain("1s budget");
  }, 60_000);
});

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `natalia evolution benchmark` (W13, the C-class survivor): the
 * per-capability benchmark synthesis. The mine/evaluate/optimize/land
 * actions that used to share this file are deleted with A2/A3/A5 — the
 * generation engine's CLI surface. What remains is the one action the
 * new design keeps: synthesizing a benchmark for a capability that has
 * none, gated by its domain filter.
 */

let base = "";

test("evolution benchmark --generate refuses without --generate, and the domain filter is the guard", () => {
  base = mkdtempSync(join(tmpdir(), "evolution-bench-gate-"));
  try {
    const run = (args: string[]) =>
      Bun.spawnSync(
        [
          process.execPath,
          join(import.meta.dir, "..", "src", "main.ts"),
          ...args,
        ],
        { cwd: base, stdout: "pipe", stderr: "pipe" },
      );
    const noGenerate = run(["evolution", "benchmark", "--target", "x"]);
    expect(noGenerate.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(noGenerate.stderr)).toContain("--generate");
    // No daemon: the synthesis runs a real turn, so it says which command
    // starts one instead of failing somewhere confusing.
    const noDaemon = run([
      "evolution",
      "benchmark",
      "--generate",
      "--target",
      "x",
      "--workspace",
      base,
    ]);
    expect(noDaemon.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(noDaemon.stderr)).toContain(
      "natalia daemon",
    );
    // And the engine's actions are gone: the usage names the one survivor.
    const gone = run(["evolution", "optimize", "--target", "x"]);
    expect(new TextDecoder().decode(gone.stderr)).toContain(
      "usage: natalia evolution benchmark",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

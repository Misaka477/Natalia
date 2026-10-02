/**
 * The bash executor: the shell this repository has always had, now behind the
 * seam.
 *
 * This package exists so the POSIX assumptions have ONE home. `shellQuote`'s
 * single-quote rules, `setsid`, `--noprofile --norc`, and the "install Git for
 * Windows" fallback all live here instead of being spread across six call sites
 * that could not name a different shell if they wanted to.
 *
 * It is behaviour-preserving by construction: the argv this produces is the argv
 * `isolatedShellCommand` produced before the seam existed.
 */
import { isolatedShellCommand } from "@anthelia/platform";

import { ShellExecutor } from "./shell";
import type { ShellExecRequest, ShellExecSpec } from "./types";

/** Cap a requested timeout rather than trusting it. */
function clampLocal(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return 120_000;
  return Math.min(Math.floor(timeoutMs), 600_000);
}

export class BashLocalExecutor extends ShellExecutor {
  resolve(request: ShellExecRequest): ShellExecSpec {
    // `--noprofile --norc -c` is the isolated invocation: a managed session must
    // not inherit the user's profile side effects.
    const shell = isolatedShellCommand(request.command);
    return {
      command: shell.executable,
      args: shell.args,
      cwd: request.workdir ?? process.cwd(),
      timeoutMs: clampLocal(request.timeoutMs),
      stdin: request.stdin,
    };
  }
}

export default BashLocalExecutor;

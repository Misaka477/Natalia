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
import {
  isolatedShellCommand,
  profileShellCommand,
  shellQuote,
} from "@anthelia/platform";

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
    // Two spellings, by request rather than by class: the shell tool wants the
    // isolated one (a managed session must not inherit profile side effects),
    // and the skill and terminal callers want the profile-reading one.
    const shell = request.loginShell
      ? profileShellCommand(request.command, {
          os: request.os,
          posixShell: request.shellExecutable,
        })
      : isolatedShellCommand(request.command, { os: request.os });
    return {
      command: shell.executable,
      args: shell.args,
      cwd: request.workdir ?? process.cwd(),
      timeoutMs: clampLocal(request.timeoutMs),
      stdin: request.stdin,
      env: request.env,
    };
  }

  /**
   * `bash -c <command> > <log> 2>&1 & echo $!` — the exact string the two
   * background call sites hand-built at their call sites before the seam. No
   * `setsid` here: the caller that wants it passes the prefix, which is why the
   * process-tools spelling has `detachedShellPrefix()` in front and this one does
   * not.
   */
  override detachedPosixScript(input: {
    command: string;
    outputPath: string;
  }): string {
    return `bash -c ${shellQuote(input.command)} > ${shellQuote(
      input.outputPath,
    )} 2>&1 & echo $!`;
  }
}

export default BashLocalExecutor;

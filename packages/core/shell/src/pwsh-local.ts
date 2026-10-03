/**
 * The PowerShell executor.
 *
 * The command is passed as ONE argv element of `-Command`, with no intermediate
 * shell: PowerShell parses the text itself. That is the property that dissolves
 * the quoting problem — `bash -c` puts the command inside a string domain that
 * must be escaped, and this does not, so there is no second quoting layer here to
 * get wrong. It is also why this executor needs no `shellQuote`-equivalent.
 *
 * NOT VERIFIED BY EXECUTION. No PowerShell exists on the hosts that built this
 * (and none under wine), so the argv, the preambles and the overrides below are
 * asserted as data and NOT run. What that means concretely: the option spellings
 * and the encoding preamble are transcribed from the reference implementation and
 * from PowerShell's documented flags, and a real pwsh host is where they get
 * confirmed. `resolve` is pure construction and is covered by the seam's tests;
 * everything about how pwsh INTERPRETS what it is handed is not.
 */
import { ShellExecutor } from "./shell";
import { clampTimeout } from "./types";
import { resolvePwshPath } from "./pwsh-resolve";
import type { ShellExecRequest, ShellExecSpec } from "./types";

/**
 * Pinned before every command.
 *
 * Windows PowerShell 5.1 — the last-resort executable — writes the console's OEM
 * code page by default, which garbles any non-ASCII output; pwsh 7 defaults to
 * UTF-8 and is unaffected. The statements ride on line 1 separated by `; ` rather
 * than on their own line so PowerShell's error LINE NUMBERS stay accurate, which
 * is the reason this is a prefix and not a preamble block.
 */
export const ENCODING_PREAMBLE =
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ";

/**
 * Model-facing environment overrides.
 *
 * Colours and pagers both corrupt tool output: a pager blocks forever waiting for
 * a keypress nobody is there to press. `TERM=dumb` is deliberately ABSENT — it is
 * a POSIX concept and modern pwsh renderers do not read it; `NO_COLOR` is the one
 * they honour.
 */
export const ENV_OVERRIDES = {
  NO_COLOR: "1",
  PAGER: "cat",
  GIT_PAGER: "cat",
} as const;

export class PwshLocalExecutor extends ShellExecutor {
  resolve(request: ShellExecRequest): ShellExecSpec {
    // The encoding prefix rides the COMMAND, not the environment: it has to run
    // inside the PowerShell process that is about to produce output, and a
    // variable set outside it would not affect the console's own encoding.
    const command = `${ENCODING_PREAMBLE}${request.command}`;
    return {
      command: resolvePwshPath(request.shellExecutable),
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      cwd: request.workdir ?? process.cwd(),
      timeoutMs: clampTimeout(request.timeoutMs),
      stdin: request.stdin,
      // The executor's defaults as the BASE and the caller's values on top, so a
      // value the caller set deliberately still wins per-key. Doing it the other
      // way round makes the caller's environment lose to a default, which is the
      // precedence the seam's other executor never has to think about.
      env: { ...ENV_OVERRIDES, ...request.env },
      // Carried through, not merged here. `ENV_OVERRIDES` above are the executor's
      // own defaults for THIS shell; the managed namespace is harness-owned and is
      // merged by `spawnSpec` after the ambient drop, so it outranks both — a
      // harness fact must not lose to a shell default either.
      shellEnv: request.shellEnv,
    };
  }

  /**
   * Refuses.
   *
   * PowerShell has no `setsid` and no `$!`, so there is no POSIX spelling that
   * detaches and reports a pid the way the bash one does — and a guessed one
   * (Start-Process with a redirected handle) would be a second mechanism that
   * nothing has executed.
   *
   * This is nearly unreachable: `startDetachedProcess` consumes `posixScript`
   * only in its POSIX branch and detaches natively on Windows, so a pwsh
   * background process on its primary platform never asks for it. The refusal
   * names the combination that cannot work instead of failing there.
   */
  override detachedPosixScript(input: {
    command: string;
    outputPath: string;
  }): string {
    // The command is named in the refusal so the failing call site is
    // identifiable in a log; the script is refused for every input alike.
    throw new Error(
      `the PowerShell executor cannot build a POSIX detached launcher script ` +
        `for \`${input.command}\`: PowerShell has no \`setsid\` and no \`$!\`, ` +
        `and Windows detaches natively (startDetachedProcess ignores ` +
        `posixScript there). Run pwsh on Windows for background processes, or ` +
        `point this call at the bash executor.`,
    );
  }
}

export default PwshLocalExecutor;

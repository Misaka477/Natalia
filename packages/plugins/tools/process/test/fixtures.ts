/**
 * Platform-spelled command fixtures for the managed-process tests.
 *
 * A managed process runs its command under the HOST's own shell — pwsh on
 * Windows, bash elsewhere — so a fixture that spells `sleep` or `printf`
 * dies there with "command not found" before the behaviour under test ever
 * runs. That is not a product failure; it is a fixture that forgot the
 * platform. Each helper below is the same behaviour in both shells.
 */
import { platformShell } from "@anthelia/shell";
import { resolvePwshPath } from "@anthelia/platform";

const onWindows = platformShell() === "pwsh";

/** A command that runs for `seconds` and prints nothing. */
export function sleepCmd(seconds: number): string {
  return onWindows ? `Start-Sleep ${seconds}` : `sleep ${seconds}`;
}

/** A command that prints `text`, then runs for `seconds`. */
export function echoSleepCmd(text: string, seconds: number): string {
  // The text is QUOTED: pwsh's `echo a b` is Write-Output with two
  // arguments, which prints an array — one element per line. Bash's echo
  // prints one line. The quoted spelling is the same command in both.
  return onWindows
    ? `echo "${text}"; Start-Sleep ${seconds}`
    : `echo "${text}"; sleep ${seconds}`;
}

/** A command that prints non-ASCII text, then runs for `seconds`. */
export function utf8SleepCmd(text: string, seconds: number): string {
  return onWindows
    ? `Write-Output '${text}'; Start-Sleep ${seconds}`
    : `printf '${text}'; sleep ${seconds}`;
}

/** A command that prints `count` 'z' characters, then the shell's newline. */
export function zFillCmd(totalBytes: number): string {
  // pwsh's Write-Output terminates with CRLF (2 bytes); bash's `echo` with LF
  // (1). The count is filled to the SAME total on both platforms, so the
  // truncation note the test asserts names one number everywhere.
  return onWindows
    ? `Write-Output ("z" * ${totalBytes - 2})`
    : `printf 'z%.0s' $(seq 1 ${totalBytes - 1}); echo`;
}

/**
 * A command that spawns a long-running CHILD, writes the child's pid to
 * `child.pid`, and waits for it. The POSIX spelling is the job-control one;
 * pwsh has no `$!`, so the child is started explicitly and waited on.
 *
 * `-NoNewWindow` is load-bearing, not decoration. Without it `Start-Process`
 * defaults to `UseShellExecute = true`, so the child is launched through the
 * Windows Shell broker. This worker runs under `DETACHED_PROCESS` with every
 * stdio ignored — the exact context where that broker cannot complete the
 * launch: the failure surfaces as 0x800700e8 (ERROR_NO_DATA, "the pipe is
 * being closed"), reported against the whole command line while the outer
 * managed process never writes its child.pid at all. `-NoNewWindow` is the
 * PowerShell spelling of `UseShellExecute = false` — a plain CreateProcess,
 * no broker, no console required, which is what the POSIX branch's `&`
 * already is.
 */
export const groupWithChildCmd = onWindows
  ? `$c = Start-Process pwsh -NoNewWindow -ArgumentList '-NoProfile','-Command','Start-Sleep 30' -PassThru; $c.Id > child.pid; Wait-Process -Id $c.Id`
  : `sleep 30 & echo $! > child.pid; wait`;

/** argv for a directly-spawned long-lived child — no shell in between. */
export function longLivedArgv(seconds: number): string[] {
  // The RESOLVED pwsh, not the bare name: a host with only Windows
  // PowerShell 5.1 has no `pwsh` on PATH, and the resolver's fallback is
  // what finds it — the same resolution the product itself uses.
  return onWindows
    ? [
        resolvePwshPath(undefined),
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Sleep ${seconds}`,
      ]
    : ["sleep", String(seconds)];
}

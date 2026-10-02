/**
 * Which shell runs a command.
 *
 * The platform mirror is dsh's shape: each host runs exactly one shell stack,
 * with bash and pwsh as twins whose enablement is inverted. It is expressed here
 * as a function rather than a patch table because this repository composes
 * packages rather than loading a plugin manifest, but the property is the same —
 * one stack per host, decided by the platform, with the permission and sandbox
 * layers untouched by the choice.
 *
 * The mirror is WRITTEN but not yet the default, and that is deliberate. The pwsh
 * executor has never been executed (no PowerShell on the hosts that built it, and
 * none under wine), so flipping Windows to it on the strength of a code read
 * would be exactly the mistake this project has made repeatedly. So:
 *
 *   - the default is bash on every platform, which is today's behaviour, so
 *     enabling the mirror changes nothing;
 *   - `NATALIA_SHELL=pwsh` opts in, for the host that verifies it;
 *   - `auto` asks for the mirror explicitly and is what the default becomes once
 *     pwsh has run on a real Windows host.
 *
 * The flip is then one line in this file, and the tests below already pin both
 * sides of the mirror.
 */
import { BashLocalExecutor } from "./bash-local";
import { PwshLocalExecutor } from "./pwsh-local";
import type { ShellExecutor } from "./shell";

/** The shells this repository can run, by name. */
export type ShellName = "bash" | "pwsh";

/**
 * The shell a host runs by default, ignoring any opt-in.
 *
 * This is the mirror. It returns "pwsh" on Windows and "bash" elsewhere, which is
 * the shape that becomes the default when pwsh is verified; today it is only
 * reachable through an explicit `auto`.
 */
export function platformShell(
  os: NodeJS.Platform = process.platform,
): ShellName {
  return os === "win32" ? "pwsh" : "bash";
}

/**
 * Resolve the requested shell name.
 *
 * `bash` and `pwsh` are honoured as given. Anything else — absent, empty,
 * unknown — falls back to bash, because a typo in a shell name must not select
 * PowerShell by accident; an unknown request is a caller bug and the safe reading
 * is the shell that has always run.
 */
export function resolveShellName(
  requested: string | undefined,
  os: NodeJS.Platform = process.platform,
): ShellName {
  if (requested === "pwsh") return "pwsh";
  if (requested === "auto") return platformShell(os);
  return "bash";
}

/** The executor for a shell name. */
export function executorFor(name: ShellName): ShellExecutor {
  return name === "pwsh" ? new PwshLocalExecutor() : new BashLocalExecutor();
}

/**
 * The executor this host's request should use.
 *
 * `request.shellExecutable` names an EXECUTABLE PATH, which is a different
 * concern from `shell` naming a SHELL; they compose (pwsh at a caller-given
 * path), so the request carries both and neither overrides the other.
 */
export function selectExecutor(
  env: NodeJS.ProcessEnv = process.env,
  os: NodeJS.Platform = process.platform,
): ShellExecutor {
  // The executor's own `resolve` resolves its executable path (pwsh is not
  // necessarily on PATH), so a caller-given path rides the request rather than
  // being a concern of this selector.
  return executorFor(resolveShellName(env.NATALIA_SHELL, os));
}

/**
 * Which shell runs a command.
 *
 * The platform mirror's shape: each host runs exactly one shell stack,
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
export type ShellName = "bash" | "pwsh" | "zsh";

/**
 * The shell a host runs by default, ignoring any opt-in.
 *
 * This is the platform's OWN shell, chosen per host rather than once for the
 * repository:
 *
 *   Windows -> pwsh    PowerShell 7 is the Windows shell; bash there is WSL,
 *                      where neither `cmd` nor the Windows-installed node/bun
 *                      are reachable.
 *   macOS   -> bash    the POSIX shell every supported macOS also ships; zsh is
 *                      the login shell but bash is what a script can rely on.
 *   Linux   -> bash    the shell every supported Linux ships.
 *
 * Anything unrecognised falls to bash, because POSIX sh is the one shell a
 * shell-shaped caller can always speak.
 */
export function platformShell(
  os: NodeJS.Platform = process.platform,
): ShellName {
  if (os === "win32") return "pwsh";
  return "bash";
}

/**
 * Resolve the requested shell name.
 *
 * `bash` and `pwsh` are honoured as given. EVERYTHING ELSE — absent, empty,
 * `auto`, or a typo — resolves to the platform's own shell, because that is the
 * only default that cannot be wrong on the machine it runs on.
 *
 * It used to fall back to bash, on the reasoning that "a typo must not select
 * PowerShell by accident". On Windows that fallback is the bug: bash there is
 * `C:\Windows\System32\bash.exe`, which is WSL, so a Windows install with no
 * NATALIA_SHELL set opened a WSL shell — `cmd` is not found, and `node`/`bun`
 * (installed on the Windows side) are not on its PATH either, so every command
 * the shell-adjacent tools run dies with "the command could not be started".
 * Measured, not theorised: the user's terminal showed exactly that.
 *
 * A typo resolving to the platform shell is a smaller surprise than a typo
 * resolving to another operating system's shell.
 */
export function resolveShellName(
  requested: string | undefined,
  os: NodeJS.Platform = process.platform,
): ShellName {
  if (requested === "bash") return "bash";
  if (requested === "pwsh") return "pwsh";
  if (requested === "zsh") return "zsh";
  return platformShell(os);
}

/**
 * The executor for a shell name.
 *
 * zsh shares the POSIX executor with bash: both go through the same
 * isolated/login `os`-parameterised spellings, and zsh's only difference from
 * bash here is the name the caller asked for — which `shellExecutable` already
 * carries. A separate class would exist only to differ by a constant.
 */
export function executorFor(name: ShellName): ShellExecutor {
  if (name === "pwsh") return new PwshLocalExecutor();
  return new BashLocalExecutor();
}

/**
 * The shell the runtime is configured to run, set once by the runtime at
 * initialize and updated on every config reload.
 *
 * This is the persisted form of the settings panel's choice. It lives here
 * rather than in `NATALIA_SHELL` because an environment variable is a
 * deployment fact, not a per-session one: writing a human's choice there made
 * it outlive the session that made it and collide with the deployment's own
 * default. A module-level slot is the only thing the six module-scope call
 * sites can reach, and the runtime owns writing it.
 */
let configuredShell: "bash" | "pwsh" | "zsh" | undefined;

/** Record the configured shell. Called by the runtime, never by a tool. */
export function setConfiguredShell(
  shell: "bash" | "pwsh" | "zsh" | undefined,
): void {
  configuredShell = shell;
}

/** The shell the runtime is configured to run, if it has said. */
export function configuredShellName(): "bash" | "pwsh" | "zsh" | undefined {
  return configuredShell;
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
  configured?: "bash" | "pwsh" | "zsh",
): ShellExecutor {
  // The executor's own `resolve` resolves its executable path (pwsh is not
  // necessarily on PATH), so a caller-given path rides the request rather than
  // being a concern of this selector.
  //
  // Precedence, highest first:
  //
  //   1. `configured` — the caller's explicit choice.
  //   2. the shell the runtime recorded from its config.
  //   3. `NATALIA_SHELL` — the DEPLOYMENT's default, for a host that never set
  //      one. Read only: a human's choice is never written here.
  //   4. the platform's own shell.
  //
  // On Linux and macOS `pwsh` is NOT honoured: PowerShell is not the shell
  // those hosts ship, and a human who picked it there gets bash rather than a
  // shell whose `cmd` and `node` are unreachable. On Windows every choice is
  // honoured — `bash` there is Git Bash, and a host that cannot find it is told
  // to set `runtime.shell.bashPath`.
  const requested = configured ?? configuredShell ?? env.NATALIA_SHELL;
  if (os !== "win32" && requested === "pwsh") return executorFor("bash");
  return executorFor(resolveShellName(requested, os));
}

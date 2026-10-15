/**
 * The shell this host actually has, per operating system.
 *
 * Every call site that used to say "bash" is a Windows-host bug in disguise:
 * Git for Windows is not guaranteed, and its bash is deliberately not on
 * PATH by default — so the product's own Windows pane used to depend on an
 * optional install. The platform this ships on answers a different question:
 * what shell is ALWAYS there. Windows has PowerShell on every machine
 * (`powershell.exe` ships with the OS, PowerShell 7 with most dev setups);
 * Linux has bash; macOS has bash and ships zsh as the user shell. This
 * module asks in that order and returns what it finds.
 *
 * The order is the one the reference implementation settles on
 * (`packages/shell/pwsh-local/src/resolve.ts`): an explicit configured path
 * first, then the well-known install roots, then the PATH. Nothing here
 * spawns anything — a resolver that shells out to ask "which shell do you
 * have" is a startup cost paid by every host command and a failure mode with
 * no answer.
 */
import { isAbsolute } from "node:path";
import type { NataliaHomeInput } from "./home-paths";
import { resolvePwshPath } from "./pwsh";

/** The shells a pane can be started with, by the name the UI lists. */
export type ShellName = "pwsh" | "powershell" | "bash" | "zsh";

export type DiscoveredShell = {
  /** The name the rest of the product already spells this shell with. */
  name: ShellName;
  /** An absolute path when one was found, undefined when only the name is known. */
  path?: string;
};

export type ShellDiscoveryInput = NataliaHomeInput & {
  /** Whether a candidate exists. Injectable so every branch tests. */
  exists?: (path: string) => boolean;
};

/**
 * The shell a pane starts with when the caller names none.
 *
 * Windows: PowerShell 7, then the OS's own Windows PowerShell 5.1, then a
 * `pwsh` on the PATH, then — last, and only because it is still better than
 * nothing — a bash. Linux: bash. macOS: zsh (the user shell since Catalina),
 * then bash. Undefined only when the host has none of them, which is a
 * machine the caller has to name a shell on itself.
 */
export function discoverDefaultShell(
  input: ShellDiscoveryInput = {},
): DiscoveredShell | undefined {
  const platform = input.os ?? process.platform;
  if (platform === "win32") {
    // PowerShell is on every Windows machine: PowerShell 7 where it is
    // installed, the OS's own Windows PowerShell 5.1 otherwise — the finder's
    // candidate list ends there, so this answer is never empty. The bare
    // fallback means the PATH has to place it, which CreateProcess does.
    const resolved = resolvePwshPath(
      undefined,
      input.env ?? process.env,
      "win32",
    );
    return { name: "pwsh", path: isAbsolute(resolved) ? resolved : undefined };
  }
  const exists = input.exists ?? (() => false);
  if (platform === "darwin") {
    for (const candidate of ["/bin/zsh", "/usr/bin/zsh"]) {
      if (exists(candidate)) return { name: "zsh", path: candidate };
    }
    for (const candidate of ["/bin/bash", "/usr/bin/bash"]) {
      if (exists(candidate)) return { name: "bash", path: candidate };
    }
    return undefined;
  }
  for (const candidate of ["/bin/bash", "/usr/bin/bash"]) {
    if (exists(candidate)) return { name: "bash", path: candidate };
  }
  return undefined;
}

/**
 * The command text a pane is started with when the caller names none.
 *
 * A name, not a path, when the shell is the platform's own: the argv builder
 * already resolves names through the platform's finders, and a hardcoded
 * absolute path is one more place a misconfigured host can break.
 */
export function defaultPaneCommand(
  input: ShellDiscoveryInput = {},
): string | undefined {
  return discoverDefaultShell(input)?.name;
}

/**
 * How one script is handed to a discovered shell.
 *
 * PowerShell's flags are the reference implementation's own spelling
 * (`pwsh -NoLogo -NoProfile -NonInteractive -Command <script>`): no banner
 * text in the output, no user profile's side effects, and non-interactive so
 * a script that reads stdin cannot hang a batch. A POSIX shell has the same
 * job done by `-lc` — login so PATH and profile are honoured, command so the
 * script is one argument and never word-split.
 */
export function shellInvocation(
  script: string,
  input: ShellDiscoveryInput & { shell?: DiscoveredShell } = {},
): { executable: string; args: string[] } {
  const shell = input.shell ?? discoverDefaultShell(input);
  if (!shell)
    throw new Error(
      "no usable shell was discovered on this host: pass the shell to run explicitly",
    );
  if (shell.name === "pwsh" || shell.name === "powershell")
    return {
      executable: shell.path ?? shell.name,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    };
  return { executable: shell.path ?? shell.name, args: ["-lc", script] };
}

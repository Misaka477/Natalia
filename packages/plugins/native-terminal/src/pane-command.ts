// pane-command.ts — the argv a pane starts with, integration attached.
//
// Extracted verbatim from the deleted native-terminal.ts when the WezTerm fork
// chain went away: the pane-command builder is a pty-controller contract, not
// a fork-host one. The shell spelling still belongs to @anthelia/shell's
// executor seam (`selectExecutor().resolve`), exactly as it did in place.
import { selectExecutor } from "@anthelia/shell";
import {
  interactiveShellArgv,
  shellEnvFor,
  withShellIntegration,
} from "./shell-integration-argv";

// The shell that owns the pane command's spelling. Stateless, so one per module.
const shell = selectExecutor();

export function nativeTerminalPaneCommand(
  command: string,
  os?: NodeJS.Platform,
): string[] {
  // The argv is unchanged — it is the public contract its callers and tests pin —
  // but the spelling now belongs to the shell rather than being built here.
  // `/bin/sh`, not bash: the pane command is derived for the workspace's own
  // shell, and the seam carries that through its `shellExecutable` valve.
  //
  // A pane whose command IS a shell is an interactive shell, and gets that shell
  // directly — not `/bin/sh -lc <shell>`. The `-lc` wrapper was the old contract
  // for every command, and it means a bash pane would be dash running bash,
  // carrying no integration and so no command-level read. Detecting the shell
  // here keeps the wrapper for real commands and drops it for a real shell.
  const integrated = interactiveShellArgv(command, os);
  if (integrated) return integrated;
  const spec = shell.resolve({
    command,
    loginShell: true,
    os,
    shellExecutable: "/bin/sh",
  });
  return withShellIntegration([spec.command, ...spec.args]).argv;
}

/**
 * The pane's spawn spec: argv AND the environment its shell needs.
 *
 * Separate from `nativeTerminalPaneCommand` because that one is a pinned
 * contract — callers and tests assert on its argv — and a zsh pane's
 * integration is not expressible as argv. It arrives as ZDOTDIR, which is
 * environment, so a pane that wants the command-level read needs both halves
 * or it gets neither.
 */
export function nativeTerminalPaneSpawn(
  command: string,
  os?: NodeJS.Platform,
): { argv: string[]; env: Record<string, string> } {
  // The pane argv ALREADY went through the integrator inside
  // `nativeTerminalPaneCommand`, so wrapping it here again would double the
  // `--rcfile` — which is what the first version did, and the argv shows it:
  // `bash --rcfile X --rcfile X`. What this adds is only the environment half,
  // which the argv path cannot carry.
  return {
    argv: nativeTerminalPaneCommand(command, os),
    env: shellEnvFor(command, os),
  };
}

/**
 * The session's shell, switchable by the human mid-session, and TOLD to the
 * model.
 *
 * The shell is a per-session choice for the same reason the sandbox rung is:
 * a model that just moved from bash to pwsh and does not know it keeps writing
 * POSIX syntax into a PowerShell pane, and every command it runs dies on the
 * first `&&`. The notice rides the durable, latest-win `context.instructions`
 * channel a rung switch uses — NOT the system prompt, whose prefix is cached:
 * a per-session fact injected there would change the prefix on every switch
 * and throw the cache away.
 *
 * The switch is SESSION-scoped rather than a config write, for the same three
 * measured reasons a rung is: a workspace's own `.natalia/config.json` outranks
 * the global file, so a global write was a silent no-op wherever the workspace
 * pinned one; a config write is a whole-runtime reload the user sees as a
 * notice without anything moving; and a shell is a decision about THIS
 * conversation, not about every future one.
 *
 * The choice is recorded through `setConfiguredShell`, which is what the
 * executor seam reads — six call sites ask for the executor at module scope
 * where no session state is reachable, and they resolve per call, so the next
 * command uses the new shell without a restart. It is NOT written to
 * `NATALIA_SHELL`: that variable is the deployment's default, and a human's
 * choice written there outlived the session that made it.
 */

import { nextContextInstructionsRevision } from "@anthelia/session";
import { setConfiguredShell } from "@anthelia/shell";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";
import type { SessionID } from "@anthelia/contracts";

/**
 * The shells a session can run.
 *
 * Spelled here rather than imported from `@anthelia/shell` because the client
 * package does not depend on it, and a type-only edge for three string
 * literals is not worth the dependency. The values are the same set
 * `resolveShellName` honours.
 */
export type ShellName = "bash" | "pwsh" | "zsh";

/** What a shell means to a model writing commands into it. */
function shellMeaning(name: ShellName): string {
  switch (name) {
    case "bash":
      return "POSIX syntax: `&&`, `;`, `$VAR`, `/` separators, single quotes";
    case "pwsh":
      return "PowerShell syntax: `;` not `&&`, `$env:VAR`, `\\` separators, cmdlets not coreutils";
    case "zsh":
      return "POSIX syntax like bash: `&&`, `;`, `$VAR`, `/` separators";
    default:
      return "the host platform's own shell";
  }
}

/**
 * Move the session's shell and tell the model.
 *
 * @returns the switch that happened, or undefined when nothing changed (the
 *   session already ran that shell, or the session is not live) — a switch to
 *   the shell you are already on is not news.
 */
export function applySessionShell(
  ctx: RuntimeContext,
  sessionID: SessionID,
  to: ShellName,
): { from?: ShellName; to: ShellName } | undefined {
  const exec = ctx.ports.getExecutionBySession().get(sessionID);
  if (!exec) return undefined;
  const from = exec.shellOverride;
  if (from === to) return undefined;
  exec.shellOverride = to;
  // The runtime-wide record the executor seam reads. Six call sites ask for the
  // executor at module scope, where no session state is reachable, so this slot
  // is the one input they all share — and they resolve per call, which is what
  // makes this take effect on the next command rather than the next start.
  setConfiguredShell(to);
  publishShellSwitchNotice(ctx, exec, { from, to });
  return { from, to };
}

/**
 * Move the session's shell back to the platform default.
 *
 * The mirror of `applySessionShell` for 自动: the session's own choice is
 * cleared and the record removed, so the executor falls back to
 * `platformShell` rather than to whatever the human last picked.
 */
export function clearSessionShell(
  ctx: RuntimeContext,
  sessionID: SessionID,
): { from?: ShellName } | undefined {
  const exec = ctx.ports.getExecutionBySession().get(sessionID);
  if (!exec) return undefined;
  const from = exec.shellOverride;
  if (from === undefined) return undefined;
  exec.shellOverride = undefined;
  setConfiguredShell(undefined);
  publishShellSwitchNotice(ctx, exec, { from, to: platformDefault() });
  return { from };
}

/** The platform's own shell, spelled here to avoid a dependency edge. */
function platformDefault(): ShellName {
  return process.platform === "win32" ? "pwsh" : "bash";
}

/**
 * The notice: a `context.instructions` record of kind `shell_switch`, the same
 * durable latest-win channel a rung switch rides. The summary names the shell
 * and what its syntax means, so the model reads "commands now run in
 * PowerShell; `&&` is not available" rather than a mode string.
 */
export function publishShellSwitchNotice(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
  input: { from?: ShellName; to: ShellName },
): void {
  const revision = nextContextInstructionsRevision(exec.session.events);
  ctx.ports.publishForSession(exec, {
    type: "context.instructions",
    id: `context:shell-switch:${Date.now().toString(36)}:${revision}`,
    kind: "shell_switch",
    at: new Date().toISOString(),
    revision,
    summary:
      `the human moved this session's shell to ${input.to}` +
      (input.from ? ` (was ${input.from})` : ""),
    detail: [
      `shell ${input.to}: ${shellMeaning(input.to)}`,
      ...(input.from
        ? [`previously ${input.from}: ${shellMeaning(input.from)}`]
        : []),
      "every command you run, and every terminal pane this session opens, now uses this shell",
      "the change is scoped to this session; a new session starts at the deployment's shell",
    ],
  });
}

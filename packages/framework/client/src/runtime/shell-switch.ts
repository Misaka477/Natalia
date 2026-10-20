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
 * The choice is projected onto `NATALIA_SHELL` as well, because the executor
 * seam reads the environment and six call sites ask for the executor at module
 * scope where no session state is reachable. The projection is what makes the
 * switch HOT: those sites resolve per call, so the next command they run uses
 * the new shell without a restart.
 */

import { nextContextInstructionsRevision } from "@anthelia/session";
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
  // The projection the executor seam reads. Six call sites ask for the executor
  // at module scope, where no session state is reachable, so the environment is
  // the one input they all share — and they resolve per call, which is what
  // makes this take effect on the next command rather than the next start.
  process.env.NATALIA_SHELL = to;
  publishShellSwitchNotice(ctx, exec, { from, to });
  return { from, to };
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

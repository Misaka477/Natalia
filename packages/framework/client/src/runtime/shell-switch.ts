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
 * command uses the new shell without a restart. Nothing is projected onto the
 * environment: `NATALIA_SHELL` was, once, and was deleted — a human's choice
 * written there outlived the session that made it and nothing read it.
 */

import { nextContextInstructionsRevision } from "@anthelia/session";
import {
  platformShell,
  setConfiguredShell,
  shellSyntaxMeaning,
} from "@anthelia/shell";
import {
  terminalController,
  type TerminalController,
} from "@anthelia/runtime-services";
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
// The wording lives in `@anthelia/shell` (shellSyntaxMeaning): the switch
// notice and the per-turn environment block must name the same shell the
// same way, and two copies of three sentences drift.
function shellMeaning(name: ShellName): string {
  return shellSyntaxMeaning(name);
}

/**
 * Move the session's shell and tell the model.
 *
 * @returns the switch that happened, or undefined when nothing changed (the
 *   session already ran that shell, or the session is not live). A switch to
 *   the shell you are already on is not news for the RECORD, but it is still a
 *   request to refresh: the panes are killed either way (see below), because a
 *   human re-picking the shell they are on means "make sure my panes run it" —
 *   measured: re-picking bash with a bash pane left the pane untouched and the
 *   reader concluded the switch had not happened.
 */
export function applySessionShell(
  ctx: RuntimeContext,
  sessionID: SessionID,
  to: ShellName,
): { from?: ShellName; to: ShellName } | undefined {
  const exec = ctx.ports.getExecutionBySession().get(sessionID);
  if (!exec) return undefined;
  const from = exec.shellOverride;
  // The panes go either way — BEFORE the no-op return, which is where they used
  // to be skipped: a re-pick of the current shell left the old pane running and
  // the user had to delete it by hand. The next pane (the terminal tab mints
  // one when a cell exits) starts the shell the slot now holds.
  void killSessionPanes(ctx, sessionID);
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
 * Stop the session's interactive panes after a shell switch.
 *
 * A pane already running the OLD shell must not outlive the choice: the human
 * switched to pwsh, the setting says pwsh, and the pane prompt still says
 * `PS`… or rather still says `$` — measured as exactly that on this host, and
 * the reader concludes the switch did not happen. The next pane starts the new
 * shell, so killing the old ones is the whole remedy.
 *
 * Best effort: a pane that is already gone is not a reason to refuse the
 * switch, so a stop failure is dropped rather than reported.
 */
async function killSessionPanes(
  ctx: RuntimeContext,
  sessionID: SessionID,
): Promise<void> {
  const terminal = ctx.state.serviceDirectory.getOptional(terminalController);
  if (!terminal) return;
  let panes: Awaited<ReturnType<TerminalController["list"]>>;
  try {
    panes = await terminal.list(sessionID);
  } catch {
    return;
  }
  for (const pane of panes)
    await terminal.stop(pane.id, "system", sessionID).catch(() => undefined);
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
  void killSessionPanes(ctx, sessionID);
  return { from };
}

/** The platform's own shell, spelled here to avoid a dependency edge. */
function platformDefault(): ShellName {
  return platformShell(process.platform);
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

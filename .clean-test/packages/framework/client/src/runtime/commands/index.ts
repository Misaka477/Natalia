/**
 * Slash commands and command catalog — runtime/commands module.
 *
 * `handleCommand` is a thin router over the read-only slash handlers
 * (`slash-read.ts`) and the state-changing slash handlers (`slash-action.ts`).
 * `commandCatalogEntries` is the plugin-command catalog read surface. Reads
 * everything it needs from `RuntimeContext` at call time.
 */
import { projectInteractiveRequests } from "@anthelia/session";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type { PluginCommand } from "@anthelia/plugin";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";
import { tryActionSlashCommand } from "./slash-action";

export { EGRESS_ADVISORY } from "../../egress-advisory";

/** The dependencies every slash handler resolves from the runtime context. */
export type SlashDeps = {
  id: string;
  text: string;
  signal: AbortSignal | undefined;
  commandExec: SessionExecutionState;
  publish: (event: RuntimeEvent) => void;
  agentRegistry: ReturnType<RuntimeContext["ports"]["getAgentRegistry"]>;
  applyAgentPolicy: () => void;
  applyAgentProvider: (exec: SessionExecutionState) => void;
  getActiveExec: () => SessionExecutionState | undefined;
  setPaused: (paused: boolean) => void;
};

export function createCommands(ctx: RuntimeContext) {
  return {
    isPendingInteractiveRequest,
    handleCommand,
    commandCatalogEntries,
  };

  function isPendingInteractiveRequest(
    forSessionID: SessionID,
    id: string,
    kind: string,
  ) {
    const { getExecutionBySession } = ctx.ports;
    // D2: the request lives in the session whose turn issued it. A response
    // arriving while the UI is attached to another session must be judged
    // against that session's journal, never the attached one's.
    const target = getExecutionBySession().get(forSessionID)?.session;
    const pending = projectInteractiveRequests(target?.events ?? []);
    if (kind === "approval")
      return pending.approvals.some((request) => request.id === id);
    if (kind === "question")
      return pending.questions.some((request) => request.id === id);
    return pending.interactives.some(
      (request) => request.id === id && request.kind === kind,
    );
  }

  function commandCatalogEntries(): PluginCommand[] {
    const { getCapabilityRegistry } = ctx.ports;
    return getCapabilityRegistry()
      .contributions<PluginCommand>("commands")
      .map((entry) => entry.payload);
  }

  async function handleCommand(
    id: string,
    text: string,
    signal: AbortSignal | undefined,
    commandExec: SessionExecutionState = ctx.ports.getActiveExec()!,
  ) {
    if (!text.trim().startsWith("/")) return false;
    const trimmed = text.trim();
    const [commandName, ...args] = trimmed.slice(1).split(/\s+/u);
    const pluginCommand = commandCatalogEntries().find(
      (command) => command.name === commandName,
    );
    if (pluginCommand) {
      const output = await pluginCommand.run({
        raw: trimmed,
        args,
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        sessionID: commandExec.session.id,
        signal,
      });
      if (typeof output === "string")
        ctx.ports.publishForSession(commandExec, {
          type: "content.delta",
          id,
          text: output,
        });
      ctx.ports.publishForSession(commandExec, { type: "content.done", id });
      ctx.ports.publishForSession(commandExec, {
        type: "turn.finished",
        id,
        stopReason: "done",
      });
      return true;
    }
    const {
      getAgentRegistry,
      setPaused,
      publishForSession,
      applyAgentPolicy,
      applyAgentProvider,
      getActiveExec,
    } = ctx.ports;
    // Commands run inside a session's drain. Bind their output to that session
    // even when the UI is attached elsewhere.
    const deps: SlashDeps = {
      id,
      text,
      signal,
      commandExec,
      publish: (event) => publishForSession(commandExec, event),
      agentRegistry: getAgentRegistry(),
      applyAgentPolicy,
      applyAgentProvider,
      getActiveExec,
      setPaused,
    };
    return await tryActionSlashCommand(deps);
  }
}

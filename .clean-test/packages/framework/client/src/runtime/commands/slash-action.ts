/**
 * State-changing slash command handlers — runtime/slash-action.ts.
 *
 * These answer the `/…` commands that mutate session or runtime state
 * (selection, pause/resume, skills). They receive a `SlashDeps` bundle from the
 * commands router and return true when they handled the input.
 */
import type { SlashDeps } from "./index";

export async function tryActionSlashCommand(deps: SlashDeps): Promise<boolean> {
  const trimmed = deps.text.trim();
  const commandExec = deps.commandExec;
  if (trimmed === "/agents") {
    const agents = deps.agentRegistry?.selectable() ?? [];
    deps.publish({
      type: "content.delta",
      id: deps.id,
      text: agents.length
        ? agents
            .map((agent) => `${agent.name}: ${agent.description}`)
            .join("\n")
        : "no selectable agents configured",
    });
    deps.publish({ type: "content.done", id: deps.id });
    deps.publish({ type: "turn.finished", id: deps.id, stopReason: "done" });
    return true;
  }
  if (trimmed.startsWith("/agent ")) {
    const name = trimmed.slice("/agent ".length).trim();
    if (!name) throw new Error("agent name is required");
    const agent = deps.agentRegistry?.select(name);
    if (!agent) throw new Error(`agent not found: ${name}`);
    commandExec.selectedAgent = agent;
    if (commandExec === deps.getActiveExec()) {
      deps.applyAgentPolicy();
    }
    deps.applyAgentProvider(commandExec);
    deps.publish({ type: "agent.selection", name: agent.name, pending: false });
    deps.publish({
      type: "content.delta",
      id: deps.id,
      text: `selected agent ${agent.name}`,
    });
    deps.publish({ type: "content.done", id: deps.id });
    deps.publish({ type: "turn.finished", id: deps.id, stopReason: "done" });
    return true;
  }
  if (trimmed === "/pause") {
    commandExec.paused = true;
    if (commandExec === deps.getActiveExec()) deps.setPaused(true);
    deps.publish({ type: "turn.paused", id: deps.id, reason: "slash command" });
    deps.publish({
      type: "content.delta",
      id: deps.id,
      text: "runtime paused",
    });
    deps.publish({ type: "content.done", id: deps.id });
    deps.publish({ type: "turn.finished", id: deps.id, stopReason: "done" });
    return true;
  }
  if (trimmed === "/resume") {
    commandExec.paused = false;
    if (commandExec === deps.getActiveExec()) deps.setPaused(false);
    const waiters = commandExec.pauseWaiters;
    commandExec.pauseWaiters = [];
    for (const resolveWaiter of waiters) resolveWaiter();
    deps.publish({ type: "turn.resumed", id: deps.id });
    deps.publish({
      type: "content.delta",
      id: deps.id,
      text: "runtime resumed",
    });
    deps.publish({ type: "content.done", id: deps.id });
    deps.publish({ type: "turn.finished", id: deps.id, stopReason: "done" });
    return true;
  }
  return false;
}

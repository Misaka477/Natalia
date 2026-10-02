/**
 * Rendering and resolving the configured agent types that `agent_spawn` offers.
 *
 * The configured agents are the subagent types: each carries its own tool
 * restrictions and system prompt. Advertising them without saying what tools
 * each one has leaves the model guessing — it cannot tell a read-only explorer
 * from a full implementer, which is the one distinction the choice turns on.
 */

/** The slice of a configured agent this module reads. */
export interface SubagentTypeView {
  name: string;
  description: string;
  mode?: string;
  allowedTools?: readonly string[];
  excludedTools?: readonly string[];
}

/**
 * The tool access an agent type grants, as a single line.
 *
 * An explicit allow-list is reported as itself. Otherwise the type is "all
 * available" narrowed by its exclusions, which is the shape most agents use and
 * reads better than a list of every tool name. No count: the count would make
 * the description depend on the order tools are registered in, and that order is
 * part of the request prefix.
 */
export function describeToolAccess(agent: SubagentTypeView): string {
  const allowed = agent.allowedTools ?? [];
  if (allowed.length > 0) return `tools: ${allowed.join(", ")}`;
  const excluded = agent.excludedTools ?? [];
  if (excluded.length === 0) return "tools: all available";
  return `tools: all except ${excluded.join(", ")}`;
}

/**
 * Render the spawnable agent types for a tool description.
 *
 * Empty when nothing is configured: a section listing nothing is worse than no
 * section, because it reads as "there are types and they are not documented".
 */
export function renderSubagentTypes(
  agents: readonly SubagentTypeView[],
): string {
  const spawnable = agents.filter(
    (agent) => (agent.mode ?? "primary") === "subagent" && agent.description,
  );
  if (spawnable.length === 0) return "";
  const lines = spawnable.map(
    (agent) =>
      `- ${agent.name}: ${agent.description} (${describeToolAccess(agent)})`,
  );
  return [
    "",
    "Pass one of these as `type` to spawn a configured agent type; omit `type` " +
      "to spawn a general subagent with every tool.",
    ...lines,
  ].join("\n");
}

/**
 * Resolve a requested type name against the configured agents.
 *
 * Throws on an unknown name rather than silently falling back to a general
 * subagent: a caller that asked for a read-only explorer and got a full
 * implementer has not been served, and nothing downstream would say so.
 */
export function resolveSubagentType(
  name: string,
  agents: readonly SubagentTypeView[],
): SubagentTypeView {
  const match = agents.find((agent) => agent.name === name);
  if (!match)
    throw new Error(
      `unknown subagent type "${name}"; configured types: ` +
        (agents.length ? agents.map((agent) => agent.name).join(", ") : "none"),
    );
  return match;
}

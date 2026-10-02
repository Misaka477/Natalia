import type { AgentConfig, ConfigV3 } from "@anthelia/contracts";

export type AgentDefinition = AgentConfig & {
  name: string;
};

export type AgentInput = Partial<AgentConfig> & {
  name: string;
};

export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();
  private defaultName?: string;

  constructor(
    input: {
      agents?: Record<string, Partial<AgentConfig>>;
      defaultAgent?: string;
    } = {},
  ) {
    for (const [name, agent] of Object.entries(input.agents ?? {}))
      this.register({ name, ...agent });
    this.defaultName = input.defaultAgent || undefined;
  }

  register(agent: AgentInput) {
    validateAgent(agent);
    this.agents.set(agent.name, {
      name: agent.name,
      description: agent.description ?? "",
      systemPrompt: agent.systemPrompt ?? "",
      mode: agent.mode ?? "primary",
      hidden: agent.hidden ?? false,
      color: agent.color,
      model: agent.model,
      variant: agent.variant,
      maxSteps: agent.maxSteps,
      allowedTools: agent.allowedTools ?? [],
      excludedTools: agent.excludedTools ?? [],
      mcpServers: agent.mcpServers ?? [],
      permissions: agent.permissions,
    });
  }

  remove(name: string) {
    this.agents.delete(name);
    if (this.defaultName === name) this.defaultName = undefined;
  }

  get(name: string) {
    return this.agents.get(name);
  }

  list() {
    return [...this.agents.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  selectable() {
    return this.list().filter(
      (agent) => agent.mode !== "subagent" && !agent.hidden,
    );
  }

  default() {
    const configured = this.defaultName
      ? this.get(this.defaultName)
      : undefined;
    if (configured && configured.mode !== "subagent" && !configured.hidden)
      return configured;
    return this.selectable()[0];
  }

  select(name?: string) {
    if (name) return this.get(name);
    return this.default();
  }

  setDefault(name?: string) {
    if (name && !this.get(name)) throw new Error(`agent not found: ${name}`);
    this.defaultName = name;
  }
}

export function agentsFromConfig(config: ConfigV3) {
  return new AgentRegistry({
    agents: config.agents,
    defaultAgent: config.defaultAgent,
  });
}

function validateAgent(agent: AgentInput) {
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(agent.name))
    throw new Error(`invalid agent name: ${agent.name}`);
}

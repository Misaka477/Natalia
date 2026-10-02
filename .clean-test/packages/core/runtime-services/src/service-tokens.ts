/**
 * Service tokens for the contracts that cross the plugin boundary.
 *
 * These services are provided by official plugins and consumed by the runtime
 * tool pipeline (terminal controller, skills registry, MCP service, …). Their
 * tokens live here, beside the contract types in `./services`, because the
 * engine must stay free of static imports into concrete plugin packages: a
 * token is the shared vocabulary both sides already import, and the wire name
 * a plugin's manifest `provides` and `api.services.provide` speak is
 * `token.id` — one spelling, no mapping table. Engine-internal services keep
 * their tokens in their owning mechanism packages instead (see
 * `collaborationWaiter`).
 *
 * When a contract type relocates to its owning package, its token moves with
 * it; until then this file is the single home for the boundary wires.
 */
import type { ToolFamily } from "@anthelia/tools";
import type {
  LocalToolsInput,
  McpInput,
  McpService,
  SkillService,
  SkillsInput,
  TeamBehaviorService,
  SandboxService,
  SubagentsService,
  TerminalController,
  TerminalInput,
} from "./services";
import { defineService } from "./service-token";

/** Swaps one local tool family; resolved as the `localTools.reload` service. */
export type LocalToolsReload = (familyID: string) => Promise<ToolFamily>;

/** The skills registry the runtime reads discovered skills through. */
export const skillService = defineService<SkillService>("skills.service", {
  scope: "workspace",
  capability: "services",
});

/** The team behavior surface collaboration tools consult. */
export const teamBehavior = defineService<TeamBehaviorService>(
  "team.behavior",
  { scope: "workspace", capability: "services" },
);

/** The reload hook the local-tools plugin exposes for config changes. */
export const localToolsReload = defineService<LocalToolsReload>(
  "localTools.reload",
  { scope: "workspace", capability: "services" },
);

/** The MCP hub: server registry, connection lifecycle, tool surface. */
export const mcpService = defineService<McpService>("mcp.service", {
  scope: "workspace",
  capability: "services",
});

/** The native terminal controller the tool pipeline drives panes through. */
export const terminalController = defineService<TerminalController>(
  "terminal.controller",
  { scope: "workspace", capability: "services" },
);

/**
 * The four host inputs official plugins receive at setup. Each plugin package
 * used to re-declare the wire name and a duplicate of the input type; the
 * token plus the contract type above are now the single home, so manifest
 * `requires`, `api.services.get`, and the framework's provide site all speak
 * one spelling.
 */

/** Roots and trust callbacks the local-tools plugin discovers families from. */
export const localToolsInput = defineService<LocalToolsInput>(
  "localTools.input",
  {
    scope: "workspace",
    capability: "services",
  },
);

/** MCP server registry view for the MCP plugin. */
export const mcpInput = defineService<McpInput>("mcp.input", {
  scope: "workspace",
  capability: "services",
});

/** Discovery roots and hooks for the skills plugin. */
export const skillsInput = defineService<SkillsInput>("skills.input", {
  scope: "workspace",
  capability: "services",
});

/** Controller construction input for the native-terminal plugin. */
export const terminalInput = defineService<TerminalInput>("terminal.input", {
  scope: "workspace",
  capability: "services",
});

/**
 * Engine-internal services that cross the plugin boundary: official plugins
 * require them at setup (`manifest.requires`), so their tokens live here
 * beside the contract types rather than in the mechanism packages — the same
 * rule as the host inputs, applied in the provide direction.
 */

/** Subagent registry the team plugin fans work out through. */
export const subagentsService = defineService<SubagentsService>(
  "subagents.service",
  { scope: "workspace", capability: "services" },
);

/** Sandbox controller the team plugin scopes its runs in. */
export const sandboxService = defineService<SandboxService>("sandbox.service", {
  scope: "workspace",
  capability: "services",
});

/**
 * The domain-invariant layer's service (Discovery D1). The token lives
 * with the other boundary tokens: runtime-diagnostics must stay free of
 * this package's dependency fan-out (it already reaches framework/session
 * through here — a token declared there would close a reference cycle).
 */
export const runtimeDiagnostics = defineService<
  import("@anthelia/runtime-diagnostics").RuntimeDiagnostics
>("runtime.diagnostics", { scope: "process", capability: "services" });

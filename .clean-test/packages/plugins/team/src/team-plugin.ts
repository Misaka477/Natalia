/**
 * The team built-in plugin: the fan-out + review collaboration lane.
 *
 * The team tools are the only built-in tools that combine two other plugin
 * services — `subagents.service` (spawn per task) and `sandbox.service`
 * (one isolated worktree per candidate) — so this plugin declares both as
 * required services and the capability kernel holds it pending until they are
 * provided. A disabled team plugin registers no team tools at all.
 */
import type { Plugin, PluginManifest } from "@anthelia/plugin";
import {
  SETTLEMENT_SERVICE,
  type SettlementService,
} from "@natalia/collaboration";
import {
  sandboxService,
  subagentsService,
  teamBehavior,
  type SandboxService,
  type SubagentsService,
} from "@anthelia/runtime-services";
import { createTeamFanoutTool, createTeamReviewTool } from "./team-tools";
import {
  sandboxedSubagentSystemPrompt,
  TEAM_MODE_DIRECTIVE,
} from "./agent-team-prompts";

export const TEAM_PLUGIN_ID = "natalia-team";

export const TEAM_PLUGIN_MANIFEST: PluginManifest = {
  apiVersion: 2,
  id: TEAM_PLUGIN_ID,
  version: "1.0.0",
  name: "Team",
  description:
    "Parallel fan-out of sandboxed subagents and the lead reviewer's merge.",
  entry: "index.js",
  scope: "workspace",
  provides: [teamBehavior.id],
  requires: [subagentsService.id, sandboxService.id],
  optionalRequires: [],
  conflicts: [],
  dependencies: [],
  hooks: {},
  integrationPoints: ["tools", "services"],
};

export function createTeamPlugin(): Plugin {
  return {
    manifest: TEAM_PLUGIN_MANIFEST,
    setup(api) {
      api.services.provide(teamBehavior.id, {
        directive: () => TEAM_MODE_DIRECTIVE,
        sandboxedSubagentSystemPrompt,
      });
      api.tools.register(
        createTeamFanoutTool({
          subagents: () => {
            const service = api.services.get<SubagentsService>(
              subagentsService.id,
            );
            return service?.enabled() ? service : undefined;
          },
          sandboxes: () => api.services.get<SandboxService>(sandboxService.id),
          // The settlement bridge, resolved by name like the process and
          // terminal adopters: absent it, the fan-out runs without notices.
          settlement: () =>
            api.services.get<SettlementService>(SETTLEMENT_SERVICE),
        }),
      );
      api.tools.register(
        createTeamReviewTool({
          sandboxes: () => api.services.get<SandboxService>(sandboxService.id),
        }),
      );
    },
  };
}

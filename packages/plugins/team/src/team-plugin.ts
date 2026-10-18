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
import type { FanOutDeclaration } from "./fan-out";
import { loadAssayDeclarationSync } from "@natalia/assay";

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
      // The project's own checks, read ONCE from the workspace root the host
      // handed the plugin. Present, a fan-out's worker self-check is the
      // DECLARED subset whose `scope` matches each task's writePaths — the
      // project's words, not the worker's guess. A missing declaration means no
      // declared checks, which is exactly what the fan-out then reports.
      const workspaceRoot =
        (api.config as { workspaceRoot?: string } | undefined)?.workspaceRoot ??
        "";
      let declaration: FanOutDeclaration | undefined;
      let declarationError: string | undefined;
      const readDeclaration = () => {
        if (declaration !== undefined || declarationError !== undefined)
          return declaration;
        try {
          declaration = {
            checks: loadAssayDeclarationSync(workspaceRoot).checks,
          };
        } catch (error) {
          // A declaration the platform cannot read is REPORTED where it shows
          // up (the fan-out's answer), never silently dropped.
          declarationError =
            error instanceof Error ? error.message : String(error);
          declaration = undefined;
        }
        return declaration;
      };
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
          declaration: readDeclaration,
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

import type { MigratedPluginRule } from "./migrated-plugin-rule-types";

export const migratedPluginRules1: readonly MigratedPluginRule[] = [
  {
    id: "natalia-skills",
    targets: [
      "packages/framework/client/src/runtime/main.ts",
      "packages/framework/client/src/runtime/commands/slash-action.ts",
    ],
    forbidden: [
      {
        description: "legacy skills controller",
        pattern: /\bcreateSkillsController\b/u,
      },
      {
        description: "direct skills discovery",
        pattern: /\bdiscoverSkills\b/u,
      },
      {
        description: "direct skill tool construction",
        pattern: /\bcreateSkillLoadTool\b/u,
      },
      {
        description: "direct skills plugin import",
        pattern: /from\s+["']@natalia\/skills-plugin["']/u,
      },
      {
        description: "client-owned skills command implementation",
        pattern: /["']\/(?:skills|skill|skill-resource|skill-script)["']/u,
      },
    ],
  },
  {
    id: "natalia-tool-web",
    targets: [
      "packages/framework/client/src/runtime/main.ts",
      "packages/framework/client/src/capabilities/tool-family-capabilities.ts",
    ],
    forbidden: [
      {
        description: "direct web package import",
        pattern: /from\s+["']@natalia\/tool-web["']/u,
      },
      {
        description: "direct web tool construction",
        pattern: /\b(?:webToolFamily|webTools|createWebPlugin)\b/u,
      },
    ],
  },
  {
    id: "natalia-sandbox",
    targets: [
      "packages/framework/client/src/runtime/main.ts",
      "packages/framework/client/src/capabilities/tool-family-capabilities.ts",
    ],
    forbidden: [
      {
        description: "direct sandbox package import",
        pattern: /from\s+["']@natalia\/(?:plugin-)?tool-sandbox["']/u,
      },
      {
        description: "direct sandbox tool construction",
        pattern: /\b(?:sandboxToolFamily|sandboxTools|createSandboxPlugin)\b/u,
      },
    ],
  },
  {
    id: "natalia-local-tools",
    targets: ["packages/framework/client/src/runtime/main.ts"],
    forbidden: [
      {
        description: "direct local family loading",
        pattern:
          /\b(?:loadLocalToolFamilies|reloadLocalToolFamily|watchLocalToolFamilies)\b/u,
      },
      {
        description: "direct local tools implementation import",
        pattern:
          /from\s+["'](?:\.\/(?:builtin-plugins\/)?local-tools-plugin|\.\/capabilities\/local-tool-families|\.\.\/capabilities\/local-tool-families)["']/u,
      },
      {
        description: "client-owned local tools implementation",
        pattern:
          /export (?:async )?function (?:createLocalToolsPlugin|discoverLocalToolFamilies|loadLocalToolFamilies|reloadLocalToolFamily|watchLocalToolFamilies)\b/u,
      },
    ],
  },
  {
    id: "natalia-subagents",
    targets: [
      "packages/framework/client/src/runtime/main.ts",
      "packages/core/tools/src/types.ts",
      "packages/framework/subagents/src/tools.ts",
      "packages/plugins/team/src/fan-out.ts",
      "packages/plugins/team/src/team-tools.ts",
      "packages/plugins/team/src/team-plugin.ts",
    ],
    forbidden: [
      {
        description: "direct subagent implementation import",
        pattern: /from\s+["']@natalia\/subagent["']/u,
      },
      {
        description: "concrete subagent backend type in service consumers",
        pattern: /\bSubagentRegistry\b/u,
      },
      {
        description: "subagents controller backend escape hatch",
        pattern: /\bsubagentsController\?*\.get\s*\(\s*\)/u,
      },
      {
        description: "concrete subagents controller type outside its owner",
        pattern: /\bSubagentsController\b/u,
      },
      {
        description: "legacy subagents controller service",
        pattern:
          /\bSUBAGENTS_CONTROLLER_SERVICE\b|["']subagents\.controller["']/u,
      },
    ],
  },
  {
    id: "natalia-mcp",
    targets: [
      "packages/plugins/mcp/src/mcp-runtime.ts",
      "packages/plugins/mcp/src/mcp-controller.ts",
      "packages/plugins/mcp/src/mcp-controller-plugin.ts",
    ],
    forbidden: [
      {
        description: "raw MCP tool registry wiring",
        pattern: /\bToolRegistry\b/u,
      },
    ],
  },
  {
    id: "natalia-session-store",
    targets: [
      "packages/framework/client/test/real-runtime.test.ts",
      "packages/framework/client/test/session-store-controller.test.ts",
    ],
    forbidden: [
      {
        description: "concrete session store type outside testing fixture",
        pattern: /\b(?:JsonSessionStore|SqliteSessionStore)\b/u,
      },
      {
        description: "session store backend accessor",
        pattern: /\bcontroller\.(?:json|sqlite)\s*\(/u,
      },
      {
        description: "client-owned session command implementation",
        pattern: /trimmed\s*===\s*["']\/sessions["']/u,
      },
    ],
  },
  {
    id: "natalia-collaboration",
    targets: ["packages/framework/client/src/runtime/main.ts"],
    forbidden: [
      {
        description: "direct waiter construction in the host",
        pattern: /\bcreateInteractiveWaiter\b/u,
      },
      {
        description: "direct collaboration implementation import",
        pattern:
          /from\s+["'](?:\.\.?\/)*(?:interactive-waiter|mailbox-ledger|mailbox-tool|collaboration-plugin|builtin-plugins\/collaboration-plugin)["']/u,
      },
      {
        description: "client-owned collaboration implementation",
        pattern:
          /export (?:async )?function (?:createCollaborationPlugin|buildMailboxQueued|buildMailboxStatus|createMailboxAcknowledgeTool|registerCollaborationTools)\b/u,
      },
      {
        description: "direct collaboration tool registration in the host",
        pattern:
          /\b(?:mailbox_acknowledge|collab_respond|collab_inbox|collab_ask)\b/u,
      },
    ],
  },
  {
    id: "natalia-turn-orchestration",
    targets: ["packages/framework/client/src/runtime/main.ts"],
    forbidden: [
      {
        description: "direct turn controller implementation import",
        pattern:
          /from\s+["'](?:\.\/turn-controller|\.\.\/turn-controller|\.\/builtin-plugins\/turn-orchestration-plugin|\.\/turn-orchestration-plugin)["']/u,
      },
      {
        description: "direct turn controller construction",
        pattern: /\bcreateTurnController\b/u,
      },
      {
        description: "client-owned turn orchestration implementation",
        pattern: /export function createTurnOrchestrationPlugin\b/u,
      },
    ],
  },
  {
    id: "natalia-compaction",
    targets: ["packages/framework/client/src/runtime/main.ts"],
    forbidden: [
      {
        description: "direct compaction implementation import",
        pattern:
          /from\s+["'](?:\.\/compaction-service|\.\/compaction-plugin|\.\/builtin-plugins\/compaction-plugin)["']/u,
      },
      {
        description: "direct compaction runtime orchestration",
        pattern:
          /\b(?:compactContext|compactionTrigger|providerCompactor|recoverContextLimitOnce)\b/u,
      },
    ],
  },
];

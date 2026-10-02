import type { MigratedPluginRule } from "./migrated-plugin-rule-types";

export const migratedPluginRules2: readonly MigratedPluginRule[] = [
  {
    id: "natalia-tool-search",
    targets: [
      "packages/framework/client/src/runtime/main.ts",
      "packages/framework/client/src/capabilities/tool-family-capabilities.ts",
    ],
    forbidden: [
      {
        description: "direct search package import",
        pattern: /from\s+["']@natalia\/tool-search["']/u,
      },
      {
        description: "direct search tool construction",
        pattern: /\b(?:searchToolFamily|searchTools|createSearchPlugin)\b/u,
      },
    ],
  },
  {
    id: "natalia-tool-shell",
    targets: [
      "packages/framework/client/src/runtime/main.ts",
      "packages/framework/client/src/capabilities/tool-family-capabilities.ts",
    ],
    forbidden: [
      {
        description: "direct shell package import",
        pattern: /from\s+["']@natalia\/tool-shell["']/u,
      },
      {
        description: "direct shell tool construction",
        pattern: /\b(?:shellToolFamily|shellTools|createShellPlugin)\b/u,
      },
    ],
  },
  {
    id: "natalia-tool-process",
    targets: [
      "packages/framework/client/src/runtime/main.ts",
      "packages/framework/client/src/capabilities/tool-family-capabilities.ts",
    ],
    forbidden: [
      {
        description: "direct process package import",
        pattern: /from\s+["']@natalia\/tool-process["']/u,
      },
      {
        description: "direct process tool construction",
        pattern:
          /\b(?:processToolFamily|managedProcessTools|createProcessPlugin|ManagedProcessRegistry)\b/u,
      },
    ],
  },
  {
    id: "natalia-tool-plugins",
    targets: ["packages/framework/client/src/runtime/main.ts"],
    forbidden: [
      {
        description: "legacy built-in tool-family bootstrap",
        pattern:
          /\b(?:applyToolFamilyEnabledFilter|builtinToolFamilies|createToolRegistryFromCapabilities|registerToolFamilyCapabilities)\b/u,
      },
    ],
  },
  {
    id: "natalia-terminal",
    targets: [
      "packages/framework/client/src/runtime/main.ts",
      "packages/core/tools/src/types.ts",
    ],
    forbidden: [
      {
        description: "direct terminal controller construction",
        pattern: /\bcreateTerminalController\b/u,
      },
      {
        description: "concrete native terminal type in client composition",
        pattern: /\b(?:NativeTerminalRegistry|NativeTerminalSession)\b/u,
      },
      {
        description: "terminal controller backend escape hatch",
        pattern: /\bterminalController\?*\.get\s*\(/u,
      },
      {
        description: "client-owned native terminal session projection",
        pattern: /\bpublicNativeTerminal\b/u,
      },
    ],
  },
  {
    id: "natalia-mcp",
    targets: [
      "packages/plugins/mcp/src/index.ts",
      "packages/plugins/mcp/src/mcp-controller-plugin.ts",
    ],
    forbidden: [
      {
        description: "concrete mcp controller exported by public barrel",
        pattern:
          /export\s+(?:type\s+)?\{[^}]*\b(?:McpAccess|McpController)\b[^}]*\}\s+from\s+["']\.\/mcp-controller["']/u,
      },
      {
        description: "legacy mcp controller service exported publicly",
        pattern: /\bMCP_CONTROLLER_SERVICE\b/u,
      },
      {
        description: "legacy mcp controller plugin exported publicly",
        pattern: /\bcreateMcpControllerPlugin\b/u,
      },
    ],
  },
  {
    id: "natalia-subagents",
    targets: ["packages/framework/client/src/runtime/main.ts"],
    forbidden: [
      {
        description: "direct subagents controller construction",
        pattern: /\bcreateSubagentsController\b/u,
      },
    ],
  },
  {
    id: "natalia-session-store",
    targets: ["packages/framework/session-store/src/index.ts"],
    forbidden: [
      {
        description: "concrete session store exported by plugin barrel",
        pattern:
          /export\s+(?:type\s+)?\{[^}]*\b(?:JsonSessionStore|SqliteSessionStore)\b[^}]*\}/u,
      },
    ],
  },
  {
    id: "natalia-tool-pipeline",
    targets: ["packages/framework/client/src/runtime/main.ts"],
    forbidden: [
      {
        description: "direct policy construction in the host",
        pattern:
          /(?<!\.)\b(?:createToolPolicyHookLayer|evaluatePermissionRules|workspaceWritePathForTool|commandTextForTool)\b/u,
      },
      {
        description: "direct tool pipeline implementation import",
        pattern:
          /from\s+["'](?:\.\/(?:builtin-plugins\/)?tool-pipeline-plugin|\.\/tool-policy|\.\/bash-command-policy|\.\.\/tool-policy|\.\.\/bash-command-policy)["']/u,
      },
      {
        description: "client-owned tool pipeline implementation",
        pattern:
          /export\s+(?:async\s+)?(?:function|class|const)\s+(?:createToolPipelinePlugin|createToolPolicyHookLayer|evaluatePermissionRules|TerminalCommandBuffer|parseBashSimpleCommand)\b/u,
      },
    ],
  },
  {
    id: "natalia-governance-ledger",
    targets: ["packages/framework/client/src/runtime/main.ts"],
    forbidden: [
      {
        description: "direct governance ledger implementation import",
        pattern:
          /from\s+["'](?:\.\.?\/)*(?:constitution-ledger|evidence-ledger|governance-ledger-controller|governance-ledger-plugin|builtin-plugins\/governance-ledger-plugin)["']/u,
      },
      {
        description: "client-owned governance ledger implementation",
        pattern:
          /export (?:const SELF_PROTECTION_RULES|function (?:createGovernanceLedgerPlugin|createGovernanceLedgerController|seedConstitutionRules|recordDecision|buildEvidenceRecorded|buildCompletionRecorded))/u,
      },
    ],
  },
  {
    id: "natalia-attachment",
    targets: [
      "packages/framework/client/src/runtime/main.ts",
      "packages/framework/client/src/index.ts",
      "apps/cli/src/index.ts",
    ],
    forbidden: [
      {
        description: "direct attachment implementation import",
        pattern:
          /from\s+["'](?:\.\/attachments|\.\/attachment-service|\.\/attachment-plugin|\.\/builtin-plugins\/attachment-plugin)["']/u,
      },
    ],
  },
];

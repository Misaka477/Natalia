import type { MigratedPluginRule } from "./migrated-plugin-rule-types";

export const migratedPluginRules4: readonly MigratedPluginRule[] = [
  {
    id: "natalia-tool-todo",
    targets: [
      "packages/framework/client/src/runtime/main.ts",
      "packages/framework/client/src/capabilities/tool-family-capabilities.ts",
    ],
    forbidden: [
      {
        description: "direct todo package import",
        pattern: /from\s+["']@natalia\/tool-todo["']/u,
      },
      {
        description: "direct todo tool construction",
        pattern: /\b(?:todoToolFamily|todoTools|createTodoPlugin)\b/u,
      },
    ],
  },
  {
    id: "natalia-tool-fs-write",
    targets: [
      "packages/framework/client/src/runtime/main.ts",
      "packages/framework/client/src/capabilities/tool-family-capabilities.ts",
    ],
    forbidden: [
      {
        description: "direct fs-write package import",
        pattern: /from\s+["']@natalia\/tool-fs-write["']/u,
      },
      {
        description: "direct fs-write tool construction",
        pattern:
          /\b(?:fsWriteToolFamily|writeFileTools|createFsWritePlugin)\b/u,
      },
    ],
  },
  {
    id: "natalia-tool-terminal",
    targets: [
      "packages/framework/client/src/runtime/main.ts",
      "packages/framework/client/src/capabilities/tool-family-capabilities.ts",
    ],
    forbidden: [
      {
        description: "direct terminal package import",
        pattern:
          /from\s+["']@natalia\/(?:plugin-tool-terminal|plugin-native-terminal|tool-terminal)["']/u,
      },
      {
        description: "direct terminal tool construction",
        pattern:
          /\b(?:terminalToolFamily|terminalTools|createTerminalPlugin)\b/u,
      },
    ],
  },
  {
    id: "natalia-runtime-config",
    targets: [
      "packages/framework/client/src/runtime/main.ts",
      "packages/framework/client/src/runtime/commands/index.ts",
    ],
    forbidden: [
      {
        description: "direct runtime config implementation import",
        pattern:
          /from\s+["'](?:\.\/runtime-config-plugin|\.\/builtin-plugins\/runtime-config-plugin)["']/u,
      },
      {
        description: "runtime config capability registration",
        pattern:
          /\b(?:registerRuntimeConfigCapability|RUNTIME_CONFIG_CAPABILITY_ID)\b/u,
      },
    ],
  },
  {
    id: "natalia-workspace",
    targets: ["packages/framework/client/src/runtime/main.ts"],
    forbidden: [
      {
        description: "direct workspace component construction",
        pattern:
          /\b(?:createWorkspaceWriteLock|createMutationRegistry|createWorkspaceFilesController)\b/u,
      },
      {
        description: "direct workspace implementation import",
        pattern:
          /from\s+["'](?:\.\.?\/)*(?:mutation-registry|workspace-change-auditor|workspace-files-controller|workspace-files|workspace-observation|workspace-write-lock|workspace-plugin|builtin-plugins\/workspace-plugin)["']/u,
      },
      {
        description: "client-owned workspace implementation",
        pattern:
          /export (?:async )?function (?:createWorkspacePlugin|createWorkspaceChangeAuditor|findWorkspaceFiles|watchWorkspaceFiles)\b/u,
      },
      {
        description: "client-owned workspace command implementation",
        pattern:
          /(?:findWorkspaceFiles|searchWorkspaceFiles|["']\/(?:files|search)["'])/u,
      },
    ],
  },
  {
    id: "natalia-mcp",
    targets: [
      "packages/framework/client/src/runtime/main.ts",
      "packages/framework/provider-model/src/provider-runner.ts",
    ],
    forbidden: [
      {
        description: "direct mcp controller construction",
        pattern: /\bcreateMcpController\b/u,
      },
      {
        description: "concrete mcp controller type outside its owner",
        pattern: /\bMcpController\b/u,
      },
      {
        description: "mcp access collection escape hatch",
        pattern: /\b(?:McpAccess|mcpAccess)\b/u,
      },
      {
        description: "legacy mcp controller service",
        pattern: /\bMCP_CONTROLLER_SERVICE\b/u,
      },
    ],
  },
  {
    id: "natalia-session-store",
    targets: ["packages/framework/client/src/runtime/main.ts"],
    forbidden: [
      {
        description: "direct session store implementation import",
        pattern:
          /from\s+["'](?:\.\/session-store-controller|\.\/session-store-controller-plugin|\.\/builtin-plugins\/session-store-controller-plugin)["']/u,
      },
      {
        description: "direct session store controller construction",
        pattern: /\bcreateSessionStoreController\b/u,
      },
      {
        description: "concrete session store type outside testing fixture",
        pattern: /\b(?:JsonSessionStore|SqliteSessionStore)\b/u,
      },
      {
        description: "session store backend accessor",
        pattern: /\bsessionStoreController\?*\.(?:json|sqlite)\s*\(/u,
      },
    ],
  },
  {
    id: "natalia-provider-model",
    targets: [
      "packages/framework/client/src/runtime/main.ts",
      "packages/framework/client/src/runtime/commands/slash-action.ts",
    ],
    forbidden: [
      {
        description: "direct provider runner construction in the host",
        pattern: /(?<!\.)\bcreateProviderRunner\b/u,
      },
      {
        description: "host-owned provider runner cache",
        pattern: /(?<!\.)\brunnerBySession\b/u,
      },
      {
        description: "host-owned live chat abort state",
        pattern: /(?<!\.)\bchatAbort\b/u,
      },
      {
        description: "direct provider model implementation import",
        pattern:
          /from\s+["'](?:\.\/provider-model-controller|\.\/provider-runner|\.\/provider-model-plugin|\.\/builtin-plugins\/provider-model-plugin)["']/u,
      },
      {
        description: "direct provider model plugin package import",
        pattern: /from\s+["']@natalia\/provider-model-plugin["']/u,
      },
      {
        description: "client-owned provider model plugin construction",
        pattern: /export function createProviderModelPlugin\b/u,
      },
      {
        description: "client-owned provider model controller",
        pattern: /export function createProviderModelController\b/u,
      },
      {
        description: "client-owned provider model command implementation",
        pattern: /["']\/(?:models|model)["']/u,
      },
    ],
  },
  {
    id: "natalia-context-ledger",
    targets: ["packages/framework/client/src/runtime/main.ts"],
    forbidden: [
      {
        description: "direct context ledger implementation import",
        pattern:
          /from\s+["'](?:\.\/context-ledger-factory|\.\/context-ledger-plugin|\.\/builtin-plugins\/context-ledger-plugin)["']/u,
      },
      {
        description: "direct context ledger construction",
        pattern: /\bnew\s+ContextLedger\b/u,
      },
      {
        description: "host-owned context event recovery",
        pattern: /\brestoreContextFromEvents\b/u,
      },
    ],
  },
  {
    id: "natalia-retry",
    targets: ["packages/framework/client/src/runtime/main.ts"],
    forbidden: [
      {
        description: "direct retry implementation import",
        pattern:
          /from\s+["'](?:\.\/retry-service|\.\/retry-plugin|\.\/builtin-plugins\/retry-plugin)["']/u,
      },
      {
        description: "direct retry runner use",
        pattern: /\b(?:runWithRetry|runStreamingWithRetry)\b/u,
      },
    ],
  },
  {
    id: "natalia-transport",
    targets: ["apps/cli/src/command-dispatcher.ts"],
    forbidden: [
      {
        description: "direct HTTP transport server lifecycle",
        pattern: /\bcreateRuntimeHttpServer\b/u,
      },
    ],
  },
  {
    id: "natalia-runtime-ui",
    targets: ["packages/framework/client/src/runtime/main.ts"],
    forbidden: [
      {
        description: "direct status controller construction",
        pattern: /\bcreateStatusSnapshotController\b/u,
      },
      {
        description: "client-owned runtime UI implementation import",
        pattern:
          /from\s+["'](?:\.\/status-controller|\.\.\/status-controller|\.\/runtime-ui-plugin|\.\/builtin-plugins\/runtime-ui-plugin)["']/u,
      },
      {
        description: "client-owned runtime UI implementation",
        pattern: /export function (?:createRuntimeUiPlugin|statusSnapshot)\b/u,
      },
      {
        description: "client-owned runtime UI command implementation",
        pattern: /["']\/(?:help|doctor|status|diagnostics)\b/u,
      },
    ],
  },
  {
    id: "natalia-ui-command-host",
    targets: ["packages/framework/runtime-status/src/status-controller.ts"],
    forbidden: [
      {
        description: "process-global plugin command bridge",
        pattern: /\b(?:getPluginCommands|setGlobalPluginCommands)\b/u,
      },
      {
        description: "direct plugin command closure execution",
        pattern: /\b(?:pluginCmd|cmd)\.run\s*\(/u,
      },
      {
        description: "static runtime command vocabulary",
        pattern: /\bruntimeSlashCommands\b/u,
      },
    ],
  },
];

import type {
  MigratedPluginRule,
  MigratedPluginViolation,
} from "./migrated-plugin-rule-types";
import { migratedPluginRules1 } from "./migrated-plugin-rules-1";
import { migratedPluginRules2 } from "./migrated-plugin-rules-2";
import { migratedPluginRules3 } from "./migrated-plugin-rules-3";
import { migratedPluginRules4 } from "./migrated-plugin-rules-4";

export type {
  MigratedPluginRule,
  MigratedPluginViolation,
} from "./migrated-plugin-rule-types";
const forbiddenRepositoryPaths = new Map([
  [
    "packages/agent-plugin/package.json",
    "deleted agent re-export facade must not be recreated",
  ],
  [
    "packages/skills/package.json",
    "merged skills implementation package must not be recreated",
  ],
  [
    "packages/skills/src/index.ts",
    "merged skills implementation package must not be recreated",
  ],
  [
    "packages/mcp/package.json",
    "merged MCP implementation package must not be recreated",
  ],
  [
    "packages/mcp/src/index.ts",
    "merged MCP implementation package must not be recreated",
  ],
  [
    "packages/framework/client/src/runtime-assembly.ts",
    "deleted runtime assembly seam must not be recreated",
  ],
  [
    "packages/builtin-plugins/package.json",
    "deleted built-in plugin classification must not be recreated",
  ],
  [
    "packages/builtin-tool-plugins/package.json",
    "deleted built-in tool plugin classification must not be recreated",
  ],
  [
    "packages/sandbox-plugin/package.json",
    "merged sandbox controller package must not be recreated",
  ],
  [
    "packages/tool-agent/package.json",
    "merged subagent tool plugin package must not be recreated",
  ],
  [
    "packages/subagent/package.json",
    "merged subagent registry package must not be recreated",
  ],
  [
    "packages/collaboration-plugin/package.json",
    "merged collaboration framework package must not be recreated",
  ],
  [
    "apps/cli/src/transport-plugin.ts",
    "framework transport plugin wrapper must not be recreated",
  ],
  [
    "packages/checkpoint-plugin/package.json",
    "merged checkpoint package must not be recreated",
  ],
  [
    "packages/attachment-plugin/package.json",
    "merged attachments framework package must not be recreated",
  ],
  [
    "packages/context-ledger-plugin/package.json",
    "merged context ledger framework package must not be recreated",
  ],
  [
    "packages/retry-plugin/package.json",
    "merged retry framework package must not be recreated",
  ],
  [
    "packages/runtime-config-plugin/package.json",
    "merged runtime config framework package must not be recreated",
  ],
  [
    "packages/tool-pipeline-plugin/package.json",
    "merged tool policy framework package must not be recreated",
  ],
  [
    "packages/workspace-plugin/package.json",
    "merged workspace framework package must not be recreated",
  ],
  [
    "packages/compaction-plugin/package.json",
    "merged compaction framework package must not be recreated",
  ],
  [
    "packages/session-store-plugin/package.json",
    "merged session store framework package must not be recreated",
  ],
  [
    "packages/provider-model-plugin/package.json",
    "merged provider/model framework package must not be recreated",
  ],
  [
    "packages/turn-orchestration-plugin/package.json",
    "merged turn orchestration framework package must not be recreated",
  ],
  [
    "packages/runtime-ui-plugin/package.json",
    "merged runtime status framework package must not be recreated",
  ],
  [
    "packages/work-ledger-plugin/package.json",
    "merged work ledger framework package must not be recreated",
  ],
  [
    "packages/governance-ledger-plugin/package.json",
    "merged governance ledger framework package must not be recreated",
  ],
]);

/** Prevent deleted transitional architecture seams from being recreated. */
export function findForbiddenRepositoryPathViolation(
  path: string,
): string | undefined {
  return forbiddenRepositoryPaths.get(path.replaceAll("\\", "/"));
}

/**
 * Runtime semantics that must remain present when every product plugin is
 * removed. These subsystems are barred from the plugin lifecycle surface:
 * no imports of the plugin kernel, no manifest/entry/API types, no plugin ID
 * constants and no `plugins.enabled` gates.
 */
export const frameworkSubsystemRoots = [
  "packages/framework/agent/src",
  "packages/framework/attachments/src",
  "packages/framework/checkpoint/src",
  "packages/framework/collaboration/src",
  "packages/framework/compaction/src",
  "packages/domains/context-ledger/src",
  "packages/domains/governance-ledger/src",
  "packages/framework/provider-model/src",
  "packages/framework/retry/src",
  "packages/framework/runtime-config/src",
  "packages/framework/runtime-status/src",
  "packages/framework/sandbox/src",
  "packages/tooling/sdk/src",
  "packages/framework/session/src",
  "packages/framework/session-store/src",
  "packages/framework/subagents/src",
  "packages/framework/tool-policy/src",
  "packages/hosts/transport/src",
  "packages/framework/turn-orchestration/src",
  "packages/domains/work-ledger/src",
  "packages/framework/workspace/src",
];
export const frameworkSubsystemFiles = ["apps/cli/src/transport-host.ts"];
export const forbiddenFrameworkPluginSurface = [
  /from\s+["']@natalia\/plugin(?:[\/"'])/u,
  /\b(?:PluginManifest|DesiredPluginEntry|PluginAPI)\b/u,
  /\b[A-Z][A-Z0-9_]*_PLUGIN_ID\b/u,
  /plugins\.enabled\s*\[/u,
];

/**
 * A framework subsystem must stay free of the plugin lifecycle surface. The
 * path is repository-relative; the guard passes the scanned root and the host
 * file through this so coverage stays visible to unit tests. Collaboration and
 * work-ledger are framework-owned, so they must remain covered by these checks
 * even though they may not import the team plugin either.
 */
export function findFrameworkPluginSurfaceViolation(
  path: string,
  text: string,
): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  const covered =
    frameworkSubsystemRoots.some((root) => normalized.startsWith(root)) ||
    frameworkSubsystemFiles.includes(normalized);
  if (!covered) return undefined;
  for (const pattern of forbiddenFrameworkPluginSurface)
    if (pattern.test(text))
      return `framework subsystem must not expose plugin lifecycle or enable gates ${pattern}`;
  return undefined;
}

const productPluginImport = /from\s+["']@natalia\/plugin-[a-z-]+["']/u;
const productPluginFactory = /\bcreate[A-Z][A-Za-z0-9]*Plugin\s*\(/u;
const migratedServiceImport = new RegExp(
  String.raw`(?:import|export)\s*(?:type\s*)?\{[^}]*\b(?:AttachmentService|CheckpointFactory|CompactionService|ContextLedgerFactory|GovernanceLedgerController|InteractiveWaiter|McpService|ProviderModelController|RetryService|SandboxService|SessionStoreController|StatusSnapshotController|SubagentsService|TerminalController|ToolPolicyService|TurnController|WorkLedgerController|WorkspaceFilesController|MutationRegistry|WorkspaceWriteLock)\b[^}]*\}\s*from\s*["']@natalia\/(?:(?:collaboration|compaction|governance-ledger|mcp|native-terminal|provider-model|runtime-ui|session-store|subagents|terminal|turn-orchestration|work-ledger)-plugin|plugin-native-terminal)["']`,
  "u",
);

/** Keep product factory assembly in runtime's ordinary desired catalog. */
export function findRuntimePluginCatalogViolation(
  path: string,
  text: string,
): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("packages/tooling/testing/")) return undefined;
  if (
    normalized.startsWith("packages/framework/client/src/runtime/") &&
    (productPluginImport.test(text) || productPluginFactory.test(text))
  )
    return "runtime product plugin assembly belongs in the ordinary desired catalog";
  if (
    /\b(?:builtinPluginCatalog|computeBuiltinPluginGates|computeBuiltinFeatureGates|DefaultPluginEntry)\b/u.test(
      text,
    )
  )
    return "built-in plugin classification must not be recreated";
  return undefined;
}

/** Runtime service definitions are owned by the shared definition package. */
export function findClientServiceContractViolation(
  path: string,
  text: string,
): string | undefined {
  if (
    path.startsWith("packages/framework/client/src/") &&
    migratedServiceImport.test(text)
  )
    return "client must import migrated service types and keys from @anthelia/runtime-services";
  return undefined;
}

const migratedClientPluginSurface = new RegExp(
  String.raw`(?:import|export)\s*(?:type\s*)?\{[^}]*\b(?:parseToolArguments|tryParseToolArguments|createToolPolicyHookLayer|ToolPolicyHookLayer|WorkflowExecutionEventStream|WorkflowExecutionEvent|WorkflowExecutionHandle|WorkflowExecutionStatus|WorkflowExecutionSchedulerService)\b[^}]*\}\s*from\s*["']@natalia\/(?:plugin-[a-z-]+|[a-z-]+-plugin)["']`,
  "u",
);
const clientProviderPluginIDImport = new RegExp(
  String.raw`(?:import|export)\s*(?:type\s*)?\{[^}]*\b[A-Z][A-Z0-9_]*_PLUGIN_ID\b[^}]*\}\s*from\s*["']@natalia\/(?:plugin-[a-z-]+|[a-z-]+-plugin)["']`,
  "u",
);
const runtimeCompositionRoot = "packages/framework/client/src/runtime/main.ts";
const runtimeCompositionDirectory =
  "packages/framework/client/src/runtime/composition/";

function isRuntimeCompositionPath(path: string) {
  return (
    path === runtimeCompositionRoot ||
    path.startsWith(runtimeCompositionDirectory)
  );
}

/** Pure contracts and helpers must not be sourced from provider packages. */
export function findClientPluginSurfaceViolation(
  path: string,
  text: string,
): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  if (
    isRuntimeCompositionPath(normalized) &&
    /(?:from\s+|import\s*\()\s*["']@natalia\/[^"']*-plugin["']/u.test(text)
  )
    return "client runtime composition root must not import provider plugin packages";
  if (
    /packages\/framework\/client\/(?:src|test)\//u.test(normalized) &&
    (migratedClientPluginSurface.test(text) ||
      clientProviderPluginIDImport.test(text))
  )
    return "client imports a migrated pure surface or plugin ID from a plugin package";
  return undefined;
}

const clientToolImplementationImport =
  /(?:from\s+|import\s*\(|require\s*\()\s*["']@natalia\/tool-(?!pipeline-plugin["'])(?!policy["'])[a-z-]+["']/u;
const clientToolImplementationDependency =
  /["']@natalia\/tool-(?!pipeline-plugin["'])(?!policy["'])[a-z-]+["']/u;
const clientToolImplementationReference =
  /["']\.\.\/tool-(?!pipeline-plugin["'])(?!policy["'])[a-z-]+["']/u;

/** Keep concrete tool implementations outside the client package boundary. */
export function findClientToolDependencyViolation(
  path: string,
  text: string,
): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  if (
    /packages\/framework\/client\/(?:src|test)\//u.test(normalized) &&
    clientToolImplementationImport.test(text)
  )
    return "client project imports a concrete tool package";
  if (normalized === "packages/framework/client/package.json") return undefined;
  if (normalized === "packages/framework/client/tsconfig.json")
    return undefined;
  return undefined;
}

/**
 * Keep concrete product packages outside the client boundary once a plugin
 * package owns them. The list grows as each controller is extracted; an entry
 * must not be added until the client no longer imports the package anywhere.
 */
const clientProductPackages = [
  "agent-plugin",
  "mcp",
  "plugin-native-terminal",
  "skills",
  "subagent",
];

/** Keep concrete product packages outside the client package boundary. */
export function findClientProductDependencyViolation(
  path: string,
  text: string,
): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  const alternation = clientProductPackages.join("|");
  const importPattern = new RegExp(
    `(?:from\\s+|import\\s*\\(|require\\s*\\()\\s*["']@natalia\\/(?:${alternation})["']`,
    "u",
  );
  const dependencyPattern = new RegExp(
    `["']@natalia\\/(?:${alternation})["']`,
    "u",
  );
  const referencePattern = new RegExp(
    `["']\\.\\.\\/(?:${alternation})["']`,
    "u",
  );
  if (
    /packages\/framework\/client\/(?:src|test)\//u.test(normalized) &&
    importPattern.test(text)
  )
    return "client project imports a concrete product package";
  if (
    normalized === "packages/framework/client/package.json" &&
    dependencyPattern.test(text)
  )
    if (/@natalia\/plugin-[a-z-]+["']/u.test(text)) return undefined;
    else return "client manifest depends on a concrete product package";
  if (
    normalized === "packages/framework/client/tsconfig.json" &&
    referencePattern.test(text)
  )
    if (
      /\.\.\/plugin-[a-z-]+["']/u.test(text) ||
      /\.\.\/[a-z-]+-plugin["']/u.test(text)
    )
      return undefined;
    else
      return "client TypeScript project references a concrete product package";
  return undefined;
}

/**
 * Runtime configuration may depend on ordinary plugin packages so it can
 * declare the product's initial desired graph. No bundle gets privileged.
 */
const clientClosureAllowlist = [
  "agent",
  "agent-prompts",
  "attachments",
  "capability",
  "collab",
  "engineering-intelligence",
  "goal-runtime",
  "checkpoint",
  "collaboration",
  "compaction",
  "composition",
  "config",
  "confinement",
  // The engine's diff capability: the client's ast-compute worker and
  // runtime-ast-client already consumed it (source predates this
  // rule's declaration check) — a mechanism, so closure-legal.
  "diff-wasm",
  // @natalia/installer's existing use lives in the client's
  // plugin-runtime (pre-existing source, found by the census): the
  // list already seats hosts-shelf packages (platform, terminal) on
  // the same standing — a declared reality beats a hidden one.
  "installer",
  "operation-log",
  // Decision20 assigns store/manifest/GC/fsck to Anthelia, and P4's
  // law is "the package prefix IS the boundary": @anthelia/object-store
  // is an ENGINE package mis-shelved under hosts/ (it even sits in
  // HOST_LAYER_PACKAGES, which answers a different question — what the
  // domains direction ban must scan under that directory). The shelf
  // does not demote it to non-kernel for the client closure.
  "object-store",
  "substrate",
  "rina",
  "runtime-diagnostics",
  "context-ledger",
  "contracts",
  "goal",
  "governance-ledger",
  "platform",
  "plugin",
  "provider-model",
  "retry",
  "runtime",
  "runtime-config",
  "runtime-services",
  "runtime-status",
  "sandbox",
  "session",
  "session-store",
  "subagents",
  "terminal",
  "testing",
  "tool-policy",
  "tools",
  "turn-orchestration",
  "ui-model",
  "work-ledger",
  "workspace",
];

/** Keep the client dependency closure free of non-kernel product packages. */

/**
 * The package's bare name under either prefix — the closure check covers
 * both worlds (P3 moves mechanisms to @anthelia; round 41 silently
 * un-guarded them here by testing only @natalia/, which this restores).
 */
function bareDep(name: string): string | undefined {
  if (name.startsWith("@anthelia/")) return name.slice(10);
  if (name.startsWith("@natalia/")) return name.slice(9);
  return undefined;
}

export function findClientClosureViolation(
  path: string,
  text: string,
): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  const allowed = new Set(clientClosureAllowlist);
  if (normalized === "packages/framework/client/package.json") {
    const manifest = JSON.parse(
      text.trimStart().startsWith("{") ? text : `{"dependencies":{${text}}}`,
    ) as {
      dependencies?: Record<string, string>;
    };
    for (const name of Object.keys(manifest.dependencies ?? {}))
      if (
        name === "@natalia/builtin-plugins" ||
        name === "@natalia/builtin-tool-plugins"
      )
        return `client manifest recreates deleted plugin classification ${name}`;
      else if (
        bareDep(name) !== undefined &&
        !allowed.has(bareDep(name)!) &&
        !name.startsWith("@natalia/plugin-")
      )
        return `client manifest depends on non-kernel package ${name}`;
  }
  return undefined;
}

/**
 * Phase 2 boundary (convergence plan §6.2): Chat, Collaboration and Plan stay
 * framework-owned while `@natalia/plugin-team` remains a true plugin, reachable
 * only through the installed desired catalog. Collaboration, work-ledger and
 * the client runtime may not name the concrete team plugin package.
 */
const teamPluginBoundaryRoots = [
  "packages/framework/collaboration/src/",
  "packages/framework/collaboration/test/",
  "packages/domains/work-ledger/src/",
  "packages/domains/work-ledger/test/",
];
const teamPluginPackageImport =
  /(?:from\s+|import\s*\(|require\s*\()\s*["']@natalia\/plugin-team(?:[\/"'])/u;
const teamPluginImplementationImport =
  /(?:from\s+|import\s*\(|require\s*\()\s*["'][^"']*team-plugin[^"']*["']/u;

/**
 * Framework domains and the client runtime must not depend on the team plugin.
 * The client package itself may declare the dependency (the catalog uses it);
 * only the plugin catalog directory may import it.
 */
export function findTeamPluginDependencyViolation(
  path: string,
  text: string,
): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  const inFrameworkDomain = teamPluginBoundaryRoots.some((root) =>
    normalized.startsWith(root),
  );
  const inClientRuntime = normalized.startsWith(
    "packages/framework/client/src/runtime/",
  );
  if (!inFrameworkDomain && !inClientRuntime) return undefined;
  if (teamPluginPackageImport.test(text))
    return "framework domain or client runtime imports the team plugin package";
  if (teamPluginImplementationImport.test(text))
    return "framework domain or client runtime imports a concrete team plugin implementation";
  return undefined;
}

export const migratedPluginRules: readonly MigratedPluginRule[] = [
  ...migratedPluginRules1,
  ...migratedPluginRules2,
  ...migratedPluginRules3,
  ...migratedPluginRules4,
];

export function findMigratedPluginViolations(
  path: string,
  text: string,
  rules: readonly MigratedPluginRule[] = migratedPluginRules,
): MigratedPluginViolation[] {
  const normalized = path.replaceAll("\\", "/");
  const violations: MigratedPluginViolation[] = [];
  for (const rule of rules) {
    const protectsRuntimeComposition = rule.targets.includes(
      runtimeCompositionRoot,
    );
    if (
      !rule.targets.includes(normalized) &&
      !(protectsRuntimeComposition && isRuntimeCompositionPath(normalized))
    )
      continue;
    for (const forbidden of rule.forbidden)
      if (forbidden.pattern.test(text))
        violations.push({
          pluginID: rule.id,
          description: forbidden.description,
        });
  }
  return violations;
}

/**
 * decisions §1.1/§1.2 + master plan P3: product policy never depends on
 * the host layer (hosts are the engine's platform adapters; policy talks
 * to the engine's API and its siblings, never to platform plumbing).
 * Deep imports are already banned globally (the deep-import rule); this
 * is the direction ban, scoped to domains (the policy-fold sublayer) —
 * extend the scan roots as P3 moves policy into their own packages.
 * Keep the list in step with packages/hosts/.
 */
export const HOST_LAYER_PACKAGES = [
  "@anthelia/config",
  "@anthelia/confinement",
  "@natalia/installer",
  "@anthelia/object-store",
  "@anthelia/platform",
  "@natalia/transport",
  "@natalia/ui-host",
  "@natalia/view-store",
] as const;

export function findPolicyHostDependencyViolation(
  specifier: string,
  file: string,
): string | undefined {
  if (!file.startsWith("packages/domains/")) return undefined;
  if (!file.includes("/src/")) return undefined; // tests may reach anywhere
  const hit = HOST_LAYER_PACKAGES.find(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
  if (hit)
    return `product policy (domains) must not depend on the host layer: imports ${hit}`;
  return undefined;
}

/**
 * master plan P3 row (composition 归内核) + interface spec's substrate list:
 * the generation-switch/composition machinery is ENGINE substrate, so
 * `@anthelia/composition` must resolve into the kernel layer
 * (packages/core/...) — checked against the paths map, which is the one
 * place the placement is declared.
 */
export function findCompositionKernelViolation(
  pathsEntry: readonly string[] | string | undefined,
): string | undefined {
  if (!pathsEntry)
    return "@anthelia/composition is missing from tsconfig.base paths";
  const first = Array.isArray(pathsEntry) ? pathsEntry[0] : pathsEntry;
  if (!first?.startsWith("packages/core/"))
    return `composition must live in the kernel layer (packages/core/...), paths says ${first}`;
  return undefined;
}

/**
 * Substrate purity (master plan P3, decisions §1.1): substrate material
 * knows no product concept. The list grows as `framework/client` is split
 * — context.ts first, then the port files, then the initialize assembly —
 * so each extraction step extends the machine-checked boundary instead of
 * trusting review.
 *
 * The banned set is §1.1's NAMED forbidden CONCEPTS (goal/协作/治理/UI)
 * as packages. The policy COLUMN governs prefix ownership — a package can
 * stay @natalia while the engine legitimately imports its types;
 * `context-ledger` is exactly that case (the runtime's context-window/
 * epoch machinery underpins exec/initialize/ports — its `plan_handoff`
 * kind is policy flavor, not the concept ban). Import bans name concepts,
 * not bands — the extraction's inventory proved the over-reach. `@natalia/
 * collaboration` is deliberately NOT banned: that package hosts
 * InteractiveWaiter (human-in-turn machinery any agent needs); the policy
 * collaboration (Navi/Nia) lives in client's runtime/collaboration and
 * cannot be imported from here anyway (relative paths).
 */
export const SUBSTRATE_PACKAGE_ROOT = "packages/framework/substrate/src/";

const POLICY_PACKAGES_IN_SUBSTRATE = [
  "goal",
  "governance-ledger",
  "work-ledger",
];

export function findSubstratePurityViolation(
  file: string,
  text: string,
): string | undefined {
  // Every file in the extracted package is substrate material (the list
  // grew with the extraction: whole package, not an enumerated subset).
  if (!file.startsWith(SUBSTRATE_PACKAGE_ROOT)) return undefined;
  for (const name of POLICY_PACKAGES_IN_SUBSTRATE)
    if (new RegExp(`from ["']@natalia/${name}["']`, "u").test(text))
      return `substrate core (${file}) imports policy package @natalia/${name} — policy belongs in product-context`;
  return undefined;
}

/**
 * workspace-manager's consumption boundary (decisions §1.2's "产品对
 * composition 的使用者" — audited 2026-09-23: the rewrite target was
 * already met by the intervening rounds, so the clean state is made
 * machine-checkable instead of left to review). The host facade runs
 * pre-runtime and may reach the client ONLY through the composition
 * root (`./runtime/main`); any other client-internal import is
 * assembly sneaking back.
 */
export const WORKSPACE_MANAGER_ALLOWED_RELATIVE = ["./runtime/main"];

export function findWorkspaceManagerBoundaryViolation(
  text: string,
): string | undefined {
  const imports = [...text.matchAll(/(?:from |import\()"(\.\.?\/[^"]+)"/g)]
    .map((match) => match[1]!)
    .filter((spec) => !spec.startsWith("@"));
  for (const spec of imports)
    if (
      !(WORKSPACE_MANAGER_ALLOWED_RELATIVE as readonly string[]).includes(spec)
    )
      return `workspace-manager may only import the composition root (./runtime/main); found ${spec}`;
  return undefined;
}

/**
 * The only .js/.jsx allowed under source trees (default-BAN rule, round
 * 51): compiled artifacts AND ORPHANS (a twin whose .ts MOVED AWAY —
 * exactly how contract-constitution-check's stale compiled test kept
 * running in the full suite after its source left, asserting old logic
 * against a missing module). These six are genuine third-party or
 * platform sources: browser extension entrypoints and vendored wezterm
 * docs assets.
 */
export const ALLOWED_LEGACY_JS = [
  "packages/plugins/browser/src/extension/chromium/background.js",
  "packages/plugins/browser/src/extension/firefox/background.js",
  "packages/plugins/native-terminal/wezterm/deps/freetype/freetype2/docs/markdown/javascripts/extra.js",
  "packages/plugins/native-terminal/wezterm/docs/asciinema-player.min.js",
  "packages/plugins/native-terminal/wezterm/docs/javascript/fix-codeblock-console-copy-button.js",
  "packages/plugins/native-terminal/wezterm/docs/mermaid-init.js",
] as const;

export function findSourceTreeJsViolation(
  relativePath: string,
): string | undefined {
  if (!(relativePath.endsWith(".js") || relativePath.endsWith(".jsx")))
    return undefined;
  if ((ALLOWED_LEGACY_JS as readonly string[]).includes(relativePath))
    return undefined;
  return `${relativePath}: source-tree JS (compiled artifact or orphan — allowed: ALLOWED_LEGACY_JS)`;
}

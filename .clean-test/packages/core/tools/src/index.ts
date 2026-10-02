export { PROCESS_OBSERVER_SERVICE } from "./types";
export { validateToolParameters } from "./validate";
export {
  globWorkspaceFilesBounded,
  grepWorkspaceFilesBounded,
  type WorkspaceGlobInput,
  type WorkspaceGlobResult,
  type WorkspaceGrepInput,
  type WorkspaceGrepMatch,
  type WorkspaceGrepResult,
} from "@anthelia/platform";
export { assertNetworkURL } from "./network";
export {
  requiresForcedGitApproval,
  requiresForcedGitApprovalAst,
  type ForcedApproval,
} from "./forced-approval";
export { runShell } from "./run-shell";
export {
  commandHasPrefix,
  ensureBashCommandParser,
  parseBashCommandRule,
  parseBashSimpleCommand,
  type BashCommandParseResult,
  type BashCommandRule,
  type ParsedBashCommand,
} from "./bash-command-policy";
export { parseToolArguments, tryParseToolArguments } from "./tool-arguments";
export {
  assertValidToolParameters,
  validateToolOutput,
  type ToolParameterError,
} from "./validate";
export {
  createToolPolicyHookLayer,
  type ToolHookEvent,
  type ToolHookResult,
  type ToolHooks,
  type ToolPolicy,
  type ToolPolicyHookLayer,
} from "./tool-policy";
export {
  commandTextForTool,
  evaluatePermissionProfileCommandRules,
  evaluatePermissionRules,
  TerminalCommandBuffer,
  workspaceWritePathForTool,
  workspaceWritePathsForTool,
  type ForegroundProgramProbe,
  type InteractiveProgramAuthorization,
  type PermissionCheck,
  type PermissionProfileCommandRules,
  type PermissionRules,
  type ResourceRule,
  type TerminalCommandBufferResult,
  type TerminalPaneMode,
} from "./permission-policy";
export {
  boundToolOutput,
  cleanupToolOutput,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TOOL_OUTPUT_LINES,
  TOOL_OUTPUT_RETENTION_MS,
  type BoundedToolOutput,
} from "./output";
/**
 * The tool-authoring surface.
 *
 * A tool family is meant to be writable outside this package — that is the point
 * of `ToolFamily` — and every built-in family already uses these helpers to read
 * its arguments. Keeping them private would have forced an out-of-package family
 * to reimplement argument validation, which is how two dialects of "what a bad
 * argument is" appear.
 */
export {
  numberOr,
  optionalInteger,
  optionalString,
  positiveNumberOr,
  positiveNumberOrUndefined,
  requireObject,
  requireString,
  timeoutSecOr,
  workspacePath,
} from "./arguments";
import type { RuntimeTool } from "./types";

export type {
  RuntimeTool,
  SandboxChangeView,
  SandboxManifestView,
  SandboxResourceView,
  SandboxToolService,
  SubagentEventView,
  SubagentOutputView,
  SubagentPhaseView,
  SubagentRecordView,
  SubagentRunnerContext,
  SubagentSpawnOptions,
  SubagentStatusView,
  SubagentStopResult,
  SubagentToolService,
  ManagedProcessNotice,
  ProcessObserverService,
  TerminalSessionView,
  TerminalToolService,
  ToolExecutionBoundary,
  ToolExecutionContext,
  ToolOutputDefinition,
  ToolRenderIntent,
  ToolSchema,
} from "./types";

export {
  encodeTerminalKey,
  nativeTerminalReadPage,
  nativeTerminalSearchPage,
} from "./terminal-io";

export { materializeTools } from "./invocation";
export {
  ToolExecutionPipeline,
  type FrozenToolResult,
  type PipelineRunResult,
  type PostToolDecision,
  type PreToolDecision,
  type ToolExecutionInput,
  type ToolGuard,
} from "./execution-pipeline";
/**
 * Process helpers are part of the tool-authoring surface: shell, process and
 * terminal families all spawn and supervise child processes, and a family
 * written outside this package must not reimplement environment sanitisation,
 * tree termination or output bounding.
 */
export {
  isProcessRunning,
  ownsProcess,
  parseProcStatStartTicks,
  processFingerprint,
  readOptionalFile,
  safeToolEnv,
  sendProcessSignal,
  stopProcessTree,
  terminateChildProcessTree,
  truncateProcessOutput,
} from "./child-process";
export type {
  ToolInvocation,
  ToolMaterialization,
  ToolSettlement,
} from "./invocation";
export class ToolRegistry extends Map<string, RuntimeTool> {
  private readonly aliases = new Map<string, { target: string }>();

  addAlias(alias: string, target: string) {
    if (!super.has(target))
      throw new Error(`cannot alias unknown tool: ${target}`);
    if (super.has(alias) || this.aliases.has(alias))
      throw new Error(`tool alias already registered: ${alias}`);
    const registration = { target };
    this.aliases.set(alias, registration);
    return () => {
      if (this.aliases.get(alias) === registration) this.aliases.delete(alias);
    };
  }

  override get(name: string) {
    return super.get(this.aliases.get(name)?.target ?? name);
  }

  override has(name: string) {
    return super.has(this.aliases.get(name)?.target ?? name);
  }
}

/**
 * A registry over an explicit tool list.
 *
 * There is no implicit default: a caller states which tools it wants, because
 * "the tools you get when you say nothing" is exactly the built-in catalogue this
 * package no longer owns. The host assembles the catalogue from families.
 */
export function createToolRegistry(tools: RuntimeTool[]): ToolRegistry {
  return new ToolRegistry(tools.map((tool) => [tool.name, tool]));
}

const interactiveTerminalToolAliases = {
  interactive_start: "interactive_terminal_start",
  interactive_read: "interactive_terminal_read",
  interactive_search: "interactive_terminal_search",
  interactive_write: "interactive_terminal_write",
  interactive_send_line: "interactive_terminal_send_line",
  interactive_keys: "interactive_terminal_keys",
  interactive_input: "interactive_terminal_input",
  interactive_snapshot: "interactive_terminal_snapshot",
  interactive_resize: "interactive_terminal_resize",
  interactive_stop: "interactive_terminal_stop",
  interactive_list: "interactive_terminal_list",
} as const;

export { interactiveTerminalToolAliases };

/**
 * A tool family: the unit a host loads, and the unit that owns its tools.
 *
 * This is the authoring surface, not a catalogue. The framework composes no
 * families of its own: a family is described by whoever ships it — a
 * `packages/tool-*` package, or the group factories below for the families still
 * living here — and the host decides which ones to load. That is what lets the
 * framework ship without any tools at all.
 *
 * `scope` is the lifetime of the family's tools, spelled with the capability
 * scopes the kernel already understands. It stays a plain string union here:
 * this package must not depend on the kernel to describe its own tools.
 */
export type ToolFamilyScope = "process" | "workspace" | "session";

export type ToolFamily = {
  /** Stable family key, and the suffix of the capability id the host loads it as. */
  id: string;
  name: string;
  version: string;
  description: string;
  scope: ToolFamilyScope;
  tools: RuntimeTool[];
  /** Alternate names for this family's tools, applied by the host's registry. */
  aliases?: Record<string, string>;
  /**
   * Family ids that must be enabled for this family to load. A disabled or
   * unknown dependency refuses the load with the reason stated, instead of a
   * family quietly running half-equipped.
   */
  dependencies?: string[];
};

/**
 * The families whose tools still live in this package.
 *
 * Each one describes itself the way an out-of-package family does, so moving a
 * family into its own `packages/tool-*` package is a move, not a redesign: the
 * host's list of families is the only thing that changes. `todo` already left —
 * see `@natalia/plugin-tool-todo`.
 */

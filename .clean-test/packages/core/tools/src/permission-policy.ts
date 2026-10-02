import { isAbsolute, normalize, relative, resolve } from "node:path";
import {
  commandHasPrefix,
  parseBashCommandRule,
  parseBashSimpleCommand,
} from "./bash-command-policy";
import type { ToolPolicy } from "./tool-policy";
export { createToolPolicyHookLayer } from "./tool-policy";
import type { BashCommandRule } from "./bash-command-policy";

export type ResourceRule = {
  pattern: string;
  allow?: boolean;
  reason?: string;
};

export type PermissionRules = {
  tools?: ToolPolicy;
  files?: {
    readPaths?: ResourceRule[];
    writePaths?: ResourceRule[];
  };
  commands?: {
    allowPatterns?: string[];
    denyPatterns?: string[];
  };
  network?: {
    allowHosts?: string[];
    denyHosts?: string[];
    allowLocalhost?: boolean;
    allowPrivate?: boolean;
  };
  env?: {
    allowlist?: string[];
  };
  redactOutput?: boolean;
};

export type PermissionProfileCommandRules = {
  mode: "blacklist" | "whitelist" | "none";
  rules: BashCommandRule[];
};

export type TerminalCommandBufferResult = PermissionCheck & {
  clearTerminal?: boolean;
};

const TERMINAL_COMMAND_BUFFER_LIMIT = 16 * 1024;

export type PermissionCheck = {
  allowed: boolean;
  reason?: string;
  diagnostics: string[];
};

/**
 * Tools that receive the command to run as an argument, so the command policy
 * reads `command`.
 */
const COMMAND_ARGUMENT_TOOLS = [
  "run_shell",
  "sandbox_execute",
  "sandbox_resource_start",
  "process_start",
  "background_start",
  "interactive_start",
  "interactive_terminal_start",
];

/**
 * Terminal input tools carry the command as terminal input instead of as a
 * command argument. They have to be checked by the same policy: otherwise a
 * model opens a shell once, which is checked, and then feeds every later
 * command through terminal input, which was not. Both the canonical names and
 * the registered aliases are listed because either name can be called.
 */
const TERMINAL_INPUT_TOOLS = [
  "interactive_terminal_write",
  "interactive_terminal_send_line",
  "interactive_terminal_keys",
  "interactive_terminal_input",
  "interactive_write",
  "interactive_send_line",
  "interactive_keys",
  "interactive_input",
];

/**
 * The command text a policy should judge for one tool call, or undefined when
 * the call carries no command. Shell and terminal paths deliberately share this
 * one function so a rule cannot hold on one path and be absent on the other.
 */
export function commandTextForTool(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (COMMAND_ARGUMENT_TOOLS.includes(toolName))
    return typeof args.command === "string" ? args.command : undefined;
  if (!TERMINAL_INPUT_TOOLS.includes(toolName)) return undefined;
  return terminalInputText(args);
}

/**
 * Tools whose `path` argument names a file in the workspace that the call will
 * write. `sandbox_write` is absent on purpose: it writes inside a sandbox, not the
 * workspace. `sandbox_merge` is also absent because a merge does not name its
 * paths in its own arguments — `authorizeSandboxMerge` authorizes each merged path
 * individually and is the only place those paths are known.
 */
const WORKSPACE_WRITE_TOOLS = [
  "write_file",
  "edit_file",
  "apply_edits",
  "browser_screenshot",
];

/**
 * The workspace files one tool call will write, or an empty array when it
 * writes nothing there. `apply_edits` names every path in its structured edits;
 * the path-based write tools name a single `path`.
 *
 * Exported so the permission layer can evaluate each touched path, while
 * `workspaceWritePathForTool` keeps answering the single-path question the
 * write lock, constitution check and Work Graph writer ask.
 */
export function workspaceWritePathsForTool(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  if (toolName === "apply_edits") {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    return edits.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const path = (entry as { path?: unknown }).path;
      return typeof path === "string" && path.trim() ? [path] : [];
    });
  }
  if (!WORKSPACE_WRITE_TOOLS.includes(toolName)) return [];
  return typeof args.path === "string" && args.path.trim() ? [args.path] : [];
}

/**
 * The workspace file one tool call will write, or undefined when the call writes
 * nothing there.
 *
 * Exported so the permission layer, the constitution check and the Work Graph
 * writer all answer "does this call change a workspace file, and which one?" from
 * one place. Three private copies of that list would drift, and the copy that
 * drifted would be the one enforcing policy.
 *
 * `apply_edits` can touch many files, so it reports the whole-workspace scope
 * `"."`: the write lock serialises it like any write, and the mutation registry
 * attributes any workspace change to it.
 */
export function workspaceWritePathForTool(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  const paths = workspaceWritePathsForTool(toolName, args);
  if (!paths.length) return undefined;
  if (toolName === "apply_edits") return ".";
  return paths[0]!;
}

/**
 * Key sequences are joined without a separator because a model can type a
 * command one key at a time, and only the reconstructed string shows what was
 * typed. Separate sources are joined by newline so they cannot merge into a
 * token that neither of them contained.
 */
function terminalInputText(args: Record<string, unknown>): string | undefined {
  const segments: string[] = [];
  if (typeof args.text === "string") segments.push(args.text);
  if (typeof args.input === "string") segments.push(args.input);
  if (typeof args.key === "string") segments.push(args.key);
  if (Array.isArray(args.keys)) {
    const typed: string[] = [];
    for (const entry of args.keys) {
      if (typeof entry === "string") {
        typed.push(entry);
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const key = entry as Record<string, unknown>;
      if (typeof key.text === "string") typed.push(key.text);
      else if (typeof key.key === "string") typed.push(key.key);
    }
    if (typed.length) segments.push(typed.join(""));
  }
  const text = segments.join("\n");
  return text.length ? text : undefined;
}

/**
 * File rules are written as workspace-relative patterns, but a tool resolves
 * its path against the workspace root before touching disk. `secret.txt` and
 * `./secret.txt` are therefore the same file, and matching the raw argument let
 * a rule be evaded by respelling the path. Paths are normalized to the same
 * workspace-relative POSIX form the tool will actually use.
 *
 * Both the normalized and the raw spelling are tested, so this can only ever
 * block more than before, never less.
 */
function policyPathCandidates(path: string, workspaceRoot?: string): string[] {
  const candidates = new Set<string>([path]);
  const slashed = path.replace(/\\/gu, "/");
  candidates.add(slashed);
  if (workspaceRoot) {
    const absolute = resolve(workspaceRoot, path);
    const relativePath = relative(resolve(workspaceRoot), absolute);
    // A path outside the workspace is matched by its absolute form. Tools
    // reject those anyway, but a rule must not silently stop applying.
    candidates.add(
      relativePath &&
        !relativePath.startsWith("..") &&
        !isAbsolute(relativePath)
        ? relativePath.replace(/\\/gu, "/")
        : absolute.replace(/\\/gu, "/"),
    );
  } else {
    candidates.add(normalize(slashed).replace(/\\/gu, "/"));
  }
  for (const candidate of [...candidates])
    if (candidate.startsWith("./")) candidates.add(candidate.slice(2));
  return [...candidates].filter((candidate) => candidate.length > 0);
}

function evaluateResourceRules(
  rules: ResourceRule[],
  path: string,
  workspaceRoot?: string,
): PermissionCheck {
  const candidates = policyPathCandidates(path, workspaceRoot);
  const matches = (rule: ResourceRule) =>
    candidates.some((candidate) => pathMatch(candidate, rule.pattern));
  // Explicit and legacy implicit deny rules win even when a broad allow scope
  // also matches. This lets a module allow `src/**` while protecting secrets.
  const denied = rules.find((rule) => rule.allow !== true && matches(rule));
  if (denied)
    return {
      allowed: false,
      reason: denied.reason ?? "path denied",
      diagnostics: [],
    };
  const allowRules = rules.filter((rule) => rule.allow === true);
  if (allowRules.length && !allowRules.some(matches))
    return {
      allowed: false,
      reason: "path is outside the allowed module scope",
      diagnostics: [],
    };
  return { allowed: true, diagnostics: [] };
}

export function evaluatePermissionRules(
  rules: PermissionRules | undefined,
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot?: string,
): PermissionCheck {
  const diags: string[] = [];
  if (!rules) return { allowed: true, diagnostics: diags };

  // Check tool allow/exclude
  if (rules.tools) {
    const allowP = compilePatterns(rules.tools.allow);
    const excludeP = compilePatterns(rules.tools.exclude);
    if (allowP.length && !allowP.some((p) => p.test(toolName))) {
      diags.push(`tool "${toolName}" not in allow list`);
      return {
        allowed: false,
        reason: "tool blocked by policy",
        diagnostics: diags,
      };
    }
    if (excludeP.some((p) => p.test(toolName))) {
      diags.push(`tool "${toolName}" in exclude list`);
      return {
        allowed: false,
        reason: "tool blocked by policy",
        diagnostics: diags,
      };
    }
  }

  const readsPath = ["read_file", "read_media_file", "glob", "grep"].includes(
    toolName,
  );
  // `sandbox_write` and `sandbox_merge` stay in this check even though they are
  // not workspace writes: a sandbox path is still a path a profile may restrict,
  // and merge arrives here through `authorizeSandboxMerge` with a synthesized
  // per-path argument.
  const writePaths = workspaceWritePathsForTool(toolName, args);
  const writesPath =
    writePaths.length > 0 ||
    ["sandbox_write", "sandbox_merge"].includes(toolName);
  if (rules.files && (readsPath || writesPath)) {
    // A path-based write tool names a single `path`; `apply_edits` names every
    // path in its structured edit list; `sandbox_write` names a sandbox path
    // directly.
    const evaluatedWritePaths =
      writesPath && writePaths.length
        ? writePaths
        : typeof args.path === "string"
          ? [args.path]
          : [];
    const evaluatedReadPaths =
      readsPath && typeof args.path === "string" ? [args.path] : [];
    for (const path of [...evaluatedWritePaths, ...evaluatedReadPaths]) {
      if (writesPath && rules.files.writePaths) {
        const decision = evaluateResourceRules(
          rules.files.writePaths,
          path,
          workspaceRoot,
        );
        if (!decision.allowed) {
          diags.push(`write to "${path}" blocked: ${decision.reason}`);
          return {
            allowed: false,
            reason: decision.reason,
            diagnostics: diags,
          };
        }
      }
      if (readsPath && rules.files.readPaths) {
        const decision = evaluateResourceRules(
          rules.files.readPaths,
          path,
          workspaceRoot,
        );
        if (!decision.allowed) {
          diags.push(`read of "${path}" blocked: ${decision.reason}`);
          return {
            allowed: false,
            reason: decision.reason,
            diagnostics: diags,
          };
        }
      }
    }
  }

  if (rules.commands) {
    const cmd = commandTextForTool(toolName, args);
    if (cmd) {
      const denied = matchesCommandPatterns(cmd, rules.commands.denyPatterns);
      if (denied.error) {
        diags.push(`invalid command deny pattern: ${denied.error}`);
        return {
          allowed: false,
          reason: "command policy configuration is invalid",
          diagnostics: diags,
        };
      }
      if (denied.matches) {
        diags.push(`command matches deny pattern`);
        return {
          allowed: false,
          reason: "command blocked by policy",
          diagnostics: diags,
        };
      }
      const allowed = matchesCommandPatterns(cmd, rules.commands.allowPatterns);
      if (allowed.error) {
        diags.push(`invalid command allow pattern: ${allowed.error}`);
        return {
          allowed: false,
          reason: "command policy configuration is invalid",
          diagnostics: diags,
        };
      }
      if (rules.commands.allowPatterns?.length && !allowed.matches) {
        diags.push(`command does not match any allow pattern`);
        return {
          allowed: false,
          reason: "command blocked by policy",
          diagnostics: diags,
        };
      }
    }
  }

  return { allowed: true, diagnostics: diags };
}

/**
 * Applies the structured command rules written by permission-profile editing.
 * Legacy regular-expression rules remain in `evaluatePermissionRules` for
 * compatibility and are deliberately evaluated before this profile layer.
 */
export async function evaluatePermissionProfileCommandRules(
  rules: PermissionProfileCommandRules | undefined,
  toolName: string,
  args: Record<string, unknown>,
  scope = "profile",
): Promise<PermissionCheck> {
  const diagnostics: string[] = [];
  if (!rules || rules.mode === "none") return { allowed: true, diagnostics };
  const source = commandTextForTool(toolName, args);
  if (!source) return { allowed: true, diagnostics };

  const command = await parseBashSimpleCommand(source);
  if (!command.ok)
    return {
      allowed: false,
      reason: "command blocked by policy",
      diagnostics: [`command could not be parsed safely: ${command.reason}`],
    };

  const parsedRules = await Promise.all(
    rules.rules.map(async (rule) => ({
      rule,
      parsed: await parseBashCommandRule(rule),
    })),
  );
  const invalidRule = parsedRules.find(({ parsed }) => !parsed.ok);
  if (invalidRule)
    return {
      allowed: false,
      reason: "command policy configuration is invalid",
      diagnostics: [
        `invalid ${scope} command rule "${invalidRule.rule.command}": ${parseFailureReason(invalidRule.parsed)}`,
      ],
    };
  const matched = parsedRules.find(
    ({ parsed }) =>
      parsed.ok && commandHasPrefix(command.command, parsed.command),
  );
  if (rules.mode === "blacklist" && matched)
    return {
      allowed: false,
      reason: "command blocked by policy",
      diagnostics: [
        `command matches ${scope} deny rule "${matched.rule.command}"${matched.rule.reason ? `: ${matched.rule.reason}` : ""}`,
      ],
    };
  if (rules.mode === "whitelist" && !matched)
    return {
      allowed: false,
      reason: "command blocked by policy",
      diagnostics: [`command does not match any ${scope} allow rule`],
    };
  return { allowed: true, diagnostics };
}

/**
 * Interactive-program mode.
 *
 * A pane only leaves Bash-command mode when an explicitly authorized launch
 * command prefix was submitted and the operating system confirms that the
 * launched program is the pane's foreground process. The mode is never inferred
 * from the screen, the prompt or a model claim, and it ends the moment the
 * foreground is confirmed to be something else. When the foreground cannot be
 * confirmed at all, input is refused instead of being sent raw.
 */
export type InteractiveProgramAuthorization = {
  allowAny?: boolean;
  allow: readonly BashCommandRule[];
};

type EffectiveInteractiveProgramAuthorization = {
  allowAny: boolean;
  allow: readonly BashCommandRule[];
};

export type ForegroundProgramProbe =
  | { supported: false; reason: string }
  | { supported: true; process: { pid: number; name: string } | undefined };

export type TerminalPaneMode =
  | { mode: "bash" }
  | { mode: "pending_program"; program: string; launch: string }
  | {
      mode: "interactive_program";
      program: string;
      launch: string;
      pid: number;
    };

/** Keeps one unsubmitted Bash line per managed pane for structured profiles. */
export class TerminalCommandBuffer {
  #lines = new Map<string, string>();
  #modes = new Map<string, TerminalPaneMode>();
  #foreground?: (paneID: string) => Promise<ForegroundProgramProbe>;

  constructor(
    options: {
      foregroundProgram?: (paneID: string) => Promise<ForegroundProgramProbe>;
    } = {},
  ) {
    this.#foreground = options.foregroundProgram;
  }

  clear(id: string): void {
    this.#lines.delete(id);
    this.#modes.delete(id);
  }

  clearAll(): void {
    this.#lines.clear();
    this.#modes.clear();
  }

  paneMode(id: string): TerminalPaneMode {
    return this.#modes.get(id) ?? { mode: "bash" };
  }

  async evaluate(
    rules:
      | PermissionProfileCommandRules
      | readonly PermissionProfileCommandRules[]
      | undefined,
    toolName: string,
    args: Record<string, unknown>,
    interactivePrograms:
      | InteractiveProgramAuthorization
      | readonly (InteractiveProgramAuthorization | undefined)[]
      | undefined = undefined,
  ): Promise<TerminalCommandBufferResult | undefined> {
    const activeRules = (Array.isArray(rules) ? rules : [rules]).filter(
      (rule): rule is PermissionProfileCommandRules =>
        Boolean(rule) && rule.mode !== "none",
    );
    const authorizedPrograms =
      interactiveProgramAuthorization(interactivePrograms);
    if (
      !activeRules.length &&
      !authorizedPrograms.allowAny &&
      !authorizedPrograms.allow.length
    )
      return undefined;
    const input = terminalCommandInput(toolName, args);
    if (!input) return undefined;
    if (!input.id)
      return denyTerminalBuffer("terminal command policy requires a pane id");
    const resolved = await this.resolvePaneMode(input.id, authorizedPrograms);
    if (resolved) return resolved;
    if (this.paneMode(input.id).mode === "interactive_program") {
      // The authorized program owns the pane, so its input follows the program's
      // own protocol rather than Bash syntax. Nothing is buffered or parsed.
      this.#lines.delete(input.id);
      return { allowed: true, diagnostics: [] };
    }
    if (input.unsupported) {
      this.clear(input.id);
      return denyTerminalBuffer(input.unsupported, true);
    }
    const line = `${this.#lines.get(input.id) ?? ""}${input.text}`;
    if (
      new TextEncoder().encode(line).byteLength > TERMINAL_COMMAND_BUFFER_LIMIT
    ) {
      this.clear(input.id);
      return denyTerminalBuffer(
        `terminal command buffer exceeded ${TERMINAL_COMMAND_BUFFER_LIMIT} bytes`,
        true,
      );
    }
    if (!input.submit) {
      this.#lines.set(input.id, line);
      return { allowed: true, diagnostics: [] };
    }
    this.#lines.delete(input.id);
    for (const [index, rules] of activeRules.entries()) {
      const check = await evaluatePermissionProfileCommandRules(
        rules,
        "run_shell",
        { command: line },
        index === 0 ? "profile" : "active module",
      );
      if (!check.allowed) return { ...check, clearTerminal: true };
    }
    // The command passed policy. If it also launches an authorized interactive
    // program, the pane waits for the operating system to confirm the takeover;
    // until then input stays under Bash policy.
    const launch = await authorizedLaunch(line, authorizedPrograms);
    if (launch)
      this.#modes.set(input.id, {
        mode: "pending_program",
        program: launch.program,
        launch: launch.launch,
      });
    return { allowed: true, diagnostics: [] };
  }

  /**
   * Confirms or retires the pane's interactive-program mode before any input is
   * considered. Returns a denial when the mode exists but cannot be confirmed.
   */
  private async resolvePaneMode(
    paneID: string,
    authorizedPrograms: EffectiveInteractiveProgramAuthorization,
  ): Promise<TerminalCommandBufferResult | undefined> {
    const current = this.#modes.get(paneID);
    if (!current || current.mode === "bash") return undefined;
    if (!authorizedPrograms.allowAny && !authorizedPrograms.allow.length) {
      // The authorization disappeared, for example on a module switch.
      this.#modes.delete(paneID);
      return undefined;
    }
    if (!this.#foreground) {
      this.#modes.delete(paneID);
      return current.mode === "interactive_program"
        ? denyTerminalBuffer(
            `interactive program ${current.program} cannot be confirmed on this host`,
            true,
          )
        : undefined;
    }
    const probe = await this.#foreground(paneID);
    if (!probe.supported) {
      this.#modes.delete(paneID);
      return current.mode === "interactive_program"
        ? denyTerminalBuffer(
            `interactive program ${current.program} cannot be confirmed: ${probe.reason}`,
            true,
          )
        : undefined;
    }
    if (probe.process && programMatches(probe.process.name, current.program)) {
      this.#modes.set(paneID, {
        mode: "interactive_program",
        program: current.program,
        launch: current.launch,
        pid: probe.process.pid,
      });
      return undefined;
    }
    // The operating system confirms the program is no longer in the foreground,
    // which is the only accepted way to return to Bash policy.
    this.#modes.delete(paneID);
    return undefined;
  }
}

function interactiveProgramAuthorization(
  input:
    | InteractiveProgramAuthorization
    | readonly (InteractiveProgramAuthorization | undefined)[]
    | undefined,
): EffectiveInteractiveProgramAuthorization {
  const groups = (Array.isArray(input) ? input : [input]).filter(
    (group): group is InteractiveProgramAuthorization =>
      Boolean(group && (group.allowAny || group.allow?.length)),
  );
  if (!groups.length) return { allowAny: false, allow: [] };
  // A module can only narrow the profile, never widen it, so an interactive
  // program must be allowed by every configured layer.
  return groups.reduce<EffectiveInteractiveProgramAuthorization>(
    (effective, group, index) => {
      if (index === 0)
        return { allowAny: group.allowAny === true, allow: group.allow };
      if (effective.allowAny)
        return { allowAny: group.allowAny === true, allow: group.allow };
      if (group.allowAny) return effective;
      return {
        allowAny: false,
        allow: effective.allow.filter((rule) =>
          group.allow.some((other) => other.command === rule.command),
        ),
      };
    },
    { allowAny: false, allow: [] },
  );
}

async function authorizedLaunch(
  line: string,
  authorization: EffectiveInteractiveProgramAuthorization,
): Promise<{ program: string; launch: string } | undefined> {
  if (!authorization.allowAny && !authorization.allow.length) return undefined;
  const command = await parseBashSimpleCommand(line);
  if (!command.ok) return undefined;
  if (authorization.allowAny) {
    const executable = command.command.tokens[0]!;
    return {
      program: executable.split("/").pop() ?? executable,
      launch: line,
    };
  }
  for (const rule of authorization.allow) {
    const parsed = await parseBashCommandRule(rule);
    if (!parsed.ok) continue;
    if (!commandHasPrefix(command.command, parsed.command)) continue;
    const program = parsed.command.tokens[0]!;
    return {
      program: program.split("/").pop() ?? program,
      launch: rule.command,
    };
  }
  return undefined;
}

function programMatches(foreground: string, program: string) {
  return foreground === program || foreground === program.slice(0, 15);
}

function denyTerminalBuffer(
  diagnostic: string,
  clearTerminal = false,
): TerminalCommandBufferResult {
  return {
    allowed: false,
    reason: "command blocked by policy",
    diagnostics: [diagnostic],
    clearTerminal,
  };
}

type TerminalCommandInput = {
  id?: string;
  text: string;
  submit: boolean;
  unsupported?: string;
};

function terminalCommandInput(
  toolName: string,
  args: Record<string, unknown>,
): TerminalCommandInput | undefined {
  if (!TERMINAL_INPUT_TOOLS.includes(toolName)) return undefined;
  const id = typeof args.id === "string" ? args.id : undefined;
  if (
    toolName === "interactive_terminal_send_line" ||
    toolName === "interactive_send_line"
  )
    return terminalCommandText(id, args.text, true);
  if (
    toolName === "interactive_terminal_write" ||
    toolName === "interactive_write"
  )
    return terminalCommandText(id, args.input, false);
  if (
    toolName === "interactive_terminal_input" ||
    toolName === "interactive_input"
  ) {
    if (args.paste)
      return {
        id,
        text: "",
        submit: false,
        unsupported:
          "terminal paste is not allowed while command rules are active",
      };
    if (typeof args.text === "string")
      return terminalCommandText(id, args.text, args.submit !== false);
  }
  return terminalCommandKeys(id, args);
}

function terminalCommandText(
  id: string | undefined,
  value: unknown,
  submit: boolean,
): TerminalCommandInput {
  if (typeof value !== "string")
    return {
      id,
      text: "",
      submit: false,
      unsupported: "terminal command input must be text",
    };
  if (/\r|\n/u.test(value))
    return {
      id,
      text: "",
      submit: false,
      unsupported:
        "terminal command input cannot contain a newline while command rules are active",
    };
  return { id, text: value, submit };
}

function terminalCommandKeys(
  id: string | undefined,
  args: Record<string, unknown>,
): TerminalCommandInput {
  const entries = Array.isArray(args.keys)
    ? args.keys
    : args.key === undefined
      ? []
      : [{ key: args.key, modifiers: args.modifiers }];
  let text = "";
  let submit = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object")
      return {
        id,
        text: "",
        submit: false,
        unsupported: "terminal command keys must be structured entries",
      };
    const key = entry as Record<string, unknown>;
    if (Array.isArray(key.modifiers) && key.modifiers.length)
      return {
        id,
        text: "",
        submit: false,
        unsupported:
          "terminal modified keys are not allowed while command rules are active",
      };
    if (typeof key.text === "string") {
      if (/\r|\n/u.test(key.text))
        return {
          id,
          text: "",
          submit: false,
          unsupported:
            "terminal command input cannot contain a newline while command rules are active",
        };
      text += key.text;
      continue;
    }
    if (key.key === "Enter" || key.key === "return") {
      submit = true;
      continue;
    }
    if (typeof key.key === "string" && Array.from(key.key).length === 1) {
      text += key.key;
      continue;
    }
    return {
      id,
      text: "",
      submit: false,
      unsupported:
        "terminal control keys are not allowed while command rules are active",
    };
  }
  return { id, text, submit };
}

function parseFailureReason(
  result: Awaited<ReturnType<typeof parseBashCommandRule>>,
): string {
  return result.ok ? "unknown parser failure" : result.reason;
}

function pathMatch(path: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/\\\*/gu, ".*");
  return new RegExp(`^${escaped}$`, "u").test(path);
}

function matchesCommandPatterns(command: string, patterns?: string[]) {
  try {
    return {
      matches:
        patterns?.some((pattern) => new RegExp(pattern, "iu").test(command)) ??
        false,
    };
  } catch (error) {
    return {
      matches: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function compilePatterns(patterns?: string[]): RegExp[] {
  if (!patterns || patterns.length === 0) return [];
  return patterns.map((p) => {
    const escaped = p
      .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
      .replace(/\\\*/gu, ".*");
    return new RegExp(`^${escaped}$`, "u");
  });
}

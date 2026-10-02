/**
 * The shell tool family, as a separately packaged family.
 *
 * Depends on the framework for the tool-authoring surface and process helpers.
 * The `runShell` execution primitive it wraps lives in `@anthelia/tools` so other
 * tool plugins (notably `@natalia/plugin-tool-web`) can run commands without depending
 * on this package. It knows nothing about the runtime or the capability kernel.
 */
import type { Plugin, PluginManifest } from "@anthelia/plugin";
import {
  requireObject,
  requireString,
  runShell,
  timeoutSecOr,
} from "@anthelia/tools";
import type { RuntimeTool, ToolFamily } from "@anthelia/tools";
import type { ConfinementMode } from "@anthelia/confinement";
import {
  ESCALATION_TARGETS,
  WIDER_MODES,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
} from "@anthelia/confinement";

export { runShell };

/** How a kernel file denial reads in captured output, across locales. */
const DENIAL_PATTERN =
  /permission denied|operation not permitted|\u6743\u9650\u4e0d\u591f/iu;

export const SHELL_PLUGIN_ID = "natalia-tool-shell";
export const RUN_SHELL_DEFAULT_TIMEOUT_SEC = 120;
export const RUN_SHELL_MAX_TIMEOUT_SEC = 1800;

function runShellTool(): RuntimeTool {
  return {
    name: "run_shell",
    description:
      "Run a shell command inside the workspace with output capture. The shell is always bash-compatible (Git Bash on Windows, native bash on Linux/Mac) — use POSIX syntax, not cmd.exe. For long-running commands, set timeoutSec; the default is 120 seconds and the maximum is 1800 seconds.",
    requiresApproval: true,
    timeoutSec: RUN_SHELL_DEFAULT_TIMEOUT_SEC,
    maxTimeoutSec: RUN_SHELL_MAX_TIMEOUT_SEC,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutSec: {
          type: "number",
          description:
            "Optional timeout in seconds for this command. Defaults to 120; values above 1800 are clamped to 1800.",
        },
        sandbox_permissions: {
          type: "string",
          enum: [...ESCALATION_TARGETS],
          description:
            "Optional. Run this one call under a sandbox mode strictly wider than the current one — applied only to this call and only after the user approves. Must travel with justification.",
        },
        justification: {
          type: "string",
          description:
            "Optional. One sentence explaining why the wider mode is needed. Travels with sandbox_permissions: both or neither.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    // The pilot output definition: the result is a terminal session card, so a
    // client draws the command with its exit status instead of a raw blob.
    output: {
      schema: {
        type: "object",
        properties: {
          stdout: { type: "string" },
          stderr: { type: "string" },
          exitCode: { type: "number" },
        },
        required: ["stdout", "stderr", "exitCode"],
        additionalProperties: false,
      },
      presentCall(args) {
        const command = requireObject(args).command as string | undefined;
        return {
          kind: "terminal",
          title: typeof command === "string" ? command : "command",
          summary: "run",
        };
      },
      presentResult(args, value) {
        const command = requireObject(args).command as string | undefined;
        const stdout =
          value.match(/stdout:\n([\s\S]*?)(?:\nstderr:|\n?$)/u)?.[1] ?? "";
        const stderr = value.match(/stderr:\n([\s\S]*?)$/u)?.[1] ?? "";
        const exitCode = Number(/exit=(-?\d+)/u.exec(value)?.[1] ?? "0");
        return {
          kind: "terminal",
          title: typeof command === "string" ? command : "command",
          summary: `exit ${exitCode}`,
          body: [stdout, stderr && `stderr:\n${stderr}`]
            .filter(Boolean)
            .join("\n"),
          meta: [["exit", String(exitCode)]],
        };
      },
    },
    async execute(input, context) {
      const args = requireObject(input);
      const timeoutSec =
        context.timeoutSec ??
        timeoutSecOr(
          args.timeoutSec,
          RUN_SHELL_DEFAULT_TIMEOUT_SEC,
          RUN_SHELL_MAX_TIMEOUT_SEC,
        );
      const requested =
        args.sandbox_permissions === undefined
          ? undefined
          : requireString(args.sandbox_permissions, "sandbox_permissions");
      const justification =
        args.justification === undefined
          ? undefined
          : requireString(args.justification, "justification");
      validateEscalationArgs(requested, justification);
      // A hand-built context with no resolved mode behaves unconfined — the
      // same rule runShell applies — so escalation judges against danger.
      const effectiveMode: ConfinementMode =
        context.confinement ?? "danger-full-access";
      const confinement =
        requested === undefined
          ? effectiveMode
          : await approveEscalation(
              {
                requestedMode: requested as ConfinementMode,
                justification: justification ?? "",
                effectiveMode,
                subject: "command",
              },
              { approver: context.sandboxApprover, toolName: "run_shell" },
            );
      try {
        return await runShell(
          requireString(args.command, "command"),
          { ...context, confinement },
          timeoutSec,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          confinement !== "danger-full-access" &&
          DENIAL_PATTERN.test(message)
        ) {
          // The kernel refused a write inside a confined call: name the mode
          // the way every sandbox-enforcing family names it, and offer the
          // sanctioned retry only while a wider mode actually exists.
          const hint =
            WIDER_MODES[confinement].length > 0
              ? `\n${escalationHintMarker("command")}`
              : "";
          throw new Error(
            `${message}\n${sandboxDenialMarker(confinement)}${hint}`,
          );
        }
        throw error;
      }
    },
  };
}

export const shellTools: RuntimeTool[] = [runShellTool()];

/**
 * Session scope: a shell command only runs while the session that submitted it
 * is alive.
 */
export function shellToolFamily(): ToolFamily {
  return {
    id: "shell",
    name: "Shell Tools",
    version: "1.0.0",
    description: "One-shot command execution.",
    scope: "session",
    tools: shellTools,
  };
}

export const SHELL_PLUGIN_MANIFEST: PluginManifest = {
  apiVersion: 2,
  id: SHELL_PLUGIN_ID,
  version: "1.0.0",
  name: "Shell Tools",
  description: "One-shot command execution.",
  entry: "index.js",
  scope: "session",
  provides: [],
  requires: [],
  optionalRequires: [],
  conflicts: [],
  dependencies: [],
  hooks: {},
  integrationPoints: ["tools"],
};

export function createShellPlugin(): Plugin {
  return {
    manifest: SHELL_PLUGIN_MANIFEST,
    setup(api) {
      for (const tool of shellTools) api.tools.register(tool);
    },
  };
}

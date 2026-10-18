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

/**
 * The managed-process registry, as `run_shell` needs it for
 * `run_in_background` — the port, not the plugin.
 *
 * The process plugin already publishes this service under
 * `managedProcessRegistry`; the shell plugin reads it through the seam the
 * capability kernel exposes, so one plugin never imports another. Only the two
 * methods a background hand-off needs are named here, and a registry that
 * predates one simply does not answer it.
 */
export const MANAGED_PROCESS_REGISTRY_SERVICE = "managedProcessRegistry";

export type BackgroundProcessPort = {
  start(
    command: string,
    context: unknown,
    id?: string,
    options?: {
      readyPattern?: string;
      maxOutputBytes?: number;
      stopTimeoutMs?: number;
      maxRuntimeMs?: number;
    },
  ): Promise<{ id: string; pid?: number; status: string; output?: string }>;
};

/**
 * What `run_in_background` answers with — a typed handle, not an id dug out of
 * JSON.
 *
 * The model asked for a background run; the answer it needs is the name it can
 * hand to `process_output` / `process_wait` / `process_stop`, plus what it must
 * do instead of reading output here. The `<kind>-<n>` spelling is the one the
 * process family already uses (`proc_3`), so a reader sees the same handle in
 * the tool result, the notice and the status panel.
 */
export type BackgroundHandle = {
  kind: "background";
  jobId: string;
  command: string;
  description: string;
  /** Where the output goes, and how to read it. */
  note: string;
};

function runShellTool(
  options: {
    background?: () => BackgroundProcessPort | undefined;
  } = {},
): RuntimeTool {
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
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
        // A required, human-facing one-liner the model writes per call. Its
        // whole job is the UI row: a collapsed tool row shows this sentence,
        // never the raw command — the same contract the bash/pwsh tools
        // declare. The examples are part of the schema so the shape is not
        // left to chance.
        description: {
          type: "string",
          description:
            "Clear, concise description of what this command does in active voice, 5-10 words " +
            '(shown in the UI). Examples: "ls" → "List files in current directory"; ' +
            '"git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
        },
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
        run_in_background: {
          type: "boolean",
          description:
            "Optional. Start the command as a managed background process instead of waiting for it. The answer is a handle ({kind: 'background', jobId}) — read it with process_output, wait for it with process_wait, stop it with process_stop. Use it for a server, a watch, or anything slower than the timeout you would have to guess; a foreground run that outlives its timeout is killed.",
        },
      },
      required: ["command", "description"],
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
        const parsed = requireObject(args);
        const command = parsed.command as string | undefined;
        const description = parsed.description as string | undefined;
        return {
          kind: "terminal",
          title: typeof command === "string" ? command : "command",
          // The model's sentence is the collapsed row's resident label; the
          // command is what the expanded card shows.
          summary: typeof description === "string" ? description : "run",
        };
      },
      presentResult(args, value) {
        const parsed = requireObject(args);
        const command = parsed.command as string | undefined;
        const description = parsed.description as string | undefined;
        // A background hand-off answers with a handle, not with output: the
        // row must say so plainly instead of showing an empty card and letting
        // a reader conclude the command printed nothing.
        const handle = backgroundHandleOf(value);
        if (handle)
          return {
            kind: "generic",
            title: handle.command,
            summary: `running in the background as ${handle.jobId}`,
            body: handle.note,
            meta: [["background", handle.jobId]],
          };
        const stdout =
          value.match(/stdout:\n([\s\S]*?)(?:\nstderr:|\n?$)/u)?.[1] ?? "";
        const stderr = value.match(/stderr:\n([\s\S]*?)$/u)?.[1] ?? "";
        // The exit status the command really reported. This used to default to
        // "0", so a result carrying no parseable exit (a signal death reads
        // `exit=null`) showed a confident success pill; it now reads "?" and
        // the row is marked failed.
        const exit = /exit=(-?\d+)/u.exec(value)?.[1] ?? "?";
        return {
          kind: "terminal",
          title: typeof command === "string" ? command : "command",
          // The sentence the model wrote survives the completed state — the
          // exit status is a PILL, not prose, so it must not evict the label.
          summary:
            typeof description === "string" ? description : "shell command",
          body: [stdout, stderr && `stderr:\n${stderr}`]
            .filter(Boolean)
            .join("\n"),
          ...(exit === "?" ? {} : { exitCode: Number(exit) }),
          meta: [["exit", exit]],
        };
      },
    },
    async execute(input, context) {
      const args = requireObject(input);
      // The description is required, so a model that omits it gets a complete
      // error naming the field — never a silently label-less card.
      const description = requireString(args.description, "description");
      if (description.trim().length === 0)
        throw new Error("invalid description: expected a non-empty string");
      if (args.run_in_background === true) {
        // A background run is a hand-off to the process registry, which owns
        // the handle, the output file, the settlement notice and the tree kill.
        // Without that service the honest answer is a refusal naming what is
        // missing — never a foreground run the model did not ask for.
        const port = options.background?.();
        if (!port)
          throw new Error(
            "run_in_background needs the managed-process registry, which this runtime does not provide (the process tool family is not loaded). Run the command in the foreground with a timeoutSec, or enable the process tools.",
          );
        const command = requireString(args.command, "command");
        const started = await port.start(command, context);
        const handle: BackgroundHandle = {
          kind: "background",
          jobId: started.id,
          command,
          description,
          note:
            `started as ${started.id}${started.pid ? ` (pid ${started.pid})` : ""}. ` +
            "Read it with process_output, wait for it with process_wait, stop it with process_stop. " +
            "Its settlement arrives as a notice when it ends.",
        };
        return JSON.stringify(handle);
      }
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
      /**
       * The refusal a confined call earns when the kernel stopped it.
       *
       * A denial is a REFUSAL, not a command answer: the command started and the
       * sandbox stopped it, and the caller has to be told that a wider mode
       * exists. It is named the way every sandbox-enforcing family names it, and
       * the sanctioned retry rides along only while a wider mode actually exists.
       */
      const denialRefusal = (text: string, mode: ConfinementMode) => {
        const hint =
          WIDER_MODES[mode].length > 0
            ? `\n${escalationHintMarker("command")}`
            : "";
        return new Error(`${text}\n${sandboxDenialMarker(mode)}${hint}`);
      };
      let result: string;
      try {
        result = await runShell(
          requireString(args.command, "command"),
          { ...context, confinement },
          timeoutSec,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          confinement !== "danger-full-access" &&
          DENIAL_PATTERN.test(message)
        )
          throw denialRefusal(message, confinement);
        throw error;
      }
      // The SAME classification for a denial that came back as a result. A
      // non-zero exit is the command's own answer now, so a sandboxed write the
      // kernel refused reaches here instead of the catch above — and when the
      // hint lived only in the catch, it silently stopped being offered.
      if (confinement !== "danger-full-access" && DENIAL_PATTERN.test(result))
        throw denialRefusal(result, confinement);
      return result;
    },
  };
}

/** The typed background handle an answer carries, when it is one. */
export function backgroundHandleOf(
  value: string,
): BackgroundHandle | undefined {
  try {
    const decoded = JSON.parse(value) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
      return undefined;
    const record = decoded as Record<string, unknown>;
    if (record.kind !== "background") return undefined;
    if (typeof record.jobId !== "string" || !record.jobId) return undefined;
    if (typeof record.command !== "string") return undefined;
    return {
      kind: "background",
      jobId: record.jobId,
      command: record.command,
      description:
        typeof record.description === "string" ? record.description : "",
      note: typeof record.note === "string" ? record.note : "",
    };
  } catch {
    return undefined;
  }
}

export const shellTools: RuntimeTool[] = [runShellTool()];

/**
 * Session scope: a shell command only runs while the session that submitted it
 * is alive.
 *
 * `background` is the managed-process registry the plugin resolved from the
 * service seam; absent it, `run_in_background` refuses rather than silently
 * running in the foreground.
 */
export function shellToolFamily(
  background?: () => BackgroundProcessPort | undefined,
): ToolFamily {
  return {
    id: "shell",
    name: "Shell Tools",
    version: "1.0.0",
    description: "One-shot command execution.",
    scope: "session",
    tools: background ? [runShellTool({ background })] : shellTools,
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
  // The managed-process registry, when the process tool family is loaded.
  // Optional on purpose: `run_shell` is useful without it, and the background
  // hand-off refuses with a reason when it is missing.
  optionalRequires: [MANAGED_PROCESS_REGISTRY_SERVICE],
  conflicts: [],
  dependencies: [],
  hooks: {},
  integrationPoints: ["tools"],
};

export function createShellPlugin(): Plugin {
  return {
    manifest: SHELL_PLUGIN_MANIFEST,
    setup(api) {
      for (const tool of shellToolFamily(() =>
        api.services.get<BackgroundProcessPort>(
          MANAGED_PROCESS_REGISTRY_SERVICE,
        ),
      ).tools)
        api.tools.register(tool);
    },
  };
}

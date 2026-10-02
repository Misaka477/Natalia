/**
 * Tools that spawn and supervise subagents.
 */
/**
 * Tools that spawn and supervise subagents.
 *
 * A subagent is another turn-taking runtime with its own budget, so spawning,
 * stopping and retrying all require approval while observing does not. Depth is
 * bounded by the execution context rather than by these tools, because the limit
 * has to hold across a chain of agents, not per call.
 */
import {
  numberOr,
  optionalString,
  requireObject,
  requireString,
} from "@anthelia/tools";
import type {
  RuntimeTool,
  SubagentToolService,
  ToolExecutionContext,
  ToolFamily,
  ToolOutputDefinition,
} from "@anthelia/tools";

import {
  renderSubagentTypes,
  resolveSubagentType,
  type SubagentTypeView,
} from "./agent-types";

export const SUBAGENT_WAIT_UNTIL = ["all_terminal", "any_terminal"] as const;

function requireSubagents(context: ToolExecutionContext) {
  if (!context.subagents) throw new Error("subagent runtime unavailable");
  return context.subagents;
}

function agentSpawnTool(agentTypes: readonly SubagentTypeView[]): RuntimeTool {
  // Rendered once at registration and refreshed on config reload: the request
  // builder reads `description` per step, so updating it in place keeps the
  // advertised types current without disturbing the tool's identity.
  const description = [
    "Spawn an isolated TS/Bun subagent task.",
    "You keep working after the spawn: when the child ends (completed, " +
      "failed, or stopped) a settlement notice tells you what it " +
      "concluded, so you do not need to block on agent_wait.",
    renderSubagentTypes(agentTypes),
  ]
    .filter(Boolean)
    .join("\n");
  return {
    name: "agent_spawn",
    description,
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
        // A configured agent type; its tool restrictions apply unless the call
        // overrides them explicitly.
        type: { type: "string" },
        // Whether the child inherits this conversation. `fork` seeds it with the
        // completed turns only; `fresh` gives it nothing but the task.
        context: { type: "string", enum: ["fresh", "fork"] },
        mode: { type: "string" },
        modelProfile: { type: "string" },
        allowedTools: { type: "array", items: { type: "string" } },
        excludeTools: { type: "array", items: { type: "string" } },
        writePaths: { type: "array", items: { type: "string" } },
      },
      required: ["task"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { taskID: { type: "string" } },
        required: ["taskID"],
        additionalProperties: false,
      },
      presentCall(args) {
        return {
          kind: "generic",
          title: requireObject(args).task as string,
          summary: "spawn",
        };
      },
      presentResult(_args, value) {
        const result = JSON.parse(value) as {
          id?: string;
          taskID?: string;
        } | null;
        const taskID = result?.taskID ?? result?.id;
        return {
          kind: "generic",
          title: "subagent",
          summary: taskID ? `spawned ${taskID}` : "spawned",
          meta: taskID ? [["taskID", taskID]] : [],
        };
      },
    },
    async execute(input, context) {
      const args = requireObject(input);
      const array = (value: unknown) =>
        Array.isArray(value) ? value.map((item) => String(item)) : undefined;
      // An unknown type throws rather than falling back to a general subagent:
      // a caller that asked for a read-only explorer and got a full implementer
      // has not been served, and nothing downstream would say so.
      const requestedType = optionalString(args.type);
      const agentType = requestedType
        ? resolveSubagentType(requestedType, agentTypes)
        : undefined;
      const record = await requireSubagents(context).spawn(
        requireString(args.task, "task"),
        {
          mode: optionalString(args.mode),
          ...(agentType ? { agentType: agentType.name } : {}),
          context:
            args.context === "fork"
              ? "fork"
              : args.context === "fresh"
                ? "fresh"
                : undefined,
          modelProfile: optionalString(args.modelProfile),
          // The type's restrictions are the default; an explicit argument still
          // wins, so a caller can widen a type deliberately.
          allowedTools:
            array(args.allowedTools) ?? agentType?.allowedTools?.slice(),
          excludeTools:
            array(args.excludeTools) ??
            (agentType?.excludedTools
              ? agentType.excludedTools.slice()
              : undefined),
          writePaths: array(args.writePaths),
          signal: context.signal,
          parentSessionID: context.parentSessionID,
          parentAgentID: context.parentAgentID,
          maxDepth: context.maxSubagentDepth,
        },
      );
      // Only the id: that is what the declared output says, and it is all the
      // caller needs to act on the spawn. Returning the whole record instead
      // would make the declaration false, and the execution boundary checks it.
      // The full state is one `agent_status` away.
      return JSON.stringify({ taskID: record.id }, null, 2);
    },
  };
}

function agentListTool(): RuntimeTool {
  return agentRegistryTool(
    "agent_list",
    "List TS/Bun subagents.",
    false,
    async (registry) => await registry.formatList(),
    false,
    {},
    () => ({
      kind: "generic",
      title: "subagents",
      summary: "list",
      meta: [["collapsible", "true"]],
    }),
    (_args, value) => ({
      kind: "generic",
      title: "subagents",
      summary: `listed ${subagentListCount(value)}`,
    }),
  );
}

function agentStatusTool(): RuntimeTool {
  return agentRegistryTool(
    "agent_status",
    "Show TS/Bun subagent status.",
    false,
    async (registry, args) =>
      await registry.formatStatus(requireString(args.id, "id")),
    true,
    {},
    idCall("check", true),
    (args, value) => ({
      kind: "generic",
      title: requireString(requireObject(args).id, "id"),
      summary: `status ${/\[([^\]]+)\]/u.exec(value)?.[1] ?? "unknown"}`,
    }),
  );
}

function agentOutputTool(): RuntimeTool {
  return agentRegistryTool(
    "agent_output",
    "Show the concise final result of a TS/Bun subagent. Set verbose=true only when the full audit log is required.",
    false,
    async (registry, args) =>
      await registry.formatOutput(
        requireString(args.id, "id"),
        args.verbose === true,
      ),
    true,
    { verbose: { type: "boolean" } },
    idCall("read output", true),
    (args) => ({
      kind: "generic",
      title: requireString(requireObject(args).id, "id"),
      summary: "output read",
    }),
  );
}

function agentStopTool(): RuntimeTool {
  return agentRegistryTool(
    "agent_stop",
    "Stop a running TS/Bun subagent.",
    true,
    async (registry, args) => {
      const id = requireString(args.id, "id");
      const force = args.force === true;
      const result = registry.requestStop(
        id,
        requireString(args.reason, "reason"),
        force,
      );
      switch (result.outcome) {
        case "stopped":
          return force
            ? `Stopped ${id} (force interrupted an active agent)`
            : `Stopped ${id}`;
        case "protected":
          return `Protected ${id}`;
        case "not_found":
          return "Agent not found";
        case "not_running":
          return "Agent is not running";
      }
    },
    true,
    {
      reason: { type: "string" },
      force: { type: "boolean" },
    },
    idCall("stop"),
    (args, value) => ({
      kind: "generic",
      title: requireString(requireObject(args).id, "id"),
      summary: value.startsWith("Stopped ")
        ? value.includes("force interrupted")
          ? "force stopped · interrupted active agent"
          : "stopped"
        : value.startsWith("Protected ")
          ? "protected · agent still active"
          : value === "Agent not found"
            ? "not found"
            : "not running",
    }),
    ["id", "reason"],
  );
}

function agentResumeTool(): RuntimeTool {
  return agentRegistryTool(
    "agent_resume",
    "Resume a paused subagent only while its owning runtime remains active.",
    false,
    async (registry, args) =>
      (await registry.resume(requireString(args.id, "id")))
        ? "resumed"
        : "subagent is not paused",
    true,
    {},
    idCall("resume"),
    (args, value) => ({
      kind: "generic",
      title: requireString(requireObject(args).id, "id"),
      summary: value === "resumed" ? "resumed" : "not paused",
    }),
  );
}

function agentRetryTool(): RuntimeTool {
  return agentRegistryTool(
    "agent_retry",
    "Retry a stopped or failed subagent as an explicit new continuation.",
    true,
    async (registry, args) => {
      const record = await registry.retry(requireString(args.id, "id"));
      return record
        ? `started continuation ${record.continuation}`
        : "subagent is not stopped or failed";
    },
    true,
    {},
    idCall("retry"),
    (args, value) => ({
      kind: "generic",
      title: requireString(requireObject(args).id, "id"),
      summary: `continuation ${/started continuation (\d+)/u.exec(value)?.[1] ?? "unavailable"}`,
    }),
  );
}

function agentAttachTool(): RuntimeTool {
  return agentRegistryTool(
    "agent_attach",
    "Attach subagent output to the current session.",
    false,
    async (registry, args) =>
      registry.attach(requireString(args.id, "id"))
        ? "attached"
        : "subagent not found",
    true,
    {},
    idCall("attach"),
    (args, value) => ({
      kind: "generic",
      title: requireString(requireObject(args).id, "id"),
      summary: value === "attached" ? "attached" : "not found",
    }),
  );
}

function agentDetachTool(): RuntimeTool {
  return agentRegistryTool(
    "agent_detach",
    "Detach subagent output from the current session.",
    false,
    async (registry, args) =>
      registry.detach(requireString(args.id, "id"))
        ? "detached"
        : "subagent not found",
    true,
    {},
    idCall("detach"),
    (args, value) => ({
      kind: "generic",
      title: requireString(requireObject(args).id, "id"),
      summary: value === "detached" ? "detached" : "not found",
    }),
  );
}

function agentCleanupTool(): RuntimeTool {
  return agentRegistryTool(
    "agent_cleanup",
    "Remove stopped, failed, and completed subagent records.",
    true,
    async (registry, args) =>
      JSON.stringify({ removed: registry.cleanup(args.dryRun === true) }),
    false,
    {},
    () => ({ kind: "generic", title: "subagents", summary: "cleanup" }),
    (_args, value) => {
      const removed = (JSON.parse(value) as { removed?: unknown[] }).removed;
      return {
        kind: "generic",
        title: "subagents",
        summary: `removed ${removed?.length ?? 0}`,
      };
    },
  );
}

function agentWaitTool(): RuntimeTool {
  return {
    name: "agent_wait",
    description:
      "Convenience wait for one or more subagents to complete. You are USUALLY TOLD: every terminal transition (completed, failed, stopped — including a run the restart interrupted) delivers a settlement notice, so prefer doing other work and reading the notice. until supports all_terminal or any_terminal. Does not stop the subagent on timeout.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        until: { type: "string", enum: [...SUBAGENT_WAIT_UNTIL] },
        timeoutMs: { type: "number" },
      },
      required: ["ids", "until"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          completed: { type: "array", items: { type: "string" } },
          pending: { type: "array", items: { type: "string" } },
          timedOut: { type: "boolean" },
          results: {
            type: "object",
            properties: {},
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      },
      presentCall(args) {
        const ids = (requireObject(args).ids as unknown[]).map(String);
        const until = requireObject(args).until as string;
        return {
          kind: "generic",
          title: until === "any_terminal" ? "any" : "all",
          summary:
            ids.length > 2
              ? `waiting for ${ids.length} agents`
              : `waiting for ${ids.join(", ")}`,
          meta: [["collapsible", "true"]],
        };
      },
      presentResult(_args, value) {
        let parsed: {
          completed?: unknown[];
          pending?: unknown[];
          timedOut?: boolean;
        };
        try {
          parsed = JSON.parse(value);
        } catch {
          return { kind: "generic", title: "wait", summary: "completed" };
        }
        const completed = (parsed.completed ?? []).length;
        const pending = (parsed.pending ?? []).length;
        const total = completed + pending;
        let summary: string;
        if (parsed.timedOut) {
          summary =
            pending > 0 ? `timed out · ${pending} pending` : "timed out";
        } else if (pending === 0) {
          summary = `${completed} completed`;
        } else {
          summary = `${completed}/${total} completed`;
        }
        return { kind: "generic", title: "wait", summary };
      },
    },
    async execute(input, context) {
      const args = requireObject(input);
      const ids = ((args.ids as unknown[]) ?? []).map((id) => String(id));
      if (ids.length === 0) throw new Error("ids is required");
      const until =
        (args.until as string) === "any_terminal"
          ? "any_terminal"
          : "all_terminal";
      const timeoutMs =
        typeof args.timeoutMs === "number" ? args.timeoutMs : 120_000;
      const registry = requireSubagents(context);
      const results = await registry.wait(
        ids,
        until,
        timeoutMs,
        context.signal,
      );
      const terminalStatuses = new Set(["completed", "failed", "stopped"]);
      const completed: string[] = [];
      const pending: string[] = [];
      for (const id of ids) {
        const r = results[id] ?? { status: "idle", phase: "idle" };
        if (terminalStatuses.has(r.status)) completed.push(id);
        else pending.push(id);
      }
      const timedOut = pending.length > 0;
      return JSON.stringify({
        completed,
        pending,
        timedOut,
        results: Object.fromEntries(
          Object.entries(results).map(([id, r]) => [
            id,
            { status: r.status, phase: r.phase },
          ]),
        ),
      });
    },
  };
}

/**
 * Steer a subagent from the session that spawned it.
 *
 * The authority check is the one rule that matters: only the subagent's own
 * parent may steer it. Without it any session could redirect a child it has no
 * relationship to, and the child has no way to tell that from a legitimate
 * instruction.
 */
function agentMessageTool(): RuntimeTool {
  return {
    name: "agent_message",
    description:
      "Send a message to a subagent you spawned. It is delivered at the subagent's nearest step if it is running, wakes it if it is paused, and is queued for its next start otherwise.",
    // Steering another agent is not read-only: it changes what that agent will
    // do next, so it goes through the same approval gate as a spawn.
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        message: { type: "string" },
      },
      required: ["id", "message"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { route: { type: "string" } },
        required: ["route"],
        additionalProperties: false,
      },
      presentCall(args) {
        const { id, message } = requireObject(args) as {
          id?: string;
          message?: string;
        };
        return {
          kind: "generic",
          title: typeof id === "string" ? id : "subagent",
          summary:
            typeof message === "string" ? message.slice(0, 80) : "message",
        };
      },
      presentResult(_args, value) {
        const parsed = JSON.parse(value) as { route?: string } | null;
        return {
          kind: "generic",
          title: "subagent",
          summary: parsed?.route ? `message ${parsed.route}` : "message sent",
        };
      },
    },
    async execute(input, context) {
      const args = requireObject(input);
      const id = requireString(args.id, "id");
      const message = requireString(args.message, "message");
      const subagents = requireSubagents(context);
      const record = subagents.get(id);
      if (!record) return JSON.stringify({ route: "not_found" });
      // Only the parent may steer. The caller's session is the authority: a
      // spawner is recorded on the record, and anything else is a stranger.
      const callerSession = context.sessionID;
      if (
        record.parentSessionID !== undefined &&
        callerSession !== undefined &&
        record.parentSessionID !== callerSession
      )
        throw new Error(
          `subagent ${id} belongs to another session; only its parent may steer it`,
        );
      return JSON.stringify(
        await subagents.sendMessage(id, message, callerSession),
        null,
        2,
      );
    },
  };
}

function agentAuditTool(): RuntimeTool {
  return agentRegistryTool(
    "agent_audit",
    "Return the TS/Bun subagent audit trail.",
    false,
    async (registry, args) =>
      registry.audit(
        numberOr(args.tail, 0) || undefined,
        optionalString(args.format),
      ),
    false,
    {},
    () => ({ kind: "generic", title: "subagents", summary: "audit" }),
    (_args, value) => ({
      kind: "generic",
      title: "subagents",
      summary: `read ${auditEntryCount(value)} audit entries`,
    }),
  );
}

type PresentCall = NonNullable<ToolOutputDefinition["presentCall"]>;
type PresentResult = NonNullable<ToolOutputDefinition["presentResult"]>;

function idCall(summary: string, collapsible = false): PresentCall {
  return (args) => ({
    kind: "generic",
    title: requireString(requireObject(args).id, "id"),
    summary,
    meta: collapsible ? [["collapsible", "true"]] : undefined,
  });
}

function subagentListCount(value: string) {
  if (value === "no subagents") return 0;
  return value
    .split("\n")
    .filter((line) => line && !line.startsWith("remaining_resources:")).length;
}

function auditEntryCount(value: string) {
  if (value === "<no agent audit entries>") return 0;
  try {
    const entries = JSON.parse(value) as unknown;
    if (Array.isArray(entries)) return entries.length;
  } catch {
    // The default audit format is one entry per line.
  }
  return value.split("\n").filter(Boolean).length;
}

function agentRegistryTool(
  name: string,
  description: string,
  requiresApproval: boolean,
  action: (
    registry: SubagentToolService,
    args: Record<string, unknown>,
  ) => Promise<string>,
  requiresID = false,
  extraProperties: Record<string, unknown> = {},
  presentCall?: PresentCall,
  presentResult?: PresentResult,
  requiredProperties?: string[],
): RuntimeTool {
  return {
    name,
    description,
    requiresApproval,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        dryRun: { type: "boolean" },
        tail: { type: "number" },
        format: { type: "string" },
        ...extraProperties,
      },
      required: requiredProperties ?? (requiresID ? ["id"] : undefined),
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: {} },
      presentCall,
      presentResult,
    },
    async execute(input, context) {
      const args = requireObject(input);
      return await action(requireSubagents(context), args);
    },
  };
}

/** Every subagent tool. */
export function agentTools(
  agentTypes: readonly SubagentTypeView[] = [],
): RuntimeTool[] {
  return [
    agentSpawnTool(agentTypes),
    agentListTool(),
    agentStatusTool(),
    agentOutputTool(),
    agentWaitTool(),
    agentStopTool(),
    agentResumeTool(),
    agentRetryTool(),
    agentMessageTool(),
    agentAttachTool(),
    agentDetachTool(),
    agentCleanupTool(),
    agentAuditTool(),
  ];
}

/**
 * Session scope: a subagent belongs to the session that spawned it.
 */
export function agentToolFamily(
  agentTypes: readonly SubagentTypeView[] = [],
): ToolFamily {
  return {
    id: "agent",
    name: "Subagent Tools",
    version: "1.0.0",
    description: "Delegating work to a subagent.",
    scope: "session",
    tools: [...agentTools(agentTypes)],
  };
}

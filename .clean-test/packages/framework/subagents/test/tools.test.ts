import { expect, test } from "bun:test";
import { agentToolFamily, agentTools } from "../src";
import type { SubagentSpawnOptions } from "@anthelia/tools";

const EXPECTED_TOOL_NAMES = [
  "agent_spawn",
  "agent_list",
  "agent_status",
  "agent_output",
  "agent_wait",
  "agent_stop",
  "agent_resume",
  "agent_retry",
  "agent_message",
  "agent_attach",
  "agent_detach",
  "agent_cleanup",
  "agent_audit",
];

test("the subagent family describes the tools it ships", () => {
  const family = agentToolFamily();
  expect(family.id).toBe("agent");
  expect(family.scope).toBe("session");
  expect(family.tools.map((tool) => tool.name)).toEqual(
    agentTools().map((tool) => tool.name),
  );
});

test("every agent_* tool declares presentCall and presentResult", () => {
  const tools = agentTools();
  expect(tools.map((t) => t.name)).toEqual(EXPECTED_TOOL_NAMES);
  for (const tool of tools) {
    expect(tool.output?.presentCall).toBeDefined();
    expect(tool.output?.presentResult).toBeDefined();
  }
});

test("agent_spawn projects task title and spawns taskID in result meta", () => {
  const spawn = agentTools().find((t) => t.name === "agent_spawn")!;
  const call = spawn.output!.presentCall!({ task: "Inspect renderer" });
  expect(call).toEqual({
    kind: "generic",
    title: "Inspect renderer",
    summary: "spawn",
  });
  const result = spawn.output!.presentResult!(
    {},
    '{"id":"a1","task":"Inspect renderer"}',
  );
  expect(result).toEqual({
    kind: "generic",
    title: "subagent",
    summary: "spawned a1",
    meta: [["taskID", "a1"]],
  });
});

test("agent_status projects checking action and status result", () => {
  const tool = agentTools().find((t) => t.name === "agent_status")!;
  const call = tool.output!.presentCall!({ id: "a1" });
  expect(call).toEqual({
    kind: "generic",
    title: "a1",
    summary: "check",
    meta: [["collapsible", "true"]],
  });
  const result = tool.output!.presentResult!(
    { id: "a1" },
    "a1 [running] attached=true Inspect renderer",
  )!;
  expect(result.title).toBe("a1");
  expect(result.summary).toBe("status running");
});

test("agent_stop projects stopping and stopped/not-running result", () => {
  const tool = agentTools().find((t) => t.name === "agent_stop")!;
  expect(tool.parameters.required).toEqual(["id", "reason"]);
  const call = tool.output!.presentCall!({ id: "a1", reason: "stalled" });
  expect(call).toEqual({ kind: "generic", title: "a1", summary: "stop" });
  const stopped = tool.output!.presentResult!(
    { id: "a1", reason: "stalled" },
    "Stopped a1",
  )!;
  expect(stopped.summary).toBe("stopped");
  const protectedResult = tool.output!.presentResult!(
    { id: "a1", reason: "still active" },
    "Protected a1",
  )!;
  expect(protectedResult.summary).toBe("protected · agent still active");
  const forced = tool.output!.presentResult!(
    { id: "a1", reason: "override", force: true },
    "Stopped a1 (force interrupted an active agent)",
  )!;
  expect(forced.summary).toBe("force stopped · interrupted active agent");
  const notRunning = tool.output!.presentResult!(
    { id: "a1", reason: "stalled" },
    "Agent is not running",
  )!;
  expect(notRunning.summary).toBe("not running");
});

test("agent_output projects reading action and output result", () => {
  const tool = agentTools().find((t) => t.name === "agent_output")!;
  const call = tool.output!.presentCall!({ id: "a1" })!;
  expect(call.summary).toBe("read output");
  expect(call.meta).toEqual([["collapsible", "true"]]);
  const result = tool.output!.presentResult!({ id: "a1" }, "some output")!;
  expect(result.summary).toBe("output read");
});

test("agent_retry projects retry action and continuation result", () => {
  const tool = agentTools().find((t) => t.name === "agent_retry")!;
  const call = tool.output!.presentCall!({ id: "a1" })!;
  expect(call.summary).toBe("retry");
  const result = tool.output!.presentResult!(
    { id: "a1" },
    "started continuation 2",
  )!;
  expect(result.summary).toBe("continuation 2");
});

test("agent_cleanup projects cleanup count", () => {
  const tool = agentTools().find((t) => t.name === "agent_cleanup")!;
  const call = tool.output!.presentCall!({})!;
  expect(call.summary).toBe("cleanup");
  const result = tool.output!.presentResult!({}, '{"removed":["a1","a2"]}')!;
  expect(result.summary).toBe("removed 2");
});

test("agent_list and agent_audit project list/audit labels", () => {
  const list = agentTools().find((t) => t.name === "agent_list")!;
  expect(list.output!.presentCall!({})!.summary).toBe("list");
  const listResult = list.output!.presentResult!({}, "no subagents")!;
  expect(listResult.summary).toBe("listed 0");

  const audit = agentTools().find((t) => t.name === "agent_audit")!;
  expect(audit.output!.presentCall!({})!.summary).toBe("audit");
});

test("agent tools refuse without the subagent registry", async () => {
  const tool = agentToolFamily().tools.find(
    (candidate) => candidate.name === "agent_spawn",
  )!;
  await expect(
    tool.execute({ prompt: "hi" }, { workspaceRoot: "/tmp" } as never),
  ).rejects.toThrow(/subagent runtime unavailable/u);
});

test("agent_retry is exposed as an explicit continuation tool", () => {
  const tool = agentTools().find(
    (candidate) => candidate.name === "agent_retry",
  )!;
  expect(tool.requiresApproval).toBe(true);
  expect(tool.description).toContain("continuation");
});

const AGENT_TYPES = [
  {
    name: "explore",
    description: "read-only search",
    mode: "subagent",
    excludedTools: ["write_file"],
  },
  {
    name: "implementer",
    description: "edits files",
    mode: "subagent",
    allowedTools: ["read_file", "write_file"],
  },
  { name: "build", description: "primary agent", mode: "primary" },
];

test("agent_spawn advertises the configured subagent types with their tools", async () => {
  const spawn = agentTools(AGENT_TYPES).find((t) => t.name === "agent_spawn")!;

  // The one distinction the choice turns on: a read-only explorer is not a full
  // implementer, and nothing else in the description says which is which.
  expect(spawn.description).toContain(
    "explore: read-only search (tools: all except write_file)",
  );
  expect(spawn.description).toContain(
    "implementer: edits files (tools: read_file, write_file)",
  );
  // A primary agent is the main runner, not a spawn target.
  expect(spawn.description).not.toContain("build");
  expect(spawn.description).toContain("Pass one of these as `type`");
});

test("agent_spawn accepts a type parameter", () => {
  const spawn = agentTools(AGENT_TYPES).find((t) => t.name === "agent_spawn")!;
  const properties = spawn.parameters.properties as Record<string, unknown>;

  expect(properties.type).toEqual({ type: "string" });
});

test("with no configured types the description stays a single line", () => {
  // A section listing nothing reads as "there are types and they are
  // undocumented" — the notice discipline is not a type section, so it
  // stays.
  const spawn = agentTools().find((t) => t.name === "agent_spawn")!;

  expect(spawn.description).toBe(
    "Spawn an isolated TS/Bun subagent task.\n" +
      "You keep working after the spawn: when the child ends (completed, " +
      "failed, or stopped) a settlement notice tells you what it " +
      "concluded, so you do not need to block on agent_wait.",
  );
});

test("spawning as a type applies its tool restrictions", async () => {
  let spawned:
    | { allowedTools?: string[]; excludeTools?: string[]; agentType?: string }
    | undefined;
  const spawn = agentTools(AGENT_TYPES).find((t) => t.name === "agent_spawn")!;
  await spawn.execute(
    { task: "find it", type: "explore" },
    {
      workspaceRoot: "/tmp",
      subagents: {
        spawn: async (_task: string, options?: SubagentSpawnOptions) => {
          spawned = options as typeof spawned;
          return { id: "a1", task: "find it", status: "idle" };
        },
      } as never,
    },
  );

  expect(spawned?.agentType).toBe("explore");
  expect(spawned?.excludeTools).toEqual(["write_file"]);
});

test("an explicit allow-list overrides the type's restrictions", async () => {
  // Widening a type has to be possible, or a type becomes a ceiling rather than
  // a default.
  let spawned: { allowedTools?: string[]; agentType?: string } | undefined;
  const spawn = agentTools(AGENT_TYPES).find((t) => t.name === "agent_spawn")!;
  await spawn.execute(
    {
      task: "fix it",
      type: "explore",
      allowedTools: ["read_file", "write_file"],
    },
    {
      workspaceRoot: "/tmp",
      subagents: {
        spawn: async (_task: string, options?: SubagentSpawnOptions) => {
          spawned = options as typeof spawned;
          return { id: "a1", task: "fix it", status: "idle" };
        },
      } as never,
    },
  );

  expect(spawned?.agentType).toBe("explore");
  expect(spawned?.allowedTools).toEqual(["read_file", "write_file"]);
});

test("an unknown type is rejected instead of spawning a general subagent", async () => {
  // A caller that asked for a read-only explorer and got a full implementer has
  // not been served, and nothing downstream would say so.
  const spawn = agentTools(AGENT_TYPES).find((t) => t.name === "agent_spawn")!;
  let spawns = 0;

  await expect(
    spawn.execute(
      { task: "go", type: "nope" },
      {
        workspaceRoot: "/tmp",
        subagents: {
          spawn: async () => {
            spawns += 1;
            return { id: "a1", task: "go", status: "idle" };
          },
        } as never,
      },
    ),
  ).rejects.toThrow(/unknown subagent type "nope"/);
  expect(spawns).toBe(0);
});

test("omitting the type spawns a general subagent", async () => {
  let spawned: { agentType?: string } | undefined;
  const spawn = agentTools(AGENT_TYPES).find((t) => t.name === "agent_spawn")!;
  await spawn.execute(
    { task: "just work" },
    {
      workspaceRoot: "/tmp",
      subagents: {
        spawn: async (_task: string, options?: SubagentSpawnOptions) => {
          spawned = options as typeof spawned;
          return { id: "a1", task: "just work", status: "idle" };
        },
      } as never,
    },
  );

  expect(spawned?.agentType).toBeUndefined();
});

test("agent_spawn accepts a context choice between fresh and fork", () => {
  const spawn = agentTools().find((t) => t.name === "agent_spawn")!;
  const properties = spawn.parameters.properties as Record<string, unknown>;

  // Without this the model cannot choose whether the child inherits the
  // conversation, and a fork would have to be the only behaviour.
  expect(properties.context).toEqual({
    type: "string",
    enum: ["fresh", "fork"],
  });
});

test("spawning with fork threads the choice through to the record", async () => {
  let spawned: { context?: string } | undefined;
  const spawn = agentTools().find((t) => t.name === "agent_spawn")!;
  await spawn.execute(
    { task: "continue the work", context: "fork" },
    {
      workspaceRoot: "/tmp",
      subagents: {
        spawn: async (
          _task: string,
          options?: { context?: "fresh" | "fork" },
        ) => {
          spawned = options;
          return { id: "a1", task: "continue the work", status: "idle" };
        },
      } as never,
    },
  );

  expect(spawned?.context).toBe("fork");
});

test("omitting context leaves the subagent fresh", async () => {
  let spawned: { context?: string } | undefined;
  const spawn = agentTools().find((t) => t.name === "agent_spawn")!;
  await spawn.execute(
    { task: "start over" },
    {
      workspaceRoot: "/tmp",
      subagents: {
        spawn: async (
          _task: string,
          options?: { context?: "fresh" | "fork" },
        ) => {
          spawned = options;
          return { id: "a1", task: "start over", status: "idle" };
        },
      } as never,
    },
  );

  expect(spawned?.context).toBeUndefined();
});

test("agent_message is registered and takes an id plus a message", () => {
  const tools = agentTools();
  const message = tools.find((t) => t.name === "agent_message");
  expect(message).toBeDefined();
  const properties = message!.parameters.properties as Record<string, unknown>;
  expect(properties.id).toEqual({ type: "string" });
  expect(properties.message).toEqual({ type: "string" });
  // Steering another agent changes what it will do next, so it is not read-only.
  expect(message!.requiresApproval).toBe(true);
});

test("a stranger session cannot steer another session's subagent", async () => {
  // Without this any session could redirect a child it has no relationship to,
  // and the child has no way to tell that from a legitimate instruction.
  const message = agentTools().find((t) => t.name === "agent_message")!;
  await expect(
    message.execute(
      { id: "a1", message: "do something else" },
      {
        workspaceRoot: "/tmp",
        sessionID: "ses_stranger",
        subagents: {
          get: (id: string) => ({
            id,
            task: "t",
            status: "running",
            parentSessionID: "ses_owner",
          }),
          sendMessage: async () => ({ route: "delivered" }),
        } as never,
      },
    ),
  ).rejects.toThrow(/only its parent may steer/);
});

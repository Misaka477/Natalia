import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp as createEmptyWorkspace,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, expect, test } from "bun:test";
import { createRealRuntimeClient as createRuntimeClient } from "../src";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type {
  ProviderStreamRequest,
  StreamingProvider,
} from "@anthelia/runtime";
import { providerError } from "@anthelia/runtime";
import { CapabilityRegistry } from "@anthelia/capability";
import { createToolRegistry } from "@anthelia/tools";
import { fingerprintFile, recordTrust, resolveConfig } from "@anthelia/config";
import { SessionStoreTestDatabase } from "@natalia/testing";
import {
  sandboxService,
  terminalController,
  type SandboxService,
} from "@anthelia/runtime-services";
import { checkpointFactory } from "@anthelia/checkpoint";
import { retryService } from "@anthelia/retry";
import { resolveWorkspaceJournalDatabasePath } from "@anthelia/platform";
import { turnController } from "@anthelia/turn-orchestration";
import { providerModelController } from "@anthelia/provider-model";
import { compactionService } from "@anthelia/compaction";
import {
  workspaceFiles,
  workspaceMutations,
  workspaceWriteLock,
} from "@anthelia/workspace";
import {
  TerminalTestRegistry as NativeTerminalRegistry,
  WorkspaceSandboxTestManager as WorkspaceSandboxManager,
} from "@natalia/testing";
import {
  createOfficialRuntimeClient,
  restoreOfficialPluginConfig,
  installFixturePlugin,
  officialPluginWorkspace as mkdtemp,
  useWorkspaceCleanup,
  registerTestArtifact,
} from "./plugin-test-helpers";

useWorkspaceCleanup();
import { projectedWorkGraphEdges } from "@anthelia/session";
import { toolCallNodeID } from "@natalia/work-ledger";
import { normalizePendingItems } from "@natalia/ui-model";
import type { ProviderModelController } from "@anthelia/provider-model";

import {
  ambientGovernanceRoot,
  MCP_PLUGIN_ID,
  SKILLS_PLUGIN_ID,
  TEAM_PLUGIN_ID,
  TODO_PLUGIN_ID,
  createRealRuntimeClient,
  scriptedProvider,
  singleToolProvider,
  interactiveTerminalProvider,
  nativeTerminalFixture,
  usageProvider,
  contextLimitThenSuccessProvider,
  toolCallingProvider,
  writeFileProvider,
  approvalWriteProvider,
  questionToolProvider,
  delayedStreamingProvider,
  subagentProvider,
  subagentCompactionProvider,
  subagentToolProvider,
  subagentRawXMLToolProvider,
  waitFor,
  waitForProcessExit,
  fingerprintEntry,
  isCollabMessageEvent,
  waitForAsync,
  pollHistoryForFinished,
  sqliteContinueProvider,
  sqliteContinueRegistry,
  sandboxedSubagentProvider,
  sandboxedDomainProvider,
  imageAttachProvider,
  subagentPlanPointerProvider,
  MAIN_PLAN_ID,
  subagentCacheUsageProvider,
} from "./real-runtime-harness";
import type { NamespacedCollabMessageEvent } from "./real-runtime-harness";

test("permission profile denies injected MCP tools before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-profile-mcp-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      agentModes: {
        unattended: {
          approval: "auto",
          description: "No MCP",
          extensions: { mcp: false },
        },
      },
    }),
  );
  const tools = createToolRegistry([]);
  let executed = false;
  tools.set("mcp_docs_echo", {
    name: "mcp_docs_echo",
    description: "test MCP tool",
    requiresApproval: false,
    parameters: { type: "object", properties: {} },
    async execute() {
      executed = true;
      return "unexpected";
    },
  });
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_profile_mcp",
    permissionProfile: "unattended",
    tools,
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool"))
          yield {
            type: "tool_call" as const,
            calls: [{ id: "mcp", name: "mcp_docs_echo", arguments: "{}" }],
          };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("use MCP");

  expect(executed).toBe(false);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "policy.decision",
      toolName: "mcp_docs_echo",
      decision: "deny",
      reason: "mcp extensions are disabled by permission profile",
    }),
  );
  await client.dispose?.();
});

test("read-only runtime preserves a plugin tool approval declaration", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-read-only-"));
  const pluginRoot = join(root, ".natalia", "plugins", "unsafe");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 1,
      id: "unsafe.plugin",
      version: "1.0.0",
      name: "Unsafe",
      description: "",
      entry: "index.ts",
      capabilities: ["tools"],
    }),
  );
  await writeFile(
    join(pluginRoot, "index.ts"),
    "export default { setup(api) { api.tools.register({ name: 'mutate', description: 'Mutate', requiresApproval: false, parameters: { type: 'object', properties: {} }, async execute() { return 'mutated'; } }) } }",
  );
  await installFixturePlugin(root, pluginRoot);
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plugin_read_only",
    permissionMode: "read_only",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request);
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.submitAndWait!("inspect plugins");

  expect(requests[0]?.tools?.map((tool) => tool.name)).toContain("mutate");
});

test("workspace plugin trust does not alter an approval declaration", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-trusted-"));
  const pluginRoot = join(root, ".natalia", "plugins", "trusted");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      plugins: { readOnly: { "trusted.plugin": true } },
    }),
  );
  await writeFile(
    join(pluginRoot, "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 1,
      id: "trusted.plugin",
      version: "1.0.0",
      name: "Trusted",
      description: "",
      entry: "index.ts",
      capabilities: ["tools"],
    }),
  );
  await writeFile(
    join(pluginRoot, "index.ts"),
    "export default { setup(api) { api.tools.register({ name: 'observe', description: 'Observe', requiresApproval: false, parameters: { type: 'object', properties: {} }, async execute() { return 'observed'; } }) } }",
  );
  await installFixturePlugin(root, pluginRoot);
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plugin_trusted",
    permissionMode: "read_only",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request);
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.submitAndWait!("inspect trusted plugins");

  expect(requests[0]?.tools?.map((tool) => tool.name)).toContain("observe");
});

test("a plugin command reaches the command catalog and the palette bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-command-"));
  const pluginRoot = join(root, ".natalia", "plugins", "paletteplugin");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 1,
      id: "palette.plugin",
      version: "1.0.0",
      name: "Palette",
      description: "",
      entry: "index.ts",
      capabilities: ["commands"],
    }),
  );
  await writeFile(
    join(pluginRoot, "index.ts"),
    "export default { setup(api) { api.commands.register({ name: 'sync', title: 'Sync everything', run(input) { return `synced ${input.args.join(',')}` } }) } }",
  );
  await installFixturePlugin(root, pluginRoot);
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plugin_command",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("load plugins");

  // The authoritative surface, which an external UI reads over RPC.
  await waitForAsync(
    async () =>
      (await client.commandCatalog?.())?.some(
        (command) => command.name === "sync",
      ) === true,
  );
  const catalog = await client.commandCatalog?.();
  expect(catalog?.map((command) => command.name)).toContain("sync");
  expect(catalog?.find((command) => command.name === "sync")).toMatchObject({
    title: "Sync everything",
    category: "Palette",
  });

  await client.commandExecute?.({
    name: "sync",
    raw: "/sync alpha beta",
    args: ["alpha", "beta"],
  });
  await waitFor(
    () =>
      events.filter((event) => event.type === "content.delta").at(-1)?.text ===
      "synced alpha,beta",
    20_000,
    "the plugin command output",
  );
  expect(
    events.filter((event) => event.type === "content.delta").at(-1)?.text,
  ).toBe("synced alpha,beta");
  await client.dispose?.();
});

test("grep retains workspace read path authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-grep-read-policy-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(join(root, "allowed.ts"), "const value = 'needle';\n");
  await writeFile(join(root, "protected.ts"), "const secret = 'needle';\n");
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      defaultAgent: "review",
      agents: {
        review: {
          description: "Review",
          permissions: {
            files: {
              readPaths: [
                {
                  pattern: "protected.ts",
                  allow: false,
                  reason: "protected read path",
                },
              ],
            },
          },
        },
      },
    }),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_grep_read_policy",
    permissionMode: "auto",
    provider: singleToolProvider("grep", {
      pattern: "needle",
      include: "*.ts",
    }),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("grep for the needle");

  const failure = events.find(
    (event): event is Extract<RuntimeEvent, { type: "tool.update" }> =>
      event.type === "tool.update" &&
      event.name === "grep" &&
      event.status === "failed",
  );
  expect(failure?.summary).toContain("protected read path");
  await client.dispose?.();
});

test("runtime executes canonical interactive Terminal tools on one native pane", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-terminal-runtime-"));
  const events: RuntimeEvent[] = [];
  const handled = new Set<string>();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_pty_runtime",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        const text = [...request.messages]
          .reverse()
          .find((message) => message.role === "user")?.content;
        if (typeof text === "string" && !handled.has(text)) {
          handled.add(text);
          const call =
            text === "start terminal"
              ? {
                  id: "start",
                  name: "interactive_terminal_start",
                  arguments: JSON.stringify({
                    id: "tty_runtime",
                    command: "cat",
                  }),
                }
              : text === "write terminal"
                ? {
                    id: "write",
                    name: "interactive_terminal_write",
                    arguments: JSON.stringify({
                      id: "tty_runtime",
                      input: "secret",
                      sensitive: true,
                    }),
                  }
                : {
                    id: "stop",
                    name: "interactive_terminal_stop",
                    arguments: JSON.stringify({ id: "tty_runtime" }),
                  };
          yield { type: "tool_call" as const, calls: [call] };
        }
        yield { type: "done" as const };
      },
    },
    nativeTerminal: nativeTerminalFixture(),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("start terminal");
  await client.submitAndWait!("write terminal");
  await client.submitAndWait!("stop terminal");
  expect(await client.nativeTerminalList?.()).toMatchObject([
    { id: "tty_runtime", status: "exited" },
  ]);
  await client.dispose?.();
});

test("runtime exposes native Terminal pane management through RuntimeClient", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-terminal-management-runtime-"),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_pty_management",
    permissionMode: "auto",
    provider: interactiveTerminalProvider(),
    nativeTerminal: nativeTerminalFixture(),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("start terminal");

  expect(await client.nativeTerminalList!()).toMatchObject([
    { id: "tty_management", status: "running", paneID: 71 },
  ]);
  // The extent rides along the read, and on this backend it is null: the
  // fixture's host answers with text and nothing that locates it in a document,
  // so a null says "cannot page" where zeros would impersonate a one-line
  // document. The real extent is pinned by the pty controller's own paging
  // test; this assertion pins the degradation a wezterm-backed runtime serves.
  const paneRead = await client.nativeTerminalRead!("tty_management");
  expect(paneRead).toEqual({
    id: "tty_management",
    text: "native pane output",
    startLine: null,
    endLine: null,
    totalLines: null,
    // The caret reads 0;0 from the fixture's pane while the extent stays null:
    // the two are answered by different layers here, and the pins keep both
    // honest to what this host actually serves rather than to each other.
    cursorX: 0,
    cursorY: 0,
    startByte: null,
    endByte: null,
    totalBytes: null,
  });
  await client.nativeTerminalOpenHub!();
  await expect(
    client.nativeTerminalRevokeApprovalScope!("tty_management"),
  ).resolves.toEqual({
    id: "tty_management",
    scope: "terminal:tty_management:low-risk",
    revoked: false,
  });
  await client.nativeTerminalStop!("tty_management");
  expect(await client.nativeTerminalList!()).toMatchObject([
    { id: "tty_management", status: "exited" },
  ]);
  await client.dispose?.();
});

test("runtime exposes checkpoint list, preview, dry-run, and safety rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-checkpoint-management-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_checkpoint_management",
    provider: scriptedProvider("ready"),
  });
  client.start((event) => events.push(event));
  expect(await client.checkpointList!()).toMatchObject([
    { id: "checkpoint_0", reason: "baseline", complete: true },
  ]);
  expect(await client.checkpointPreview!("checkpoint_0")).toMatchObject({
    checkpointID: "checkpoint_0",
    dryRun: true,
  });
  expect(
    await client.checkpointRollback!({ id: "checkpoint_0", dryRun: true }),
  ).toMatchObject({ dryRun: true });
  expect(
    await client.checkpointRollback!({ id: "checkpoint_0" }),
  ).toMatchObject({
    checkpointID: "checkpoint_0",
    safetyCheckpointID: "checkpoint_1",
    dryRun: false,
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "rollback.end",
      checkpointID: "checkpoint_0",
    }),
  );
  await client.dispose?.();
});

test("runtime reports malformed provider tool calls without rendering an empty tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-empty-tool-call-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, runtime: { maxStepsPerTurn: 3 } }),
  );
  const events: RuntimeEvent[] = [];
  const provider: StreamingProvider = {
    provider: "malformed",
    model: "malformed",
    async *stream() {
      yield {
        type: "tool_call",
        calls: [{ id: "empty_call", name: "", arguments: "{}" }],
      };
      yield { type: "done" };
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_empty_tool_call",
    provider,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("test malformed tool call");
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.update",
      name: "invalid_tool_call",
      summary: expect.stringContaining("without a name"),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "diagnostic",
      level: "warning",
      message: expect.stringContaining("without a name"),
    }),
  );
  await client.dispose?.();
});

test("agent permissions block configured file and command execution at tool boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-agent-permissions-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      agents: {
        locked: {
          description: "Locked",
          permissions: {
            files: {
              writePaths: [
                { pattern: "secret.txt", allow: false, reason: "protected" },
              ],
            },
            commands: { denyPatterns: ["rm\\s"] },
          },
        },
      },
      defaultAgent: "locked",
    }),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_agent_permissions",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "write",
                name: "write_file",
                arguments: JSON.stringify({
                  path: "secret.txt",
                  content: "no",
                }),
              },
              {
                id: "shell",
                name: "run_shell",
                arguments: JSON.stringify({ command: "rm secret.txt" }),
              },
            ],
          };
        }
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("try protected actions");
  const failures = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "tool.update" }> =>
      event.type === "tool.update" && event.status === "failed",
  );
  expect(events.map((event) => event.type)).toContain("tool.update");
  expect(JSON.stringify(failures)).toContain("protected");
  expect(JSON.stringify(failures)).toContain("command matches deny pattern");
});

test("terminal input cannot bypass the command policy after opening a shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-terminal-bypass-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      agents: {
        locked: {
          description: "Locked",
          permissions: { commands: { denyPatterns: ["rm\\s+-rf"] } },
        },
      },
      defaultAgent: "locked",
    }),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_terminal_bypass",
    // permissionMode "auto" grants every approval, which is the strongest form
    // of the cached approval window: if the block still holds here, no approval
    // state can let the command through.
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "open",
                name: "interactive_terminal_start",
                arguments: JSON.stringify({ command: "bash" }),
              },
              {
                id: "sneak",
                name: "interactive_terminal_send_line",
                arguments: JSON.stringify({
                  id: "terminal_1",
                  text: "rm -rf /",
                }),
              },
            ],
          };
        }
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("open a shell and clean up");
  const sneak = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "tool.update" }> =>
      event.type === "tool.update" &&
      event.callID === "sneak" &&
      (event.status === "failed" || event.status === "rejected"),
  );
  expect(sneak.length).toBeGreaterThan(0);
  // Denied by policy, not merely by a terminal that failed to start.
  expect(JSON.stringify(sneak)).toContain("command matches deny pattern");
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "policy.decision",
      toolCallID: "sneak",
      decision: "deny",
    }),
  );
  await client.dispose?.();
});

test("self-protection patterns block terminal input, not only run_shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-terminal-selfprotect-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_terminal_selfprotect",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "kill",
                name: "interactive_terminal_send_line",
                arguments: JSON.stringify({
                  id: "terminal_1",
                  text: "pkill -f wezterm-mux-server",
                }),
              },
            ],
          };
        }
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  const submitted = await client.submitAndWait!("stop the terminal host");
  const blocked = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "tool.update" }> =>
      event.type === "tool.update" &&
      event.callID === "kill" &&
      event.status === "failed",
  );
  expect(JSON.stringify(blocked)).toContain("blocked by constitution");
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "constitution.check",
      ruleID: "C-TERM-001",
    }),
  );
  // CST4: the blocked call is linked to the rule that constrained it. The
  // call is recorded as a failed tool-call node, so the edge source exists.
  expect(
    projectedWorkGraphEdges(events).some(
      (edge) =>
        edge.kind === "constrained_by" &&
        edge.sourceID === toolCallNodeID(submitted.id, "kill") &&
        edge.targetID === "wg:constraint:C-TERM-001",
    ),
  ).toBe(true);
  await client.dispose?.();
});

test("C-REL-001 forces git approval even in auto mode without a session grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-cst3-approval-"));
  const events: RuntimeEvent[] = [];
  let approval: Extract<RuntimeEvent, { type: "approval.request" }> | undefined;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_cst3_approval",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        if (request.messages.at(-1)?.role === "user") {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "commit",
                name: "run_shell",
                arguments: JSON.stringify({ command: "git commit -m x" }),
              },
            ],
          };
        }
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request" && event.id.includes("commit")) {
      approval = event;
      client.respondApproval({ requestID: event.id, decision: "reject" });
    }
  });
  await client.submitAndWait!("commit the work");
  expect(approval).toMatchObject({
    title: "Approve git commit",
    allowSession: false,
  });
  expect(
    events.some(
      (event) =>
        event.type === "tool.update" &&
        event.callID === "commit" &&
        event.status === "rejected",
    ),
  ).toBe(true);
  await client.dispose?.();
});

test("forbidden override policy refuses requestOverride", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-cst3-forbidden-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_cst3_forbidden",
    permissionMode: "auto",
    provider: scriptedProvider("ready"),
  });
  client.start(() => undefined);
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);
  await expect(
    client.requestOverride?.({
      ruleID: "C-TERM-001",
      reason: "please",
    }),
  ).resolves.toMatchObject({ requested: false, reason: "override forbidden" });
  await client.dispose?.();
});

test("workspace governance decisions do not leak across workspace roots", async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), "natalia-gov-ws-a-"));
  const first = createRealRuntimeClient({
    workspaceRoot: firstRoot,
    sessionID: "ses_gov_a",
    permissionMode: "auto",
    provider: scriptedProvider("ready"),
  });
  first.start(() => undefined);
  await first.submitAndWait!("hello");
  await pollHistoryForFinished(first);
  await first.recordDecision?.({
    decision: "workspace A release rule",
    scope: "workspace",
  });
  await first.dispose?.();

  const secondRoot = await mkdtemp(join(tmpdir(), "natalia-gov-ws-b-"));
  const second = createRealRuntimeClient({
    workspaceRoot: secondRoot,
    sessionID: "ses_gov_b",
    permissionMode: "auto",
    provider: scriptedProvider("ready"),
  });
  second.start(() => undefined);
  await second.submitAndWait!("hello again");
  await pollHistoryForFinished(second);
  const records = await second.decisionRecords!({ scope: "workspace" });
  expect(records.items).not.toContainEqual(
    expect.objectContaining({ decision: "workspace A release rule" }),
  );
  await second.dispose?.();
});

test("truncated instance governance degrades without dropping C-TERM enforcement", async () => {
  const store = await mkdtemp(join(tmpdir(), "natalia-gov-bad-"));
  await writeFile(join(store, "constitution.jsonl"), "{truncated");
  const previous = process.env.NATALIA_TEST_GOVERNANCE_ROOT;
  process.env.NATALIA_TEST_GOVERNANCE_ROOT = store;
  try {
    const root = await mkdtemp(join(tmpdir(), "natalia-gov-ws-bad-"));
    const events: RuntimeEvent[] = [];
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: "ses_gov_bad",
      pluginStoreRoot: join(store, "plugin-store"),
      permissionMode: "auto",
      provider: scriptedProvider("ready"),
    });
    client.start((event) => events.push(event));
    await client.submitAndWait!("hello");
    await pollHistoryForFinished(client);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "diagnostic",
        message: "governance_store_unavailable",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "constitution.rule_added",
        ruleID: "C-TERM-001",
      }),
    );
    await client.dispose?.();
  } finally {
    if (previous === undefined) delete process.env.NATALIA_TEST_GOVERNANCE_ROOT;
    else process.env.NATALIA_TEST_GOVERNANCE_ROOT = previous;
  }
});

test("security.redactToolOutput drives redaction when no agent overrides it", async () => {
  async function runWithSetting(redact: boolean | undefined) {
    const root = await mkdtemp(join(tmpdir(), "natalia-redact-global-"));
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({
        version: 3,
        ...(redact === undefined
          ? {}
          : { security: { redactToolOutput: redact } }),
      }),
    );
    await writeFile(join(root, "creds.txt"), "token=supersecretvalue\n");
    const events: RuntimeEvent[] = [];
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: `ses_redact_${String(redact)}`,
      permissionMode: "auto",
      provider: {
        provider: "test",
        model: "test",
        async *stream(request) {
          if (!request.messages.some((message) => message.role === "tool"))
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "read",
                  name: "read_file",
                  arguments: JSON.stringify({ path: "creds.txt" }),
                },
              ],
            };
          yield { type: "done" as const };
        },
      },
    });
    client.start((event) => events.push(event));
    await client.submitAndWait!("read the credentials file");
    await client.dispose?.();
    return JSON.stringify(events);
  }

  // The global setting was previously never read, so a token reached the
  // journal even though the schema and the settings toggle said otherwise.
  expect(await runWithSetting(true)).not.toContain("supersecretvalue");
  expect(await runWithSetting(true)).toContain("[REDACTED]");
  // Explicitly disabling it still works, so the field is read in both
  // directions rather than being hardcoded.
  expect(await runWithSetting(false)).toContain("supersecretvalue");
  // Unset falls back to the schema default, which is on.
  expect(await runWithSetting(undefined)).not.toContain("supersecretvalue");
});

test("agent permissions apply network, environment, and output redaction boundaries", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-agent-boundary-permissions-"),
  );
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      agents: {
        guarded: {
          description: "Guarded",
          permissions: {
            network: { allowLocalhost: false },
            env: { allowlist: [] },
            redactOutput: true,
          },
        },
      },
      defaultAgent: "guarded",
    }),
  );
  process.env.NATALIA_AGENT_BOUNDARY_SECRET = "should-not-leak";
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_agent_boundary_permissions",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "web",
                name: "web_fetch",
                arguments: JSON.stringify({ url: "http://127.0.0.1:9" }),
              },
              {
                id: "shell",
                name: "run_shell",
                arguments: JSON.stringify({
                  command:
                    "printf 'token=visible\\nsecret=$NATALIA_AGENT_BOUNDARY_SECRET'",
                }),
              },
            ],
          };
        }
        yield { type: "done" as const };
      },
    },
  });
  try {
    client.start((event) => events.push(event));
    await client.submitAndWait!("check boundaries");
    const results = events.filter(
      (event): event is Extract<RuntimeEvent, { type: "tool.update" }> =>
        event.type === "tool.update" && Boolean(event.result),
    );
    expect(results.map((event) => event.result).join(" ")).toContain(
      "localhost network access is not allowed",
    );
    const shell =
      results.find((event) => event.name === "run_shell")?.result ?? "";
    expect(shell).toContain("token=[REDACTED]");
    expect(shell).not.toContain("should-not-leak");
  } finally {
    delete process.env.NATALIA_AGENT_BOUNDARY_SECRET;
  }
});

test("runtime agent selection applies only at the next provider turn boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-agent-boundary-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      agents: {
        first: { description: "First", systemPrompt: "first system" },
        second: { description: "Second", systemPrompt: "second system" },
      },
      defaultAgent: "first",
    }),
  );
  const requests: ProviderStreamRequest[] = [];
  let release: (() => void) | undefined;
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_agent_boundary",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1)
          await new Promise<void>((resolve) => (release = resolve));
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  const first = client.submit("first");
  while (!release) await Bun.sleep(1);
  await client.selectAgent?.("second");
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "agent.selection",
      name: "second",
      pending: true,
      sessionID: "ses_agent_boundary",
    }),
  );
  release();
  await first;
  // The pending agent switch applies at the next turn boundary, so the second
  // message is queued as its own turn rather than injected into the running one.
  await client.submitAndWait!({ text: "second", delivery: "next-turn" });
  expect(String(requests[0]?.messages[0]?.content)).toContain("first system");
  expect(String(requests[1]?.messages[0]?.content)).toContain("second system");
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "agent.selection",
      name: "second",
      pending: false,
      sessionID: "ses_agent_boundary",
    }),
  );
});

test("committed agent selection restores when a session runtime is reopened", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-agent-replay-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      agents: {
        first: { description: "First", systemPrompt: "first system" },
        second: { description: "Second", systemPrompt: "second system" },
      },
      defaultAgent: "first",
    }),
  );
  const sessionID = "ses_agent_replay";
  const first = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    provider: scriptedProvider("first"),
  });
  first.start(() => undefined);
  await first.submitAndWait!("initialize runtime");
  first.selectAgent?.("second");
  await first.dispose?.();

  const requests: ProviderStreamRequest[] = [];
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request);
        yield { type: "done" as const };
      },
    },
  });
  reopened.start(() => undefined, { replay: "none" });
  await reopened.submitAndWait!("after reopen");
  expect(String(requests[0]?.messages[0]?.content)).toContain("second system");
});

test("agent model overrides apply when the next provider turn starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-agent-model-override-"));
  const requests: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push((await request.json()) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  try {
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({
        version: 3,
        providers: {
          local: {
            name: "local",
            driver: "openai",
            enabled: true,
            connection: { apiKey: "local-key", baseURL: server.url.toString() },
          },
        },
        catalog: {
          providers: {
            local: {
              models: {
                alpha: { name: "alpha" },
                beta: { name: "beta" },
              },
            },
          },
        },
        defaultModel: { provider: "local", model: "alpha" },
        agents: {
          first: { description: "First", model: "local/alpha" },
          second: {
            description: "Second",
            model: "local/beta",
            variant: "careful",
          },
        },
        defaultAgent: "first",
      }),
    );
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: "ses_agent_model_override",
    });
    client.start(() => undefined);
    await client.submitAndWait!("first");
    client.selectAgent?.("second");
    await client.submitAndWait!("second");
    expect(requests.map((request) => request.model)).toEqual(["alpha", "beta"]);
  } finally {
    server.stop(true);
  }
});

test("runtime model selections persist across reopen and expose safe catalogs", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-runtime-model-selection-"),
  );
  const requests: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push((await request.json()) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  try {
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({
        version: 3,
        providers: {
          local: {
            name: "local",
            driver: "openai",
            enabled: true,
            connection: { apiKey: "local-key", baseURL: server.url.toString() },
          },
        },
        catalog: {
          providers: {
            local: {
              models: {
                alpha: { name: "alpha" },
                beta: {
                  name: "beta",
                },
              },
            },
          },
        },
        modelOverrides: {
          "local/beta": {
            requestDefaults: {
              temperature: 0.2,
              topP: null,
              stream: true,
              thinkingEnabled: false,
            },
          },
        },
        defaultModel: { provider: "local", model: "alpha" },
      }),
    );
    const sessionID = "ses_runtime_model_selection" as const;
    const client = createRealRuntimeClient({ workspaceRoot: root, sessionID });
    client.start(() => undefined);
    expect(await client.modelCatalog?.()).toEqual([
      {
        id: "local/alpha",
        name: "alpha",
        provider: "local",
        variants: [],
      },
      {
        id: "local/beta",
        name: "beta",
        provider: "local",
        variants: [],
      },
    ]);
    await client.selectModel?.("local/beta");
    expect(await client.modelSelection?.()).toEqual({
      modelID: "local/beta",
      variant: undefined,
    });
    const beforeComposerOverride = await readFile(
      join(root, ".natalia", "config.json"),
      "utf8",
    );
    await client.setReasoningEffort?.("high");
    expect(await client.reasoningEffort?.()).toBe("high");
    await client.submitAndWait!("selected model");
    expect(requests[0]).toMatchObject({
      model: "beta",
      temperature: 0.2,
      reasoning_effort: "high",
    });
    expect(await readFile(join(root, ".natalia", "config.json"), "utf8")).toBe(
      beforeComposerOverride,
    );
    await client.dispose?.();

    const reopened = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID,
    });
    reopened.start(() => undefined);
    expect(await reopened.reasoningEffort?.()).toBe("high");
    await reopened.submitAndWait!("restored model");
    expect(requests[1]).toMatchObject({
      model: "beta",
      temperature: 0.2,
      reasoning_effort: "high",
    });
  } finally {
    server.stop(true);
  }
});

test("runtime skill catalog exposes discovery metadata without skill body", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-skill-catalog-"));
  await mkdir(join(root, ".natalia", "skills", "release"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "skills", "release", "SKILL.md"),
    "---\nname: release\ndescription: Prepare release evidence\nrequire-approval: true\n---\nSECRET SKILL BODY",
  );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_skill_catalog",
    provider: scriptedProvider("unused"),
  });
  client.start(() => undefined);
  expect(await client.skills?.()).toEqual([
    {
      name: "release",
      enabled: true,
      qualifiedName: "project:release",
      description: "Prepare release evidence",
      source: "project",
      requireApproval: true,
      sandboxRequired: false,
    },
  ]);
  expect(
    (await client.capabilities?.())?.find(
      (capability) => capability.id === "natalia-skills",
    ),
  ).toMatchObject({
    grants: ["services", "tools", "commands"],
    provides: ["skills.service"],
    contributions: [
      { kind: "services", name: "skills.service" },
      { kind: "tools", name: "skill_load" },
      { kind: "commands", name: "skills" },
      { kind: "commands", name: "skill-install" },
      { kind: "commands", name: "skill" },
      { kind: "commands", name: "skill-resource" },
      { kind: "commands", name: "skill-script" },
    ],
  });
  await client.dispose?.();
});

test("runtime exposes contained workspace filesystem APIs", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-workspace-api-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.ts"), "const needle = true\n");
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_workspace_api",
    provider: scriptedProvider("unused"),
  });
  client.start(() => undefined);
  expect(await client.workspaceList?.()).toEqual({
    entries: [
      { path: ".natalia/", type: "directory" },
      { path: "src/", type: "directory" },
      { path: ".nataliaignore", type: "file" },
    ],
    truncated: false,
  });
  expect(await client.workspaceGlob?.({ pattern: "**/*.ts" })).toEqual([
    { path: "src/main.ts", type: "file" },
  ]);
  expect(await client.workspaceRead?.({ path: "src/main.ts" })).toMatchObject({
    content: "const needle = true\n",
    encoding: "utf8",
  });
  expect(await client.workspaceSearch?.({ query: "needle" })).toEqual(
    expect.arrayContaining([
      { path: "src/main.ts", line: 1, text: "const needle = true" },
    ]),
  );
});

test("runtime named resource reads enforce declarations and audit events", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-runtime-plugin-resource-"),
  );
  const sessionID = "ses_runtime_plugin_resource";
  const relativePath = `.natalia/todos/${sessionID}.json`;
  await mkdir(join(root, ".natalia", "todos"), { recursive: true });
  await writeFile(join(root, relativePath), '{"items":[]}\n');
  await writeFile(
    join(root, ".natalia", "todos", "ses_other.json"),
    '{"items":[{"content":"other","status":"pending"}]}\n',
  );

  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    provider: scriptedProvider("unused"),
  });
  client.start((event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === "session.ready"));

  expect(
    await client.resourceRead!({
      resource: "session-todo-store",
      params: { sessionID },
      reader: "natalia.ui.todo",
    }),
  ).toMatchObject({
    path: relativePath,
    content: '{"items":[]}\n',
  });
  await expect(
    client.resourceRead!({
      resource: "session-todo-store",
      params: { sessionID },
      reader: "other.plugin",
    }),
  ).rejects.toThrow("plugin resource is unavailable or not authorized");
  await expect(
    client.workspaceRead!({ path: relativePath }),
  ).resolves.toMatchObject({ path: relativePath, content: '{"items":[]}\n' });
  await expect(
    client.workspaceRead!({ path: ".natalia/todos/ses_other.json" }),
  ).resolves.toMatchObject({
    path: ".natalia/todos/ses_other.json",
    content: '{"items":[{"content":"other","status":"pending"}]}\n',
  });
  expect(events.some((event) => event.type === "resource.read")).toBe(true);
  await client.dispose?.();
});

test("runtime session management uses durable metadata and protects the active session", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-runtime-session-management-"),
  );
  const activeID = "ses_runtime_session_active" as const;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: activeID,
    provider: scriptedProvider("unused"),
  });
  client.start(() => undefined);
  await client.submitAndWait!("active session");
  const duplicated = await client.sessionDuplicate?.(activeID, "Copy");
  expect(duplicated).toMatchObject({ title: "Copy", pinned: false });
  await client.sessionPin?.(duplicated!.id, true);
  await client.sessionRename?.(duplicated!.id, "Renamed copy");
  await client.sessionTouch?.(duplicated!.id);
  expect(await client.sessionList?.()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: duplicated!.id,
        title: "Renamed copy",
        pinned: true,
      }),
    ]),
  );
  await expect(client.sessionDelete?.(activeID)).rejects.toThrow(
    "cannot delete the active runtime session",
  );
  expect(await client.sessionDelete?.(duplicated!.id)).toMatchObject({
    id: duplicated!.id,
  });
});

test("runtime session management keeps SQLite projection synchronized", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-runtime-sqlite-management-"),
  );
  const activeID = "ses_runtime_sqlite_active" as const;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: activeID,
    provider: scriptedProvider("unused"),
    useSqliteStore: true,
  });
  client.start(() => undefined);
  await client.submitAndWait!("active session");
  await Bun.sleep(20);
  const duplicated = await client.sessionDuplicate?.(activeID, "Copy");
  await client.sessionPin?.(duplicated!.id, true);
  await client.sessionRename?.(duplicated!.id, "Renamed copy");
  await client.sessionTouch?.(duplicated!.id);
  const copyID = duplicated!.id as SessionID;
  const store = new SessionStoreTestDatabase(
    resolveWorkspaceJournalDatabasePath(root),
  );
  expect(store.get(copyID)).toMatchObject({
    title: "Renamed copy",
    pinned: true,
  });
  expect(store.eventCount(copyID)).toBeGreaterThan(0);
  await client.sessionDelete?.(duplicated!.id);
  expect(store.get(copyID)).toBeUndefined();
  expect(store.loadEvents(copyID)).toEqual([]);
  store.close();
});

test("runtime replaces a generated provider ID with a local SQLite title", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-title-id-"));
  const sessionID = "ses_runtime_title_id" as const;
  await mkdir(join(root, ".natalia"), { recursive: true });
  const seeded = new SessionStoreTestDatabase(
    resolveWorkspaceJournalDatabasePath(root),
  );
  seeded.create(sessionID, "chatcmpl-tool-b10625d073fa5e8d");
  seeded.updateMetadata(sessionID, { titleSource: "generated" });
  seeded.close();

  const provider: StreamingProvider = {
    provider: "scripted",
    model: "scripted-model",
    async *stream(request) {
      const titleRequest = request.messages.some(
        (message) =>
          message.role === "system" &&
          message.content.includes("Create a concise session topic"),
      );
      yield {
        type: "content",
        text: titleRequest ? "chatcmpl-tool-b10625d073fa5e8d" : "turn complete",
      };
      yield { type: "done" };
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    provider,
    useSqliteStore: true,
  });
  client.start(() => undefined);
  await client.submitAndWait!("修复会话标题");
  await waitForAsync(async () => {
    const current = (await client.sessionList?.())?.find(
      (item) => item.id === sessionID,
    );
    return current?.title === "修复会话标题";
  });
  await client.dispose?.();

  const persisted = new SessionStoreTestDatabase(
    resolveWorkspaceJournalDatabasePath(root),
  );
  expect(persisted.get(sessionID)).toMatchObject({
    title: "修复会话标题",
    metadata: { titleSource: "fallback" },
  });
  persisted.close();
});

test("runtime rebuilds a missing JSON session from SQLite history", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-sqlite-rebuild-"));
  const sessionID = "ses_runtime_sqlite_rebuild" as const;
  await mkdir(join(root, ".natalia"), { recursive: true });
  const database = new SessionStoreTestDatabase(
    resolveWorkspaceJournalDatabasePath(root),
  );
  database.create(sessionID, "Recovered SQLite session");
  database.appendEvent(sessionID, {
    type: "agent.selection",
    name: "recovered",
    pending: false,
  });
  database.close();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    provider: scriptedProvider("unused"),
    useSqliteStore: true,
  });
  client.start(() => undefined);
  await Bun.sleep(30);
  const sessions = await client.sessionList?.();
  expect(sessions?.find((item) => item.id === sessionID)).toMatchObject({
    title: "Recovered SQLite session",
  });
  expect(
    sessions?.find((item) => item.id === sessionID)?.events,
  ).toBeGreaterThanOrEqual(1);
});

test("runtime filesystem slash commands use the protected catalog", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-runtime-workspace-command-"),
  );
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.ts"), "const needle = true\n");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_workspace_command",
    provider: scriptedProvider("unused"),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("/files main");
  await client.submitAndWait!("/search needle");
  const output = events
    .filter((event) => event.type === "content.delta")
    .map((event) => event.text)
    .join("\n");
  expect(output).toContain("src/main.ts");
  expect(output).toContain("src/main.ts:1:const needle = true");
});

test("sessions slash command reports durable event counts", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-runtime-sessions-command-"),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_sessions_command",
    provider: scriptedProvider("unused"),
    useSqliteStore: true,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("first event");
  await client.submitAndWait!("/sessions");
  const output = events
    .filter((event) => event.type === "content.delta")
    .at(-1);
  expect(output?.type).toBe("content.delta");
  expect(output?.text).toContain("ses_runtime_sessions_command");
  expect(output?.text).toMatch(/\s[1-9]\d* events$/u);
  expect(
    (await client.commandCatalog?.())?.map((command) => command.name),
  ).toContain("sessions");
});

test("model slash commands share catalog and durable selection behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-model-command-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      providers: {
        local: {
          name: "Local",
          driver: "openai",
          connection: { apiKey: "local-key", baseURL: "http://127.0.0.1:9" },
        },
      },
      catalog: {
        providers: {
          local: {
            models: { alpha: { name: "alpha" }, beta: { name: "beta" } },
          },
        },
      },
      defaultModel: { provider: "local", model: "alpha" },
    }),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_model_command",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("/models");
  expect(
    events.filter((event) => event.type === "content.delta").at(-1),
  ).toMatchObject({
    text: expect.stringContaining("local/beta: beta @ local"),
  });
  await client.submitAndWait!("/model local/beta");
  expect(events).toContainEqual({
    type: "model.selection",
    modelID: "local/beta",
    variant: undefined,
    sessionID: "ses_runtime_model_command",
  });
});

test("configured provider policy denies a selected model without starting a provider request", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-provider-policy-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      providers: {
        local: {
          name: "Local",
          driver: "openai",
          connection: { apiKey: "local-key", baseURL: "http://127.0.0.1:9" },
        },
      },
      catalog: {
        providers: { local: { models: { blocked: { name: "blocked" } } } },
      },
      defaultModel: { provider: "local", model: "blocked" },
      experimental: {
        policies: [
          { effect: "deny", action: "provider.use", resource: "local/blocked" },
        ],
      },
    }),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_provider_policy",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("policy blocked");
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "diagnostic",
      level: "error",
      message: expect.stringContaining("No real provider configured"),
    }),
  );
});

test("model capability disables provider-visible tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-model-capabilities-"));
  const requests: ProviderStreamRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push((await request.json()) as ProviderStreamRequest);
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  try {
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({
        version: 3,
        providers: {
          local: {
            name: "Local",
            driver: "openai",
            connection: { apiKey: "key", baseURL: server.url.toString() },
          },
        },
        catalog: {
          providers: {
            local: {
              models: {
                text: {
                  name: "text",
                  capabilities: {
                    toolCall: false,
                    reasoning: false,
                    thinking: false,
                  },
                },
              },
            },
          },
        },
        defaultModel: { provider: "local", model: "text" },
      }),
    );
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: "ses_model_capabilities",
    });
    client.start(() => undefined);
    await client.submitAndWait!("no tools");
    expect(requests[0]?.tools).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("workspace image attachment is stored privately and lowered for OpenAI-compatible provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-image-attachment-"));
  const requests: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push((await request.json()) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  try {
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, "image.png"),
      Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex"),
    );
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({
        version: 3,
        providers: {
          local: {
            name: "Local",
            driver: "openai",
            connection: { apiKey: "key", baseURL: server.url.toString() },
          },
        },
        catalog: {
          providers: {
            local: {
              models: {
                vision: { name: "vision", capabilities: { imageInput: true } },
              },
            },
          },
        },
        defaultModel: { provider: "local", model: "vision" },
      }),
    );
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: "ses_image_attachment",
    });
    client.start(() => undefined);
    await client.submitAndWait!({
      text: "inspect",
      attachments: ["image.png"],
    });
    const history = await client.history?.({ limit: 500 });
    expect(
      history?.events.find((item) => item.event.type === "turn.submitted")
        ?.event,
    ).toMatchObject({ attachments: [{ mediaType: "image/png" }] });
    const messages = requests[0]?.messages as Array<{
      role: string;
      content: unknown;
    }>;
    // ADR D2: the runtime context block is an earlier user message; the
    // lowered image lives on the turn's request (the message with part
    // content), not on a plain-text request.
    const user = messages.findLast(
      (message) => message.role === "user" && Array.isArray(message.content),
    );
    expect(user?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image_url",
          image_url: expect.objectContaining({
            url: expect.stringMatching(/^data:image\/png;base64,/u),
          }),
        }),
      ]),
    );
    expect(await readdir(join(root, ".natalia", "attachments"))).toHaveLength(
      1,
    );
    await client.dispose?.();
    const reopened = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: "ses_image_attachment",
    });
    reopened.start(() => undefined);
    await reopened.submitAndWait!("follow up");
    const followUpMessages = requests[1]?.messages as Array<{
      role: string;
      content: unknown;
    }>;
    // The earlier turn's attachment is re-lowered into the replayed history.
    expect(
      followUpMessages.findLast(
        (message) => message.role === "user" && Array.isArray(message.content),
      )?.content,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image_url",
          image_url: expect.objectContaining({
            url: expect.stringMatching(/^data:image\/png;base64,/u),
          }),
        }),
      ]),
    );
    await reopened.dispose?.();
  } finally {
    server.stop(true);
  }
});

test("attachmentDataUrl authorizes by session-referenced attachment id", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-attachment-auth-"));
  const sessionID = "ses_attachment_auth";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    provider: scriptedProvider("ok"),
  });
  client.start(() => undefined);
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d494844520000000100000001",
    "hex",
  );
  const uploaded = await client.uploadAttachment!({
    name: "image.png",
    mediaType: "image/png",
    data: png.toString("base64"),
  });
  await expect(
    client.attachmentDataUrl!({
      attachmentID: uploaded.id,
      sessionID,
    }),
  ).rejects.toThrow("not referenced");

  await client.submitAndWait!({
    text: "inspect",
    attachments: [uploaded.path],
  });
  const history = await client.history?.({ limit: 500 });
  const submitted = history?.events.find(
    (entry) => entry.event.type === "turn.submitted",
  )?.event;
  const referenced =
    submitted?.type === "turn.submitted"
      ? submitted.attachments?.[0]
      : undefined;
  expect(referenced).toBeDefined();
  expect(referenced!.id).not.toBe(uploaded.id);

  await expect(
    client.attachmentDataUrl!({
      attachmentID: referenced!.id,
      sessionID,
    }),
  ).resolves.toMatch(/^data:image\/png;base64,/u);
  await expect(
    client.attachmentDataUrl!({
      attachmentID: referenced!.id,
      sessionID: "ses_attachment_auth_other",
    }),
  ).rejects.toThrow();
  await expect(
    client.attachmentDataUrl!({
      path: referenced!.path,
      mediaType: referenced!.mediaType,
    }),
  ).resolves.toMatch(/^data:image\/png;base64,/u);
  await client.dispose?.();
}, 30_000);

test("unsupported video attachments degrade to text instead of failing the turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-video-attachment-"));
  const requests: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push((await request.json()) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  try {
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, "clip.mp4"),
      Buffer.from("0000001866747970", "hex"),
    );
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({
        version: 3,
        providers: {
          local: {
            name: "Local",
            driver: "openai",
            connection: { apiKey: "key", baseURL: server.url.toString() },
          },
        },
        catalog: {
          providers: {
            local: {
              models: {
                plain: { name: "plain", capabilities: { imageInput: true } },
                vision: {
                  name: "vision",
                  capabilities: { imageInput: true, videoInput: true },
                },
              },
            },
          },
        },
        defaultModel: { provider: "local", model: "plain" },
      }),
    );
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: "ses_video_attachment",
    });
    client.start(() => undefined);
    const userText = (request: Record<string, unknown> | undefined): string => {
      const messages = request?.messages as Array<{
        role: string;
        content: unknown;
      }>;
      return (messages ?? [])
        .filter((message) => message.role === "user")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content ?? ""),
        )
        .join("\n");
    };
    const finished = async (stopReason: string) => {
      for (let elapsed = 0; elapsed < 3_000; elapsed += 10) {
        const history = await client.history?.({ limit: 500 });
        const event = history?.events.find(
          (item) =>
            item.event.type === "turn.finished" &&
            (item.event as { stopReason?: string }).stopReason === stopReason,
        );
        if (event) return event.event;
        await Bun.sleep(10);
      }
      throw new Error(`timed out waiting for turn.finished:${stopReason}`);
    };

    await client.submitAndWait!({ text: "watch", attachments: ["clip.mp4"] });
    expect(await finished("done")).toMatchObject({ stopReason: "done" });
    expect(userText(requests[0])).toContain("[Attached video/mp4: clip.mp4]");

    // Title generation races this config switch: the task reads
    // exec.provider AFTER async persistence/store I/O, so an
    // updateConfig(vision) landing in that window turns the title call
    // into a phantom "vision" request without attachments — and
    // find(vision) below would pick it. Drain the title request first
    // (its provider is resolved pre-switch), then switch. This was the
    // root of this test's long-standing rotation failures.
    for (let elapsed = 0; elapsed < 3_000 && requests.length < 2; elapsed += 10)
      await Bun.sleep(10);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[1]?.model).toBe("plain");

    await client.updateConfig?.({
      patch: { defaultModel: { provider: "local", model: "vision" } },
    });
    await client.submitAndWait!({ text: "watch", attachments: ["clip.mp4"] });
    expect(await finished("done")).toMatchObject({ stopReason: "done" });
    const visionRequest = requests.find(
      (request) => request.model === "vision",
    );
    expect(visionRequest).toBeDefined();
    expect(userText(visionRequest)).toContain("[Attached video/mp4: clip.mp4]");
    await client.dispose?.();
  } finally {
    server.stop(true);
  }
});

test("runtime injects a UTF-8 text attachment into the active provider turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-text-attachment-"));
  const requests: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push((await request.json()) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  try {
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(join(root, "notes.md"), "evidence");
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({
        version: 3,
        providers: {
          local: {
            name: "Local",
            driver: "openai",
            connection: { apiKey: "key", baseURL: server.url.toString() },
          },
        },
        catalog: {
          providers: { local: { models: { text: { name: "text" } } } },
        },
        defaultModel: { provider: "local", model: "text" },
      }),
    );
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: "ses_text_attachment",
    });
    client.start(() => undefined);
    await client.submitAndWait!({ text: "review", attachments: ["notes.md"] });
    const messages = requests[0]?.messages as Array<{
      role: string;
      content: string;
    }>;
    // ADR D2: the turn's request is the trailing user message; the runtime
    // context block is an earlier user message.
    expect(
      messages.findLast((message) => message.role === "user")?.content,
    ).toContain("[Attachment: notes.md]\nevidence");
  } finally {
    server.stop(true);
  }
});

test("runtime rejects a PDF attachment before provider dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pdf-attachment-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(join(root, "report.pdf"), "%PDF-1.7\n");
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_pdf_attachment",
    provider: scriptedProvider("ok"),
  });
  client.start(() => undefined);
  await expect(
    client.submitAndWait!({
      text: "read",
      attachments: ["report.pdf"],
    }),
  ).rejects.toThrow(/unsupported/u);
  await client.dispose?.();
});

test("agent MCP server scope limits provider-visible MCP tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-agent-mcp-scope-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      agents: { scoped: { description: "Scoped", mcpServers: ["one"] } },
      defaultAgent: "scoped",
    }),
  );
  const tools = createToolRegistry([]);
  for (const name of ["mcp_one_echo", "mcp_two_echo"]) {
    tools.set(name, {
      name,
      description: name,
      requiresApproval: false,
      parameters: { type: "object", properties: {} },
      async execute() {
        return "ok";
      },
    });
  }
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_agent_mcp_scope",
    tools,
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request);
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.submitAndWait!("scope MCP tools");
  expect(requests[0]?.tools?.map((tool) => tool.name)).toContain(
    "mcp_one_echo",
  );
  expect(requests[0]?.tools?.map((tool) => tool.name)).not.toContain(
    "mcp_two_echo",
  );
});

test("agent MCP scope includes only its server prompt and resource tools", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-agent-mcp-catalog-scope-"),
  );
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      agents: { scoped: { description: "Scoped", mcpServers: ["one"] } },
      defaultAgent: "scoped",
    }),
  );
  const tools = createToolRegistry([]);
  for (const name of [
    "mcp_one_prompt_get",
    "mcp_one_resource_read",
    "mcp_two_prompt_get",
    "mcp_two_resource_read",
  ]) {
    tools.set(name, {
      name,
      description: name,
      requiresApproval: false,
      parameters: { type: "object", properties: {} },
      async execute() {
        return "ok";
      },
    });
  }
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_agent_mcp_catalog_scope",
    tools,
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request);
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.submitAndWait!("scope MCP catalog tools");
  const names = requests[0]?.tools?.map((tool) => tool.name) ?? [];
  expect(names).toEqual(
    expect.arrayContaining(["mcp_one_prompt_get", "mcp_one_resource_read"]),
  );
  expect(names).not.toEqual(
    expect.arrayContaining(["mcp_two_prompt_get", "mcp_two_resource_read"]),
  );
});

test("runtime persists and lowers structured agent resource mentions", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-mentions-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      agents: { review: { description: "Review" } },
    }),
  );
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_mentions",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request);
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.submitInput?.({
    text: "inspect this",
    resources: [{ server: "missing", uri: "docs://guide", name: "Guide" }],
    agents: [{ name: "review" }],
  });
  expect(requests).toHaveLength(0);
  expect(client.lastSubmission?.()).toMatchObject({
    resources: [{ server: "missing", uri: "docs://guide", name: "Guide" }],
    agents: [{ name: "review" }],
  });
});

test("real runtime client routes checkpoint slash commands to real store", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-checkpoint-"));
  await writeFile(join(root, "test_example.py"), "print('ok')\n");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_checkpoint",
    provider: scriptedProvider("unused"),
  });
  client.start((event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === "session.ready"));
  await client.submitAndWait!("/checkpoint");
  await writeFile(join(root, "created_after.py"), "print('new')\n");
  await client.submitAndWait!("/rollback checkpoint_1 --dry-run");

  expect(
    events.some(
      (event) =>
        event.type === "checkpoint.created" && event.reason === "manual",
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) => event.type === "rollback.previewed" && event.preview.dryRun,
    ),
  ).toBe(true);
  expect(
    (await client.registeredTools?.())?.find(
      (tool) => tool.name === "skill_load",
    )?.owner,
  ).toBe("natalia-skills");
  await client.dispose?.();
});

test("real runtime client executes model tool calls with approval policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-tools-"));
  await writeFile(join(root, "input.txt"), "tool data\n");
  const events: RuntimeEvent[] = [];
  const provider = toolCallingProvider();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_tools",
    provider,
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("Read input.txt");

  expect(
    events.some(
      (event) =>
        event.type === "tool.update" &&
        event.name === "read_file" &&
        event.status === "succeeded",
    ),
  ).toBe(true);
  expect(
    events
      .filter((event) => event.type === "content.delta")
      .map((event) => event.text)
      .join(""),
  ).toContain("tool said: tool data");
  expect(
    provider.requests
      .at(-1)
      ?.messages.some(
        (message) =>
          message.role === "tool" && message.content.includes("tool data"),
      ),
  ).toBe(true);
});

test("run_shell constitution checks allow ordinary cat commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-shell-cat-"));
  await writeFile(join(root, "input.txt"), "shell data\n");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_shell_cat",
    permissionMode: "auto",
    provider: {
      provider: "scripted-shell-cat",
      model: "scripted-shell-cat-model",
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_cat",
                name: "run_shell",
                arguments: JSON.stringify({ command: "cat input.txt" }),
              },
            ],
          };
          yield { type: "done" as const };
          return;
        }
        yield { type: "content" as const, text: "shell command completed" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));

  await client.submitAndWait!("cat input.txt");

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.update",
      name: "run_shell",
      status: "succeeded",
      result: expect.stringContaining("shell data"),
    }),
  );
  expect(JSON.stringify(events)).not.toContain("DANGEROUS_SHELL_PATTERNS");
  expect(JSON.stringify(events)).not.toContain("dangerous shell patterns");
});

test("real runtime reserves the configured final step for a text response", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-tool-finalize-"));
  await writeFile(join(root, "input.txt"), "tool data\n");
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, runtime: { maxStepsPerTurn: 10 } }),
  );
  const requests: ProviderStreamRequest[] = [];
  const provider: StreamingProvider = {
    provider: "scripted-tool-finalize",
    model: "scripted-tool-finalize-model",
    async *stream(request) {
      const mainTurnRequest =
        request.tools !== undefined ||
        request.messages.some((message) =>
          message.content.includes("MAXIMUM STEPS REACHED"),
        );
      if (mainTurnRequest) requests.push(request);
      if (request.tools === undefined) {
        yield { type: "content", text: "All tool checks completed." };
        yield { type: "done" };
        return;
      }
      yield {
        type: "tool_call",
        calls: [
          {
            id: `call_read_${requests.length}`,
            name: "read_file",
            arguments: JSON.stringify({ path: "input.txt" }),
          },
        ],
      };
      yield { type: "done" };
    },
  };
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_tool_finalize",
    provider,
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("run every tool step");

  expect(requests).toHaveLength(10);
  expect(requests.slice(0, -1).every((request) => request.tools?.length)).toBe(
    true,
  );
  expect(requests.at(-1)?.tools).toBeUndefined();
  expect(requests.at(-1)?.toolChoice).toBe("none");
  expect(
    requests
      .at(-1)
      ?.messages.some((message) =>
        message.content.includes("MAXIMUM STEPS REACHED"),
      ),
  ).toBe(true);
  expect(
    events
      .filter((event) => event.type === "content.delta")
      .map((event) => event.text)
      .join(""),
  ).toContain("All tool checks completed.");
  expect(
    events.filter((event) => event.type === "turn.finished").at(-1),
  ).toMatchObject({
    type: "turn.finished",
    stopReason: "done",
  });
});

test("tool turns require a non-empty final assistant response", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-final-response-"));
  await writeFile(join(root, "input.txt"), "tool data\n");
  let requests = 0;
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_final_response",
    permissionMode: "auto",
    provider: {
      provider: "scripted-final-response",
      model: "scripted-final-response-model",
      async *stream(request) {
        requests += 1;
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_read_final",
                name: "read_file",
                arguments: JSON.stringify({ path: "input.txt" }),
              },
            ],
          };
        } else {
          yield {
            type: "content",
            text: "The file check completed successfully.",
          };
        }
        yield { type: "done" };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("check the file");

  expect(requests).toBe(2);
  expect(
    events
      .filter((event) => event.type === "content.delta")
      .map((event) => event.text)
      .join(""),
  ).toBe("The file check completed successfully.");
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "turn.finished",
      id: expect.any(String),
      stopReason: "done",
      sessionID: "ses_ts7_final_response",
    }),
  );
});

test("tool turns emit fallback text when the model omits its final response", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-missing-final-"));
  await writeFile(join(root, "input.txt"), "tool data\n");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_missing_final",
    permissionMode: "auto",
    provider: {
      provider: "scripted-missing-final",
      model: "scripted-missing-final-model",
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_read_missing_final",
                name: "read_file",
                arguments: JSON.stringify({ path: "input.txt" }),
              },
            ],
          };
        }
        yield { type: "done" };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("check the file");

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "turn.finished",
      id: expect.any(String),
      stopReason: "done",
      sessionID: "ses_ts7_missing_final",
    }),
  );
  expect(
    events.some(
      (event) => event.type === "diagnostic" && event.level === "error",
    ),
  ).toBe(false);
  expect(
    events
      .filter((event) => event.type === "content.delta")
      .map((event) => event.text)
      .join(""),
  ).toContain("Tool execution completed");
});

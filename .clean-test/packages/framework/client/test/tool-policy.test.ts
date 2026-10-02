import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createOfficialRuntimeClient as createRealRuntimeClient,
  officialPluginWorkspace as mkdtemp,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();
import {
  createToolPolicyHookLayer,
  type ToolHooks,
  type ToolPolicy,
  type RuntimeEvent,
} from "../src";
import {
  commandTextForTool,
  evaluatePermissionRules,
  evaluatePermissionProfileCommandRules,
  TerminalCommandBuffer,
} from "@anthelia/tools";
import { parseBashSimpleCommand } from "@anthelia/tools";
import {
  terminalApprovalScope,
  terminalInputRisk,
} from "@anthelia/runtime-services";
import type {
  ProviderStreamRequest,
  StreamingProvider,
} from "@anthelia/runtime";
import { WorkspaceSandboxTestManager as WorkspaceSandboxManager } from "@natalia/testing";

test("createToolPolicyHookLayer default allows all tools", () => {
  const layer = createToolPolicyHookLayer();
  expect(layer.isToolAllowed("read_file")).toBe(true);
  expect(layer.isToolAllowed("write_file")).toBe(true);
  expect(layer.isToolAllowed("unknown")).toBe(true);
});

test("createToolPolicyHookLayer allow list restricts tools", () => {
  const policy: ToolPolicy = { allow: ["read_file", "glob"] };
  const layer = createToolPolicyHookLayer(policy);
  expect(layer.isToolAllowed("read_file")).toBe(true);
  expect(layer.isToolAllowed("glob")).toBe(true);
  expect(layer.isToolAllowed("write_file")).toBe(false);
  expect(layer.isToolAllowed("run_shell")).toBe(false);
});

test("createToolPolicyHookLayer exclude list blocks specific tools", () => {
  const policy: ToolPolicy = { exclude: ["write_file", "edit_file"] };
  const layer = createToolPolicyHookLayer(policy);
  expect(layer.isToolAllowed("read_file")).toBe(true);
  expect(layer.isToolAllowed("glob")).toBe(true);
  expect(layer.isToolAllowed("write_file")).toBe(false);
  expect(layer.isToolAllowed("edit_file")).toBe(false);
});

test("createToolPolicyHookLayer allow and exclude together", () => {
  const policy: ToolPolicy = {
    allow: ["read_*", "write_*"],
    exclude: ["write_file"],
  };
  const layer = createToolPolicyHookLayer(policy);
  expect(layer.isToolAllowed("read_file")).toBe(true);
  expect(layer.isToolAllowed("read_dir")).toBe(true);
  expect(layer.isToolAllowed("write_file")).toBe(false);
  expect(layer.isToolAllowed("write_dir")).toBe(true);
});

test("createToolPolicyHookLayer filterTools filters arrays", () => {
  const policy: ToolPolicy = { allow: ["read_file", "glob"] };
  const layer = createToolPolicyHookLayer(policy);
  const tools = [
    { name: "read_file", description: "a" },
    { name: "write_file", description: "b" },
    { name: "glob", description: "c" },
  ];
  const filtered = layer.filterTools(tools);
  expect(filtered).toEqual([
    { name: "read_file", description: "a" },
    { name: "glob", description: "c" },
  ]);
});

test("createToolPolicyHookLayer preExecute blocks disallowed tools", async () => {
  const policy: ToolPolicy = { exclude: ["dangerous_tool"] };
  const layer = createToolPolicyHookLayer(policy);
  const result = await layer.preExecute({
    turnID: "turn_1",
    toolName: "dangerous_tool",
    toolCallID: "call_1",
    arguments: "{}",
  });
  expect(result.allowed).toBe(false);
  expect(result.diagnostics).toContain("blocked by policy: dangerous_tool");
});

test("createToolPolicyHookLayer preExecute allows allowed tools", async () => {
  const layer = createToolPolicyHookLayer();
  const result = await layer.preExecute({
    turnID: "turn_1",
    toolName: "read_file",
    toolCallID: "call_1",
    arguments: '{"path":"test.txt"}',
  });
  expect(result.allowed).toBe(true);
  expect(result.diagnostics).toEqual([]);
});

test("invalid command policy regex fails closed with a diagnostic", async () => {
  const result = evaluatePermissionRules(
    { commands: { denyPatterns: ["["] } },
    "run_shell",
    { command: "echo safe" },
  );
  expect(result.allowed).toBe(false);
  expect(result.diagnostics.join(" ")).toContain(
    "invalid command deny pattern",
  );
});

test("structured profile command rules parse only one simple Bash command", async () => {
  await expect(parseBashSimpleCommand("git push origin main")).resolves.toEqual(
    {
      ok: true,
      command: { tokens: ["git", "push", "origin", "main"] },
    },
  );
  for (const source of [
    "git status && git push",
    "git status | less",
    "git status > status.txt",
    "echo $(date)",
    "(git status)",
    "function check() { git status; }",
  ])
    await expect(parseBashSimpleCommand(source)).resolves.toMatchObject({
      ok: false,
    });
});

test("structured profile command rules use exact AST token prefixes", async () => {
  const denied = await evaluatePermissionProfileCommandRules(
    {
      mode: "blacklist",
      rules: [{ command: "rm -rf /tmp", reason: "temporary files are owned" }],
    },
    "run_shell",
    { command: "rm -rf /tmp generated" },
  );
  expect(denied).toMatchObject({
    allowed: false,
    reason: "command blocked by policy",
  });
  await expect(
    evaluatePermissionProfileCommandRules(
      {
        mode: "blacklist",
        rules: [{ command: "rm -rf /tmp" }],
      },
      "run_shell",
      { command: "rm -rf /var/tmp" },
    ),
  ).resolves.toMatchObject({ allowed: true });
  await expect(
    evaluatePermissionProfileCommandRules(
      {
        mode: "blacklist",
        rules: [{ command: "git push" }],
      },
      "run_shell",
      { command: "git diff" },
    ),
  ).resolves.toMatchObject({ allowed: true });
});

test("structured profile command rules enforce whitelist and fail closed", async () => {
  await expect(
    evaluatePermissionProfileCommandRules(
      { mode: "whitelist", rules: [{ command: "git diff" }] },
      "interactive_terminal_send_line",
      { id: "term", text: "git diff --stat" },
    ),
  ).resolves.toMatchObject({ allowed: true });
  await expect(
    evaluatePermissionProfileCommandRules(
      { mode: "whitelist", rules: [{ command: "git diff" }] },
      "interactive_terminal_send_line",
      { id: "term", text: "git status" },
    ),
  ).resolves.toMatchObject({ allowed: false });
  await expect(
    evaluatePermissionProfileCommandRules(
      { mode: "whitelist", rules: [{ command: "git status && pwd" }] },
      "run_shell",
      { command: "git status" },
    ),
  ).resolves.toMatchObject({
    allowed: false,
    reason: "command policy configuration is invalid",
  });
});

test("terminal command buffer evaluates the complete pane line on submit", async () => {
  const buffer = new TerminalCommandBuffer();
  const rules = { mode: "blacklist" as const, rules: [{ command: "rm -rf" }] };
  await expect(
    buffer.evaluate(rules, "interactive_terminal_write", {
      id: "pane_a",
      input: "rm ",
    }),
  ).resolves.toMatchObject({ allowed: true });
  await expect(
    buffer.evaluate(rules, "interactive_terminal_send_line", {
      id: "pane_a",
      text: "-rf /tmp",
    }),
  ).resolves.toMatchObject({ allowed: false, clearTerminal: true });
  // The denied command was cleared, so a later command on this pane is not
  // contaminated by the old prefix.
  await expect(
    buffer.evaluate(rules, "interactive_terminal_send_line", {
      id: "pane_a",
      text: "git status",
    }),
  ).resolves.toMatchObject({ allowed: true });
});

test("terminal command buffer intersects profile and active module rules", async () => {
  const buffer = new TerminalCommandBuffer();
  const profile = {
    mode: "whitelist" as const,
    rules: [{ command: "git status" }],
  };
  const module = {
    mode: "blacklist" as const,
    rules: [{ command: "git status", reason: "module only reads diffs" }],
  };
  await expect(
    buffer.evaluate([profile, module], "interactive_terminal_send_line", {
      id: "pane_a",
      text: "git status",
    }),
  ).resolves.toMatchObject({
    allowed: false,
    clearTerminal: true,
    diagnostics: [expect.stringContaining("active module deny rule")],
  });
});

test("terminal command buffer is pane-scoped and fails closed for unsafe input", async () => {
  const buffer = new TerminalCommandBuffer();
  const rules = {
    mode: "whitelist" as const,
    rules: [{ command: "git diff" }],
  };
  await buffer.evaluate(rules, "interactive_terminal_write", {
    id: "pane_a",
    input: "git ",
  });
  await expect(
    buffer.evaluate(rules, "interactive_terminal_send_line", {
      id: "pane_b",
      text: "git diff --stat",
    }),
  ).resolves.toMatchObject({ allowed: true });
  await expect(
    buffer.evaluate(rules, "interactive_terminal_keys", {
      id: "pane_a",
      keys: [{ key: "ArrowUp" }],
    }),
  ).resolves.toMatchObject({ allowed: false, clearTerminal: true });
  await expect(
    buffer.evaluate(rules, "interactive_terminal_send_line", {
      id: "pane_a",
      text: "diff --stat",
    }),
  ).resolves.toMatchObject({ allowed: false });
});

test("apply_edits is evaluated per path it touches", () => {
  const fileRules = {
    files: {
      writePaths: [
        { pattern: "protected/*", allow: false, reason: "protected" },
      ],
    },
  };
  // An edit that touches a protected path is blocked even when it also touches
  // an allowed one.
  expect(
    evaluatePermissionRules(fileRules, "apply_edits", {
      edits: [
        { path: "open.ts", operation: "replace", oldText: "a", newText: "A" },
        {
          path: "protected/secret.ts",
          operation: "replace",
          oldText: "b",
          newText: "B",
        },
      ],
    }),
  ).toMatchObject({ allowed: false, reason: "protected" });
  // An edit that avoids protected paths is allowed.
  expect(
    evaluatePermissionRules(fileRules, "apply_edits", {
      edits: [
        { path: "open.ts", operation: "replace", oldText: "a", newText: "A" },
      ],
    }),
  ).toMatchObject({ allowed: true });
});

test("agent rules cover sandbox paths and all command-launching tools", () => {
  const fileRules = {
    files: {
      writePaths: [
        { pattern: "protected/*", allow: false, reason: "protected" },
      ],
    },
  };
  expect(
    evaluatePermissionRules(fileRules, "sandbox_write", {
      path: "protected/note.txt",
    }),
  ).toMatchObject({ allowed: false, reason: "protected" });
  expect(
    evaluatePermissionRules(fileRules, "browser_screenshot", {
      path: "protected/page.png",
    }),
  ).toMatchObject({ allowed: false, reason: "protected" });
  expect(
    evaluatePermissionRules(
      { files: { readPaths: fileRules.files.writePaths } },
      "glob",
      { path: "protected/note.txt" },
    ),
  ).toMatchObject({ allowed: false, reason: "protected" });
  expect(
    evaluatePermissionRules(
      { files: { readPaths: fileRules.files.writePaths } },
      "grep",
      { path: "protected/note.txt" },
    ),
  ).toMatchObject({ allowed: false, reason: "protected" });

  const commandRules = { commands: { denyPatterns: ["rm\\s+-rf"] } };
  for (const toolName of [
    "sandbox_execute",
    "sandbox_resource_start",
    "process_start",
    "background_start",
    "interactive_start",
    "interactive_terminal_start",
  ])
    expect(
      evaluatePermissionRules(commandRules, toolName, {
        command: "rm -rf generated",
      }),
    ).toMatchObject({ allowed: false, reason: "command blocked by policy" });
});

test("command policy covers terminal input, not only command arguments", () => {
  const rules = { commands: { denyPatterns: ["rm\\s+-rf"] } };
  // Every terminal write entry point, under both its canonical name and its
  // registered alias, carrying the command in whichever field that tool uses.
  const calls: [string, Record<string, unknown>][] = [
    ["interactive_terminal_send_line", { id: "t", text: "rm -rf /" }],
    ["interactive_terminal_write", { id: "t", input: "rm -rf /" }],
    ["interactive_terminal_input", { id: "t", text: "rm -rf /" }],
    ["interactive_terminal_keys", { id: "t", key: "rm -rf /" }],
    ["interactive_send_line", { id: "t", text: "rm -rf /" }],
    ["interactive_write", { id: "t", input: "rm -rf /" }],
    ["interactive_input", { id: "t", text: "rm -rf /" }],
    ["interactive_keys", { id: "t", key: "rm -rf /" }],
  ];
  for (const [toolName, args] of calls)
    expect(evaluatePermissionRules(rules, toolName, args)).toMatchObject({
      allowed: false,
      reason: "command blocked by policy",
    });
});

test("terminal command text reconstructs key-by-key typing", () => {
  // Typing a command one key at a time must not evade the policy.
  expect(
    commandTextForTool("interactive_terminal_input", {
      keys: [
        { key: "r" },
        { key: "m" },
        { key: " " },
        { key: "-" },
        { key: "r" },
        { key: "f" },
      ],
    }),
  ).toBe("rm -rf");
  expect(
    evaluatePermissionRules(
      { commands: { denyPatterns: ["rm\\s+-rf"] } },
      "interactive_terminal_input",
      {
        id: "t",
        keys: [{ text: "rm" }, { text: " -rf" }, { text: " /" }],
      },
    ),
  ).toMatchObject({ allowed: false });
});

test("terminal command text keeps separate input sources apart", () => {
  // Sources are joined by newline so two harmless fields cannot be spliced
  // into a token that neither of them contained.
  expect(
    commandTextForTool("interactive_terminal_input", {
      text: "r",
      keys: [{ key: "m" }],
    }),
  ).toBe("r\nm");
  expect(
    evaluatePermissionRules(
      { commands: { denyPatterns: ["\\brm\\b"] } },
      "interactive_terminal_input",
      { id: "t", text: "r", keys: [{ key: "m" }] },
    ),
  ).toMatchObject({ allowed: true });
});

test("terminal input honours command allow lists and ignores unrelated tools", () => {
  const allowOnlyGit = { commands: { allowPatterns: ["^git\\s"] } };
  expect(
    evaluatePermissionRules(allowOnlyGit, "interactive_terminal_send_line", {
      id: "t",
      text: "git status",
    }),
  ).toMatchObject({ allowed: true });
  expect(
    evaluatePermissionRules(allowOnlyGit, "interactive_terminal_send_line", {
      id: "t",
      text: "ls",
    }),
  ).toMatchObject({ allowed: false, reason: "command blocked by policy" });
  // A tool that runs no command is not a command carrier, whatever its args.
  expect(commandTextForTool("read_file", { text: "rm -rf /" })).toBeUndefined();
  expect(
    evaluatePermissionRules(
      { commands: { denyPatterns: ["rm\\s+-rf"] } },
      "read_file",
      { path: "a.txt", text: "rm -rf /" },
    ),
  ).toMatchObject({ allowed: true });
  // Calls that carry no input at all stay undefined rather than empty string.
  expect(
    commandTextForTool("interactive_terminal_input", { id: "t" }),
  ).toBeUndefined();
});

test("file rules cannot be evaded by respelling the same path", () => {
  const rules = {
    files: {
      writePaths: [
        { pattern: "secret.txt", allow: false, reason: "protected" },
      ],
      readPaths: [{ pattern: "secret.txt", allow: false, reason: "protected" }],
    },
  };
  const root = "/tmp/policy-workspace";
  // Every spelling below resolves to the same file the tool would write.
  for (const path of [
    "secret.txt",
    "./secret.txt",
    "dir/../secret.txt",
    "/tmp/policy-workspace/secret.txt",
    ".\\secret.txt",
  ]) {
    expect(
      evaluatePermissionRules(rules, "write_file", { path }, root),
    ).toMatchObject({ allowed: false, reason: "protected" });
    expect(
      evaluatePermissionRules(rules, "read_file", { path }, root),
    ).toMatchObject({ allowed: false, reason: "protected" });
  }
  // Different files stay allowed, so normalization does not over-block.
  expect(
    evaluatePermissionRules(rules, "write_file", { path: "other.txt" }, root),
  ).toMatchObject({ allowed: true });
  expect(
    evaluatePermissionRules(
      rules,
      "write_file",
      { path: "sub/secret.txt" },
      root,
    ),
  ).toMatchObject({ allowed: true });
  // Rules still apply when no workspace root is supplied.
  expect(
    evaluatePermissionRules(rules, "write_file", { path: "./secret.txt" }),
  ).toMatchObject({ allowed: false, reason: "protected" });
});

test("terminal low-risk approval scopes bind one terminal and exclude high-risk input", () => {
  expect(
    terminalApprovalScope(
      "interactive_terminal_send_line",
      JSON.stringify({ id: "terminal_a", text: "ls" }),
    ),
  ).toMatchObject({
    terminalID: "terminal_a",
    scope: "terminal:terminal_a:low-risk",
    risk: "terminal_low",
  });
  expect(
    terminalApprovalScope(
      "interactive_terminal_send_line",
      JSON.stringify({ id: "terminal_b", text: "ls" }),
    ),
  ).toMatchObject({ scope: "terminal:terminal_b:low-risk" });
  expect(
    terminalApprovalScope(
      "interactive_terminal_send_line",
      JSON.stringify({ id: "terminal_a", text: "rm -rf generated" }),
    ),
  ).toMatchObject({
    scope: "terminal:terminal_a:high-risk",
    risk: "terminal_high",
  });
  expect(
    terminalApprovalScope(
      "interactive_terminal_keys",
      JSON.stringify({ id: "terminal_a", key: "ArrowUp" }),
    ),
  ).toMatchObject({ risk: "terminal_high" });
  expect(
    terminalInputRisk("interactive_terminal_keys", {
      key: "x",
    }),
  ).toBe("terminal_low");
  expect(
    terminalInputRisk("interactive_terminal_keys", {
      key: "x",
      modifiers: ["ctrl"],
    }),
  ).toBe("terminal_high");
});

test("createToolPolicyHookLayer preExecute calls custom hook", async () => {
  const calls: string[] = [];
  const hooks: ToolHooks = {
    preExecute: async (event) => {
      calls.push(event.toolName);
      return { allowed: true, diagnostics: ["custom check ok"] };
    },
  };
  const layer = createToolPolicyHookLayer(undefined, hooks);
  const result = await layer.preExecute({
    turnID: "turn_1",
    toolName: "read_file",
    toolCallID: "call_1",
    arguments: "{}",
  });
  expect(calls).toEqual(["read_file"]);
  expect(result.allowed).toBe(true);
  expect(result.diagnostics).toContain("custom check ok");
});

test("createToolPolicyHookLayer preExecute hook can block", async () => {
  const hooks: ToolHooks = {
    preExecute: async (event) => {
      if (event.toolName === "write_file")
        return { allowed: false, diagnostics: ["write not allowed by hook"] };
      return { allowed: true, diagnostics: [] };
    },
  };
  const layer = createToolPolicyHookLayer(undefined, hooks);
  const allowed = await layer.preExecute({
    turnID: "turn_1",
    toolName: "read_file",
    toolCallID: "call_1",
    arguments: "{}",
  });
  const blocked = await layer.preExecute({
    turnID: "turn_1",
    toolName: "write_file",
    toolCallID: "call_2",
    arguments: "{}",
  });
  expect(allowed.allowed).toBe(true);
  expect(blocked.allowed).toBe(false);
  expect(blocked.diagnostics).toContain("write not allowed by hook");
});

test("createToolPolicyHookLayer preserves terminal cleanup on a policy denial", async () => {
  const layer = createToolPolicyHookLayer(undefined, {
    preExecute: () => ({
      allowed: false,
      diagnostics: ["blocked command"],
      clearTerminal: true,
    }),
  });
  await expect(
    layer.preExecute({
      turnID: "turn_1",
      toolName: "interactive_terminal_send_line",
      toolCallID: "call_1",
      arguments: '{"id":"pane"}',
    }),
  ).resolves.toMatchObject({ allowed: false, clearTerminal: true });
});

test("createToolPolicyHookLayer postExecute calls custom hook", async () => {
  const captured: Array<{ toolName: string; result?: string; error?: string }> =
    [];
  const hooks: ToolHooks = {
    postExecute: async (event) => {
      captured.push({
        toolName: event.toolName,
        result: event.result,
        error: event.error,
      });
    },
  };
  const layer = createToolPolicyHookLayer(undefined, hooks);
  await layer.postExecute({
    turnID: "turn_1",
    toolName: "read_file",
    toolCallID: "call_1",
    arguments: "{}",
    result: "file content",
  });
  expect(captured).toEqual([
    { toolName: "read_file", result: "file content", error: undefined },
  ]);
});

test("createToolPolicyHookLayer postExecute captures errors", async () => {
  const captured: Array<{ toolName: string; error?: string }> = [];
  const hooks: ToolHooks = {
    postExecute: async (event) => {
      captured.push({ toolName: event.toolName, error: event.error });
    },
  };
  const layer = createToolPolicyHookLayer(undefined, hooks);
  await layer.postExecute({
    turnID: "turn_1",
    toolName: "write_file",
    toolCallID: "call_2",
    arguments: "{}",
    error: "permission denied",
  });
  expect(captured).toEqual([
    { toolName: "write_file", error: "permission denied" },
  ]);
});

test("real runtime client with allow policy prevents excluded tools from provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-policy-allow-"));
  const events: RuntimeEvent[] = [];
  const requests: ProviderStreamRequest[] = [];
  const provider: StreamingProvider & { requests: ProviderStreamRequest[] } = {
    provider: "scripted-policy",
    model: "scripted-policy-model",
    requests,
    async *stream(request: ProviderStreamRequest) {
      requests.push(request);
      yield { type: "content", text: "ok" };
      yield { type: "done" };
    },
  };
  const policy: ToolPolicy = { allow: ["read_file"] };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_policy_allow",
    provider,
    permissionMode: "auto",
    toolPolicy: policy,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("run");
  const toolsSent = requests[0]?.tools ?? [];
  const toolNames = toolsSent.map((t) => t.name);
  expect(toolNames).toContain("read_file");
  expect(toolNames).not.toContain("write_file");
  expect(toolNames).not.toContain("run_shell");
});

test("mode permission profile overrides default runtime approval mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mode-permission-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await Bun.write(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      agentModes: {
        ask: { approval: "ask", description: "Ask" },
        safe: { approval: "read_only", description: "Safe mode" },
        review: { approval: "read_only", description: "Review mode" },
      },
      defaultAgentMode: "review",
    }),
  );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mode_permission",
    provider: toolCallingProviderWithName("read_file"),
  });
  client.start(() => undefined);

  expect(await client.runtimeStatus?.()).toMatchObject({
    permissions: "read_only",
  });
});

test("permission profile command rules deny before execution and audit the decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-profile-command-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await Bun.write(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      agentModes: {
        guarded: {
          approval: "auto",
          description: "Guarded commands",
          commandRules: {
            mode: "blacklist",
            rules: [{ command: "git push", reason: "publish manually" }],
          },
        },
      },
    }),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_profile_command",
    permissionProfile: "guarded",
    provider: {
      provider: "scripted-command",
      model: "scripted-command-model",
      async *stream(request: ProviderStreamRequest) {
        if (!request.messages.some((message) => message.role === "tool"))
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_command",
                name: "run_shell",
                arguments: JSON.stringify({ command: "git push origin main" }),
              },
            ],
          };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("publish changes");

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "policy.decision",
      toolName: "run_shell",
      decision: "deny",
      reason: expect.stringContaining(
        'command matches profile deny rule "git push"',
      ),
    }),
  );
  expect(events.some((event) => event.type === "approval.request")).toBe(false);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.update",
      name: "run_shell",
      status: "failed",
    }),
  );
});

test("explicit toolPolicy cannot bypass agent file permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-agent-policy-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await Bun.write(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      defaultAgent: "review",
      agents: {
        review: {
          description: "Review",
          permissions: {
            files: {
              writePaths: [
                { pattern: "protected.txt", allow: false, reason: "protected" },
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
    sessionID: "ses_ts7_agent_policy",
    provider: writeProvider("protected.txt"),
    permissionMode: "auto",
    toolPolicy: { allow: ["write_file"] },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("write protected");

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.update",
      name: "write_file",
      status: "failed",
      summary: expect.stringContaining("protected"),
    }),
  );
  await expect(
    readFile(join(root, "protected.txt"), "utf8"),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("agent command rules block sandbox execution before approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-sandbox-policy-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await Bun.write(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      defaultAgent: "review",
      agents: {
        review: {
          description: "Review",
          permissions: { commands: { denyPatterns: ["rm\\s+-rf"] } },
        },
      },
    }),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_sandbox_policy",
    provider: sandboxCommandProvider(),
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("run sandbox command");

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.update",
      name: "sandbox_execute",
      status: "failed",
      summary: expect.stringContaining("command matches deny pattern"),
    }),
  );
});

test("sandbox merge preflight rejects every denied manifest path atomically", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-sandbox-merge-policy-"),
  );
  await mkdir(join(root, ".natalia"), { recursive: true });
  await Bun.write(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      sandbox: { promoteCommand: "true" },
      defaultAgent: "review",
      agents: {
        review: {
          description: "Review",
          permissions: {
            files: {
              writePaths: [
                {
                  pattern: "protected.txt",
                  allow: false,
                  reason: "protected by agent policy",
                },
              ],
            },
          },
        },
      },
    }),
  );
  const sandboxes = new WorkspaceSandboxManager(
    join(root, ".natalia", "sandboxes"),
  );
  await sandboxes.create("box");
  await sandboxes.write("box", "allowed.txt", "allowed");
  await sandboxes.write("box", "protected.txt", "protected");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_sandbox_merge_policy",
    permissionMode: "auto",
    provider: sandboxMergeProvider(),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("merge sandbox changes");

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.update",
      name: "sandbox_merge",
      status: "failed",
      summary: expect.stringContaining("protected by agent policy"),
    }),
  );
  await expect(
    readFile(join(root, "allowed.txt"), "utf8"),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    readFile(join(root, "protected.txt"), "utf8"),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("sandbox merge preflight permits a manifest when every path is allowed", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-sandbox-merge-allow-"),
  );
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      sandbox: { promoteCommand: "true" },
    }),
  );
  const sandboxes = new WorkspaceSandboxManager(
    join(root, ".natalia", "sandboxes"),
  );
  await sandboxes.create("box");
  await sandboxes.write("box", "allowed.txt", "allowed");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_sandbox_merge_allow",
    permissionMode: "auto",
    provider: sandboxMergeProvider(),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("merge sandbox changes");

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.update",
      name: "sandbox_merge",
      status: "succeeded",
    }),
  );
  expect(await readFile(join(root, "allowed.txt"), "utf8")).toBe("allowed");
});

test("sandbox merge exclusion applies to catalog and forced execution", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-sandbox-merge-exclude-"),
  );
  const sandboxes = new WorkspaceSandboxManager(
    join(root, ".natalia", "sandboxes"),
  );
  await sandboxes.create("box");
  await sandboxes.write("box", "allowed.txt", "allowed");
  const events: RuntimeEvent[] = [];
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_sandbox_merge_exclude",
    permissionMode: "auto",
    toolPolicy: { exclude: ["sandbox_merge"] },
    provider: {
      provider: "scripted-sandbox-merge-exclude",
      model: "scripted-sandbox-merge-exclude-model",
      async *stream(request) {
        requests.push(request);
        if (!request.messages.some((message) => message.role === "tool"))
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "merge",
                name: "sandbox_merge",
                arguments: JSON.stringify({ id: "box" }),
              },
            ],
          };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("merge sandbox changes");

  expect(requests[0]?.tools?.map((tool) => tool.name)).not.toContain(
    "sandbox_merge",
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.update",
      name: "sandbox_merge",
      status: "failed",
      summary: "Unknown tool: sandbox_merge",
    }),
  );
  await expect(
    readFile(join(root, "allowed.txt"), "utf8"),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("agent read paths block glob and grep before exposing protected files", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-search-policy-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(join(root, "allowed.ts"), "const value = 'needle';\n");
  await writeFile(join(root, "protected.ts"), "const secret = 'needle';\n");
  await Bun.write(
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
    sessionID: "ses_ts7_search_policy",
    permissionMode: "auto",
    provider: searchPolicyProvider(),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("search workspace");

  for (const name of ["glob", "grep"])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.update",
        name,
        status: "failed",
        summary: expect.stringContaining("protected read path"),
      }),
    );
});

test("real runtime client with exclude policy blocks tool execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-policy-block-"));
  const events: RuntimeEvent[] = [];
  const policy: ToolPolicy = { exclude: ["read_file"] };
  const provider = blockTestProvider();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_policy_block",
    provider,
    permissionMode: "auto",
    toolPolicy: policy,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("read input.txt");
  const failedEvents = events.filter(
    (event) =>
      event.type === "tool.update" &&
      event.name === "read_file" &&
      event.status === "failed",
  );
  expect(failedEvents.length).toBeGreaterThan(0);
});

test("runtime persists safe policy decisions without tool arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-policy-audit-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await Bun.write(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      defaultAgent: "review",
      agents: {
        review: {
          description: "Review",
          permissions: {
            files: {
              writePaths: [
                {
                  pattern: "protected.txt",
                  allow: false,
                  reason: "protected by agent policy",
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
    sessionID: "ses_ts7_policy_audit",
    permissionMode: "auto",
    provider: writeProvider("protected.txt"),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("read input.txt");

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "policy.decision",
      toolName: "write_file",
      decision: "deny",
      reason: 'write to "protected.txt" blocked: protected by agent policy',
    }),
  );
  const history = await client.history!({ limit: 500 });
  const decision = history.events.find(
    (
      entry,
    ): entry is typeof entry & {
      event: Extract<RuntimeEvent, { type: "policy.decision" }>;
    } => entry.event.type === "policy.decision",
  )?.event;
  expect(decision).toEqual({
    type: "policy.decision",
    turnID: expect.any(String),
    toolName: "write_file",
    toolCallID: "call_write",
    decision: "deny",
    reason: 'write to "protected.txt" blocked: protected by agent policy',
    sessionID: "ses_ts7_policy_audit",
  });
  expect(JSON.stringify(decision)).not.toContain("content");
});

test("catalog policy denials are durably distinguished from unknown tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-catalog-audit-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_catalog_audit",
    permissionMode: "auto",
    toolPolicy: { exclude: ["read_file"] },
    provider: blockTestProvider(),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("read input.txt");

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "policy.decision",
      toolName: "read_file",
      decision: "deny",
      reason: "tool is excluded from the runtime catalog by policy",
    }),
  );
});

test("real runtime client hooks emit diagnostics on preExecute", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-hooks-pre-"));
  const events: RuntimeEvent[] = [];
  const hookCalls: string[] = [];
  const hooks: ToolHooks = {
    preExecute: async (event) => {
      hookCalls.push(`pre:${event.toolName}`);
      return {
        allowed: true,
        diagnostics: [`pre-check passed for ${event.toolName}`],
      };
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_hooks_pre",
    provider: toolCallingProviderWithName("read_file"),
    permissionMode: "auto",
    hooks,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("read");
  expect(hookCalls).toContain("pre:read_file");
  const diagEvents = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "diagnostic" }> =>
      event.type === "diagnostic" && event.message.includes("pre-check passed"),
  );
  expect(diagEvents.length).toBeGreaterThan(0);
});

test("real runtime client hooks call postExecute after tool success", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-hooks-post-"));
  const events: RuntimeEvent[] = [];
  const captured: Array<{ toolName: string; result?: string }> = [];
  const hooks: ToolHooks = {
    postExecute: async (event) => {
      captured.push({ toolName: event.toolName, result: event.result });
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_hooks_post",
    provider: toolCallingProviderWithName("read_file"),
    permissionMode: "auto",
    hooks,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("read");
  expect(captured.length).toBeGreaterThan(0);
  expect(captured[0]?.toolName).toBe("read_file");
});

test("real runtime client hooks call postExecute with error on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-hooks-error-"));
  const events: RuntimeEvent[] = [];
  const captured: Array<{ toolName: string; error?: string }> = [];
  const hooks: ToolHooks = {
    postExecute: async (event) => {
      captured.push({ toolName: event.toolName, error: event.error });
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_hooks_error",
    provider: toolCallingProviderWithName("read_file"),
    permissionMode: "auto",
    hooks,
    toolPolicy: { exclude: ["read_file"] },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("read");
  expect(captured.length).toBe(0);
});

test("real runtime client toolPolicy filters executeToolCalls lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-policy-lookup-"));
  await writeFile(join(root, "test.txt"), "data\n");
  const events: RuntimeEvent[] = [];
  const policy: ToolPolicy = { allow: ["read_file"] };
  const provider = toolCallingProviderWithName("read_file");
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_policy_lookup",
    provider,
    permissionMode: "auto",
    toolPolicy: policy,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("read");
  const succeeded = events.some(
    (event) =>
      event.type === "tool.update" &&
      event.name === "read_file" &&
      event.status === "succeeded",
  );
  expect(succeeded).toBe(true);
});

test("real runtime client preExecute hook can block execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-hooks-block-"));
  const events: RuntimeEvent[] = [];
  const hooks: ToolHooks = {
    preExecute: async () => {
      return { allowed: false, diagnostics: ["blocked by custom hook"] };
    },
  };
  const provider = toolCallingProviderWithName("read_file");
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_hooks_block",
    provider,
    permissionMode: "auto",
    hooks,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("read");
  const failedEvents = events.filter(
    (event) =>
      event.type === "tool.update" &&
      event.status === "failed" &&
      event.name === "read_file",
  );
  expect(failedEvents.length).toBeGreaterThan(0);
});

test("real runtime client no policy or hooks preserves default behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-default-"));
  await writeFile(join(root, "test.txt"), "default\n");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_default",
    provider: toolCallingProviderWithName("read_file"),
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("read");
  const succeeded = events.some(
    (event) =>
      event.type === "tool.update" &&
      event.name === "read_file" &&
      event.status === "succeeded",
  );
  expect(succeeded).toBe(true);
});

function toolCallingProviderWithName(toolName: string): StreamingProvider {
  return {
    provider: "scripted-tool",
    model: "scripted-tool-model",
    async *stream(request: ProviderStreamRequest) {
      if (!request.messages.some((m) => m.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            { id: "call_1", name: toolName, arguments: '{"path":"test.txt"}' },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "done" };
      yield { type: "done" };
    },
  };
}

function writeProvider(path: string): StreamingProvider {
  return {
    provider: "scripted-write",
    model: "scripted-write-model",
    async *stream(request: ProviderStreamRequest) {
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_write",
              name: "write_file",
              arguments: JSON.stringify({ path, content: "blocked" }),
            },
          ],
        };
      }
      yield { type: "done" };
    },
  };
}

function sandboxCommandProvider(): StreamingProvider {
  return {
    provider: "scripted-sandbox",
    model: "scripted-sandbox-model",
    async *stream(request: ProviderStreamRequest) {
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_sandbox",
              name: "sandbox_execute",
              arguments: JSON.stringify({
                id: "box",
                command: "rm -rf generated",
              }),
            },
          ],
        };
      }
      yield { type: "done" };
    },
  };
}

function sandboxMergeProvider(): StreamingProvider {
  return {
    provider: "scripted-sandbox-merge",
    model: "scripted-sandbox-merge-model",
    async *stream(request: ProviderStreamRequest) {
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "merge",
              name: "sandbox_merge",
              arguments: JSON.stringify({ id: "box" }),
            },
          ],
        };
      }
      yield { type: "done" };
    },
  };
}

function searchPolicyProvider(): StreamingProvider {
  return {
    provider: "scripted-search-policy",
    model: "scripted-search-policy-model",
    async *stream(request: ProviderStreamRequest) {
      if (!request.messages.some((message) => message.role === "tool"))
        yield {
          type: "tool_call",
          calls: [
            {
              id: "glob",
              name: "glob",
              arguments: JSON.stringify({ pattern: "*.ts" }),
            },
            {
              id: "grep",
              name: "grep",
              arguments: JSON.stringify({
                pattern: "needle",
                include: "*.ts",
              }),
            },
          ],
        };
      yield { type: "done" };
    },
  };
}

function blockTestProvider(): StreamingProvider {
  return {
    provider: "block-test",
    model: "block-test-model",
    async *stream(request: ProviderStreamRequest) {
      if (!request.messages.some((m) => m.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_read",
              name: "read_file",
              arguments: '{"path":"input.txt"}',
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "done" };
      yield { type: "done" };
    },
  };
}

/** Foreground program the fake host reports for the pane, one step at a time. */
function foregroundSequence(
  steps: Array<
    { program: string; pid?: number } | { none: true } | { unsupported: string }
  >,
) {
  let index = 0;
  return async () => {
    const step = steps[Math.min(index++, steps.length - 1)]!;
    if ("unsupported" in step)
      return { supported: false as const, reason: step.unsupported };
    if ("none" in step) return { supported: true as const, process: undefined };
    return {
      supported: true as const,
      process: { pid: step.pid ?? 4242, name: step.program },
    };
  };
}

const WHITELIST_WITH_VIM = {
  mode: "whitelist" as const,
  rules: [{ command: "git diff" }, { command: "vim" }],
};

test("an unauthorized interactive program never leaves Bash command policy", async () => {
  const buffer = new TerminalCommandBuffer({
    foregroundProgram: foregroundSequence([{ program: "vim" }]),
  });
  // `vim` is a permitted command but no interactive program is authorized, so
  // the pane stays in Bash mode and vim's own keystrokes are still policed.
  await expect(
    buffer.evaluate(WHITELIST_WITH_VIM, "interactive_terminal_send_line", {
      id: "pane_a",
      text: "vim notes.md",
    }),
  ).resolves.toMatchObject({ allowed: true });
  expect(buffer.paneMode("pane_a")).toEqual({ mode: "bash" });
  await expect(
    buffer.evaluate(WHITELIST_WITH_VIM, "interactive_terminal_send_line", {
      id: "pane_a",
      text: ":wq",
    }),
  ).resolves.toMatchObject({ allowed: false, clearTerminal: true });
});

test("an authorized program takes over the pane only once the host confirms it", async () => {
  const buffer = new TerminalCommandBuffer({
    foregroundProgram: foregroundSequence([
      { program: "bash" },
      { program: "vim" },
    ]),
  });
  const programs = { allow: [{ command: "vim" }] };
  await expect(
    buffer.evaluate(
      WHITELIST_WITH_VIM,
      "interactive_terminal_send_line",
      { id: "pane_a", text: "vim notes.md" },
      programs,
    ),
  ).resolves.toMatchObject({ allowed: true });
  expect(buffer.paneMode("pane_a")).toMatchObject({
    mode: "pending_program",
    program: "vim",
  });
  // The shell is still in the foreground, so the takeover is not accepted yet
  // and the input remains under Bash policy.
  await expect(
    buffer.evaluate(
      WHITELIST_WITH_VIM,
      "interactive_terminal_send_line",
      { id: "pane_a", text: ":set number" },
      programs,
    ),
  ).resolves.toMatchObject({ allowed: false });
  expect(buffer.paneMode("pane_a")).toEqual({ mode: "bash" });
  await buffer.evaluate(
    WHITELIST_WITH_VIM,
    "interactive_terminal_send_line",
    { id: "pane_a", text: "vim notes.md" },
    programs,
  );
  // Now the host reports vim in the foreground: its protocol input passes
  // without being parsed as Bash.
  await expect(
    buffer.evaluate(
      WHITELIST_WITH_VIM,
      "interactive_terminal_send_line",
      { id: "pane_a", text: ":set number" },
      programs,
    ),
  ).resolves.toMatchObject({ allowed: true });
  expect(buffer.paneMode("pane_a")).toMatchObject({
    mode: "interactive_program",
    program: "vim",
    pid: 4242,
  });
  await expect(
    buffer.evaluate(
      WHITELIST_WITH_VIM,
      "interactive_terminal_input",
      { id: "pane_a", text: "i some prose | with pipes", submit: true },
      programs,
    ),
  ).resolves.toMatchObject({ allowed: true });
});

test("a confirmed program exit returns the pane to Bash command policy", async () => {
  const buffer = new TerminalCommandBuffer({
    foregroundProgram: foregroundSequence([
      { program: "vim" },
      { program: "bash" },
    ]),
  });
  const programs = { allow: [{ command: "vim" }] };
  await buffer.evaluate(
    WHITELIST_WITH_VIM,
    "interactive_terminal_send_line",
    { id: "pane_a", text: "vim notes.md" },
    programs,
  );
  await expect(
    buffer.evaluate(
      WHITELIST_WITH_VIM,
      "interactive_terminal_send_line",
      { id: "pane_a", text: ":wq" },
      programs,
    ),
  ).resolves.toMatchObject({ allowed: true });
  expect(buffer.paneMode("pane_a")).toMatchObject({
    mode: "interactive_program",
  });
  // The host now reports the shell again, which is the only accepted way back.
  // The dangerous command that follows is policed as Bash again.
  await expect(
    buffer.evaluate(
      { mode: "blacklist", rules: [{ command: "rm" }] },
      "interactive_terminal_send_line",
      { id: "pane_a", text: "rm -rf /" },
      programs,
    ),
  ).resolves.toMatchObject({ allowed: false, clearTerminal: true });
  expect(buffer.paneMode("pane_a")).toEqual({ mode: "bash" });
});

test("an unconfirmable foreground blocks interactive input instead of sending it raw", async () => {
  const buffer = new TerminalCommandBuffer({
    foregroundProgram: foregroundSequence([
      { program: "vim" },
      {
        unsupported: "foreground process confirmation is unavailable on win32",
      },
    ]),
  });
  const programs = { allow: [{ command: "vim" }] };
  await buffer.evaluate(
    WHITELIST_WITH_VIM,
    "interactive_terminal_send_line",
    { id: "pane_a", text: "vim notes.md" },
    programs,
  );
  await buffer.evaluate(
    WHITELIST_WITH_VIM,
    "interactive_terminal_send_line",
    { id: "pane_a", text: ":w" },
    programs,
  );
  expect(buffer.paneMode("pane_a")).toMatchObject({
    mode: "interactive_program",
  });
  await expect(
    buffer.evaluate(
      WHITELIST_WITH_VIM,
      "interactive_terminal_send_line",
      { id: "pane_a", text: ":wq" },
      programs,
    ),
  ).resolves.toMatchObject({
    allowed: false,
    clearTerminal: true,
    diagnostics: [expect.stringContaining("cannot be confirmed")],
  });
  expect(buffer.paneMode("pane_a")).toEqual({ mode: "bash" });
});

test("a host that cannot report the foreground never enters interactive mode", async () => {
  const buffer = new TerminalCommandBuffer();
  const programs = { allow: [{ command: "vim" }] };
  await buffer.evaluate(
    WHITELIST_WITH_VIM,
    "interactive_terminal_send_line",
    { id: "pane_a", text: "vim notes.md" },
    programs,
  );
  await expect(
    buffer.evaluate(
      WHITELIST_WITH_VIM,
      "interactive_terminal_send_line",
      { id: "pane_a", text: ":wq" },
      programs,
    ),
  ).resolves.toMatchObject({ allowed: false });
  expect(buffer.paneMode("pane_a")).toEqual({ mode: "bash" });
});

test("a module can narrow the authorized programs but never widen them", async () => {
  const buffer = new TerminalCommandBuffer({
    foregroundProgram: foregroundSequence([{ program: "python3" }]),
  });
  const rules = {
    mode: "whitelist" as const,
    rules: [{ command: "vim" }, { command: "python3" }],
  };
  // The module allows python3, the profile only vim, so the intersection is
  // empty and no takeover happens.
  await buffer.evaluate(
    rules,
    "interactive_terminal_send_line",
    { id: "pane_a", text: "python3" },
    [{ allow: [{ command: "vim" }] }, { allow: [{ command: "python3" }] }],
  );
  expect(buffer.paneMode("pane_a")).toEqual({ mode: "bash" });
  // With both layers allowing python3 the takeover is authorized.
  await buffer.evaluate(
    rules,
    "interactive_terminal_send_line",
    { id: "pane_a", text: "python3" },
    [{ allow: [{ command: "python3" }] }, { allow: [{ command: "python3" }] }],
  );
  expect(buffer.paneMode("pane_a")).toMatchObject({
    mode: "pending_program",
    program: "python3",
  });
});

test("allowAny authorizes an unlisted simple launch after command policy", async () => {
  const buffer = new TerminalCommandBuffer({
    foregroundProgram: foregroundSequence([{ program: "python3" }]),
  });
  const rules = {
    mode: "whitelist" as const,
    rules: [{ command: "python3" }],
  };
  await buffer.evaluate(
    rules,
    "interactive_terminal_send_line",
    { id: "pane_any", text: "python3 -q" },
    { allowAny: true, allow: [] },
  );
  expect(buffer.paneMode("pane_any")).toMatchObject({
    mode: "pending_program",
    program: "python3",
    launch: "python3 -q",
  });
  await expect(
    buffer.evaluate(
      rules,
      "interactive_terminal_send_line",
      { id: "pane_any", text: "print('ready')" },
      { allowAny: true, allow: [] },
    ),
  ).resolves.toMatchObject({ allowed: true });
  expect(buffer.paneMode("pane_any")).toMatchObject({
    mode: "interactive_program",
  });
});

test("allowAny works without enabling command rules", async () => {
  const buffer = new TerminalCommandBuffer({
    foregroundProgram: foregroundSequence([{ program: "python3" }]),
  });
  await buffer.evaluate(
    undefined,
    "interactive_terminal_send_line",
    { id: "pane_any", text: "python3" },
    { allowAny: true, allow: [] },
  );
  expect(buffer.paneMode("pane_any")).toMatchObject({
    mode: "pending_program",
    program: "python3",
  });
});

test("a module allowlist narrows a profile allowAny authorization", async () => {
  const buffer = new TerminalCommandBuffer({
    foregroundProgram: foregroundSequence([{ program: "python3" }]),
  });
  const rules = {
    mode: "whitelist" as const,
    rules: [{ command: "python3" }, { command: "vim" }],
  };
  await buffer.evaluate(
    rules,
    "interactive_terminal_send_line",
    { id: "pane_any", text: "python3" },
    [{ allowAny: true, allow: [] }, { allow: [{ command: "vim" }] }],
  );
  expect(buffer.paneMode("pane_any")).toEqual({ mode: "bash" });
});

test("stopping a pane clears its interactive program mode", async () => {
  const buffer = new TerminalCommandBuffer({
    foregroundProgram: foregroundSequence([{ program: "vim" }]),
  });
  const programs = { allow: [{ command: "vim" }] };
  await buffer.evaluate(
    WHITELIST_WITH_VIM,
    "interactive_terminal_send_line",
    { id: "pane_a", text: "vim notes.md" },
    programs,
  );
  await buffer.evaluate(
    WHITELIST_WITH_VIM,
    "interactive_terminal_send_line",
    { id: "pane_a", text: ":w" },
    programs,
  );
  expect(buffer.paneMode("pane_a")).toMatchObject({
    mode: "interactive_program",
  });
  buffer.clear("pane_a");
  expect(buffer.paneMode("pane_a")).toEqual({ mode: "bash" });
  buffer.clearAll();
  expect(buffer.paneMode("pane_a")).toEqual({ mode: "bash" });
});

test("module path allow rules form a whitelist scope", () => {
  const rules = {
    files: {
      writePaths: [{ pattern: "docs/**", allow: true }],
      readPaths: [{ pattern: "docs/**", allow: true }],
    },
  };
  expect(
    evaluatePermissionRules(rules, "write_file", { path: "docs/a.md" }),
  ).toMatchObject({ allowed: true });
  expect(
    evaluatePermissionRules(rules, "write_file", { path: "src/a.ts" }),
  ).toMatchObject({
    allowed: false,
    reason: "path is outside the allowed module scope",
  });
  expect(
    evaluatePermissionRules(rules, "read_file", { path: "docs/a.md" }),
  ).toMatchObject({ allowed: true });
  expect(
    evaluatePermissionRules(rules, "read_file", { path: "README.md" }),
  ).toMatchObject({ allowed: false });
});

test("deny path rules win over broad allow scopes", () => {
  const rules = {
    files: {
      writePaths: [
        { pattern: "docs/**", allow: true },
        { pattern: "docs/secrets/**", allow: false, reason: "protected" },
      ],
    },
  };
  expect(
    evaluatePermissionRules(rules, "write_file", { path: "docs/a.md" }),
  ).toMatchObject({ allowed: true });
  expect(
    evaluatePermissionRules(rules, "write_file", { path: "docs/secrets/key" }),
  ).toMatchObject({ allowed: false, reason: "protected" });
});

test("mixed legacy deny-only rules keep deny semantics without a whitelist", () => {
  const rules = {
    files: {
      writePaths: [
        { pattern: "protected/*", allow: false, reason: "protected" },
      ],
    },
  };
  expect(
    evaluatePermissionRules(rules, "write_file", {
      path: "protected/note.txt",
    }),
  ).toMatchObject({ allowed: false, reason: "protected" });
  expect(
    evaluatePermissionRules(rules, "write_file", { path: "other/note.txt" }),
  ).toMatchObject({ allowed: true });
});

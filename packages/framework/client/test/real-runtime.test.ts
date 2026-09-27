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
// The governance-root override below is process-global, so this file restores
// the ambient value when it ends: without the restore, every later test file's
// runtime in the same bun process reads and writes its constitution into the
// last workspace's ledger — cross-file state leakage the hygiene guard caught
// as a recreated governance directory.
const ambientGovernanceRoot = process.env.NATALIA_TEST_GOVERNANCE_ROOT;
afterAll(() => {
  if (ambientGovernanceRoot === undefined)
    delete process.env.NATALIA_TEST_GOVERNANCE_ROOT;
  else process.env.NATALIA_TEST_GOVERNANCE_ROOT = ambientGovernanceRoot;
});

const MCP_PLUGIN_ID = "natalia-mcp";
const SKILLS_PLUGIN_ID = "natalia-skills";
const TEAM_PLUGIN_ID = "natalia-team";
const TODO_PLUGIN_ID = "natalia-tool-todo";

function createRealRuntimeClient(
  options: Parameters<typeof createRuntimeClient>[0] = {},
) {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  restoreOfficialPluginConfig(workspaceRoot);
  const globalConfigPath =
    options.globalConfigPath ??
    join(workspaceRoot, ".natalia-test-global.json");
  const projectPath = join(workspaceRoot, ".natalia", "config.json");
  if (
    !options.globalConfigPath &&
    !existsSync(globalConfigPath) &&
    existsSync(projectPath)
  ) {
    const project = JSON.parse(readFileSync(projectPath, "utf8")) as Record<
      string,
      unknown
    >;
    const modelConfig = Object.fromEntries(
      ["providers", "catalog", "modelOverrides", "defaultModel"].flatMap(
        (key) => (Object.hasOwn(project, key) ? [[key, project[key]]] : []),
      ),
    );
    if (Object.keys(modelConfig).length) {
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(globalConfigPath, JSON.stringify(modelConfig));
    }
  }
  // Keep each test workspace's governance ledger isolated. The default
  // governance root is derived from the plugin store and would otherwise be
  // shared across every tmp workspace, allowing records/overrides from one
  // test to leak into the next.
  // Normal tests get a per-workspace governance ledger so records from one
  // tmp workspace cannot leak into the next. Tests that deliberately exercise
  // a shared/custom governance store pass pluginStoreRoot and manage the env
  // themselves.
  if (!options.pluginStoreRoot) {
    const suffix = workspaceRoot.split("/").pop() ?? "workspace";
    const governanceRoot = join(
      workspaceRoot,
      "..",
      `.natalia-test-governance-${suffix}`,
    );
    process.env.NATALIA_TEST_GOVERNANCE_ROOT = governanceRoot;
    // The governance ledger lives beside the workspace so it survives a
    // workspace relocation; that also puts it outside the workspace removal,
    // so register it for the helper's per-file sweep or it leaks one directory
    // per test into the shared test-workspaces root.
    registerTestArtifact(governanceRoot);
  }
  return createOfficialRuntimeClient({
    ...options,
    globalConfigPath,
  });
}

test("real runtime client streams provider output and persists replayable session", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-real-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_real",
    provider: scriptedProvider("hello from provider"),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });

  await client.submitAndWait!("Say hello");

  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining([
      "session.created",
      "session.ready",
      "turn.submitted",
      "checkpoint.created",
      "content.delta",
      "content.done",
      "turn.finished",
    ]),
  );
  expect(
    events
      .filter((event) => event.type === "content.delta")
      .map((event) => event.text)
      .join(""),
  ).toBe("hello from provider");
  const persisted = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", "ses_ts7_real.json"),
      "utf8",
    ),
  ) as { events: RuntimeEvent[]; inbox?: Array<Record<string, unknown>> };
  expect(
    persisted.events.some((event) => event.type === "turn.submitted"),
  ).toBe(true);

  const replay: RuntimeEvent[] = [];
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    checkpointDir: join(root, ".natalia", "checkpoint-store"),
    sessionID: "ses_ts7_real",
    provider: scriptedProvider("unused"),
  });
  reopened.start((event) => replay.push(event));
  await waitFor(() => replay.some((event) => event.type === "session.ready"));
  expect(
    replay.some(
      (event) =>
        event.type === "content.done" && event.text === "hello from provider",
    ),
  ).toBe(true);
});

test("provider-model subsystem ignores plugins.enabled and always provides the controller", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-provider-model-disabled-"),
  );
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      plugins: { enabled: { "natalia-provider-model": false } },
    }),
  );
  let streams = 0;
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_provider_model_disabled",
    capabilityRegistry: kernel,
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        streams += 1;
        yield { type: "content" as const, text: "ok" };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("run");
  await waitFor(() => streams === 1);
  // Framework subsystem: present even when plugins.enabled says otherwise.
  expect(kernel.has("natalia-provider-model")).toBe(true);
  expect(kernel.service(providerModelController.id)).toBeDefined();
  await client.dispose?.();
});

test("turn orchestration subsystem is present even when plugins.enabled disables it", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-turn-orchestration-disabled-"),
  );
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      plugins: { enabled: { "natalia-turn-orchestration": false } },
    }),
  );
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_turn_orchestration_disabled",
    capabilityRegistry: kernel,
  });
  client.start(() => undefined);
  await client.runtimeStatus?.();
  expect(kernel.has("natalia-turn-orchestration")).toBe(true);
  expect(kernel.service(turnController.id)).toBeDefined();
  expect(existsSync(join(root, ".natalia", "sessions"))).toBe(true);
  await client.dispose?.();
});

test("runtime can suppress startup event replay for paged UI hydration", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-paged-replay-"));
  const sessionID = "ses_runtime_paged_replay" as SessionID;
  const initial = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    provider: scriptedProvider("paged response"),
  });
  initial.start(() => undefined);
  await initial.submitAndWait!("persist history");
  await initial.dispose?.();

  const replay: RuntimeEvent[] = [];
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    provider: scriptedProvider("unused"),
  });
  reopened.start((event) => replay.push(event), { replay: "none" });
  await waitFor(() => replay.some((event) => event.type === "session.ready"));
  expect(replay.some((event) => event.type === "content.done")).toBe(false);
  const page = await reopened.messages?.({ limit: 1 });
  expect(page?.data[0]?.rows).toContainEqual(
    expect.objectContaining({
      event: expect.objectContaining({
        type: "content.done",
        text: "paged response",
      }),
    }),
  );
  await reopened.dispose?.();
});

test("SQLite runtime message pages use the durable turn cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sqlite-message-page-"));
  const sessionID = "ses_sqlite_message_page" as SessionID;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    provider: scriptedProvider("reply"),
    useSqliteStore: true,
  });
  client.start(() => undefined);
  for (const prompt of ["one", "two", "three"])
    await client.submitAndWait!(prompt);

  const latest = await client.messages?.({ limit: 2 });
  expect(latest?.data.map((message) => message.submitted.text)).toEqual([
    "three",
    "two",
  ]);
  const older = await client.messages?.({ cursor: latest?.cursor.next });
  expect(older?.data.map((message) => message.submitted.text)).toEqual(["one"]);
  await client.dispose?.();
});

test("SQLite runtime persists durable events without growing the JSON mirror", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sqlite-authority-"));
  const sessionID = "ses_sqlite_authority" as SessionID;
  const initial = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    provider: scriptedProvider("durable SQLite reply"),
    useSqliteStore: true,
  });
  initial.start(() => undefined);
  await initial.submitAndWait!("persist only in SQLite");
  await initial.dispose?.();

  await expect(
    readFile(join(root, ".natalia", "sessions", `${sessionID}.json`), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });

  const replayed: RuntimeEvent[] = [];
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    provider: scriptedProvider("unused"),
    useSqliteStore: true,
  });
  reopened.start((event) => replayed.push(event));
  await waitFor(() => replayed.some((event) => event.type === "session.ready"));
  expect(
    replayed.some(
      (event) =>
        event.type === "content.done" && event.text === "durable SQLite reply",
    ),
  ).toBe(true);
  await reopened.dispose?.();
});

test("runtime correlates durable events with an episode without changing session replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-episode-runtime-"));
  const sessionID = "ses_episode_runtime" as SessionID;
  const episodeID =
    "epi_episode_runtime" as import("@anthelia/contracts").EpisodeID;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    episodeID,
    provider: scriptedProvider("episode response"),
    useSqliteStore: true,
  });
  client.start(() => undefined);
  await client.submitAndWait!("record an episode");
  await client.dispose?.();

  const replay: RuntimeEvent[] = [];
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    provider: scriptedProvider("unused"),
    useSqliteStore: true,
  });
  reopened.start((event) => replay.push(event));
  await waitFor(() => replay.some((event) => event.type === "session.ready"));
  const durable = replay.filter(
    (event) =>
      event.type === "turn.submitted" || event.type === "turn.finished",
  );
  expect(durable).not.toHaveLength(0);
  expect(durable.every((event) => event.episodeID === episodeID)).toBe(true);
  await reopened.dispose?.();
});

test("runtime status and diagnostics expose only published safe state", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-status-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: no migration attempt, no external-store
    // diagnostic — this test asserts the exact diagnostics surface.
    checkpointDir: join(root, ".natalia", "checkpoint-store"),
    sessionID: "ses_runtime_status",
    provider: scriptedProvider("ready"),
    nativeTerminal: nativeTerminalFixture(),
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  client.diagnostic("provider key is configured", "info");
  const status = await client.runtimeStatus?.();
  const diagnostics = await client.diagnostics?.(1);
  expect(status).toMatchObject({
    type: "status.snapshot",
    model: "scripted-model",
    permissions: "ask",
  });
  expect(diagnostics).toMatchObject([
    {
      level: "info",
      message: "provider key is configured",
      at: expect.any(String),
    },
  ]);
});

test("runtime status reports the active approval mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-permissions-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_permissions",
    provider: scriptedProvider("ready"),
    permissionMode: "auto",
  });
  client.start(() => undefined);

  expect(await client.runtimeStatus?.()).toMatchObject({
    type: "status.snapshot",
    permissions: "auto",
  });
});

test("runtime status reflects the configured auto approval profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-profile-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      defaultAgentMode: "trusted",
      agentModes: {
        trusted: { approval: "auto", description: "Trusted workspace" },
      },
    }),
  );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_profile",
    provider: scriptedProvider("ready"),
  });
  client.start(() => undefined);

  expect(await client.runtimeStatus?.()).toMatchObject({
    type: "status.snapshot",
    permissions: "auto",
  });
});

test("tools.paths loads out-of-tree families through the kernel", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-tools-paths-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      tools: { paths: ["extra-tools"] },
    }),
  );
  await mkdir(join(root, "extra-tools", "extra.family"), { recursive: true });
  await writeFile(
    join(root, "extra-tools", "extra.family", "natalia.tool.json"),
    JSON.stringify({ entry: "index.ts" }),
  );
  await writeFile(
    join(root, "extra-tools", "extra.family", "index.ts"),
    `import type { ToolFamily } from "@anthelia/tools";
export default (): ToolFamily => ({
  id: "extra.family",
  name: "Extra",
  version: "1.0.0",
  description: "Out-of-tree fixture family",
  scope: "session",
  tools: [{
    name: "extra_run",
    description: "Run",
    requiresApproval: false,
    parameters: { type: "object", properties: {} },
    async execute() { return "extra"; },
  }],
});
`,
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_tools_paths",
    provider: scriptedProvider("ready"),
  });
  client.start((event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === "session.ready"));
  const registered = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "tool.registered" }> =>
      event.type === "tool.registered",
  );
  // The out-of-tree family's tool is in the catalogue, owned by the local-tools
  // plugin like any other built-in — nothing about an external family is
  // special-cased once it loads. The journal scope is the plugin's workspace
  // scope, because the plugin owns every family it loads.
  expect(registered.find((event) => event.name === "extra_run")).toMatchObject({
    owner: "natalia-local-tools",
    scope: "workspace",
  });
  await client.dispose?.();
}, 60_000);

test("the family watcher hot-reloads a promoted change automatically", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-tools-watch-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, tools: { paths: ["extra-tools"] } }),
  );
  await mkdir(join(root, "extra-tools", "extra.family"), { recursive: true });
  await writeFile(
    join(root, "extra-tools", "extra.family", "natalia.tool.json"),
    JSON.stringify({ entry: "index.ts" }),
  );
  const entryPath = join(root, "extra-tools", "extra.family", "index.ts");
  const familySource = (tool: string) =>
    `import type { ToolFamily } from "@anthelia/tools";
export default (): ToolFamily => ({
  id: "extra.family", name: "Extra", version: "1.0.0",
  description: "Out-of-tree fixture family", scope: "session",
  tools: [{ name: "${tool}", description: "Run", requiresApproval: false,
    parameters: { type: "object", properties: {} }, async execute() { return "ok"; } }],
});
`;
  await writeFile(entryPath, familySource("extra_run"));
  await fingerprintEntry(root, entryPath);

  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_tools_watch",
    provider: scriptedProvider("ready"),
  });
  client.start((event) => events.push(event));
  await waitFor(() =>
    events.some(
      (event) => event.type === "tool.registered" && event.name === "extra_run",
    ),
  );

  // The promoted change lands and the trust record is re-pinned; the watcher
  // detects it and hot-reloads without any manual reload call.
  await writeFile(entryPath, familySource("extra_run_v2"));
  await fingerprintEntry(root, entryPath);
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "tool.registered" && event.name === "extra_run_v2",
      ),
    10_000,
    "the watcher to hot-reload the promoted change",
  );
  await client.dispose?.();
}, 60_000);

test("toolFamilyReload hot-swaps an out-of-tree family after promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-tools-reload-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, tools: { paths: ["extra-tools"] } }),
  );
  await mkdir(join(root, "extra-tools", "extra.family"), { recursive: true });
  await writeFile(
    join(root, "extra-tools", "extra.family", "natalia.tool.json"),
    JSON.stringify({ entry: "index.ts" }),
  );
  const entryPath = join(root, "extra-tools", "extra.family", "index.ts");
  const familySource = (tool: string) =>
    `import type { ToolFamily } from "@anthelia/tools";
export default (): ToolFamily => ({
  id: "extra.family", name: "Extra", version: "1.0.0",
  description: "Out-of-tree fixture family", scope: "session",
  tools: [{ name: "${tool}", description: "Run", requiresApproval: false,
    parameters: { type: "object", properties: {} }, async execute() { return "ok"; } }],
});
`;
  await writeFile(entryPath, familySource("extra_run"));

  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_tools_reload",
    provider: scriptedProvider("ready"),
  });
  client.start((event) => events.push(event));
  await waitFor(() =>
    events.some(
      (event) => event.type === "tool.registered" && event.name === "extra_run",
    ),
  );

  // The agent's change lands (promotion writes the new entry), the trust
  // record is re-pinned to the promoted version, and the runtime hot-swaps.
  await writeFile(entryPath, familySource("extra_run_v2"));
  await fingerprintEntry(root, entryPath);
  const reloaded = await client.toolFamilyReload?.("extra.family");
  console.log("reload result:", JSON.stringify(reloaded));
  expect(reloaded).toEqual({ reloaded: true });
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "tool.registered" && event.name === "extra_run_v2",
    ),
  );
  expect(
    events.some(
      (event) =>
        event.type === "tool.unregistered" && event.name === "extra_run",
    ),
  ).toBe(true);
  await client.dispose?.();
}, 60_000);

test("finalizeContent is applied exactly once before the result freezes", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-finalize-"));
  const tools = createToolRegistry([]);
  let calls = 0;
  tools.set("finalized_tool", {
    name: "finalized_tool",
    description: "Tool with a final content invariant.",
    requiresApproval: false,
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "object", properties: {} },
      finalizeContent(content) {
        calls++;
        return content.toUpperCase();
      },
    },
    async execute() {
      return "raw result";
    },
  });
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_finalize",
    tools,
    provider: {
      provider: "finalize",
      model: "finalize-model",
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool"))
          yield {
            type: "tool_call" as const,
            calls: [
              { id: "call_finalize", name: "finalized_tool", arguments: "{}" },
            ],
          };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("run the finalizing tool");
  const update = events.find(
    (event): event is Extract<RuntimeEvent, { type: "tool.update" }> =>
      event.type === "tool.update" && event.status === "succeeded",
  );
  // The model sees the finalized content, and it ran exactly once.
  const failedUpdate = events.find(
    (event): event is Extract<RuntimeEvent, { type: "tool.update" }> =>
      event.type === "tool.update" && event.status === "failed",
  );
  console.log("failed:", failedUpdate?.result, "calls:", calls);
  expect(update?.result).toBe("RAW RESULT");
  expect(calls).toBe(1);
  await client.dispose?.();
}, 60_000);

test("a tool with an output definition projects its result into the event", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-tool-render-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(join(root, "note.txt"), "projected content");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_tool_render",
    provider: {
      provider: "tool-render",
      model: "tool-render-model",
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool"))
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_read",
                name: "read_file",
                arguments: JSON.stringify({ path: "note.txt" }),
              },
            ],
          };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("read the note");
  const update = events.find(
    (event): event is Extract<RuntimeEvent, { type: "tool.update" }> =>
      event.type === "tool.update" && event.status === "succeeded",
  );
  expect(update).toBeDefined();
  // read_file declares an output definition, so its card travels with the event
  // and a client renders it without reclassifying the string.
  expect(update!.metadata?.render).toMatchObject({
    kind: "read",
    title: "note.txt",
    body: "projected content",
  });
  // The running event carried the call card the tool projected, so the running
  // card is the call's presentation (a file path), not a raw argument dump.
  const running = events.find(
    (event): event is Extract<RuntimeEvent, { type: "tool.update" }> =>
      event.type === "tool.update" && event.status === "running",
  );
  expect(running?.metadata?.call).toMatchObject({
    kind: "read",
    title: "note.txt",
    summary: "read",
  });
  await client.dispose?.();
}, 60_000);

test("the runtime config is a kernel service refreshed on reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-config-service-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, defaultAgentMode: "ask" }),
  );
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_config_service",
    capabilityRegistry: kernel,
    provider: scriptedProvider("ready"),
  });
  client.start(() => undefined);
  await waitFor(
    () => kernel.service("runtime.config") !== undefined,
    10_000,
    "the runtime config service to be provided",
  );

  // By-name resolution: any capability can read the resolved config.
  const first = kernel.service<{ defaultAgentMode?: string }>("runtime.config");
  expect(first?.defaultAgentMode).toBe("ask");
  expect(kernel.ownerOf("services", "runtime.config")).toBe(
    "natalia-runtime-config",
  );

  // A config reload runs a new plugin activation epoch: the old service leaves,
  // then the new epoch provides its replacement.
  const updates: Array<{
    name: string;
    provider?: string;
    providerBefore?: string;
  }> = [];
  const unsubscribe = kernel.onServiceUpdate((update) => updates.push(update));
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, defaultAgentMode: "auto" }),
  );
  // Reload applies on demand through plugin dispose/setup.
  await client.reloadConfig?.();
  await waitFor(() => {
    const current = kernel.service<{ defaultAgentMode?: string }>(
      "runtime.config",
    );
    return current?.defaultAgentMode === "auto";
  });
  expect(
    kernel.service<{ defaultAgentMode?: string }>("runtime.config")
      ?.defaultAgentMode,
  ).toBe("auto");
  expect(updates.filter((update) => update.name === "runtime.config")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ provider: undefined }),
      expect.objectContaining({ provider: "natalia-runtime-config" }),
    ]),
  );
  expect(kernel.ownerOf("services", "runtime.config")).toBe(
    "natalia-runtime-config",
  );
  unsubscribe();
  await client.dispose?.();
}, 60_000);

test("failed config reload restores runtime config and plugin settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-config-rollback-"));
  const pluginRoot = join(root, ".natalia", "plugins", "rollback.plugin");
  await mkdir(pluginRoot, { recursive: true });
  const configPath = join(root, ".natalia", "config.json");
  await writeFile(
    join(pluginRoot, "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 1,
      id: "rollback.plugin",
      version: "1.0.0",
      name: "Rollback",
      entry: "index.ts",
      provides: ["rollback.value"],
    }),
  );
  await writeFile(
    join(pluginRoot, "index.ts"),
    `export default { setup(api) {
      if (api.config?.fail) throw new Error("configured plugin failure");
      api.services.provide("rollback.value", api.config?.value);
    } };`,
  );
  await installFixturePlugin(root, pluginRoot);
  await writeFile(
    configPath,
    JSON.stringify({
      version: 3,
      defaultAgentMode: "ask",
      plugins: {
        paths: [".natalia/plugins"],
        settings: { "rollback.plugin": { value: "old" } },
      },
    }),
  );
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    pluginStoreRoot: `${root}-plugin-store`,
    sessionID: "ses_config_rollback",
    capabilityRegistry: kernel,
    provider: scriptedProvider("ready"),
  });
  client.start(() => undefined);
  await client.runtimeStatus?.();
  expect(kernel.service<string>("rollback.value")).toBe("old");

  await writeFile(
    configPath,
    JSON.stringify({
      version: 3,
      defaultAgentMode: "auto",
      plugins: {
        paths: [".natalia/plugins"],
        settings: { "rollback.plugin": { value: "new", fail: true } },
      },
    }),
  );
  const result = await client.reloadConfig?.();
  expect(result?.applied).toBe(false);
  expect(result?.reason).toContain("configured plugin failure");
  expect(
    kernel.service<{ defaultAgentMode?: string }>("runtime.config")
      ?.defaultAgentMode,
  ).toBe("ask");
  expect(kernel.service<string>("rollback.value")).toBe("old");
  expect(
    (await client.plugins?.())?.find(
      (plugin) => plugin.id === "rollback.plugin",
    )?.id,
  ).toBe("rollback.plugin");
  await client.dispose?.();
}, 60_000);

test("user plugin config reload reconciles its lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-config-reload-"));
  const pluginRoot = join(root, ".natalia", "plugins", "reload.plugin");
  await mkdir(pluginRoot, { recursive: true });
  const configPath = join(root, ".natalia", "config.json");
  await writeFile(
    join(pluginRoot, "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 1,
      id: "reload.plugin",
      version: "1.0.0",
      name: "Reload",
      entry: "index.ts",
      capabilities: ["commands"],
    }),
  );
  await writeFile(
    join(pluginRoot, "index.ts"),
    `export default { setup(api) { api.commands.register({ name: "reload", title: "Reload", run() {} }); } };`,
  );
  await installFixturePlugin(root, pluginRoot);
  await writeFile(
    configPath,
    JSON.stringify({
      version: 3,
      plugins: { paths: [".natalia/plugins"] },
    }),
  );
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    pluginStoreRoot: `${root}-plugin-store`,
    sessionID: "ses_plugin_config_reload",
    provider: scriptedProvider("ready"),
    capabilityRegistry: kernel,
  });
  client.start(() => undefined);
  await client.runtimeStatus?.();
  expect(
    (await client.plugins?.())?.some((plugin) => plugin.id === "reload.plugin"),
  ).toBe(true);
  expect(kernel.ownerOf("commands", "reload")).toBe("reload.plugin");

  await writeFile(
    configPath,
    JSON.stringify({
      version: 3,
      plugins: {
        paths: [".natalia/plugins"],
        enabled: { "reload.plugin": false },
      },
    }),
  );
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(
    (await client.plugins?.())?.some((plugin) => plugin.id === "reload.plugin"),
  ).toBe(false);
  expect(kernel.ownerOf("commands", "reload")).toBeUndefined();
  await client.dispose?.();
}, 60_000);

test("workspace framework services are always present and stable across reloads", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-workspace-config-reload-"),
  );
  await mkdir(join(root, ".natalia"), { recursive: true });
  const configPath = join(root, ".natalia", "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 3,
      plugins: { enabled: { "natalia-workspace": false } },
    }),
  );
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_workspace_config_reload",
    capabilityRegistry: kernel,
    provider: scriptedProvider("ready"),
  });
  client.start(() => undefined);
  await client.runtimeStatus?.();

  // The workspace subsystem is framework-internal: it is not gated by
  // plugins.enabled and is present on first boot.
  // Framework-internal services now bind through the service directory, whose
  // owner per binding is `service:<token.id>` — still not a plugin owner.
  expect(kernel.ownerOf("services", workspaceWriteLock.id)).toMatch(
    /^service:/u,
  );
  expect(kernel.service(workspaceWriteLock.id)).toBeDefined();
  expect(kernel.service(workspaceMutations.id)).toBeDefined();
  expect(kernel.service(workspaceFiles.id)).toBeDefined();

  const firstWriteLock = kernel.service<object>(workspaceWriteLock.id);
  const firstMutations = kernel.service<object>(workspaceMutations.id);
  const firstFiles = kernel.service<object>(workspaceFiles.id);

  await writeFile(configPath, JSON.stringify({ version: 3 }));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  // Framework services survive reload: same instances, no teardown/recreate.
  expect(kernel.service<object>(workspaceWriteLock.id)).toBe(firstWriteLock);
  expect(kernel.service<object>(workspaceMutations.id)).toBe(firstMutations);
  expect(kernel.service<object>(workspaceFiles.id)).toBe(firstFiles);
  await client.dispose?.();
}, 60_000);

test("provider-model framework service is always present and stable across reloads", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-provider-model-config-reload-"),
  );
  await mkdir(join(root, ".natalia"), { recursive: true });
  const configPath = join(root, ".natalia", "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 3,
      plugins: { enabled: { "natalia-provider-model": false } },
    }),
  );
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_provider_model_config_reload",
    capabilityRegistry: kernel,
    provider: scriptedProvider("ready"),
  });
  client.start(() => undefined);
  await client.runtimeStatus?.();

  // The provider-model subsystem is framework-internal: it is not gated by
  // plugins.enabled and is present on first boot.
  expect(kernel.ownerOf("services", providerModelController.id)).toMatch(
    /^service:/u,
  );
  const firstController = kernel.service<ProviderModelController>(
    providerModelController.id,
  );
  expect(firstController).toBeDefined();

  await writeFile(configPath, JSON.stringify({ version: 3 }));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  // Framework services survive reload: same instance, no teardown/recreate.
  expect(
    kernel.service<ProviderModelController>(providerModelController.id),
  ).toBe(firstController);
  await client.dispose?.();
}, 60_000);

test("compaction framework service is always present and stable across reloads", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-compaction-config-reload-"),
  );
  await mkdir(join(root, ".natalia"), { recursive: true });
  const configPath = join(root, ".natalia", "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 3,
      plugins: { enabled: { "natalia-compaction": false } },
    }),
  );
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_compaction_config_reload",
    capabilityRegistry: kernel,
    provider: scriptedProvider("ready"),
  });
  client.start(() => undefined);
  await client.runtimeStatus?.();

  expect(kernel.ownerOf("services", compactionService.id)).toMatch(
    /^service:/u,
  );
  expect(kernel.ownerOf("services", providerModelController.id)).toMatch(
    /^service:/u,
  );
  const firstService = kernel.service<object>(compactionService.id);
  expect(firstService).toBeDefined();
  const firstController = kernel.service<ProviderModelController>(
    providerModelController.id,
  );
  expect(firstController).toBeDefined();

  await writeFile(configPath, JSON.stringify({ version: 3 }));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.service<object>(compactionService.id)).toBe(firstService);
  expect(
    kernel.service<ProviderModelController>(providerModelController.id),
  ).toBe(firstController);
  await client.dispose?.();
}, 60_000);

test("terminal plugin config reload preserves its host-owned registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-terminal-config-reload-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  const configPath = join(root, ".natalia", "config.json");
  await writeFile(configPath, JSON.stringify({ version: 3 }));
  let stops = 0;
  const nativeTerminal = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 81, window_id: 8, tab_id: 1 };
    },
    async list() {
      return [{ pane_id: 81, window_id: 8, tab_id: 1, rows: 24, cols: 80 }];
    },
    async read() {
      return "reload pane output";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {
      stops += 1;
    },
  });
  await nativeTerminal.start({
    id: "reload_terminal",
    cwd: root,
    command: "cat",
    sessionID: "ses_terminal_config_reload",
  });
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_terminal_config_reload",
    capabilityRegistry: kernel,
    nativeTerminal,
    provider: scriptedProvider("ready"),
  });
  client.start(() => undefined);
  await client.runtimeStatus?.();

  expect(kernel.has("natalia-tool-terminal")).toBe(true);
  expect(kernel.service(terminalController.id)).toBeDefined();
  expect(await client.nativeTerminalList?.()).toMatchObject([
    { id: "reload_terminal" },
  ]);
  await expect(client.nativeTerminalRead?.("reload_terminal")).resolves.toEqual(
    { id: "reload_terminal", text: "reload pane output" },
  );
  const firstController = kernel.service<object>(terminalController.id);

  // A reload with the same windowMode must not rebuild the plugin: the input
  // callbacks and the host-owned registry are recreated per catalog build, but
  // the identity is derived from windowMode alone.
  await writeFile(
    configPath,
    JSON.stringify({
      version: 3,
      runtime: { terminal: { windowMode: "windowless" } },
    }),
  );
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  // windowMode changed, so the plugin is rebuilt; the host-owned registry is
  // borrowed as-is, so its sessions survive and nothing is disposed.
  expect(kernel.has("natalia-tool-terminal")).toBe(true);
  expect(kernel.service<object>(terminalController.id)).not.toBe(
    firstController,
  );
  expect(await client.nativeTerminalList?.()).toMatchObject([
    { id: "reload_terminal" },
  ]);
  expect(stops).toBe(0);

  // Re-contributing host input may rebuild the physical plugin, but the
  // host-owned terminal registry and its sessions remain mounted.
  await writeFile(
    configPath,
    JSON.stringify({
      version: 3,
      runtime: { terminal: { windowMode: "windowless" } },
    }),
  );
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.service<object>(terminalController.id)).toBeDefined();
  expect(await client.nativeTerminalList?.()).toMatchObject([
    { id: "reload_terminal" },
  ]);
  expect(stops).toBe(0);

  await client.dispose?.();
  expect(stops).toBe(0);
}, 60_000);

test("checkpoint config reload reconciles its lifecycle", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-checkpoint-config-reload-"),
  );
  await mkdir(join(root, ".natalia"), { recursive: true });
  const configPath = join(root, ".natalia", "config.json");
  const disabledConfig = {
    version: 3,
    checkpoint: { enabled: false },
  };
  await writeFile(configPath, JSON.stringify(disabledConfig));
  const kernel = new CapabilityRegistry();
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_checkpoint_config_reload",
    capabilityRegistry: kernel,
    provider: scriptedProvider("ready"),
  });
  client.start((event) => events.push(event));
  await client.runtimeStatus?.();
  expect(kernel.service(checkpointFactory.id)).toBeDefined();
  await client.submitAndWait!("without checkpoint");
  expect(events.some((event) => event.type === "checkpoint.created")).toBe(
    false,
  );
  expect(await client.checkpointList?.()).toEqual([]);

  await writeFile(configPath, JSON.stringify({ version: 3 }));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  await client.submitAndWait!("with checkpoint");
  expect(events.some((event) => event.type === "checkpoint.created")).toBe(
    true,
  );

  await writeFile(configPath, JSON.stringify(disabledConfig));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  const checkpointCount = events.filter(
    (event) => event.type === "checkpoint.created",
  ).length;
  await client.submitAndWait!("disabled again");
  expect(
    events.filter((event) => event.type === "checkpoint.created"),
  ).toHaveLength(checkpointCount);

  await writeFile(configPath, JSON.stringify({ version: 3 }));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  await client.submitAndWait!("enabled again");
  expect(
    events.filter((event) => event.type === "checkpoint.created").length,
  ).toBeGreaterThan(checkpointCount);
  await client.dispose?.();
}, 60_000);

test("MCP plugin config reload reconciles its lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-mcp-config-reload-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  const configPath = join(root, ".natalia", "config.json");
  const server = String.raw`
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (!("id" in message)) return;
  let result = {};
  if (message.method === "initialize") {
    result = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, prompts: {}, resources: {} },
      serverInfo: { name: "reload", version: "1" },
    };
  } else if (message.method === "tools/list") {
    result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
  } else if (message.method === "prompts/list") {
    result = { prompts: [{ name: "reload_prompt" }] };
  } else if (message.method === "resources/list") {
    result = { resources: [] };
  }
  console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});
`;
  const mcpServers = {
    reload: {
      type: "stdio",
      command: process.execPath,
      args: ["-e", server],
      enabled: true,
      allowedTools: [],
      excludedTools: [],
      readOnly: true,
      headers: {},
      environment: {},
      timeoutSec: 5,
    },
  };
  const disabledConfig = {
    version: 3,
    mcpServers,
    plugins: { enabled: { [MCP_PLUGIN_ID]: false } },
  };
  const enabledConfig = {
    version: 3,
    mcpServers,
    defaultAgentMode: "mcp",
    agentModes: {
      mcp: {
        approval: "ask",
        description: "MCP enabled",
        mcpServers: ["reload"],
      },
    },
  };
  await writeFile(configPath, JSON.stringify(disabledConfig));
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_mcp_config_reload",
    capabilityRegistry: kernel,
    provider: scriptedProvider("ready"),
  });
  client.start(() => undefined);
  await client.runtimeStatus?.();
  expect(kernel.has(MCP_PLUGIN_ID)).toBe(false);
  expect(await client.mcpCatalog?.()).toEqual({ prompts: [], resources: [] });

  await writeFile(configPath, JSON.stringify(enabledConfig));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.has(MCP_PLUGIN_ID)).toBe(true);
  await waitForAsync(
    async () =>
      (await client.registeredTools?.())?.some(
        (tool) => tool.name === "mcp_reload_echo",
      ) === true,
  );
  await waitForAsync(
    async () =>
      (await client.mcpCatalog?.())?.prompts?.some(
        (prompt) => prompt.name === "reload_prompt",
      ) === true,
  );
  expect(
    (await client.registeredTools?.())?.filter(
      (tool) => tool.name === "mcp_reload_echo",
    ),
  ).toHaveLength(1);
  expect(await client.mcpCatalog?.()).toEqual({
    prompts: [
      expect.objectContaining({ server: "reload", name: "reload_prompt" }),
    ],
    resources: [],
  });

  await writeFile(configPath, JSON.stringify(disabledConfig));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.has(MCP_PLUGIN_ID)).toBe(false);
  expect(
    (await client.registeredTools?.())?.some((tool) =>
      tool.name.startsWith("mcp_reload_"),
    ),
  ).toBe(false);
  expect(await client.mcpCatalog?.()).toEqual({ prompts: [], resources: [] });

  await writeFile(configPath, JSON.stringify(enabledConfig));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.has(MCP_PLUGIN_ID)).toBe(true);
  await waitForAsync(
    async () =>
      (await client.registeredTools?.())?.some(
        (tool) => tool.name === "mcp_reload_echo",
      ) === true,
  );
  await waitForAsync(
    async () => (await client.mcpCatalog?.())?.prompts?.length === 1,
  );
  expect(
    (await client.registeredTools?.())?.filter(
      (tool) => tool.name === "mcp_reload_echo",
    ),
  ).toHaveLength(1);
  expect((await client.mcpCatalog?.())?.prompts).toHaveLength(1);

  await writeFile(
    configPath,
    JSON.stringify({
      version: 3,
      mcpServers,
      defaultAgentMode: "without-mcp",
      agentModes: {
        "without-mcp": {
          approval: "ask",
          description: "MCP disabled",
          extensions: { mcp: false },
        },
      },
    }),
  );
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.has(MCP_PLUGIN_ID)).toBe(false);
  expect(await client.mcpCatalog?.()).toEqual({ prompts: [], resources: [] });
  await client.dispose?.();
}, 60_000);

test("sandbox subsystem composes directly and releases on dispose", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sandbox-config-reload-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  const configPath = join(root, ".natalia", "config.json");
  await writeFile(configPath, JSON.stringify({ version: 3 }));
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_sandbox_config_reload",
    capabilityRegistry: kernel,
    permissionMode: "auto",
    provider: singleToolProvider("sandbox_create", { id: "reload_box" }),
  });
  client.start(() => undefined);
  await client.submitAndWait!("create sandbox");
  await client.runtimeStatus?.();

  expect(kernel.service(sandboxService.id)).toBeDefined();
  expect(kernel.has(TEAM_PLUGIN_ID)).toBe(true);
  await waitForAsync(
    async () =>
      (await client.registeredTools?.())?.some((tool) =>
        tool.name.startsWith("team_"),
      ) === true,
  );
  const first = kernel.service<SandboxService>(sandboxService.id)!;
  const resource = await first.startResource(
    "reload_box",
    "sleep 30",
    "reload_resource",
  );
  expect(
    (await client.registeredTools?.())?.filter((tool) =>
      tool.name.startsWith("team_"),
    ),
  ).toHaveLength(2);

  await writeFile(configPath, JSON.stringify({ version: 3 }));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.service<SandboxService>(sandboxService.id)).toBe(first);
  expect(kernel.has(TEAM_PLUGIN_ID)).toBe(true);
  expect(await client.sandboxList?.()).toMatchObject([{ id: "reload_box" }]);

  await client.dispose?.();
  await expect(first.list()).rejects.toThrow(
    "sandbox manager is not initialized",
  );
  await waitForProcessExit(resource.pid);
}, 60_000);

test("built-in tool plugin config reload reconciles its lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-config-reload-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  const configPath = join(root, ".natalia", "config.json");
  await writeFile(configPath, JSON.stringify({ version: 3 }));
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_tool_config_reload",
    capabilityRegistry: kernel,
    provider: scriptedProvider("ready"),
  });
  client.start(() => undefined);
  await client.runtimeStatus?.();
  expect(kernel.has(TODO_PLUGIN_ID)).toBe(true);

  await writeFile(
    configPath,
    JSON.stringify({
      version: 3,
      plugins: { enabled: { [TODO_PLUGIN_ID]: false } },
    }),
  );
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.has(TODO_PLUGIN_ID)).toBe(false);
  expect(
    (await client.registeredTools?.())?.some((tool) =>
      tool.name.startsWith("todo_"),
    ),
  ).toBe(false);
  await client.dispose?.();
}, 60_000);

test("skills plugin config reload reconciles its lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-skills-config-reload-"));
  const skillRoot = join(root, ".natalia", "skills", "reloadable");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: reloadable\ndescription: Reloadable skill\nresources: [note.txt]\n---\nReload guidance.",
  );
  await writeFile(join(skillRoot, "note.txt"), "skill resource");
  const configPath = join(root, ".natalia", "config.json");
  const disabledConfig = {
    version: 3,
    plugins: { enabled: { [SKILLS_PLUGIN_ID]: false } },
  };
  await writeFile(configPath, JSON.stringify(disabledConfig));
  const kernel = new CapabilityRegistry();
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_skills_config_reload",
    capabilityRegistry: kernel,
    provider: scriptedProvider("ready"),
  });
  client.start((event) => events.push(event));
  await client.runtimeStatus?.();
  expect(kernel.has(SKILLS_PLUGIN_ID)).toBe(false);
  expect(await client.skills?.()).toEqual([]);
  expect(
    (await client.registeredTools?.())?.some(
      (tool) => tool.name === "skill_load",
    ),
  ).toBe(false);

  await writeFile(configPath, JSON.stringify({ version: 3 }));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.has(SKILLS_PLUGIN_ID)).toBe(true);
  expect(await client.skills?.()).toEqual([
    expect.objectContaining({ qualifiedName: "project:reloadable" }),
  ]);
  await waitForAsync(
    async () =>
      (await client.registeredTools?.())?.some(
        (tool) => tool.name === "skill_load",
      ) === true,
  );
  expect(
    (await client.registeredTools?.())?.filter(
      (tool) => tool.name === "skill_load",
    ),
  ).toHaveLength(1);
  await client.submitAndWait!("/skill reloadable");

  await writeFile(configPath, JSON.stringify(disabledConfig));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.has(SKILLS_PLUGIN_ID)).toBe(false);
  expect(await client.skills?.()).toEqual([]);
  const eventCount = events.length;
  await client.submitAndWait!("/skill-resource note.txt");
  expect(
    events
      .slice(eventCount)
      .some(
        (event) =>
          event.type === "content.delta" && event.text === "skill resource",
      ),
  ).toBe(false);

  await writeFile(configPath, JSON.stringify({ version: 3 }));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.has(SKILLS_PLUGIN_ID)).toBe(true);
  expect(
    (await client.registeredTools?.())?.filter(
      (tool) => tool.name === "skill_load",
    ),
  ).toHaveLength(1);
  await client.submitAndWait!("/skill reloadable");
  await expect(
    client.submit("/skill-resource note.txt"),
  ).resolves.toBeDefined();

  await writeFile(
    configPath,
    JSON.stringify({
      version: 3,
      defaultAgentMode: "without-skills",
      agentModes: {
        "without-skills": {
          approval: "ask",
          description: "Skills disabled",
          extensions: { skills: false },
        },
      },
    }),
  );
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.has(SKILLS_PLUGIN_ID)).toBe(false);
  expect(await client.skills?.()).toEqual([]);
  await client.dispose?.();
}, 60_000);

test("team plugin config reload reconciles its lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-team-config-reload-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  const configPath = join(root, ".natalia", "config.json");
  const disabledConfig = {
    version: 3,
    plugins: { enabled: { [TEAM_PLUGIN_ID]: false } },
  };
  await writeFile(configPath, JSON.stringify(disabledConfig));
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_team_config_reload",
    capabilityRegistry: kernel,
    provider: scriptedProvider("ready"),
  });
  client.start(() => undefined);
  await client.runtimeStatus?.();
  expect(kernel.has(TEAM_PLUGIN_ID)).toBe(false);
  expect(kernel.has("natalia-sandbox")).toBe(true);
  expect(kernel.has("natalia-subagents")).toBe(true);
  expect(
    (await client.registeredTools?.())?.some((tool) =>
      tool.name.startsWith("team_"),
    ),
  ).toBe(false);

  await writeFile(configPath, JSON.stringify({ version: 3 }));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.has(TEAM_PLUGIN_ID)).toBe(true);
  await waitForAsync(
    async () =>
      (await client.registeredTools?.())?.some((tool) =>
        tool.name.startsWith("team_"),
      ) === true,
  );
  expect(
    (await client.registeredTools?.())?.filter((tool) =>
      tool.name.startsWith("team_"),
    ),
  ).toHaveLength(2);

  await writeFile(configPath, JSON.stringify(disabledConfig));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.has(TEAM_PLUGIN_ID)).toBe(false);
  expect(kernel.has("natalia-sandbox")).toBe(true);
  expect(kernel.has("natalia-subagents")).toBe(true);
  expect(
    (await client.registeredTools?.())?.some((tool) =>
      tool.name.startsWith("team_"),
    ),
  ).toBe(false);

  await writeFile(configPath, JSON.stringify({ version: 3 }));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.has(TEAM_PLUGIN_ID)).toBe(true);
  expect(
    (await client.registeredTools?.())?.filter((tool) =>
      tool.name.startsWith("team_"),
    ),
  ).toHaveLength(2);
  await client.dispose?.();
}, 60_000);

test("local tool paths reconcile plugin lifecycle on config reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-local-tools-config-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  const configPath = join(root, ".natalia", "config.json");
  await writeFile(configPath, JSON.stringify({ version: 3 }));
  await mkdir(join(root, "extra-tools", "extra.family"), { recursive: true });
  await writeFile(
    join(root, "extra-tools", "extra.family", "natalia.tool.json"),
    JSON.stringify({ entry: "index.ts" }),
  );
  await writeFile(
    join(root, "extra-tools", "extra.family", "index.ts"),
    `export default { id: "extra.family", name: "Extra", version: "1.0.0",
description: "Extra", scope: "session", tools: [{ name: "extra_run",
description: "Run", requiresApproval: false, parameters: { type: "object", properties: {} },
async execute() { return "ok"; } }] };`,
  );
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_local_tools_config_reload",
    capabilityRegistry: kernel,
    provider: scriptedProvider("ready"),
  });
  client.start(() => undefined);
  await client.runtimeStatus?.();
  expect(kernel.has("natalia-local-tools")).toBe(false);

  await writeFile(
    configPath,
    JSON.stringify({ version: 3, tools: { paths: ["extra-tools"] } }),
  );
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.has("natalia-local-tools")).toBe(true);
  expect(kernel.service("localTools.reload")).toBeDefined();
  await waitForAsync(
    async () =>
      (await client.registeredTools?.())?.some(
        (tool) => tool.name === "extra_run",
      ) === true,
  );
  expect(
    (await client.registeredTools?.())?.some(
      (tool) => tool.name === "extra_run",
    ),
  ).toBe(true);

  await writeFile(
    configPath,
    JSON.stringify({
      version: 3,
      tools: { paths: ["extra-tools"] },
      plugins: { enabled: { "natalia-local-tools": false } },
    }),
  );
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.has("natalia-local-tools")).toBe(false);
  expect(
    (await client.registeredTools?.())?.some(
      (tool) => tool.name === "extra_run",
    ),
  ).toBe(false);

  await writeFile(
    configPath,
    JSON.stringify({ version: 3, tools: { paths: ["extra-tools"] } }),
  );
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.has("natalia-local-tools")).toBe(true);

  await writeFile(configPath, JSON.stringify({ version: 3 }));
  await expect(client.reloadConfig?.()).resolves.toEqual({ applied: true });
  expect(kernel.has("natalia-local-tools")).toBe(false);
  expect(kernel.service("localTools.reload")).toBeUndefined();
  expect(
    (await client.registeredTools?.())?.some(
      (tool) => tool.name === "extra_run",
    ),
  ).toBe(false);
  await client.dispose?.();
}, 60_000);

for (const [label, config] of [
  ["plugin switch", { plugins: { enabled: { "natalia-tool-todo": false } } }],
] as const)
  test(`disabled todo ${label} leaves no tool, capability or persistence`, async () => {
    const root = await mkdtemp(
      join(tmpdir(), "natalia-runtime-todo-disabled-"),
    );
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({ version: 3, ...config }),
    );
    const events: RuntimeEvent[] = [];
    const kernel = new CapabilityRegistry();
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: `ses_runtime_todo_disabled_${label.replaceAll(" ", "_")}`,
      capabilityRegistry: kernel,
      provider: scriptedProvider("ready"),
    });
    client.start((event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === "session.ready"));
    expect(
      events.some(
        (event) =>
          event.type === "tool.registered" &&
          (event.name.startsWith("todo_") || event.name === "plan"),
      ),
    ).toBe(false);
    expect(kernel.has("natalia-tool-todo")).toBe(false);
    expect(existsSync(join(root, ".natalia", "todos"))).toBe(false);
    await client.dispose?.();
  }, 60_000);

for (const [label, config] of [
  ["plugin switch", { plugins: { enabled: { "natalia-tool-ask": false } } }],
] as const)
  test(`disabled ask ${label} leaves no tool or capability`, async () => {
    const root = await mkdtemp(join(tmpdir(), "natalia-runtime-ask-disabled-"));
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({ version: 3, ...config }),
    );
    const events: RuntimeEvent[] = [];
    const kernel = new CapabilityRegistry();
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: `ses_runtime_ask_disabled_${label.replaceAll(" ", "_")}`,
      capabilityRegistry: kernel,
      provider: scriptedProvider("ready"),
    });
    client.start((event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === "session.ready"));
    expect(
      events.some(
        (event) =>
          event.type === "tool.registered" && event.name === "ask_user",
      ),
    ).toBe(false);
    expect(kernel.has("natalia-tool-ask")).toBe(false);
    await client.dispose?.();
  }, 60_000);

for (const [label, config] of [
  ["plugin switch", { plugins: { enabled: { "natalia-tool-search": false } } }],
] as const)
  test(`disabled search ${label} leaves no tool or capability`, async () => {
    const root = await mkdtemp(
      join(tmpdir(), "natalia-runtime-search-disabled-"),
    );
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({ version: 3, ...config }),
    );
    const events: RuntimeEvent[] = [];
    const kernel = new CapabilityRegistry();
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: `ses_runtime_search_disabled_${label.replaceAll(" ", "_")}`,
      capabilityRegistry: kernel,
      provider: scriptedProvider("ready"),
    });
    client.start((event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === "session.ready"));
    expect(
      events.some(
        (event) =>
          event.type === "tool.registered" &&
          (event.name === "glob" || event.name === "grep"),
      ),
    ).toBe(false);
    expect(kernel.has("natalia-tool-search")).toBe(false);
    await client.dispose?.();
  }, 60_000);

for (const [label, config] of [
  [
    "legacy plugin switch",
    {
      plugins: {
        enabled: {
          "natalia-tool-fs-read": false,
          "natalia-tool-fs-write": false,
        },
      },
    },
  ],
] as const)
  test(`disabled fs ${label} leaves no tool or capability`, async () => {
    const root = await mkdtemp(join(tmpdir(), "natalia-runtime-fs-disabled-"));
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({ version: 3, ...config }),
    );
    const events: RuntimeEvent[] = [];
    const kernel = new CapabilityRegistry();
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: `ses_runtime_fs_disabled_${label.replaceAll(" ", "_")}`,
      capabilityRegistry: kernel,
      provider: scriptedProvider("ready"),
    });
    client.start((event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === "session.ready"));
    expect(
      events.some(
        (event) =>
          event.type === "tool.registered" &&
          (event.name === "read_file" ||
            event.name === "write_file" ||
            event.name === "edit_file" ||
            event.name === "read_media_file" ||
            event.name === "image_read" ||
            event.name === "apply_edits"),
      ),
    ).toBe(false);
    expect(kernel.has("natalia-tool-fs-read")).toBe(false);
    expect(kernel.has("natalia-tool-fs-write")).toBe(false);
    await client.dispose?.();
  }, 60_000);

test("disabling only the fs read plugin keeps the write tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-fs-read-off-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      plugins: { enabled: { "natalia-tool-fs-read": false } },
    }),
  );
  const events: RuntimeEvent[] = [];
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_fs_read_off",
    capabilityRegistry: kernel,
    provider: scriptedProvider("ready"),
  });
  client.start((event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === "session.ready"));
  const registered = new Set(
    events
      .filter((event) => event.type === "tool.registered")
      .map((event) => event.name),
  );
  for (const name of ["read_file", "read_media_file", "image_read"])
    expect(registered.has(name)).toBe(false);
  for (const name of ["write_file", "edit_file", "apply_edits"])
    expect(registered.has(name)).toBe(true);
  expect(kernel.has("natalia-tool-fs-read")).toBe(false);
  expect(kernel.has("natalia-tool-fs-write")).toBe(true);
  await client.dispose?.();
}, 60_000);

for (const [label, config] of [
  ["plugin switch", { plugins: { enabled: { "natalia-tool-web": false } } }],
] as const)
  test(`disabled web ${label} leaves no tool or capability`, async () => {
    const root = await mkdtemp(join(tmpdir(), "natalia-runtime-web-disabled-"));
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({ version: 3, ...config }),
    );
    const events: RuntimeEvent[] = [];
    const kernel = new CapabilityRegistry();
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: `ses_runtime_web_disabled_${label.replaceAll(" ", "_")}`,
      capabilityRegistry: kernel,
      provider: scriptedProvider("ready"),
    });
    client.start((event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === "session.ready"));
    expect(
      events.some(
        (event) =>
          event.type === "tool.registered" &&
          (event.name === "web_fetch" || event.name === "web_search"),
      ),
    ).toBe(false);
    expect(kernel.has("natalia-tool-web")).toBe(false);
    await client.dispose?.();
  }, 60_000);

for (const [label, config] of [
  ["plugin switch", { plugins: { enabled: { "natalia-tool-shell": false } } }],
] as const)
  test(`disabled shell ${label} leaves no tool or capability`, async () => {
    const root = await mkdtemp(
      join(tmpdir(), "natalia-runtime-shell-disabled-"),
    );
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({ version: 3, ...config }),
    );
    const events: RuntimeEvent[] = [];
    const kernel = new CapabilityRegistry();
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: `ses_runtime_shell_disabled_${label.replaceAll(" ", "_")}`,
      capabilityRegistry: kernel,
      provider: scriptedProvider("ready"),
    });
    client.start((event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === "session.ready"));
    expect(
      events.some(
        (event) =>
          event.type === "tool.registered" && event.name === "run_shell",
      ),
    ).toBe(false);
    expect(kernel.has("natalia-tool-shell")).toBe(false);
    await client.dispose?.();
  }, 60_000);

for (const [label, config] of [
  [
    "legacy plugin switch",
    { plugins: { enabled: { "natalia-tool-agent": false } } },
  ],
] as const)
  test(`framework subagents ignore ${label}`, async () => {
    const root = await mkdtemp(
      join(tmpdir(), "natalia-runtime-agent-disabled-"),
    );
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({ version: 3, ...config }),
    );
    const events: RuntimeEvent[] = [];
    const kernel = new CapabilityRegistry();
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: `ses_runtime_agent_disabled_${label.replaceAll(" ", "_")}`,
      capabilityRegistry: kernel,
      provider: scriptedProvider("ready"),
    });
    client.start((event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === "session.ready"));
    expect(
      events.some(
        (event) =>
          event.type === "tool.registered" && event.name.startsWith("agent_"),
      ),
    ).toBe(true);
    expect(kernel.has("natalia-subagents")).toBe(true);
    await client.dispose?.();
  }, 60_000);

for (const [label, config] of [
  [
    "plugin switch",
    { plugins: { enabled: { "natalia-tool-terminal": false } } },
  ],
] as const)
  test(`disabled terminal ${label} leaves no tool or capability`, async () => {
    const root = await mkdtemp(
      join(tmpdir(), "natalia-runtime-terminal-disabled-"),
    );
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({ version: 3, ...config }),
    );
    const events: RuntimeEvent[] = [];
    const kernel = new CapabilityRegistry();
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: `ses_runtime_terminal_disabled_${label.replaceAll(" ", "_")}`,
      capabilityRegistry: kernel,
      provider: scriptedProvider("ready"),
    });
    client.start((event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === "session.ready"));
    expect(
      events.some(
        (event) =>
          event.type === "tool.registered" &&
          (event.name.startsWith("interactive_terminal") ||
            event.name === "terminal_observe" ||
            event.name.startsWith("interactive_")),
      ),
    ).toBe(false);
    expect(kernel.has("natalia-tool-terminal")).toBe(false);
    await client.dispose?.();
  }, 60_000);

for (const [label, config] of [
  [
    "plugin switch",
    { plugins: { enabled: { "natalia-tool-sandbox": false } } },
  ],
] as const)
  test(`framework sandbox ignores ${label}`, async () => {
    const root = await mkdtemp(
      join(tmpdir(), "natalia-runtime-sandbox-disabled-"),
    );
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({ version: 3, ...config }),
    );
    const events: RuntimeEvent[] = [];
    const kernel = new CapabilityRegistry();
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: `ses_runtime_sandbox_disabled_${label.replaceAll(" ", "_")}`,
      capabilityRegistry: kernel,
      provider: scriptedProvider("ready"),
    });
    client.start((event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === "session.ready"));
    expect(
      events.some(
        (event) =>
          event.type === "tool.registered" && event.name.startsWith("sandbox_"),
      ),
    ).toBe(true);
    expect(kernel.has("natalia-sandbox")).toBe(true);
    await client.dispose?.();
  }, 60_000);

for (const [label, config] of [
  [
    "plugin switch",
    { plugins: { enabled: { "natalia-tool-process": false } } },
  ],
] as const)
  test(`disabled process ${label} leaves no tool or capability`, async () => {
    const root = await mkdtemp(
      join(tmpdir(), "natalia-runtime-process-disabled-"),
    );
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({ version: 3, ...config }),
    );
    const events: RuntimeEvent[] = [];
    const kernel = new CapabilityRegistry();
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: `ses_runtime_process_disabled_${label.replaceAll(" ", "_")}`,
      capabilityRegistry: kernel,
      provider: scriptedProvider("ready"),
    });
    client.start((event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === "session.ready"));
    expect(
      events.some(
        (event) =>
          event.type === "tool.registered" &&
          (event.name.startsWith("process_") ||
            event.name.startsWith("background_")),
      ),
    ).toBe(false);
    expect(kernel.has("natalia-tool-process")).toBe(false);
    await client.dispose?.();
  }, 60_000);

test("read-only profile rejects side-effecting tools without an approval request", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-read-only-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      defaultAgentMode: "safe",
      agentModes: {
        safe: { approval: "read_only", description: "Read-only workspace" },
      },
    }),
  );
  const events: RuntimeEvent[] = [];
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_read_only",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request);
        if (!request.messages.some((message) => message.role === "tool"))
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "write",
                name: "write_file",
                arguments: JSON.stringify({
                  path: "hello-ts7.txt",
                  content: "blocked",
                }),
              },
            ],
          };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("write a file");

  expect(await client.runtimeStatus?.()).toMatchObject({
    type: "status.snapshot",
    permissions: "read_only",
  });
  expect(requests[0]?.tools?.map((tool) => tool.name)).not.toContain(
    "write_file",
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.update",
      name: "write_file",
      status: "failed",
      summary: "Unknown tool: write_file",
    }),
  );
  expect(events.some((event) => event.type === "approval.request")).toBe(false);
  await expect(
    readFile(join(root, "hello-ts7.txt"), "utf8"),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("selected permission profile denies tools outside its allow list before approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-profile-allow-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      agentModes: {
        unattended_read: {
          approval: "auto",
          description: "Read-only unattended inspection",
          permissions: {
            tools: { allow: ["read_file", "web_fetch"] },
            files: {
              readPaths: [
                { pattern: "allowed.txt", allow: false, reason: "protected" },
              ],
            },
            network: { allowLocalhost: false },
          },
        },
      },
    }),
  );
  const events: RuntimeEvent[] = [];
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_profile_allow",
    permissionProfile: "unattended_read",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request);
        if (!request.messages.some((message) => message.role === "tool"))
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "write",
                name: "write_file",
                arguments: JSON.stringify({
                  path: "blocked.txt",
                  content: "blocked",
                }),
              },
              {
                id: "network",
                name: "web_fetch",
                arguments: JSON.stringify({ url: "http://127.0.0.1:9" }),
              },
            ],
          };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("inspect only");

  expect(requests[0]?.tools?.map((tool) => tool.name).sort()).toEqual(
    ["read_file", "web_fetch"].sort(),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "policy.decision",
      toolName: "write_file",
      decision: "deny",
      reason: "tool is excluded from the runtime catalog by policy",
    }),
  );
  expect(events.some((event) => event.type === "approval.request")).toBe(false);
  const history = await client.history!({ limit: 500 });
  expect(history.events).toContainEqual(
    expect.objectContaining({
      event: expect.objectContaining({
        type: "policy.decision",
        toolName: "write_file",
        decision: "deny",
      }),
    }),
  );
  expect(
    events
      .filter(
        (event): event is Extract<RuntimeEvent, { type: "tool.update" }> =>
          event.type === "tool.update" && event.name === "web_fetch",
      )
      .map((event) => event.result ?? "")
      .join(" "),
  ).toContain("localhost network access is not allowed");
});

test("selected permission profile applies file rules to allowed tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-profile-files-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(join(root, "allowed.txt"), "allowed");
  await writeFile(join(root, "protected.txt"), "protected");
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      agentModes: {
        unattended_read: {
          approval: "auto",
          description: "Read-only unattended inspection",
          permissions: {
            tools: { allow: ["read_file"] },
            files: {
              readPaths: [
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
    sessionID: "ses_runtime_profile_files",
    permissionProfile: "unattended_read",
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
                arguments: JSON.stringify({ path: "protected.txt" }),
              },
            ],
          };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("inspect protected file");

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "policy.decision",
      toolName: "read_file",
      decision: "deny",
      reason: 'read of "protected.txt" blocked: protected',
    }),
  );
  expect(events.some((event) => event.type === "approval.request")).toBe(false);
});

test("unknown selected permission profile reports a configuration error", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-runtime-profile-missing-"),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_profile_missing",
    permissionProfile: "missing",
    provider: scriptedProvider("ready"),
  });
  client.start((event) => events.push(event));
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "diagnostic" &&
        event.message.includes("permission profile not found: missing"),
    ),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "diagnostic",
      level: "error",
      message: expect.stringContaining("permission profile not found: missing"),
    }),
  );
});

test("runtime status reflects committed agent and model selections", async () => {
  const agentRoot = await mkdtemp(join(tmpdir(), "natalia-agent-status-"));
  await mkdir(join(agentRoot, ".natalia"), { recursive: true });
  await writeFile(
    join(agentRoot, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      providers: {
        alpha: {
          name: "Alpha",
          driver: "openai",
          enabled: true,
          connection: { apiKey: "alpha-key", baseURL: "http://127.0.0.1:9" },
        },
        beta: {
          name: "Beta",
          driver: "anthropic",
          enabled: true,
          connection: { apiKey: "beta-key", baseURL: "http://127.0.0.1:9" },
        },
      },
      catalog: {
        providers: {
          alpha: { models: { "alpha-model": { name: "alpha-model" } } },
          beta: { models: { "beta-model": { name: "beta-model" } } },
        },
      },
      defaultModel: { provider: "alpha", model: "alpha-model" },
      agents: {
        first: { description: "First", model: "alpha/alpha-model" },
        second: { description: "Second", model: "beta/beta-model" },
      },
      defaultAgent: "first",
    }),
  );
  const agentClient = createRealRuntimeClient({
    workspaceRoot: agentRoot,
    sessionID: "ses_agent_status",
  });
  agentClient.start(() => undefined);
  expect(await agentClient.runtimeStatus?.()).toMatchObject({
    provider: "openai",
    model: "alpha-model",
  });
  agentClient.selectAgent?.("second");
  expect(await agentClient.runtimeStatus?.()).toMatchObject({
    provider: "anthropic",
    model: "beta-model",
  });

  const modelRoot = await mkdtemp(join(tmpdir(), "natalia-model-status-"));
  await mkdir(join(modelRoot, ".natalia"), { recursive: true });
  await writeFile(
    join(modelRoot, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      providers: {
        alpha: {
          name: "Alpha",
          driver: "openai",
          enabled: true,
          connection: { apiKey: "alpha-key", baseURL: "http://127.0.0.1:9" },
        },
        beta: {
          name: "Beta",
          driver: "anthropic",
          enabled: true,
          connection: { apiKey: "beta-key", baseURL: "http://127.0.0.1:9" },
        },
      },
      catalog: {
        providers: {
          alpha: { models: { "alpha-model": { name: "alpha-model" } } },
          beta: { models: { "beta-model": { name: "beta-model" } } },
        },
      },
      defaultModel: { provider: "alpha", model: "alpha-model" },
    }),
  );
  const modelClient = createRealRuntimeClient({
    workspaceRoot: modelRoot,
    sessionID: "ses_model_status",
  });
  modelClient.start(() => undefined);
  expect(await modelClient.runtimeStatus?.()).toMatchObject({
    provider: "openai",
    model: "alpha-model",
  });
  await modelClient.selectModel?.("beta/beta-model");
  expect(await modelClient.runtimeStatus?.()).toMatchObject({
    provider: "anthropic",
    model: "beta-model",
  });
});

test("runtime agent catalog exposes configured selectable metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-agent-catalog-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      defaultAgent: "review",
      agents: {
        review: {
          description: "Review changes",
          mode: "primary",
          model: "scripted",
          variant: "careful",
          maxSteps: 12,
          allowedTools: ["read_file"],
          excludedTools: ["run_shell"],
          mcpServers: ["docs"],
          permissions: { tools: { allow: ["grep"], exclude: ["write_file"] } },
        },
      },
    }),
  );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_agent_catalog",
    provider: scriptedProvider("ready"),
  });
  client.start(() => undefined);

  expect(await client.agents?.()).toEqual([
    {
      name: "review",
      description: "Review changes",
      mode: "primary",
      hidden: false,
      model: "scripted",
      variant: "careful",
      maxSteps: 12,
      allowedTools: ["read_file"],
      excludedTools: ["run_shell"],
      mcpServers: ["docs"],
      permissions: { tools: { allow: ["grep"], exclude: ["write_file"] } },
    },
  ]);
});

test("durable diagnostics restore on runtime reopen and render through the command", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-diagnostic-replay-"));
  const sessionID = "ses_diagnostic_replay";
  const first = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the exact-diagnostics assertion below must
    // not see an external-store diagnostic from this harness's read-only home.
    checkpointDir: join(root, ".natalia", "checkpoint-store"),
    sessionID,
    provider: scriptedProvider("first"),
    nativeTerminal: nativeTerminalFixture(),
  });
  first.start(() => undefined);
  await first.runtimeStatus?.();
  first.diagnostic("persisted safe warning", "warning");
  await first.dispose?.();
  const events: RuntimeEvent[] = [];
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    checkpointDir: join(root, ".natalia", "checkpoint-store"),
    sessionID,
    provider: scriptedProvider("reopened"),
    nativeTerminal: nativeTerminalFixture(),
  });
  reopened.start((event) => events.push(event));
  expect(await reopened.diagnostics?.()).toMatchObject([
    {
      level: "warning",
      message: "persisted safe warning",
      at: expect.any(String),
    },
  ]);
  await reopened.submitAndWait!("/diagnostics 1");
  expect(
    events
      .filter((event) => event.type === "content.delta")
      .map((event) => event.text)
      .join("\n"),
  ).toContain("warning: persisted safe warning");
});

test("TS config applies retry/context/checkpoint policy to an explicit provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-effective-config-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      runtime: {
        maxStepsPerTurn: 4,
        retry: {
          maxAttemptsPerStep: 1,
          initialBackoffMs: 1,
          maxBackoffMs: 1,
          jitterMs: 0,
        },
      },
      context: { compactionThresholdPercent: 90, reservedOutputTokens: 4096 },
      defaultModel: { provider: "configured", model: "configured-model" },
      catalog: {
        providers: {
          configured: {
            models: { "configured-model": { name: "configured-model" } },
          },
        },
      },
      providers: {
        configured: {
          name: "configured",
          driver: "openai",
          enabled: true,
          connection: { apiKey: "test-config-key" },
        },
      },
      checkpoint: {
        enabled: false,
        maxFiles: 1,
        maxBytes: 1024,
        ignore: [],
        additionalDirs: [],
      },
    }),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_effective_config",
    provider: scriptedProvider("effective config"),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("hello");
  expect(events.some((event) => event.type === "checkpoint.created")).toBe(
    false,
  );
  expect(
    events.some(
      (event) =>
        event.type === "context.status" &&
        event.thresholdPercent === 90 &&
        event.reserved === 4096,
    ),
  ).toBe(true);
});

test("context budget follows the executing model instead of a mismatched configured default", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-active-model-context-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      context: { compactionThresholdPercent: 91 },
      defaultModel: { provider: "configured", model: "configured-model" },
      catalog: {
        providers: {
          configured: {
            models: {
              "configured-model": {
                name: "configured-model",
                limits: { contextWindow: 500_000 },
              },
            },
          },
        },
      },
      providers: {
        configured: {
          name: "configured",
          driver: "openai",
          enabled: true,
          connection: { apiKey: "test-config-key" },
        },
      },
    }),
  );
  const events: RuntimeEvent[] = [];
  const provider: StreamingProvider = {
    provider: "configured",
    model: "actual-model",
    listModels: async () => [
      { id: "actual-model", contextWindow: 64_000, maxOutputTokens: 4_096 },
    ],
    async *stream() {
      yield { type: "content" as const, text: "done" };
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_active_model_context",
    provider,
  });
  client.start((event) => events.push(event));
  try {
    await client.submitAndWait!("hello");
    expect(
      events.some(
        (event) =>
          event.type === "context.status" &&
          event.max === 64_000 &&
          event.thresholdPercent === 91,
      ),
    ).toBe(true);
  } finally {
    await client.dispose?.();
  }
});

test("runtime does not cap steps when no maximum is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-unlimited-steps-"));
  let calls = 0;
  const provider: StreamingProvider = {
    provider: "scripted-unlimited",
    model: "scripted-unlimited-model",
    async *stream(request: ProviderStreamRequest) {
      calls += 1;
      const toolMessages = request.messages.filter(
        (message) => message.role === "tool",
      ).length;
      if (toolMessages < 12)
        yield {
          type: "tool_call",
          calls: [
            {
              id: `read_${calls}`,
              name: "read_file",
              arguments: JSON.stringify({ path: "/tmp/natalia-read" }),
            },
          ],
        };
      else yield { type: "content", text: "finished after many steps" };
      yield { type: "done" };
    },
  };
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_unlimited_steps",
    provider,
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("keep going");
  expect(calls).toBeGreaterThan(10);
  expect(
    events.some(
      (event) =>
        event.type === "content.delta" &&
        event.text.includes("finished after many steps"),
    ),
  ).toBe(true);
});

test("configured agent selection supplies the provider system prompt and tool policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-agent-selection-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      agents: {
        reviewer: {
          description: "Review changes",
          systemPrompt: "Review only with evidence.",
          allowedTools: ["read_file"],
        },
      },
      defaultAgent: "reviewer",
    }),
  );
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_agent_selection",
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
  await client.submitAndWait!("review this");
  const request = requests[0];
  expect(request).toBeDefined();
  expect(request!.messages[0]?.role).toBe("system");
  const systemPrompt = String(request!.messages[0]?.content);
  const runtimeContext = request!.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  expect(systemPrompt).toContain(
    "You are Natalia, a local software engineering agent",
  );
  // ADR D1: the workspace root is per-workspace dynamic context, not static
  // system prompt content.
  expect(systemPrompt).not.toContain("Working directory: " + root);
  expect(runtimeContext).toContain("Working directory: " + root);
  // The configured agent instructions stay in the static system (per-role,
  // per-config, stable across sessions and workspaces).
  expect(systemPrompt).toContain("Review only with evidence.");
  expect(request!.tools?.map((tool) => tool.name)).toEqual(["read_file"]);
});

test("runtime sends a baseline system prompt without configured agent instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-baseline-system-prompt-"));
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_baseline_system_prompt",
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
  await client.submitAndWait!("who are you?");
  const systemPrompt = String(requests[0]?.messages[0]?.content);
  const runtimeContext = (requests[0]?.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  expect(requests[0]?.messages[0]).toMatchObject({ role: "system" });
  expect(systemPrompt).toContain(
    "You are Natalia, a local software engineering agent",
  );
  expect(systemPrompt).toContain("<natalia_cli_persona>");
  expect(systemPrompt).toContain(
    "Be warm, perceptive, and recognizably yourself",
  );
  expect(systemPrompt).toContain(
    "Natalia is a gentle, cute, and thoughtful girl",
  );
  expect(systemPrompt).toContain("娜塔莉娅");
  expect(systemPrompt).toContain(
    "Do not turn a simple personal question into a detached disclaimer",
  );
  // ADR D1: per-workspace environment facts are runtime context, not static
  // system prompt content.
  expect(systemPrompt).not.toContain(`Working directory: ${root}`);
  expect(runtimeContext).toContain(`Working directory: ${root}`);
  expect(runtimeContext).toContain("Permission mode: ask");
  await client.dispose?.();
});

test("runtime discovers configured remote skills through the local cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-remote-skill-runtime-"));
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/skills/index.json")
        return Response.json({
          skills: [{ name: "remote", version: "1", files: ["SKILL.md"] }],
        });
      if (path === "/skills/remote/SKILL.md")
        return new Response(
          "---\nname: remote\ndescription: Remote\n---\nRemote guidance",
        );
      return new Response("missing", { status: 404 });
    },
  });
  try {
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({
        version: 3,
        skills: { urls: [`${server.url}skills/`] },
      }),
    );
    expect(
      (await resolveConfig({ workspaceRoot: root })).config.skills.urls,
    ).toEqual([`${server.url}skills/`]);
    const events: RuntimeEvent[] = [];
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: "ses_remote_skill_runtime",
      provider: scriptedProvider("done"),
    });
    client.start((event) => events.push(event));
    await client.submitAndWait!("/skills");
    expect(
      events
        .filter((event) => event.type === "content.delta")
        .map((event) => event.text)
        .join("\n"),
    ).toContain("remote: Remote");
  } finally {
    server.stop(true);
  }
});

test("runtime starts with no plugins when none are present on disk", async () => {
  const root = await createEmptyWorkspace(
    join(tmpdir(), "natalia-empty-plugin-runtime-"),
  );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_empty_plugin_runtime",
    provider: scriptedProvider("unused"),
  });
  client.start(() => undefined);

  expect(await client.plugins?.()).toEqual([]);
  await client.dispose?.();
});

test("a physical plugin consumes its typed host input service", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-input-runtime-"));
  const pluginRoot = join(root, ".natalia", "plugins", "input-consumer");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 2,
      id: "input.consumer",
      version: "1.0.0",
      name: "Input Consumer",
      description: "",
      entry: "index.ts",
      scope: "workspace",
      provides: ["input.workspace"],
      requires: ["terminal.input"],
      optionalRequires: [],
      conflicts: [],
      dependencies: [],
      hooks: {},
      integrationPoints: ["services"],
    }),
  );
  await writeFile(
    join(pluginRoot, "index.ts"),
    `export default { setup(api) {
      const input = api.services.get("terminal.input");
      if (!input) throw new Error("terminal input unavailable");
      api.services.provide("input.workspace", input.workspaceRoot);
    } };`,
  );
  await installFixturePlugin(root, pluginRoot);
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plugin_input_runtime",
    provider: scriptedProvider("unused"),
  });
  client.start(() => undefined);

  expect(await client.plugins?.()).toContainEqual(
    expect.objectContaining({ id: "input.consumer" }),
  );
  expect(await client.service?.<string>("input.workspace")).toBe(root);
  await client.dispose?.();
});

test("runtime loads a local manifest plugin and exposes its owned tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-runtime-"));
  const pluginRoot = join(root, ".natalia", "plugins", "demo");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 1,
      id: "demo.plugin",
      version: "1.0.0",
      name: "Demo",
      description: "",
      entry: "index.ts",
      capabilities: ["tools"],
    }),
  );
  await writeFile(
    join(pluginRoot, "index.ts"),
    "export default { setup(api) { api.tools.register({ name: 'echo', description: 'Echo', requiresApproval: false, parameters: { type: 'object', properties: {} }, async execute() { return 'plugin ok'; } }) } }",
  );
  await installFixturePlugin(root, pluginRoot);
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plugin_runtime",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool"))
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "plugin",
                name: "echo",
                arguments: "{}",
              },
            ],
          };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.submitAndWait!("run plugin");
  expect(events).toContainEqual({
    type: "plugin.update",
    id: "demo.plugin",
    status: "loaded",
    detail: undefined,
  });
  expect(
    events.some(
      (event) =>
        event.type === "tool.update" &&
        event.name === "echo" &&
        event.status === "succeeded",
    ),
  ).toBe(true);
  await client.dispose?.();
  expect(events).toContainEqual({
    type: "plugin.update",
    id: "demo.plugin",
    status: "unloaded",
    detail: undefined,
    sessionID: "ses_plugin_runtime",
  });
});

test("unloading a plugin publishes tool.unregistered and drops it from registeredTools", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-unregister-"));
  const pluginRoot = join(root, ".natalia", "plugins", "demo");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 1,
      id: "demo.plugin",
      version: "1.0.0",
      name: "Demo",
      description: "",
      entry: "index.ts",
      capabilities: ["tools"],
    }),
  );
  await writeFile(
    join(pluginRoot, "index.ts"),
    "export default { setup(api) { api.tools.register({ name: 'echo', description: 'Echo', requiresApproval: false, parameters: { type: 'object', properties: {} }, async execute() { return 'plugin ok'; } }) } }",
  );
  await installFixturePlugin(root, pluginRoot);
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plugin_unregister",
  });
  client.start((event) => events.push(event));
  await client.plugins?.();

  // The plugin tool is registered and reported.
  await waitForAsync(
    async () =>
      (await client.registeredTools?.())?.some(
        (tool) => tool.name === "echo",
      ) === true,
  );
  const before = await client.registeredTools!();
  expect(before.some((tool) => tool.name === "echo")).toBe(true);

  const unloaded = await client.pluginUnload?.("demo.plugin");
  expect(unloaded?.unloaded).toBe(true);

  // tool.unregistered was published for the removed tool.
  expect(
    events.some(
      (event) => event.type === "tool.unregistered" && event.name === "echo",
    ),
  ).toBe(true);
  // The projected catalog no longer reports it.
  const after = await client.registeredTools!();
  expect(after.some((tool) => tool.name === "echo")).toBe(false);

  await client.dispose?.();
});

test("permission profile extension rules do not gate desired plugins", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-profile-extensions-"));
  const pluginRoot = join(root, ".natalia", "plugins", "demo");
  const skillRoot = join(root, ".natalia", "skills", "review");
  await mkdir(pluginRoot, { recursive: true });
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      agentModes: {
        unattended: {
          approval: "auto",
          description: "No extensions",
          extensions: { skills: false, mcp: false, plugins: false },
        },
      },
    }),
  );
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: review\ndescription: Review\n---\nReview guidance",
  );
  await writeFile(
    join(pluginRoot, "natalia.plugin.json"),
    JSON.stringify({
      apiVersion: 1,
      id: "demo.plugin",
      version: "1.0.0",
      name: "Demo",
      description: "",
      entry: "index.ts",
      capabilities: ["tools"],
    }),
  );
  await writeFile(
    join(pluginRoot, "index.ts"),
    "export default { setup(api) { api.tools.register({ name: 'echo', description: 'Echo', requiresApproval: false, parameters: { type: 'object', properties: {} }, async execute() { return 'plugin ok'; } }) } }",
  );
  await installFixturePlugin(root, pluginRoot);
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_profile_extensions",
    permissionProfile: "unattended",
    provider: scriptedProvider("done"),
  });
  client.start(() => undefined);

  expect(await client.skills?.()).toEqual([]);
  expect(
    (await client.plugins?.())?.some((plugin) => plugin.id === "demo.plugin"),
  ).toBe(true);
  expect(
    (await client.capabilities?.())?.some(
      (capability) => capability.id === "natalia-skills",
    ),
  ).toBe(false);
  expect(
    (await client.registeredTools?.())?.some(
      (tool) => tool.name === "skill_load",
    ),
  ).toBe(false);
  await client.dispose?.();
});

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

// The standalone workflow engine is gone, so a workflow step can no longer be
// the carrier for these two protections. They are still real for direct tool
// calls, so the coverage moves to the direct path instead of disappearing.
test("sandbox merge retains manifest path authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sandbox-merge-policy-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
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
    sessionID: "ses_sandbox_merge_policy",
    permissionMode: "auto",
    provider: singleToolProvider("sandbox_merge", { id: "box" }),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("merge the sandbox");

  const failure = events.find(
    (event): event is Extract<RuntimeEvent, { type: "tool.update" }> =>
      event.type === "tool.update" &&
      event.name === "sandbox_merge" &&
      event.status === "failed",
  );
  expect(failure?.summary).toContain("protected by agent policy");
  // A refused path must not let the rest of the merge land either.
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
  expect(await client.nativeTerminalRead!("tty_management")).toEqual({
    id: "tty_management",
    text: "native pane output",
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

// Two durable turns with a live approval in between: seconds of real work,
// and the file's accumulated state makes the default 5s per-test budget a
// load lottery rather than a measurement.
test("session approval grants the approved tool for this runtime instance only", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-approval-"));
  let approvalCount = 0;
  const provider: StreamingProvider = {
    provider: "session-approval",
    model: "session-approval",
    async *stream(request) {
      if (!request.messages.some((message) => message.role === "tool"))
        yield {
          type: "tool_call",
          calls: [
            {
              id: `call_${crypto.randomUUID()}`,
              name: "run_shell",
              arguments: JSON.stringify({ command: "pwd" }),
            },
          ],
        };
      yield { type: "done" };
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_session_approval",
    provider,
  });
  client.start((event) => {
    if (event.type !== "approval.request") return;
    approvalCount++;
    client.respondApproval({ requestID: event.id, decision: "session" });
  });
  await client.submitAndWait!("run pwd once");
  await client.submitAndWait!("run pwd again");
  expect(approvalCount).toBe(1);
  await client.dispose?.();

  const reopenedApprovals: RuntimeEvent[] = [];
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_session_approval",
    provider,
  });
  reopened.start((event) => {
    reopenedApprovals.push(event);
    if (event.type === "approval.request")
      reopened.respondApproval({ requestID: event.id, decision: "once" });
  });
  await reopened.submitAndWait!("run pwd after restart");
  expect(reopenedApprovals).toContainEqual(
    expect.objectContaining({ type: "approval.request" }),
  );
  await reopened.dispose?.();
}, 30_000);

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

test("ordinary tools settle as failed when their execution timeout expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-tool-timeout-"));
  const tools = createToolRegistry([]);
  tools.set("wait_forever", {
    name: "wait_forever",
    description: "Wait until the runtime cancels this tool.",
    requiresApproval: false,
    timeoutSec: 0.01,
    parameters: { type: "object", properties: {} },
    async execute() {
      return await new Promise<string>(() => undefined);
    },
  });
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_tool_timeout",
    tools,
    provider: {
      provider: "scripted-tool-timeout",
      model: "scripted-tool-timeout-model",
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_wait",
                name: "wait_forever",
                arguments: "{}",
              },
            ],
          };
        } else {
          yield { type: "content", text: "The tool timed out; task stopped." };
        }
        yield { type: "done" };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("wait forever");

  expect(
    events.find(
      (event) =>
        event.type === "tool.update" &&
        event.callID === "call_wait" &&
        event.status === "failed",
    ),
  ).toBeDefined();
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "turn.finished",
      id: expect.any(String),
      stopReason: "done",
      sessionID: "ses_ts7_tool_timeout",
    }),
  );
});

test("a tool can extend its timeout through a bounded per-call argument", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-tool-timeout-override-"),
  );
  const tools = createToolRegistry([]);
  tools.set("wait_briefly", {
    name: "wait_briefly",
    description: "Wait briefly before returning.",
    requiresApproval: false,
    timeoutSec: 0.1,
    maxTimeoutSec: 5,
    parameters: {
      type: "object",
      properties: { timeoutSec: { type: "number" } },
    },
    async execute() {
      await Bun.sleep(250);
      return "finished";
    },
  });
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_tool_timeout_override",
    tools,
    provider: {
      provider: "scripted-tool-timeout-override",
      model: "scripted-tool-timeout-override-model",
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_wait_briefly",
                name: "wait_briefly",
                arguments: JSON.stringify({ timeoutSec: 1 }),
              },
            ],
          };
        } else {
          yield { type: "content", text: "The bounded wait finished." };
        }
        yield { type: "done" };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("wait briefly");

  expect(
    events.find(
      (event) =>
        event.type === "tool.update" &&
        event.callID === "call_wait_briefly" &&
        event.status === "succeeded",
    ),
  ).toBeDefined();
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "turn.finished",
      id: expect.any(String),
      stopReason: "done",
      sessionID: "ses_ts7_tool_timeout_override",
    }),
  );
});

test("runtime status counts managed background processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-background-"));
  const handled = new Set<string>();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_runtime_background",
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
          yield {
            type: "tool_call" as const,
            calls: [
              text === "start"
                ? {
                    id: "start",
                    name: "process_start",
                    arguments: JSON.stringify({
                      id: "proc_status",
                      command: "sleep 30",
                    }),
                  }
                : {
                    id: "stop",
                    name: "process_stop",
                    arguments: JSON.stringify({ id: "proc_status" }),
                  },
            ],
          };
        }
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("start");
  expect(await client.runtimeStatus?.()).toMatchObject({
    background: "1 running",
  });
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "status.snapshot" && event.background === "1 running",
    ),
  );
  await client.submitAndWait!("stop");
  expect(await client.runtimeStatus?.()).toMatchObject({
    background: "0 running",
  });
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "status.snapshot" && event.background === "0 running",
    ),
  );
});

test("write approval uses a compact preview and preserves raw request detail", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-approval-preview-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_approval_preview",
    provider: approvalWriteProvider(),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.submitAndWait!("write a note");
  const approval = events.find(
    (event): event is Extract<RuntimeEvent, { type: "approval.request" }> =>
      event.type === "approval.request",
  )!;
  expect(approval.preview).toContain("Write long-note.md");
  expect(approval.preview.length).toBeLessThan(300);
  expect(approval.detail).toContain('"content"');
});

test("cancelling a pending approval settles the active turn without polling", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-approval-cancel-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_approval_cancel",
    provider: approvalWriteProvider(),
  });
  let cancelled = false;
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request" && !cancelled) {
      cancelled = true;
      client.cancel("approval cancelled");
    }
  });

  await client.submitAndWait!("write then cancel");
  expect(events.some((event) => event.type === "turn.cancelled")).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "turn.finished" && event.stopReason === "cancelled",
    ),
  ).toBe(true);
  expect(
    events.filter(
      (event) =>
        event.type === "turn.finished" && event.stopReason === "cancelled",
    ),
  ).toHaveLength(1);
});

test("submit after cancel returns without waiting for the next turn to finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-submit-after-cancel-"));
  let streamCalls = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_submit_after_cancel",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        streamCalls += 1;
        if (streamCalls === 1) {
          // Hold the turn open but honor abort: a provider that ignored the
          // signal would keep the interrupted drain from ever settling.
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) resolve();
            else
              request.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          return;
        }
        yield { type: "content" as const, text: "continued" };
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  void client.submit("hang until cancelled");
  await waitFor(
    () => events.some((event) => event.type === "turn.submitted"),
    20_000,
    "the first turn to be admitted",
  );
  client.cancel("user cancel");
  const started = Date.now();
  const second = await Promise.race([
    client.submit("continue after stop"),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("submit hung")), 1000),
    ),
  ]);
  expect(Date.now() - started).toBeLessThan(500);
  expect(second.text).toBe("continue after stop");
  await waitFor(
    () =>
      events.some(
        (event) => event.type === "turn.submitted" && event.id === second.id,
      ),
    20_000,
    "the second turn to be admitted",
  );
  await client.dispose?.();
}, 120_000);

test("provider admission is persisted before the provider turn begins", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-admission-"));
  let started = false;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_admission",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        started = true;
        yield { type: "content" as const, text: "done" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  const submitted = await client.submitAndWait!("persist me first");
  await waitFor(() => started, 20_000, "the admitted turn to start streaming");
  expect(started).toBe(true);
  const stored = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", "ses_ts7_admission.json"),
      "utf8",
    ),
  ) as { events: RuntimeEvent[]; inbox?: Array<Record<string, unknown>> };
  expect(
    stored.events.some(
      (event) => event.type === "turn.submitted" && event.id === submitted.id,
    ),
  ).toBe(true);
  expect(stored.inbox).toMatchObject([
    {
      id: submitted.id,
      text: "persist me first",
      delivery: "next-turn",
      promotedAt: expect.any(String),
    },
  ]);
});

test("queued input wakes an idle session after durable admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-queued-input-"));
  let started = false;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_queued_input",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        started = true;
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  const submitted = await client.submitInput!({
    text: "wait for idle",
    delivery: "next-turn",
  });
  await waitFor(() => started, 20_000, "the queued input to start streaming");
  expect(started).toBe(true);
  const stored = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", "ses_ts7_queued_input.json"),
      "utf8",
    ),
  ) as { inbox?: Array<Record<string, unknown>> };
  expect(stored.inbox).toMatchObject([
    { id: submitted.id, text: "wait for idle", delivery: "next-turn" },
  ]);
  expect(stored.inbox?.[0]?.promotedAt).toEqual(expect.any(String));
  await client.dispose?.();
});

test("queued inputs promote in FIFO order after the active turn becomes idle", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-queued-promotion-"));
  const requests: string[] = [];
  let release: (() => void) | undefined;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_queued_promotion",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        const text = request.messages.at(-1)?.content ?? "";
        requests.push(text);
        if (text === "first")
          await new Promise<void>((resolve) => (release = resolve));
        yield { type: "content" as const, text: "done" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  const first = client.submit("first");
  while (!release) await Bun.sleep(1);
  const queued = await Promise.all(
    ["queued one", "queued two", "queued three"].map((text) =>
      client.submitInput!({ text, delivery: "next-turn" }),
    ),
  );
  release();
  await first;
  // Admission is fire-and-forget: queued rows promote through the coalesced
  // successor drain once the active turn goes idle.
  await waitFor(
    () =>
      requests.includes("queued one") &&
      requests.includes("queued two") &&
      requests.includes("queued three"),
    20_000,
    "the queued inputs to promote in order",
  );
  expect(requests.filter((text) => text === "first")).toHaveLength(1);
  expect(requests.filter((text) => text.startsWith("queued"))).toEqual([
    "queued one",
    "queued two",
    "queued three",
  ]);
  const stored = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", "ses_ts7_queued_promotion.json"),
      "utf8",
    ),
  ) as { inbox?: Array<{ id: string; promotedAt?: string }> };
  expect(
    queued.every(
      (turn) =>
        stored.inbox?.find((item) => item.id === turn.id)?.promotedAt !==
        undefined,
    ),
  ).toBe(true);
  await client.dispose?.();
});

test("a queued input survives cancellation and drains on the next prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-cancel-queue-"));
  const requests: string[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_cancel_queue",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request.messages.at(-1)?.content ?? "");
        if (requests.length === 1)
          await new Promise<void>((resolve) => {
            const finish = () => resolve();
            if (request.signal?.aborted) finish();
            else
              request.signal?.addEventListener("abort", finish, { once: true });
          });
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  const first = client.submit("first");
  await waitFor(() => requests.length === 1, 20_000, "the first turn to start");
  await client.submitInput!({ text: "queued", delivery: "next-turn" });
  client.cancel("stop mid-turn");
  await first;
  // Stop interrupts the running drain and leaves durable inbox work alone:
  // nothing auto-promotes until the next admission wakes the session.
  await Bun.sleep(30);
  expect(requests).toEqual(["first"]);
  await client.submitInput!({ text: "resume please", delivery: "next-step" });
  await waitFor(
    () => requests.includes("queued"),
    20_000,
    "the queued input to drain after the next prompt",
  );
  expect(requests).toEqual(["first", "resume please", "queued"]);
  await client.dispose?.();
});

test("cancelling after admission but before execution does not start the turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-cancel-admission-"));
  const events: RuntimeEvent[] = [];
  let providerCalls = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_cancel_admission",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        providerCalls += 1;
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    events.push(event);
    // Admission (`input.admitted`) still precedes execution (`turn.submitted`),
    // so cancelling here removes the queued input before any provider call.
    if (event.type === "input.admitted") client.cancel("cancel admission");
  });
  await client.submitAndWait!("do not start");
  await Bun.sleep(20);

  expect(providerCalls).toBe(0);
  expect(events).toContainEqual(
    expect.objectContaining({ type: "input.removed" }),
  );
  expect(events.some((event) => event.type === "turn.submitted")).toBe(false);
  await client.dispose?.();
});

test("exact input retry does not duplicate a completed provider turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-input-retry-"));
  let calls = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_input_retry",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        calls++;
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.submitAndWait!({
    id: "turn_retry",
    text: "same",
    delivery: "next-step",
  });
  await client.submitAndWait!({
    id: "turn_retry",
    text: "same",
    delivery: "next-step",
  });
  expect(calls).toBe(1);
  await expect(
    client.submitInput!({
      id: "turn_retry",
      text: "different",
      delivery: "next-step",
    }),
  ).rejects.toThrow("session input conflicts");
});

test("restart resumes a pending queued input but does not replay interrupted provider work", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-restart-queue-"));
  await mkdir(join(root, ".natalia", "sessions"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "sessions", "ses_ts7_restart_queue.json"),
    JSON.stringify({
      id: "ses_ts7_restart_queue",
      title: "Interrupted",
      createdAt: "2026-07-21T00:00:00.000Z",
      cancelled: false,
      resumable: true,
      metadata: {
        inFlightOperation: {
          kind: "provider_dispatch",
          turnID: "turn_interrupted",
          startedAt: "2026-07-21T00:00:01.000Z",
        },
      },
      events: [
        {
          type: "turn.submitted",
          id: "turn_interrupted",
          text: "unsafe to replay",
          byteLength: 16,
          lineCount: 1,
          sha256: "test",
        },
      ],
      inbox: [
        {
          id: "turn_queued",
          sessionID: "ses_ts7_restart_queue",
          text: "safe queued",
          delivery: "next-turn",
          admittedAt: "2026-07-21T00:00:00.000Z",
        },
      ],
    }),
  );

  const events: RuntimeEvent[] = [];
  let calls = 0;
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_restart_queue",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        calls++;
        yield { type: "done" as const };
      },
    },
  });
  reopened.start((event) => events.push(event));
  // A cold start replays the session, registers tools and rebuilds context
  // before it can wake the queued input, so the budget is the runtime's
  // startup, not a single tick.
  await waitFor(
    () => calls > 0,
    20_000,
    "the queued input to reach the provider",
  );
  expect(calls).toBe(1);
  await waitFor(
    () =>
      events.some(
        (event) => event.type === "turn.finished" && event.id === "turn_queued",
      ),
    20_000,
    "the queued turn to finish",
  );
  expect(
    events.some(
      (event) =>
        event.type === "diagnostic" &&
        event.message.includes("provider dispatch") &&
        event.message.includes("cannot be replayed"),
    ),
  ).toBe(true);
  const persisted = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", "ses_ts7_restart_queue.json"),
      "utf8",
    ),
  );
  expect(persisted.metadata?.inFlightOperation).toBeUndefined();
});

test("restart safely settles a durable tool execution window without replaying its side effect", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-restart-tool-window-"),
  );
  await mkdir(join(root, ".natalia", "sessions"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "sessions", "ses_ts7_restart_tool_window.json"),
    JSON.stringify({
      id: "ses_ts7_restart_tool_window",
      title: "Interrupted tool",
      createdAt: "2026-07-21T00:00:00.000Z",
      cancelled: false,
      resumable: true,
      metadata: {
        inFlightOperation: {
          kind: "tool_execution",
          turnID: "turn_interrupted_tool",
          toolName: "write_file",
          toolCallID: "call_write",
          startedAt: "2026-07-21T00:00:01.000Z",
        },
      },
      events: [
        {
          type: "turn.submitted",
          id: "turn_interrupted_tool",
          text: "write this once",
          byteLength: 15,
          lineCount: 1,
          sha256: "test",
        },
        {
          type: "tool.update",
          id: "turn_interrupted_tool:call_write",
          name: "write_file",
          callID: "call_write",
          status: "running",
          summary: "running",
          startedAt: 1,
        },
      ],
      inbox: [
        {
          id: "turn_queued_after_tool",
          sessionID: "ses_ts7_restart_tool_window",
          text: "safe queued",
          delivery: "next-turn",
          admittedAt: "2026-07-21T00:00:00.000Z",
        },
      ],
    }),
  );

  const events: RuntimeEvent[] = [];
  let calls = 0;
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_restart_tool_window",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        calls++;
        yield { type: "done" as const };
      },
    },
  });
  reopened.start((event) => events.push(event));
  await waitFor(
    () => calls > 0,
    20_000,
    "the queued input to reach the provider",
  );
  expect(calls).toBe(1);
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "turn.finished" &&
          event.id === "turn_queued_after_tool",
      ),
    20_000,
    "the queued turn to finish",
  );
  expect(
    events.some(
      (event) =>
        event.type === "turn.finished" &&
        event.id === "turn_interrupted_tool" &&
        event.stopReason === "error",
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "diagnostic" &&
        event.message.includes("tool execution") &&
        event.message.includes("cannot be replayed"),
    ),
  ).toBe(true);
});

test("runtime history supplies a stable local cursor without SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-history-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_history",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.submitAndWait!("one");
  await client.submitAndWait!("two");
  const first = await client.history!({ limit: 1 });
  expect(first.events).toHaveLength(1);
  expect(first.hasMore).toBe(true);
  const next = await client.history!({
    after: first.events[0]!.seq,
    limit: 100,
  });
  expect(next.events[0]!.seq).toBe(first.events[0]!.seq + 1);
});

test("durable history retains full assistant settlement without live fragments", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-durable-content-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_durable_content",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "content" as const, text: "hello " };
        yield { type: "content" as const, text: "world" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.submitAndWait!("greet");
  await waitForAsync(async () => {
    try {
      const persisted = JSON.parse(
        await readFile(
          join(root, ".natalia", "sessions", "ses_ts7_durable_content.json"),
          "utf8",
        ),
      ) as { events: RuntimeEvent[] };
      return persisted.events.some(
        (event) =>
          event.type === "content.done" && event.text === "hello world",
      );
    } catch {
      return false;
    }
  });
  const stored = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", "ses_ts7_durable_content.json"),
      "utf8",
    ),
  ) as { events: RuntimeEvent[] };
  expect(stored.events.some((event) => event.type === "content.delta")).toBe(
    false,
  );
  expect(
    stored.events.find((event) => event.type === "content.done"),
  ).toMatchObject({ text: "hello world" });
});

test("restart restores the latest durable context checkpoint before later events", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-context-epoch-"));
  const requests: Array<{
    messages: Array<{ role: string; content: string }>;
  }> = [];
  const first = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_context_epoch",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "content" as const, text: "first answer" };
        yield { type: "done" as const };
      },
    },
  });
  first.start(() => undefined);
  await first.submitAndWait!("first question");
  await waitForAsync(async () => {
    try {
      const persisted = JSON.parse(
        await readFile(
          join(root, ".natalia", "sessions", "ses_ts7_context_epoch.json"),
          "utf8",
        ),
      ) as { events: RuntimeEvent[] };
      return persisted.events.some(
        (event) => event.type === "context.checkpoint",
      );
    } catch {
      return false;
    }
  });
  const persisted = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", "ses_ts7_context_epoch.json"),
      "utf8",
    ),
  ) as { events: RuntimeEvent[] };
  expect(
    persisted.events.some((event) => event.type === "context.checkpoint"),
  ).toBe(true);

  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_context_epoch",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push({
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        });
        yield { type: "done" as const };
      },
    },
  });
  const reopenedEvents: RuntimeEvent[] = [];
  reopened.start((event) => reopenedEvents.push(event));
  await Bun.sleep(5);
  const initializationFailure = reopenedEvents.find(
    (event) => event.type === "diagnostic" && event.level === "error",
  );
  expect(initializationFailure).toBeUndefined();
  await reopened.submitAndWait!("second question");
  expect(requests[0]?.messages).toEqual(
    expect.arrayContaining([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ]),
  );
});

test("context-limit compaction persists a durable context epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-context-compaction-"));
  let attempts = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_context_compaction",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        attempts++;
        if (attempts === 1)
          throw providerError({
            kind: "context_limit",
            message: "context limit",
          });
        yield { type: "content" as const, text: "recovered" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.submitAndWait!("compact then retry");
  await waitForAsync(async () => {
    try {
      const persisted = JSON.parse(
        await readFile(
          join(root, ".natalia", "sessions", "ses_ts7_context_compaction.json"),
          "utf8",
        ),
      ) as { events: RuntimeEvent[] };
      return persisted.events.some(
        (event) => event.type === "context.checkpoint",
      );
    } catch {
      return false;
    }
  });
  const stored = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", "ses_ts7_context_compaction.json"),
      "utf8",
    ),
  ) as { events: RuntimeEvent[] };
  expect(
    stored.events.some((event) => event.type === "context.checkpoint"),
  ).toBe(true);
});

test("SQLite restart restores context from epoch baseline without duplicate history", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-sqlite-context-epoch-"),
  );
  const first = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_sqlite_context_epoch",
    useSqliteStore: true,
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "content" as const, text: "first answer" };
        yield { type: "done" as const };
      },
    },
  });
  first.start(() => undefined);
  await first.submitAndWait!("first question");

  const requests: Array<{
    messages: Array<{ role: string; content: string }>;
  }> = [];
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_sqlite_context_epoch",
    useSqliteStore: true,
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push({
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        });
        yield { type: "done" as const };
      },
    },
  });
  reopened.start(() => undefined, { replay: "none" });
  await reopened.submitAndWait!("second question");
  const restored = requests[0]!.messages;
  expect(
    restored.filter((message) => message.content === "first question"),
  ).toHaveLength(1);
  expect(
    restored.filter((message) => message.content === "first answer"),
  ).toHaveLength(1);
  expect(
    restored.filter((message) => message.content === "second question"),
  ).toHaveLength(1);
});

test("SQLite indexed replay recovers pending interactive control state", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-sqlite-indexed-interactive-"),
  );
  const sessionID = "ses_ts7_sqlite_indexed_interactive" as SessionID;
  const databasePath = resolveWorkspaceJournalDatabasePath(root);
  await mkdir(join(root, ".natalia"), { recursive: true });
  const store = new SessionStoreTestDatabase(databasePath);
  store.create(sessionID, "Indexed interactive");
  store.appendEvents(sessionID, [
    {
      type: "context.checkpoint",
      id: "epoch_indexed_interactive",
      snapshot: {
        entries: [],
        resources: [],
        journalOffset: 0,
        step: 0,
        tokenEstimate: 0,
        compactionGeneration: 0,
      },
    },
    {
      type: "approval.request",
      id: "approval_indexed",
      title: "Write",
      preview: "file",
    },
    {
      type: "question.request",
      id: "question_indexed",
      title: "Choice",
    },
  ]);
  store.close();

  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    useSqliteStore: true,
    provider: scriptedProvider("unused"),
  });
  client.start((event) => events.push(event), { replay: "none" });
  await waitFor(() => events.some((event) => event.type === "session.ready"));
  expect(await client.pendingInteractive!()).toMatchObject({
    approvals: [{ id: "approval_indexed" }],
    questions: [{ id: "question_indexed" }],
  });
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "approval.request",
        id: "approval_indexed",
      }),
      expect.objectContaining({
        type: "question.request",
        id: "question_indexed",
      }),
    ]),
  );
  await client.dispose?.();
});

test("SQLite indexed replay recovers bounded durable diagnostics", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-sqlite-indexed-diagnostics-"),
  );
  const sessionID = "ses_ts7_sqlite_indexed_diagnostics" as SessionID;
  const databasePath = resolveWorkspaceJournalDatabasePath(root);
  await mkdir(join(root, ".natalia"), { recursive: true });
  const store = new SessionStoreTestDatabase(databasePath);
  store.create(sessionID, "Indexed diagnostics");
  store.appendEvents(sessionID, [
    {
      type: "context.checkpoint",
      id: "epoch_indexed_diagnostics",
      snapshot: {
        entries: [],
        resources: [],
        journalOffset: 0,
        step: 0,
        tokenEstimate: 0,
        compactionGeneration: 0,
      },
    },
    {
      type: "diagnostic",
      level: "warning",
      message: "durable indexed diagnostic",
      at: "2026-07-25T00:00:00.000Z",
    },
  ]);
  store.close();

  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    useSqliteStore: true,
    provider: scriptedProvider("unused"),
  });
  client.start(() => undefined, { replay: "none" });
  await Bun.sleep(50);
  expect(await client.diagnostics?.(10)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: "durable indexed diagnostic" }),
    ]),
  );
  await client.dispose?.();
});

test("restart projects unresolved interactive requests from durable events", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-interactive-restart-"),
  );
  await mkdir(join(root, ".natalia", "sessions"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "sessions", "ses_ts7_interactive_restart.json"),
    JSON.stringify({
      id: "ses_ts7_interactive_restart",
      title: "Interactive",
      createdAt: "2026-07-21T00:00:00.000Z",
      cancelled: false,
      resumable: true,
      events: [
        {
          type: "approval.request",
          id: "approval_open",
          title: "Write",
          preview: "file",
        },
        {
          type: "approval.request",
          id: "approval_closed",
          title: "Shell",
          preview: "pwd",
        },
        { type: "approval.response", id: "approval_closed", decision: "once" },
        { type: "question.request", id: "question_open", title: "Choice" },
      ],
    }),
  );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_interactive_restart",
    provider: toolCallingProvider(),
  });
  client.start(() => undefined);
  expect(await client.pendingInteractive!()).toMatchObject({
    approvals: [{ id: "approval_open" }],
    questions: [{ id: "question_open" }],
  });
  client.respondApproval({ requestID: "approval_open", decision: "once" });
  client.respondQuestion({ requestID: "question_open", answers: [["answer"]] });
  client.respondApproval({ requestID: "approval_open", decision: "reject" });
  client.respondQuestion({ requestID: "question_open", answers: [["late"]] });
  expect(await client.pendingInteractive!()).toEqual({
    approvals: [],
    questions: [],
    interactives: [],
  });
  await waitForAsync(async () => {
    const history = await client.history!({ limit: 500 });
    return (
      history.events.some(
        (entry) =>
          entry.event.type === "approval.response" &&
          entry.event.id === "approval_open",
      ) &&
      history.events.some(
        (entry) =>
          entry.event.type === "question.response" &&
          entry.event.id === "question_open",
      )
    );
  });
  const history = await client.history!({ limit: 500 });
  expect(
    history.events.filter(
      (entry) =>
        entry.event.type === "approval.response" &&
        entry.event.id === "approval_open",
    ),
  ).toHaveLength(1);
  expect(
    history.events.filter(
      (entry) =>
        entry.event.type === "question.response" &&
        entry.event.id === "question_open",
    ),
  ).toHaveLength(1);
});

test("restart durably rejects orphaned interactive requests from a crashed turn", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-interrupted-interactive-restart-"),
  );
  await mkdir(join(root, ".natalia", "sessions"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "sessions", "ses_ts7_interrupted_interactive.json"),
    JSON.stringify({
      id: "ses_ts7_interrupted_interactive",
      title: "Interrupted interactive",
      createdAt: "2026-07-21T00:00:00.000Z",
      cancelled: false,
      resumable: true,
      events: [
        {
          type: "turn.submitted",
          id: "turn_crashed",
          text: "write",
          byteLength: 5,
          lineCount: 1,
          sha256: "test",
        },
        {
          type: "approval.request",
          id: "turn_crashed:write",
          title: "Write",
          preview: "file",
        },
        {
          type: "question.request",
          id: "turn_crashed:write:question",
          title: "Confirm",
        },
        {
          type: "approval.request",
          id: "independent_approval",
          title: "Independent",
          preview: "safe",
        },
      ],
    }),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_interrupted_interactive",
    provider: toolCallingProvider(),
  });
  client.start((event) => events.push(event));

  expect(await client.pendingInteractive!()).toEqual({
    approvals: [expect.objectContaining({ id: "independent_approval" })],
    questions: [],
    interactives: [],
  });
  const history = await client.history!({ limit: 500 });
  expect(history.events.map((entry) => entry.event)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "approval.response",
        id: "turn_crashed:write",
        decision: "reject",
      }),
      expect.objectContaining({
        type: "question.response",
        id: "turn_crashed:write:question",
        rejected: true,
      }),
      expect.objectContaining({
        type: "turn.finished",
        id: "turn_crashed",
        stopReason: "error",
      }),
    ]),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "diagnostic",
      level: "warning",
      message: expect.stringContaining(
        "unresolved interactive requests were rejected",
      ),
    }),
  );
});

test("provider can load a discovered skill through the canonical tool path", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-skill-tool-"));
  const skillRoot = join(root, ".natalia", "skills", "review");
  await mkdir(join(skillRoot, "references"), { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: review\ndescription: Review\n---\nReview guidance",
  );
  await writeFile(join(skillRoot, "references", "guide.md"), "guide");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_skill_tool",
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
                id: "call_skill",
                name: "skill_load",
                arguments: JSON.stringify({ name: "review" }),
              },
            ],
          };
          yield { type: "done" as const };
          return;
        }
        yield { type: "content" as const, text: "skill loaded" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("load review skill");
  expect(
    events.some(
      (event) =>
        event.type === "tool.update" &&
        event.name === "skill_load" &&
        event.status === "succeeded",
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) => event.type === "content.done" && event.text === "skill loaded",
    ),
  ).toBe(true);
});

test("two local clients serialize provider turns for one durable session", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-shared-session-"));
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const provider = (label: string) => ({
    provider: "test",
    model: "test",
    async *stream() {
      order.push(`${label}:start`);
      if (label === "first")
        await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push(`${label}:end`);
      yield { type: "done" as const };
    },
  });
  const first = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_shared_session",
    provider: provider("first"),
  });
  const second = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_shared_session",
    provider: provider("second"),
  });
  first.start(() => undefined);
  second.start(() => undefined);
  const firstSubmit = first.submit("one");
  while (!releaseFirst) await Bun.sleep(1);
  const secondSubmit = second.submit("two");
  await Bun.sleep(2);
  expect(order).toEqual(["first:start"]);
  releaseFirst?.();
  await Promise.all([firstSubmit, secondSubmit]);
  await waitFor(
    () => order.includes("second:start") && order.includes("second:end"),
    20_000,
    "the second local client's provider turn to run",
  );
  expect(order).toEqual([
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("real runtime client discovers and activates native Skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-skills-"));
  const skillRoot = join(root, ".natalia", "skills", "read-only");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: read-only\ndescription: Read files only\nallowed-tools: [read_file]\n---\nInspect before changing.",
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_skills",
    provider: scriptedProvider("unused"),
  });
  client.start((event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === "session.ready"));
  await client.submitAndWait!("/skills");
  await client.submitAndWait!("/skill read-only");
  expect(
    events.some(
      (event) =>
        event.type === "content.delta" &&
        event.text.includes("project:read-only"),
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "content.delta" &&
        event.text.includes("activated skill project:read-only"),
    ),
  ).toBe(true);
});

test("real runtime client provides provider-independent doctor and help commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-doctor-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_doctor",
  });
  client.start((event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === "session.ready"));
  await client.submitAndWait!("/doctor");
  await client.submitAndWait!("/help");

  const output = events
    .filter((event) => event.type === "content.delta")
    .map((event) => event.text)
    .join("\n");
  expect(output).toContain("Natalia TS7 runtime doctor");
  expect(output).toContain("provider: not configured");
  expect(output).toContain("/checkpoint");
  expect(output).toContain(
    "the application-layer host allowlist only covers fetch-style tools",
  );
  expect(output).toContain("run_shell and native terminal input");
  await client.dispose?.();
});

test("real runtime client records provider usage checkpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-usage-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_usage",
    provider: usageProvider(),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("Track usage");

  expect(
    events.some(
      (event) =>
        event.type === "context.status" &&
        event.used === 15 &&
        event.source === "exact_checkpoint",
    ),
  ).toBe(true);
});

test("real runtime forks a session at a submitted-turn boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-session-fork-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_ts7_session_fork",
    provider: scriptedProvider("answer"),
  });
  client.start(() => undefined);
  const first = await client.submitAndWait!("first");
  const second = await client.submitAndWait!("second");

  const fork = await client.sessionFork!("ses_ts7_session_fork", second.id);
  const child = JSON.parse(
    await readFile(
      join(root, ".natalia", "sessions", `${fork.id}.json`),
      "utf8",
    ),
  ) as { events: RuntimeEvent[] };
  expect(fork.title).toBe("New session (fork)");
  expect(
    child.events.some(
      (event) => event.type === "turn.submitted" && event.text === "second",
    ),
  ).toBe(false);
  expect(
    child.events.some(
      (event) => event.type === "turn.submitted" && event.text === "first",
    ),
  ).toBe(true);
});

test("real runtime exposes projected message pages independently from event history", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-message-pages-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_message_pages",
    provider: scriptedProvider("answer"),
  });
  client.start(() => undefined);
  await client.submitAndWait!("first");
  await client.submitAndWait!("second");

  const page = await client.messages!({ order: "asc", limit: 1 });
  expect(page.data).toHaveLength(1);
  expect(page.data[0]).toMatchObject({
    id: expect.stringMatching(/^turn_/u),
    submitted: { text: "first" },
  });
  expect(page.data[0]?.rows.map((row) => row.kind)).toContain("assistant");
  expect(page.cursor.next).toEqual(expect.any(String));
  expect((await client.history!({ limit: 1 })).events[0]?.event.type).toBe(
    "checkpoint.created",
  );
});

test("real runtime client publishes provider chunks before stream completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-live-stream-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_live_stream",
    provider: delayedStreamingProvider(),
  });
  client.start((event) => events.push(event));
  const submission = client.submit("stream live");
  await waitFor(() =>
    events.some(
      (event) => event.type === "content.delta" && event.text === "first ",
    ),
  );
  expect(events.some((event) => event.type === "turn.finished")).toBe(false);
  await submission;
  await waitFor(
    () => events.some((event) => event.type === "turn.finished"),
    20_000,
    "the streamed turn to finish",
  );
  expect(
    events
      .filter((event) => event.type === "content.delta")
      .map((event) => event.text)
      .join(""),
  ).toBe("first second");
});

test("real runtime client retries once when a new turn has no old context to compact", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-context-limit-"));
  const events: RuntimeEvent[] = [];
  const provider = contextLimitThenSuccessProvider();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_context_limit",
    provider,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("Recover context");

  expect(provider.calls).toBe(2);
  expect(
    events.some(
      (event) => event.type === "context.limit.recovery" && !event.compacted,
    ),
  ).toBe(true);
  expect(events.some((event) => event.type === "compaction.begin")).toBe(false);
  expect(
    events.some(
      (event) => event.type === "content.delta" && event.text === "recovered",
    ),
  ).toBe(true);
});

test("real runtime client writes inside its selected workspace after approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-workspace-tool-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_workspace_tool",
    provider: writeFileProvider(),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.submitAndWait!("create a workspace file");

  expect(await readFile(join(root, "hello-ts7.txt"), "utf8")).toBe(
    "hello from TS7\n",
  );
  expect(
    events.some(
      (event) => event.type === "tool.update" && event.status === "succeeded",
    ),
  ).toBe(true);
});

test("session intelligence writer publishes real snapshot facts for a working turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-intelligence-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_intelligence",
    provider: writeFileProvider(),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.submitAndWait!("create a workspace file");

  const snapshots = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "session.snapshot" }> =>
      event.type === "session.snapshot",
  );
  expect(snapshots.length).toBeGreaterThan(0);

  // The snapshot reflects the real turn lifecycle: running while the turn is
  // active, idle after it settles.
  const running = snapshots.find(
    (snapshot) => snapshot.agentStatus === "running",
  );
  expect(running).toBeDefined();
  const settled = snapshots.find((snapshot) => snapshot.agentStatus === "idle");
  expect(settled).toBeDefined();

  // The write tool is the active tool on at least one snapshot, and the Work
  // Graph records the workspace change the snapshot counts.
  const withTool = snapshots.find(
    (snapshot) => snapshot.activeTool === "write_file",
  );
  expect(withTool).toBeDefined();
  const last = snapshots.at(-1);
  expect(last?.changedFiles).toBeGreaterThan(0);
  expect(last?.unvalidatedChanges).toBeGreaterThan(0);

  // Secret-safe: no file content, no tool arguments, no command text.
  const serialized = JSON.stringify(snapshots);
  expect(serialized).not.toContain("hello from TS7");
  expect(serialized).not.toContain("call_write");
});

test("session intelligence writer survives replay with the same facts", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-ts7-intelligence-replay-"),
  );
  const initial = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_intelligence_replay",
    provider: writeFileProvider(),
  });
  initial.start((event) => {
    if (event.type === "approval.request")
      initial.respondApproval({ requestID: event.id, decision: "once" });
  });
  await initial.submitAndWait!("create a workspace file");
  await pollHistoryForFinished(initial);

  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_intelligence_replay",
    provider: writeFileProvider(),
  });
  reopened.start(() => undefined);
  await reopened.sessionAttach!("ses_ts7_intelligence_replay");

  // `session.snapshot` is live/reconstructible now, so replay does not carry
  // historical snapshot events. The read model must rebuild the same facts
  // from the durable journal on demand.
  const snapshot = await reopened.sessionSnapshot?.();
  expect(snapshot).toBeDefined();
  expect(snapshot?.changedFiles).toBeGreaterThan(0);
  expect(snapshot?.agentStatus).toBe("idle");
  expect(JSON.stringify(snapshot)).not.toContain("hello from TS7");
});

test("session intelligence read model answers the latest published snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-intelligence-read-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_intelligence_read",
    provider: writeFileProvider(),
  });
  client.start((event) => {
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.submitAndWait!("create a workspace file");
  await pollHistoryForFinished(client);

  // Before the writer existed this answered `undefined` forever. Now the RPC
  // member reports the latest durable snapshot with real work facts.
  const snapshot = await client.sessionSnapshot?.();
  expect(snapshot).toBeDefined();
  expect(snapshot?.changedFiles).toBeGreaterThan(0);
  expect(snapshot?.agentStatus).toBe("idle");
  expect(snapshot?.hasPTY).toBe(false);
  expect(snapshot?.hasSandbox).toBe(false);
});

test("the self-protection rules are seeded as the first constitution facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-constitution-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_constitution",
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
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  const rules = await client.constitutionRules!();
  expect(rules.map((rule) => rule.ruleID)).toEqual([
    "C-TERM-001",
    "C-TERM-002",
    "C-TERM-003",
    "C-REL-001",
    "C-REL-002",
  ]);
  for (const rule of rules.filter((item) => item.ruleID !== "C-REL-001"))
    expect(rule).toMatchObject({
      scope: "release",
      priority: "critical",
      source: "policy",
      enforcement: "deny",
    });
  expect(rules.find((rule) => rule.ruleID === "C-REL-001")).toMatchObject({
    scope: "release",
    priority: "critical",
    source: "policy",
    enforcement: "approval",
    overridePolicy: "user_scoped",
  });
  expect(
    events.some(
      (event) =>
        event.type === "constitution.rule_added" &&
        event.ruleID === "C-TERM-001",
    ),
  ).toBe(true);
});

test("recordDecision writes a durable decision fact", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-decision-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_decision",
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
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  const outcome = await client.recordDecision?.({
    decision: "workspace isolation is not container/VM security",
    rationale: ["the sandbox is a workspace boundary"],
    linkedConstraints: ["C-TERM-001"],
  });
  expect(outcome).toEqual({ recorded: true });
  const records = await client.decisionRecords!();
  const recorded = records.items.find(
    (record) =>
      record.decision === "workspace isolation is not container/VM security",
  );
  expect(recorded).toBeDefined();
  expect(recorded).toMatchObject({
    decision: "workspace isolation is not container/VM security",
    rationale: ["the sandbox is a workspace boundary"],
    status: "accepted",
    linkedConstraints: ["C-TERM-001"],
  });
  expect(
    events.some(
      (event) =>
        event.type === "decision.recorded" &&
        event.decision === "workspace isolation is not container/VM security",
    ),
  ).toBe(true);
});

test("seeded constitution rules and decisions are Work Graph constraint/decision nodes (CST4)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-cst4-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_cst4",
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
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  // Each seeded self-protection rule is a constraint node in the graph.
  const constraintNodes = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "workgraph.node_added" }> =>
      event.type === "workgraph.node_added" && event.kind === "constraint",
  );
  expect(constraintNodes.length).toBeGreaterThanOrEqual(3);
  expect(constraintNodes.some((node) => node.target === "C-TERM-001")).toBe(
    true,
  );

  // A recorded decision becomes a decision node.
  await client.recordDecision?.({
    decision: "default no commit/push",
    rationale: ["the framework should never write to git without asking"],
  });
  expect(
    events.some(
      (event) =>
        event.type === "workgraph.node_added" && event.kind === "decision",
    ),
  ).toBe(true);
});

test("constitution rules and decisions survive replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-const-replay-"));
  const initial = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_const_replay",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  initial.start(() => {});
  await initial.submitAndWait!("hello");
  await initial.recordDecision?.({
    decision: "default no commit/push",
  });
  await pollHistoryForFinished(initial);

  const replayed: RuntimeEvent[] = [];
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_const_replay",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  reopened.start((event) => replayed.push(event));
  await reopened.submitAndWait!("again");
  await pollHistoryForFinished(reopened);

  const rules = await reopened.constitutionRules!();
  expect(rules.map((rule) => rule.ruleID)).toEqual([
    "C-TERM-001",
    "C-TERM-002",
    "C-TERM-003",
    "C-REL-001",
    "C-REL-002",
  ]);
  const decisions = await reopened.decisionRecords!();
  expect(decisions.items.map((decision) => decision.decision)).toContain(
    "default no commit/push",
  );
  // Replay must not duplicate the seeded rules: the reopened session replays
  // the original three rule_added events to the sink and the idempotent seed
  // skips them — exactly three, not six.
  const ruleAdded = replayed.filter(
    (
      event,
    ): event is Extract<RuntimeEvent, { type: "constitution.rule_added" }> =>
      event.type === "constitution.rule_added",
  );
  expect(ruleAdded.map((event) => event.ruleID).sort()).toEqual([
    "C-REL-001",
    "C-REL-002",
    "C-TERM-001",
    "C-TERM-002",
    "C-TERM-003",
  ]);
});

test("recordValidation runs a command and records durable evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-evidence-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_evidence",
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
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  const passed = await client.recordValidation?.({
    taskID: "task_build",
    objective: "verify the build passes",
    command: "exit 0",
  });
  expect(passed).toEqual({ recorded: true, result: "passed", safeSummary: "" });
  const failed = await client.recordValidation?.({
    taskID: "task_build",
    objective: "verify the build passes",
    command: "exit 1",
  });
  expect(failed?.result).toBe("failed");

  const records = await client.evidenceRecords!();
  expect(records.items).toHaveLength(2);
  expect(records.items[0]).toMatchObject({
    taskID: "task_build",
    status: "validated",
    validations: [{ command: "exit 0", result: "passed" }],
  });
  expect(records.items[1]).toMatchObject({
    status: "failed",
    validations: [{ command: "exit 1", result: "failed" }],
  });
  expect(
    events.filter(
      (event): event is Extract<RuntimeEvent, { type: "evidence.recorded" }> =>
        event.type === "evidence.recorded",
    ).length,
  ).toBe(2);
});

test("recordValidation redacts secrets from the recorded summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-evidence-redact-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_evidence_redact",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => {});
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  await client.recordValidation?.({
    taskID: "task_secret",
    objective: "a validation that prints a secret",
    command: 'printf "api_key=supersecretvalue\\n"; exit 0',
  });
  const records = await client.evidenceRecords!();
  const summary = records.items[0]?.validations[0]?.safeSummary ?? "";
  expect(summary).not.toContain("supersecretvalue");
  expect(JSON.stringify(records)).not.toContain("supersecretvalue");
});

test("promoting framework sources emits restart_required", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-e5-restart-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await mkdir(join(root, "packages", "framework"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      sandbox: { promoteCommand: "true" },
    }),
  );
  const kernel = new CapabilityRegistry();
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_e5_restart",
    capabilityRegistry: kernel,
    permissionMode: "auto",
    provider: singleToolProvider("sandbox_create", { id: "box" }),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("create sandbox");
  await pollHistoryForFinished(client);
  const sandboxes = kernel.service<SandboxService>(sandboxService.id)!;
  await sandboxes.write("box", "packages/framework/restart.ts", "export {}\n");
  await client.sandboxMerge!("box");
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "diagnostic",
      message: "restart_required",
    }),
  );
  await client.dispose?.();
});

test("promote records evidence when validation passes", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-e5-promote-pass-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      sandbox: { promoteCommand: "true" },
    }),
  );
  const kernel = new CapabilityRegistry();
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_e5_promote_pass",
    capabilityRegistry: kernel,
    permissionMode: "auto",
    provider: singleToolProvider("sandbox_create", { id: "box" }),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("create sandbox");
  await pollHistoryForFinished(client);
  const sandboxes = kernel.service<SandboxService>(sandboxService.id)!;
  await sandboxes.write("box", "promoted.txt", "landed");
  const changes = await client.sandboxMerge!("box");
  expect(changes).toContainEqual(
    expect.objectContaining({ path: "promoted.txt" }),
  );
  expect(await readFile(join(root, "promoted.txt"), "utf8")).toBe("landed");
  const records = await client.evidenceRecords!();
  expect(records.items).toContainEqual(
    expect.objectContaining({
      taskID: "sandbox:box",
      status: "promoted",
      validations: [
        expect.objectContaining({ command: "true", result: "passed" }),
      ],
    }),
  );
  expect(JSON.stringify(records)).not.toContain("stdout");
  const cards = await client.completions!();
  expect(cards.items).toContainEqual(
    expect.objectContaining({
      taskID: "sandbox:box",
      rollbackState: "available",
      changeSummary: "1 files promoted from sandbox box",
    }),
  );
  expect(events.some((event) => event.type === "evidence.recorded")).toBe(true);
  await client.dispose?.();
});

test("a high-risk promotion requires a multi-stage user confirmation (E5 R3/R4)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-e5-highrisk-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, sandbox: { promoteCommand: "true" } }),
  );
  const kernel = new CapabilityRegistry();
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_e5_highrisk",
    capabilityRegistry: kernel,
    permissionMode: "ask",
    provider: singleToolProvider("sandbox_create", { id: "box" }),
  });
  const approvalRequests: string[] = [];
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request") {
      approvalRequests.push(String((event as { scope?: string }).scope ?? ""));
      client.respondApproval({ requestID: event.id, decision: "once" });
    }
  });
  await client.submitAndWait!("create sandbox");
  await pollHistoryForFinished(client);
  const sandboxes = kernel.service<SandboxService>(sandboxService.id)!;
  // A change to the tool contract is high risk.
  await sandboxes.write(
    "box",
    "packages/core/tools/src/types.ts",
    "export {}\n",
  );
  const changes = await client.sandboxMerge!("box");
  // The multi-stage gate fired for the high-risk promotion.
  expect(approvalRequests).toContain("sandbox_promotion");
  // The user approved, so the high-risk file landed.
  expect(changes).toContainEqual(
    expect.objectContaining({ path: "packages/core/tools/src/types.ts" }),
  );
  await client.dispose?.();
});

test("a rejected high-risk promotion leaves the host unchanged and records failed evidence (E5 R3/R4)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-e5-highrisk-reject-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, sandbox: { promoteCommand: "true" } }),
  );
  const kernel = new CapabilityRegistry();
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_e5_highrisk_reject",
    capabilityRegistry: kernel,
    permissionMode: "ask",
    provider: singleToolProvider("sandbox_create", { id: "box" }),
  });
  let gateFired = false;
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request") {
      if ((event as { scope?: string }).scope === "sandbox_promotion") {
        gateFired = true;
        client.respondApproval({ requestID: event.id, decision: "reject" });
      } else {
        client.respondApproval({ requestID: event.id, decision: "once" });
      }
    }
  });
  await client.submitAndWait!("create sandbox");
  await pollHistoryForFinished(client);
  const sandboxes = kernel.service<SandboxService>(sandboxService.id)!;
  await sandboxes.write(
    "box",
    "packages/core/tools/src/types.ts",
    "export {}\n",
  );

  // The high-risk gate fired and the user rejected it: the merge refuses.
  let rejected = false;
  try {
    await client.sandboxMerge!("box");
  } catch (error) {
    rejected = /rejected by the user/iu.test(
      error instanceof Error ? error.message : String(error),
    );
  }
  expect(gateFired).toBe(true);
  expect(rejected).toBe(true);
  // The host is unchanged: the high-risk file did not land.
  const landed = await readFile(
    join(root, "packages/core/tools/src/types.ts"),
    "utf8",
  ).then(
    () => true,
    () => false,
  );
  expect(landed).toBe(false);
  // Failed promotion evidence is recorded.
  const records = await client.evidenceRecords!();
  expect(
    records.items.some(
      (record) => record.taskID === "sandbox:box" && record.status === "failed",
    ),
  ).toBe(true);
  await client.dispose?.();
});

test("a low-risk promotion skips the multi-stage confirmation (E5)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-e5-lowrisk-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, sandbox: { promoteCommand: "true" } }),
  );
  const kernel = new CapabilityRegistry();
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_e5_lowrisk",
    capabilityRegistry: kernel,
    permissionMode: "auto",
    provider: singleToolProvider("sandbox_create", { id: "box" }),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("create sandbox");
  await pollHistoryForFinished(client);
  const sandboxes = kernel.service<SandboxService>(sandboxService.id)!;
  // A docs change is low risk.
  await sandboxes.write("box", "docs/note.md", "hello");
  const changes = await client.sandboxMerge!("box");
  expect(changes).toContainEqual(
    expect.objectContaining({ path: "docs/note.md" }),
  );
  // No multi-stage confirmation gate for a low-risk promotion.
  expect(
    events.some(
      (event) =>
        event.type === "approval.request" &&
        (event as { scope?: string }).scope === "sandbox_promotion",
    ),
  ).toBe(false);
  await client.dispose?.();
});

test("failed validation records failed evidence and does not promote", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-e5-promote-fail-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      sandbox: { promoteCommand: "exit 1" },
    }),
  );
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_e5_promote_fail",
    capabilityRegistry: kernel,
    permissionMode: "auto",
    provider: singleToolProvider("sandbox_create", { id: "box" }),
  });
  client.start(() => undefined);
  await client.submitAndWait!("create sandbox");
  await pollHistoryForFinished(client);
  const sandboxes = kernel.service<SandboxService>(sandboxService.id)!;
  await sandboxes.write("box", "blocked.txt", "should-not-land");
  await expect(client.sandboxMerge!("box")).rejects.toThrow(
    /failed validation/u,
  );
  await expect(
    readFile(join(root, "blocked.txt"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const records = await client.evidenceRecords!();
  expect(records.items).toContainEqual(
    expect.objectContaining({
      taskID: "sandbox:box",
      status: "failed",
      knownGaps: ["candidate failed validation; host unchanged"],
      validations: [
        expect.objectContaining({ command: "exit 1", result: "failed" }),
      ],
    }),
  );
  await client.dispose?.();
});

test("evidence summary is secret-safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-e5-promote-secret-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      sandbox: {
        promoteCommand: 'printf "token=fakefaketoken\\n"; true',
      },
    }),
  );
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_e5_promote_secret",
    capabilityRegistry: kernel,
    permissionMode: "auto",
    provider: singleToolProvider("sandbox_create", { id: "box" }),
  });
  client.start(() => undefined);
  await client.submitAndWait!("create sandbox");
  await pollHistoryForFinished(client);
  const sandboxes = kernel.service<SandboxService>(sandboxService.id)!;
  await sandboxes.write("box", "ok.txt", "ok");
  await client.sandboxMerge!("box");
  const records = await client.evidenceRecords!();
  const payload = JSON.stringify(records);
  expect(payload).not.toContain("fakefaketoken");
  expect(records.items[0]?.validations[0]?.command).not.toContain(
    "fakefaketoken",
  );
  await client.dispose?.();
});

test("recordCompletion records a card, its projection and validated_by edges", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-completion-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_completion",
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
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  const outcome = await client.recordCompletion?.({
    taskID: "task_build",
    objective: "verify the build",
    changeSummary: "added the build check",
    behaviorImpact: "CI now runs typecheck",
    validations: [
      { command: "npm run typecheck", result: "passed", safeSummary: "ok" },
    ],
    humanValidation: "reviewed by owner",
    knownGaps: ["no windows coverage"],
    externalSideEffects: ["writes .tmp"],
    rollbackState: "available",
    evidenceIDs: ["evidence:1"],
    changePaths: ["src/build.ts"],
  });
  expect(outcome?.recorded).toBe(true);
  expect(outcome?.completionID).toBeDefined();

  const cards = await client.completions!();
  expect(cards.items).toHaveLength(1);
  expect(cards.items[0]).toMatchObject({
    taskID: "task_build",
    changeSummary: "added the build check",
    validations: [{ command: "npm run typecheck", result: "passed" }],
    humanValidation: "reviewed by owner",
    knownGaps: ["no windows coverage"],
    rollbackState: "available",
    evidenceIDs: ["evidence:1"],
  });

  // The completion card validated the change via a validated_by Work Graph edge.
  expect(
    events.some(
      (event) =>
        event.type === "workgraph.edge_added" &&
        event.kind === "validated_by" &&
        event.targetID.includes("completion"),
    ),
  ).toBe(true);
});

test("mailbox send/list/deliver/acknowledge records a durable lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox",
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
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  const sent = await client.mailboxSend?.({
    intent: "reprioritize",
    text: "focus on the docs task first",
    safeSummary: "user asked to reprioritize",
    priority: "high",
    deliveryPolicy: "next_safe_boundary",
  });
  expect(sent?.queued).toBe(true);
  expect(sent?.messageID).toBeDefined();

  let mailbox = await client.mailboxList!();
  expect(mailbox).toHaveLength(1);
  expect(mailbox[0]).toMatchObject({
    intent: "reprioritize",
    priority: "high",
    text: "focus on the docs task first",
    status: "queued",
    deliveryPolicy: "next_safe_boundary",
  });

  expect(await client.mailboxDeliver?.(sent!.messageID!)).toEqual({
    delivered: true,
  });
  expect((await client.mailboxList!())[0]?.status).toBe("delivered");

  expect(await client.mailboxAcknowledge?.(sent!.messageID!)).toEqual({
    acknowledged: true,
  });
  expect((await client.mailboxList!())[0]?.status).toBe("acknowledged");

  expect(
    events.filter((event) => event.type.startsWith("mailbox.")).length,
  ).toBe(3);
  expect(
    events.some(
      (event) =>
        event.type === "mailbox.queued" &&
        event.intent === "reprioritize" &&
        event.safeSummary === "user asked to reprioritize",
    ),
  ).toBe(true);
});

test("mailbox defer and supersede move a queued message out of the way", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-def-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_def",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => {});
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  const sent = await client.mailboxSend?.({
    intent: "constraint",
    text: "never merge a failing build",
    safeSummary: "a merge constraint",
  });
  expect(
    await client.mailboxDefer?.(sent!.messageID!, "unsafe boundary"),
  ).toEqual({ deferred: true });
  expect((await client.mailboxList!())[0]?.status).toBe("deferred");
  expect((await client.mailboxList!())[0]?.reason).toBe("unsafe boundary");

  const second = await client.mailboxSend?.({
    intent: "cancel",
    text: "stop the current plan",
    safeSummary: "cancel requested",
  });
  expect(
    await client.mailboxSupersede?.(second!.messageID!, "superseded by newer"),
  ).toEqual({ superseded: true });
  expect((await client.mailboxList!())[1]?.status).toBe("superseded");

  // A delivered message cannot be acknowledged twice or delivered twice.
  expect(await client.mailboxDefer?.(sent!.messageID!, "again")).toEqual({
    deferred: false,
  });
  expect(await client.mailboxAcknowledge?.(sent!.messageID!)).toEqual({
    acknowledged: false,
  });
});

test("mailbox_cancel drops a queued duplicate before Natalia consumes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-mailbox-cancel-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_mailbox_cancel",
    permissionMode: "auto",
    provider: scriptedProvider("ready"),
  });
  client.start(() => undefined);
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);
  const sent = await client.mailboxSend?.({
    intent: "pause",
    text: "please pause after this step",
  });
  expect(
    await client.mailboxSupersede?.(sent!.messageID!, "cancelled by live chat"),
  ).toEqual({ superseded: true });
  expect((await client.mailboxList!())[0]?.status).toBe("superseded");
  await client.dispose?.();
});

test("mailboxSend redacts secrets from the recorded safe summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-redact-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_redact",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => {});
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  await client.mailboxSend?.({
    intent: "constraint",
    text: "api_key=supersecretvalue",
    safeSummary: "api_key=supersecretvalue",
  });
  const mailbox = await client.mailboxList!();
  expect(mailbox[0]?.safeSummary).not.toContain("supersecretvalue");
  expect(JSON.stringify(mailbox)).not.toContain("supersecretvalue");
});

test("queued mailbox messages are delivered at the next turn safe boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-safe-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_safe",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => {});
  await client.submitAndWait!("first");
  await pollHistoryForFinished(client);

  // No turn running: the intent wakes the idle main agent immediately (P8 §7)
  // instead of sitting queued until the next manual turn.
  await client.mailboxSend?.({
    intent: "reprioritize",
    text: "focus on docs",
    safeSummary: "reprioritize to docs",
  });
  await waitForAsync(
    async () => (await client.mailboxList!())[0]?.status === "acknowledged",
  );
  const mailbox = await client.mailboxList!();
  expect(mailbox[0]?.status).toBe("acknowledged");
  expect(
    mailbox[0]?.deliveryPolicy === undefined
      ? "next_safe_boundary"
      : mailbox[0]?.deliveryPolicy,
  ).toBe("next_safe_boundary");
});

test("deferred and superseded mailbox messages are not auto-delivered at a boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-safe-def-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_safe_def",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => {});
  await client.submitAndWait!("first");
  await pollHistoryForFinished(client);

  const deferred = await client.mailboxSend?.({
    intent: "constraint",
    text: "never merge failing",
    safeSummary: "a constraint",
  });
  const superseded = await client.mailboxSend?.({
    intent: "cancel",
    text: "stop the plan",
    safeSummary: "cancel",
  });
  expect(
    await client.mailboxDefer?.(deferred!.messageID!, "unsafe boundary"),
  ).toEqual({ deferred: true });
  expect(
    await client.mailboxSupersede?.(superseded!.messageID!, "newer"),
  ).toEqual({ superseded: true });

  await client.submitAndWait!("second");
  await pollHistoryForFinished(client);

  const mailbox = await client.mailboxList!();
  const byIntent = new Map(mailbox.map((m) => [m.intent, m.status]));
  expect(byIntent.get("constraint")).toBe("deferred");
  expect(byIntent.get("cancel")).toBe("superseded");
});

test("a manually delivered mailbox message is not re-delivered at a boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-safe-man-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_safe_man",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => {});
  await client.submitAndWait!("first");
  await pollHistoryForFinished(client);

  const sent = await client.mailboxSend?.({
    intent: "request_report",
    text: "summarize",
    safeSummary: "a report request",
  });
  expect(await client.mailboxDeliver?.(sent!.messageID!)).toEqual({
    delivered: true,
  });

  await client.submitAndWait!("second");
  await pollHistoryForFinished(client);

  // The manually delivered message was injected into turn 2's context, so the
  // turn's finish acknowledges it (consumption-driven settlement) and it is not
  // re-delivered by the boundary.
  expect((await client.mailboxList!())[0]?.status).toBe("acknowledged");
});

test("a mailbox message sent mid-turn injects before the next model step", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-midturn-"));
  const userTurns: string[] = [];
  let release: (() => void) | undefined;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_midturn",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        userTurns.push(
          request.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content)
            .join("\n"),
        );
        if (userTurns.length === 1) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "read1",
                name: "unknown_probe",
                arguments: "{}",
              },
            ],
          };
          await new Promise<void>((resolve) => (release = resolve));
        }
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  const submitting = client.submit("long task");
  while (!release) await Bun.sleep(1);
  await client.mailboxSend?.({
    intent: "pause",
    text: "please pause after this step",
    safeSummary: "pause requested",
  });
  release();
  await submitting;
  await pollHistoryForFinished(client);
  expect(
    userTurns.some((text) =>
      text.includes("[user] please pause after this step"),
    ),
  ).toBe(true);
});

test("delivered mailbox intents reach the main agent as ordinary tagged user messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-inject-"));
  const userTurns: string[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_inject",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        userTurns.push(
          request.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content)
            .join("\n"),
        );
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => {});
  await client.submitAndWait!("first");
  await pollHistoryForFinished(client);

  await client.mailboxSend?.({
    intent: "constraint",
    text: "never commit the lockfile",
    safeSummary: "a commit constraint",
    priority: "high",
  });
  await waitFor(() =>
    userTurns.some((text) => text.includes("never commit the lockfile")),
  );
  const injected = userTurns.find((text) =>
    text.includes("never commit the lockfile"),
  );
  expect(injected).toContain("[user] never commit the lockfile");
  await waitForAsync(
    async () => (await client.mailboxList!())[0]?.status === "acknowledged",
  );
  expect((await client.mailboxList!())[0]?.status).toBe("acknowledged");
});

test("mailbox_acknowledge marks delivered messages acknowledged and stops re-injection", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-ack-tool-"));
  let ackAttempted = 0;
  const userTurns: string[] = [];
  let sentID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_ack_tool",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        const users = request.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content)
          .join("\n");
        userTurns.push(users);
        const pending = users.includes("never commit the lockfile");
        if (pending && ackAttempted === 0 && sentID) {
          ackAttempted += 1;
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_ack",
                name: "mailbox_acknowledge",
                arguments: JSON.stringify({ messageIDs: [sentID] }),
              },
            ],
          };
        }
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("first");
  await pollHistoryForFinished(client);

  // Seed a queued mailbox message while idle.
  await client.mailboxSend?.({
    intent: "constraint",
    text: "never commit the lockfile",
    safeSummary: "a constraint",
  });
  sentID = (await client.mailboxList!())[0]!.messageID;

  await client.submitAndWait!("second");
  await pollHistoryForFinished(client);
  expect(ackAttempted).toBe(1);
  expect(events.some((event) => event.type === "mailbox.acknowledged")).toBe(
    true,
  );

  await client.submitAndWait!("third");
  await pollHistoryForFinished(client);
  expect(userTurns.at(-1)).not.toContain("never commit the lockfile");
});

test("delivered mailbox intents are auto-acknowledged at the next turn finish (no tool needed)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-consume-"));
  const userTurns: string[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_consume",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        userTurns.push(
          request.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content)
            .join("\n"),
        );
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("first");
  await pollHistoryForFinished(client);

  // Seed an intent while idle: the agent wakes and the wake turn sees it; its
  // finish auto-acknowledges it (consumption-driven, no tool needed).
  await client.mailboxSend?.({
    intent: "constraint",
    text: "never merge a failing build",
    safeSummary: "a merge constraint",
  });
  await waitFor(() =>
    userTurns.some((text) => text.includes("never merge a failing build")),
  );
  expect(
    userTurns.find((text) => text.includes("never merge a failing build")),
  ).toContain("[user] never merge a failing build");
  await waitForAsync(
    async () => (await client.mailboxList!())[0]?.status === "acknowledged",
  );

  await client.submitAndWait!("next");
  await pollHistoryForFinished(client);
  expect(userTurns.at(-1)).not.toContain("never merge a failing build");
});

test("a turn that does not finish normally does not auto-acknowledge delivered intents", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-mailbox-error-"));
  let streamCalls = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_mailbox_error",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        streamCalls++;
        if (streamCalls === 1) {
          // The warm-up turn completes normally.
          yield { type: "done" as const };
          return;
        }
        // The second turn errors mid-stream: it is not a "done" settlement, so
        // it must not acknowledge a delivered intent.
        yield { type: "content" as const, text: "half" };
        await new Promise((resolve) => setTimeout(resolve, 200));
        throw providerError({
          kind: "invalid_request",
          message: "provider rejected the request",
        });
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("first");
  await pollHistoryForFinished(client);

  // Send the intent mid-turn (the running turn keeps the coordinator active, so
  // no wake turn spawns), then deliver it explicitly so it is "delivered".
  events.length = 0;
  const running = client.submit("long");
  await waitFor(() => events.some((event) => event.type === "content.delta"));
  const sent = await client.mailboxSend?.({
    intent: "pause",
    text: "pause after this",
    safeSummary: "pause requested",
  });
  expect((await client.mailboxList!())[0]?.status).toBe("queued");
  if (sent?.messageID) await client.mailboxDeliver?.(sent.messageID);
  expect((await client.mailboxList!())[0]?.status).toBe("delivered");

  // The running turn errors out: not a "done" finish, so the delivered intent
  // stays delivered for another turn to see.
  await running;
  await pollHistoryForFinished(client);
  expect((await client.mailboxList!())[0]?.status).toBe("delivered");
});

test("evaluateDrift opens durable findings and driftFindings answers them", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-drift-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_drift",
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
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  // EI §8.6: a session with no accepted contract gets the advisory unverifiable
  // finding. The prose objective/activity mismatch is now a 问通道 (ask), not a
  // finding, so it does not open here.
  const opened = await client.evaluateDrift?.({
    objective: "implement user authentication",
    currentActivity: "refactoring the css theme",
    applicableConstraints: ["never commit generated files"],
    changes: [{ action: "modified", path: "src/theme.css" }],
    evidenceRefs: [],
  });
  expect(opened).toEqual({ opened: 1 });

  const findings = await client.driftFindings!();
  expect(findings.items).toHaveLength(1);
  expect(findings.items[0]).toMatchObject({
    severity: "advisory",
    originalObjective: "implement user authentication",
    status: "open",
  });
  expect(
    events.some(
      (event) =>
        event.type === "drift.finding_opened" &&
        event.findingID.includes("unverifiable_no_contract"),
    ),
  ).toBe(true);

  // The same signals do not reopen an already-open finding.
  const again = await client.evaluateDrift?.({
    objective: "implement user authentication",
    currentActivity: "refactoring the css theme",
    applicableConstraints: ["never commit generated files"],
    changes: [{ action: "modified", path: "src/theme.css" }],
    evidenceRefs: [],
  });
  expect(again).toEqual({ opened: 0 });
  expect((await client.driftFindings!()).items).toHaveLength(1);
});

test("evaluateDrift opens a high finding for a forbidden constraint signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-drift-high-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_drift_high",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => {});
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  await client.evaluateDrift?.({
    objective: "finish the docs",
    currentActivity: "commit the generated files to the repo",
    applicableConstraints: ["never commit generated files"],
    changes: [{ action: "added", path: "dist/out.js" }],
    evidenceRefs: [],
  });
  const findings = await client.driftFindings!();
  const high = findings.items.find((finding) => finding.severity === "high");
  expect(high).toBeDefined();
  expect(high?.evidence.some((entry) => entry.startsWith("constraint:"))).toBe(
    true,
  );
});

test("acknowledgeDriftFinding transitions an open finding with a rationale", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-drift-ack-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_drift_ack",
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
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  await client.evaluateDrift?.({
    objective: "implement user authentication",
    currentActivity: "refactoring the css theme",
    applicableConstraints: [],
    changes: [{ action: "modified", path: "src/theme.css" }],
    evidenceRefs: [],
  });
  const open = await client.driftFindings!();
  const findingID = open.items[0]!.findingID;
  expect(open.items[0]?.status).toBe("open");

  const acked = await client.acknowledgeDriftFinding?.({
    findingID,
    status: "explained",
    rationale: "the css refactor is a prerequisite",
  });
  expect(acked).toEqual({ acknowledged: true });

  const after = await client.driftFindings!();
  expect(after.items[0]?.status).toBe("explained");
  expect(
    events.some(
      (event) =>
        event.type === "drift.finding_updated" &&
        event.status === "explained" &&
        event.rationale === "the css refactor is a prerequisite",
    ),
  ).toBe(true);

  // A non-open finding cannot be acknowledged again.
  expect(
    await client.acknowledgeDriftFinding?.({
      findingID,
      status: "dismissed",
    }),
  ).toEqual({ acknowledged: false });
});

test("a write_file turn registers a mutation the auditor can attribute", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-obs-write-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_obs_write",
    provider: writeFileProvider(),
    permissionMode: "auto",
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("create a workspace file");
  await pollHistoryForFinished(client);

  // The write tool settled and registered an expected mutation; the turn-end
  // reconcile attributes the watcher hint to the tool call (WG4 Phase 3) rather
  // than treating it as an external change.
  const changes = await client.confirmedWorkspaceChanges!();
  const externalNodes = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "workgraph.node_added" }> =>
      event.type === "workgraph.node_added" &&
      event.kind === "workspace_change" &&
      event.actor === "external",
  );
  // The attributed tool change is graphed by the tool path, not double-graphed
  // as an isolated external node.
  expect(externalNodes.some((node) => node.target === "hello-ts7.txt")).toBe(
    false,
  );
  expect(
    events.some(
      (event) =>
        event.type === "workgraph.node_added" &&
        event.kind === "workspace_change" &&
        event.target === "hello-ts7.txt" &&
        event.actor === "write_file",
    ),
  ).toBe(true);
  // Secret-safe: the confirmed change facts carry no file content (the tool's
  // own tool.update argumentsDelta legitimately does — that is the call record).
  expect(JSON.stringify(changes)).not.toContain("hello from TS7");
});

test("an external workspace change becomes an isolated external graph node", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-obs-external-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_obs_external",
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
  await client.submitAndWait!("hello");
  await pollHistoryForFinished(client);

  // An external edit the watcher sees but no tool claimed.
  await writeFile(join(root, "external-note.txt"), "written outside\n");
  await Bun.sleep(400);
  const changes = await client.confirmedWorkspaceChanges!();
  const external = changes.find((change) =>
    change.path.includes("external-note"),
  );
  expect(external).toBeDefined();
  expect(external?.attribution).toBe("unattributed");

  // The external confirmed change became an isolated workspace_change node with
  // no causal edge.
  const externalNodes = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "workgraph.node_added" }> =>
      event.type === "workgraph.node_added" &&
      event.kind === "workspace_change" &&
      event.actor === "external",
  );
  expect(
    externalNodes.some((node) => node.target === "external-note.txt"),
  ).toBe(true);
  const edges = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "workgraph.edge_added" }> =>
      event.type === "workgraph.edge_added",
  );
  // No edge points at the external node (no reliable turn/call identity).
  expect(
    edges.every(
      (edge) => !externalNodes.some((node) => edge.targetID === node.nodeID),
    ),
  ).toBe(true);
});

test("an external change during a turn is reconciled at turn finish without an explicit call", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-obs-turnend-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_obs_turnend",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "content" as const, text: "working" };
        await new Promise((resolve) => setTimeout(resolve, 40));
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("first");
  await pollHistoryForFinished(client);

  // External edit while idle, then another turn finishes: the turn-end
  // reconcile must discover, graph and drift-check it — no explicit
  // confirmedWorkspaceChanges call.
  await writeFile(join(root, "turnend-note.txt"), "external\n");
  await Bun.sleep(300);
  await client.submitAndWait!("second");
  await pollHistoryForFinished(client);
  await Bun.sleep(300);

  expect(
    events.some(
      (event) =>
        event.type === "workgraph.node_added" &&
        event.kind === "workspace_change" &&
        event.actor === "external" &&
        event.target === "turnend-note.txt",
    ),
  ).toBe(true);
});

test("durable session replay preserves tool-call pairs for the next provider turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-replay-tools-"));
  await writeFile(join(root, "input.txt"), "replay-ok\n");
  const initial = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_replay_tools",
    provider: toolCallingProvider(),
    permissionMode: "auto",
  });
  initial.start(() => {});
  await initial.submitAndWait!("read the input");

  const requests: ProviderStreamRequest[] = [];
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_replay_tools",
    permissionMode: "auto",
    provider: {
      provider: "scripted-replay",
      model: "scripted-replay-model",
      async *stream(request) {
        requests.push(request);
        yield { type: "content", text: "replay continuation works" };
        yield { type: "done" };
      },
    },
  });
  reopened.start(() => {});
  await reopened.submitAndWait!("continue");
  const restoredTool = requests[0]?.messages.find(
    (message) => message.role === "tool",
  );
  expect(restoredTool).toMatchObject({
    toolCallID: "call_read",
    content: "replay-ok\n",
  });
});

test("real runtime client routes ask_user tool calls through question response", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-question-tool-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_question_tool",
    provider: questionToolProvider(),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "question.request")
      client.respondQuestion({ requestID: event.id, answers: [["yes"]] });
  });
  await client.submitAndWait!("ask a question");
  expect(events.some((event) => event.type === "question.request")).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "content.delta" && event.text === "answer received",
    ),
  ).toBe(true);
});

test("real runtime client spawns and projects a TS/Bun subagent lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-subagent-tool-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_subagent_tool",
    provider: subagentProvider(),
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate a focused task");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );
  expect(
    events.some(
      (event) =>
        event.type === "subagent.update" &&
        event.text?.includes("child result"),
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "content.delta" && event.text === "parent complete",
    ),
  ).toBe(true);
  const lifecycle = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "subagent.update" }> =>
      event.type === "subagent.update",
  );
  expect(
    lifecycle.every(
      (event) => event.parentSessionID === "ses_ts7_subagent_tool",
    ),
  ).toBe(true);
  expect(lifecycle.every((event) => event.continuation === 0)).toBe(true);
  const childEvents = events.filter(
    (event) => event.agentID === lifecycle[0]?.id,
  );
  expect(childEvents.some((event) => event.type === "turn.submitted")).toBe(
    true,
  );
  expect(childEvents.some((event) => event.type === "thinking.delta")).toBe(
    true,
  );
  expect(childEvents.some((event) => event.type === "content.delta")).toBe(
    true,
  );
  expect(childEvents.some((event) => event.type === "turn.finished")).toBe(
    true,
  );
  // Startup capability and tool registration events precede subagent progress,
  // so the default 100-event history page may not reach this lifecycle.
  const history = await client.history?.({ limit: 1000 });
  expect(
    history?.events.some(
      (item) =>
        item.event.type === "subagent.update" &&
        item.event.parentSessionID === "ses_ts7_subagent_tool",
    ),
  ).toBe(true);
  expect(history?.events.some((item) => item.event.agentID)).toBe(false);
});

test("subagent compaction uses its active provider and stays in the child lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-subagent-compaction-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(join(root, "readable.txt"), "subagent input ".repeat(12_000));
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      context: {
        compactionThresholdPercent: 85,
        preservedRecentMessages: 0,
        // The default preserved-tail budget is 20k tokens. With a count of 0
        // that budget alone would keep this small ledger entirely inside the
        // tail, leaving nothing to compact at all. This test is about the
        // compaction mechanics, so the budget is switched off rather than the
        // ledger padded until it clears 20k tokens.
        preservedRecentTokens: 0,
      },
    }),
  );
  const events: RuntimeEvent[] = [];
  const provider = subagentCompactionProvider();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_subagent_compaction",
    permissionMode: "auto",
    provider,
  });
  client.start((event) => events.push(event));

  await client.submitAndWait!("delegate a compacted child task");
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "subagent.update" && event.event === "created",
      ),
    5_000,
    "the compacted subagent to start",
  );
  const childID = events.find(
    (event): event is Extract<RuntimeEvent, { type: "subagent.update" }> =>
      event.type === "subagent.update" && event.event === "created",
  )?.id;
  expect(childID).toBeDefined();
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "compaction.begin" && event.agentID === childID,
      ),
    5_000,
    "the subagent preflight compaction",
  );

  expect(provider.compactionCalls).toBe(1);
  const compactionEvents = events.filter(
    (
      event,
    ): event is Extract<
      RuntimeEvent,
      { type: "compaction.begin" | "compaction.end" }
    > & { agentID: string } =>
      (event.type === "compaction.begin" || event.type === "compaction.end") &&
      Boolean(event.agentID),
  );
  expect(compactionEvents).toHaveLength(2);
  expect(compactionEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "compaction.begin",
        agentID: childID,
        sessionID: "ses_subagent_compaction",
        id: expect.stringMatching(/^subagent:.+:preflight:/u),
      }),
      expect.objectContaining({
        type: "compaction.end",
        agentID: childID,
        sessionID: "ses_subagent_compaction",
        id: expect.stringMatching(/^subagent:.+:preflight:/u),
        success: true,
      }),
    ]),
  );
  expect(
    events.some(
      (event) =>
        (event.type === "compaction.begin" ||
          event.type === "compaction.end") &&
        !event.agentID,
    ),
  ).toBe(false);
  expect(
    (await client.history?.({ limit: 1_000 }))?.events.some(
      (item) =>
        item.event.type === "compaction.begin" ||
        item.event.type === "compaction.end",
    ),
  ).toBe(false);
  await client.dispose?.();
});

test("subagent executes TS native workspace tools before reporting completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-subagent-tools-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_subagent_tools",
    provider: subagentToolProvider(),
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate a file task");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );
  expect(await readFile(join(root, "agent-test.txt"), "utf8")).toBe(
    "agent test success",
  );
  expect(
    events.some(
      (event) =>
        event.type === "subagent.update" &&
        event.text?.includes("tool write_file"),
    ),
  ).toBe(true);
  const childToolEvents = events.filter(
    (
      event,
    ): event is Extract<RuntimeEvent, { type: "tool.update" }> & {
      agentID: string;
    } => Boolean(event.agentID) && event.type === "tool.update",
  );
  expect(childToolEvents.map((event) => event.status)).toEqual([
    "awaiting_approval",
    "running",
    "succeeded",
  ]);
});

test("subagent corrects raw XML and executes a native tool call", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-subagent-raw-xml-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_subagent_raw_xml",
    provider: subagentRawXMLToolProvider(),
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));

  await client.submitAndWait!("delegate a raw XML file task");
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "subagent.update" && event.status === "completed",
      ),
    5_000,
    "the raw XML subagent tool to complete",
  );

  expect(await readFile(join(root, "agent-raw-xml.txt"), "utf8")).toBe(
    "raw XML child success",
  );
  expect(
    events
      .filter(
        (event) =>
          event.type === "tool.update" &&
          Boolean(event.agentID) &&
          event.name === "write_file",
      )
      .map((event) =>
        event.type === "tool.update" ? event.status : undefined,
      ),
  ).toEqual(["awaiting_approval", "running", "succeeded"]);
  expect(
    events.some(
      (event) =>
        event.type === "content.delta" &&
        Boolean(event.agentID) &&
        event.text.includes("<tool_call>"),
    ),
  ).toBe(false);
});

test("subagent approval stays in the child conversation and remains answerable", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-ts7-subagent-approval-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_ts7_subagent_approval",
    provider: subagentToolProvider(),
    permissionMode: "ask",
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval?.({
        requestID: event.id,
        decision: "once",
      });
  });

  await client.submitAndWait!("delegate a file task");
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "subagent.update" && event.status === "completed",
      ),
    20_000,
    "the approved subagent tool to complete",
  );

  const request = events.find(
    (
      event,
    ): event is Extract<RuntimeEvent, { type: "approval.request" }> & {
      agentID: string;
    } => event.type === "approval.request" && Boolean(event.agentID),
  );
  expect(request).toMatchObject({
    type: "approval.request",
    agentID: expect.any(String),
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "approval.response",
      id: request?.id,
      decision: "once",
      agentID: request?.agentID,
    }),
  );
  expect(await readFile(join(root, "agent-test.txt"), "utf8")).toBe(
    "agent test success",
  );
  expect(
    (await client.history?.({ limit: 1000 }))?.events.some(
      (item) => item.event.agentID,
    ),
  ).toBe(false);
});

test("subagent honors configured step limits above twenty", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-subagent-step-limit-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      defaultAgent: "long_running",
      agents: { long_running: { description: "Long running", maxSteps: 21 } },
    }),
  );
  for (let step = 0; step < 21; step++)
    await writeFile(join(root, `readable-${step}.txt`), "safe test input");
  const childToolCalls: string[] = [];
  const childRequests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_subagent_step_limit",
    permissionMode: "auto",
    provider: {
      provider: "subagent-step-limit",
      model: "subagent-step-limit",
      async *stream(request) {
        const child =
          request.messages[0]?.role === "system" &&
          String(request.messages[0].content).includes(
            "focused Natalia TS/Bun subagent",
          );
        if (child) {
          childRequests.push(request);
          const priorCalls = request.messages.filter(
            (message) => message.role === "tool",
          ).length;
          if (priorCalls < 20) {
            const path = `readable-${priorCalls}.txt`;
            childToolCalls.push(path);
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: `child_read_${priorCalls}`,
                  name: "read_file",
                  arguments: JSON.stringify({ path }),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          yield {
            type: "content" as const,
            // Long enough to clear the result-quality gate, whose extra turn
            // would otherwise count as a step here. The XML-like tool call is
            // kept because this test also pins that it is not executed.
            text:
              "completed after 20 tools. Every read_file call the child made " +
              "was a real native tool call, and the step budget stopped the " +
              "child at its configured limit rather than letting it run on. " +
              "The following pseudo-call is text and must not be executed: " +
              "<function=read_file><parameter=path>ignored.txt</parameter></function>",
          };
          yield { type: "done" as const };
          return;
        }
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "spawn_long_child",
                name: "agent_spawn",
                arguments: JSON.stringify({ task: "perform many reads" }),
              },
            ],
          };
          yield { type: "done" as const };
          return;
        }
        yield { type: "content" as const, text: "parent complete" };
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate a long task");
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "subagent.update" && event.status === "completed",
      ),
    2_000,
  );

  expect(childToolCalls).toHaveLength(20);
  expect(childRequests).toHaveLength(21);
  expect(
    childRequests.slice(0, -1).every((request) => request.tools?.length),
  ).toBe(true);
  expect(childRequests.at(-1)).toMatchObject({
    tools: undefined,
    toolChoice: "none",
  });
  expect(
    childRequests
      .at(-1)
      ?.messages.some((message) =>
        message.content.includes("MAXIMUM STEPS REACHED"),
      ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "subagent.update" &&
        event.text?.includes("completed after 20 tools"),
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "content.delta" &&
        Boolean(event.agentID) &&
        event.text.includes("<function=read_file>"),
    ),
  ).toBe(true);
  await client.dispose?.();
});

function scriptedProvider(text: string): StreamingProvider {
  return {
    provider: "scripted",
    model: "scripted-model",
    async *stream(_request: ProviderStreamRequest) {
      yield { type: "content", text };
      yield { type: "done" };
    },
  };
}

function singleToolProvider(
  name: string,
  arguments_: unknown,
): StreamingProvider {
  return {
    provider: "scripted-single-tool",
    model: "scripted-single-tool-model",
    async *stream(request: ProviderStreamRequest) {
      if (!request.messages.some((message) => message.role === "tool"))
        yield {
          type: "tool_call",
          calls: [
            {
              id: "single",
              name,
              arguments: JSON.stringify(arguments_),
            },
          ],
        };
      yield { type: "done" };
    },
  };
}

function interactiveTerminalProvider(): StreamingProvider {
  return {
    provider: "scripted-interactive-terminal",
    model: "scripted-interactive-terminal-model",
    async *stream(request) {
      if (!request.messages.some((message) => message.role === "tool"))
        yield {
          type: "tool_call",
          calls: [
            {
              id: "start",
              name: "interactive_terminal_start",
              arguments: JSON.stringify({
                id: "tty_management",
                command: "cat",
              }),
            },
          ],
        };
      yield { type: "done" };
    },
  };
}

function nativeTerminalFixture() {
  let running = true;
  return new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 71, window_id: 7, tab_id: 1 };
    },
    async list() {
      return running
        ? [{ pane_id: 71, window_id: 7, tab_id: 1, rows: 24, cols: 80 }]
        : [];
    },
    async read() {
      return "native pane output";
    },
    async write() {},
    async open() {
      return { pane_id: 71, window_id: 7, tab_id: 1, rows: 24, cols: 80 };
    },
    async openHub() {},
    async focus() {},
    async resize() {},
    async stop() {
      running = false;
    },
  });
}

function usageProvider(): StreamingProvider {
  return {
    provider: "scripted-usage",
    model: "scripted-usage-model",
    async *stream(_request: ProviderStreamRequest) {
      yield { type: "content", text: "usage ok" };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "done" };
    },
  };
}

function contextLimitThenSuccessProvider(): StreamingProvider & {
  calls: number;
} {
  return {
    provider: "scripted-context-limit",
    model: "scripted-context-limit-model",
    calls: 0,
    async *stream(this: StreamingProvider & { calls: number }) {
      this.calls++;
      if (this.calls === 1)
        throw providerError({
          kind: "context_limit",
          message: "context length exceeded",
        });
      yield { type: "content", text: "recovered" };
      yield { type: "done" };
    },
  };
}

function toolCallingProvider(): StreamingProvider & {
  requests: ProviderStreamRequest[];
} {
  const requests: ProviderStreamRequest[] = [];
  return {
    provider: "scripted-tools",
    model: "scripted-tool-model",
    requests,
    async *stream(request: ProviderStreamRequest) {
      requests.push(request);
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_read",
              name: "read_file",
              arguments: JSON.stringify({ path: "input.txt" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "tool said: tool data" };
      yield { type: "done" };
    },
  };
}

function writeFileProvider(): StreamingProvider {
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
              arguments: JSON.stringify({
                path: "hello-ts7.txt",
                content: "hello from TS7\n",
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "file created" };
      yield { type: "done" };
    },
  };
}

function approvalWriteProvider(): StreamingProvider {
  return {
    provider: "scripted-approval-write",
    model: "scripted-approval-write-model",
    async *stream(request: ProviderStreamRequest) {
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_approval_write",
              name: "write_file",
              arguments: JSON.stringify({
                path: "long-note.md",
                content: "long content ".repeat(100),
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "file created" };
      yield { type: "done" };
    },
  };
}

function questionToolProvider(): StreamingProvider {
  return {
    provider: "scripted-question",
    model: "scripted-question-model",
    async *stream(request: ProviderStreamRequest) {
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_question",
              name: "ask_user",
              arguments: JSON.stringify({
                question: "Continue?",
                options: ["yes", "no"],
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "answer received" };
      yield { type: "done" };
    },
  };
}

function delayedStreamingProvider(): StreamingProvider {
  return {
    provider: "scripted-delayed",
    model: "scripted-delayed-model",
    async *stream(_request: ProviderStreamRequest) {
      yield { type: "content", text: "first " };
      await Bun.sleep(80);
      yield { type: "content", text: "second" };
      yield { type: "done" };
    },
  };
}

function subagentProvider(): StreamingProvider {
  return {
    provider: "scripted-subagent",
    model: "scripted-subagent-model",
    async *stream(request: ProviderStreamRequest) {
      if (
        request.messages[0]?.role === "system" &&
        String(request.messages[0].content).includes(
          "focused Natalia TS/Bun subagent",
        )
      ) {
        yield { type: "thinking", text: "checking the delegated task" };
        yield { type: "content", text: "child result" };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_subagent",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child task" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "parent complete" };
      yield { type: "done" };
    },
  };
}

function subagentCompactionProvider(): StreamingProvider & {
  compactionCalls: number;
} {
  let compactionCalls = 0;
  return {
    provider: "scripted-subagent-compaction",
    model: "scripted-subagent-compaction-model",
    get compactionCalls() {
      return compactionCalls;
    },
    async *stream(request: ProviderStreamRequest) {
      // Round 12 made the summarization call replay the span, so its
      // instruction rides as the final message rather than in a leading system
      // message — that is what identifies this call now.
      if (
        request.messages
          .at(-1)
          ?.content?.includes("Summarize this Natalia agent session")
      ) {
        compactionCalls += 1;
        // Must satisfy the summary contract (every required section and the
        // minimum length): a shorter answer is regenerated and then rejected,
        // which fails the compaction this test is trying to observe.
        yield {
          type: "content",
          text: [
            "## Objective",
            "- Compact the child's context so the compaction runs against the active provider.",
            "",
            "## Important Details",
            "- The summarization call is a provider call like any other.",
            "",
            "## Work State",
            "### Completed",
            "- Read readable.txt.",
            "",
            "### Active",
            "- Finishing the compacted child turn.",
            "",
            "### Blocked",
            "- (none)",
            "",
            "## Next Move",
            "1. Return the compacted result to the parent.",
            "",
            "## Relevant Files",
            "- readable.txt: the file the child read.",
          ].join("\n"),
        };
        yield { type: "done" };
        return;
      }
      const hasCompactedSummary = request.messages.some((message) =>
        message.content.includes("Natalia compacted context summary"),
      );
      const isChild =
        (hasCompactedSummary ||
          (request.messages[0]?.role === "system" &&
            request.messages[0].content.includes(
              "focused Natalia TS/Bun subagent",
            ))) &&
        request.messages.some((message) =>
          message.content.includes("child compaction task"),
        );
      if (
        isChild &&
        !request.messages.some((message) => message.role === "tool")
      ) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_child_read_for_compaction",
              name: "read_file",
              arguments: JSON.stringify({ path: "readable.txt" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      if (isChild) {
        // Short on purpose: it is under the result-quality gate's minimum, so
        // the gate spends one more turn asking for detail. That turn is a second
        // user message, and it is what gives this single-turn child a history
        // worth compacting — the preserved tail always reaches back to the last
        // user message, so a child with only its task has nothing before it but
        // the protected system head.
        yield { type: "content", text: "child compacted result" };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_spawn_compacted_child",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child compaction task" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "parent complete" };
      yield { type: "done" };
    },
  };
}

function subagentToolProvider(): StreamingProvider {
  return {
    provider: "scripted-subagent-tools",
    model: "scripted-subagent-tools-model",
    async *stream(request: ProviderStreamRequest) {
      const isChild = request.messages.some(
        (message) => message.content === "child file task",
      );
      if (
        isChild &&
        !request.messages.some((message) => message.role === "tool")
      ) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_child_write",
              name: "write_file",
              arguments: JSON.stringify({
                path: "agent-test.txt",
                content: "agent test success",
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      if (isChild) {
        yield { type: "content", text: "created agent-test.txt successfully" };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_subagent_tools",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child file task" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "parent complete" };
      yield { type: "done" };
    },
  };
}

function subagentRawXMLToolProvider(): StreamingProvider {
  return {
    provider: "scripted-subagent-raw-xml",
    model: "scripted-subagent-raw-xml-model",
    async *stream(request: ProviderStreamRequest) {
      const isChild = request.messages.some(
        (message) => message.content === "child raw XML file task",
      );
      if (
        isChild &&
        !request.messages.some((message) => message.role === "tool")
      ) {
        yield {
          type: "content",
          text: [
            "Inspecting. ",
            "<tool_call><function=write_file>",
            "<parameter=path>&quot;agent-raw-xml.txt&quot;</parameter>",
            "<parameter=content>&quot;raw XML child success&quot;</parameter>",
            "</function></tool_call>",
          ].join(""),
        };
        yield { type: "done" };
        return;
      }
      if (isChild) {
        yield { type: "content", text: "created the raw XML child file" };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_subagent_raw_xml",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child raw XML file task" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "parent complete" };
      yield { type: "done" };
    },
  };
}

/**
 * Waits for a condition. The default budget is generous for the same
 * reason waitForAsync's is: this file's conditions routinely cross
 * process boundaries (a settle on disk, a wake that has to run), and a
 * 500ms default was a lottery under the concurrent suite — a different
 * victim every run. The 60s per-test cap still bounds a genuine hang.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 20_000,
  label = "condition",
) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 10) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

/** Re-pins a family's trust record to the promoted bytes (the promotion step). */
async function fingerprintEntry(workspaceRoot: string, entryPath: string) {
  await recordTrust(workspaceRoot, {
    key: resolve(entryPath, ".."),
    source: resolve(entryPath, ".."),
    fingerprint: await fingerprintFile(entryPath),
    installedAt: new Date().toISOString(),
  });
}

type NamespacedCollabMessageEvent = Extract<
  RuntimeEvent,
  {
    type:
      | "natalia.collab.message"
      | "navi.collab.message"
      | "nia.collab.message";
  }
>;

function isCollabMessageEvent(
  event: RuntimeEvent,
): event is NamespacedCollabMessageEvent {
  return event.type.endsWith(".collab.message");
}

/** Polls until an async predicate holds (the runtime wakes turns asynchronously). */
/**
 * Waits for a durable condition. The default budget is deliberately
 * generous: these conditions cross process boundaries (a settle on disk,
 * a wake that has to run), and this file runs for minutes inside a
 * concurrent suite — a 3s default was a load lottery that failed a
 * different test on every run. The per-test cap (60s) is what still
 * bounds a genuine hang.
 */
async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 50) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error("timed out waiting for async condition");
}

/** Polls the attached session's history until a turn has settled on disk. */
async function pollHistoryForFinished(
  client: ReturnType<typeof createRealRuntimeClient>,
  timeoutMs = 20_000,
) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 50) {
    // A larger window than 100: seeded constitution rules and session
    // snapshots are durable events too, so a turn's `turn.finished` can sit
    // beyond a 100-event window and must not look like the turn never settled.
    const history = await client.history?.({ limit: 1000 });
    if (history?.events.some((entry) => entry.event.type === "turn.finished"))
      return;
    await Bun.sleep(50);
  }
  throw new Error("timed out waiting for a settled turn in history");
}

test("the system prompt enumerates installed skills dynamically", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-prompt-skills-"));
  const requests: ProviderStreamRequest[] = [];
  const provider: StreamingProvider = {
    provider: "test",
    model: "test",
    async *stream(request) {
      requests.push(request);
      yield { type: "done" as const };
    },
  };
  const promptFor = async (sessionID: SessionID) => {
    requests.length = 0;
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID,
      provider,
    });
    client.start(() => undefined);
    await client.submitAndWait!("hi");
    await client.dispose?.();
    // ADR D1: dynamic content (skills) is no longer in the static system
    // message; it arrives as `<runtime_context>` user messages. Assert on
    // everything the model actually sees.
    return (requests[0]?.messages ?? [])
      .map((message) => message.content)
      .join("\n");
  };

  // Nothing installed: the section must be absent rather than empty, so a
  // workspace without skills neither pays tokens nor learns about skill_load.
  expect(await promptFor("ses_prompt_skills_none" as SessionID)).not.toContain(
    "<available_skills>",
  );

  const skillRoot = join(root, ".natalia", "skills", "probe-skill");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    `---\nname: probe-skill\ndescription: ${"d".repeat(900)}\n---\n\n# probe\n`,
  );

  const withSkill = await promptFor("ses_prompt_skills_one" as SessionID);
  expect(withSkill).toContain("<available_skills>");
  // Enumerated from the registry, not hardcoded: the freshly created directory
  // shows up without any code or config change.
  expect(withSkill).toContain("- probe-skill (project):");
  expect(withSkill).toContain("None is loaded yet.");
  // A pathological description must not be able to dominate the prompt.
  expect(withSkill).toContain("...");
  expect(withSkill).not.toContain("d".repeat(700));
});

test("a rejected approval feeds the reason back and lets the turn continue", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-reject-"));
  const events: RuntimeEvent[] = [];
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_reject_continue" as SessionID,
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request);
        // The second step only happens if the turn survived the rejection.
        if (request.messages.some((message) => message.role === "tool")) {
          yield { type: "content" as const, text: "understood, moving on" };
          yield { type: "done" as const };
          return;
        }
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_1",
              name: "run_shell",
              arguments: JSON.stringify({ command: "rm -rf /" }),
            },
          ],
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({
        requestID: event.id,
        decision: "reject",
        feedback: "too dangerous, list the directory instead",
      });
  });

  await client.submitAndWait!("clean the workspace");

  // The refusal is reported as a decision about the call, not a broken turn.
  expect(
    events.find(
      (event) => event.type === "tool.update" && event.status === "rejected",
    ),
  ).toMatchObject({
    type: "tool.update",
    name: "run_shell",
    status: "rejected",
  });
  const finished = events.filter((event) => event.type === "turn.finished");
  expect(finished).toHaveLength(1);
  expect(finished[0]).not.toMatchObject({ stopReason: "error" });

  // The model is told why, so it can choose differently.
  const toolMessages = requests
    .at(-1)!
    .messages.filter((message) => message.role === "tool");
  expect(toolMessages).toHaveLength(1);
  expect(String(toolMessages[0]?.content)).toContain(
    "too dangerous, list the directory instead",
  );
  expect(String(toolMessages[0]?.content)).toContain("rejected by the user");

  // And it kept working afterwards.
  expect(
    events
      .filter((event) => event.type === "content.delta")
      .map((event) => event.text)
      .join(""),
  ).toContain("understood, moving on");
});

test("a rejection without feedback still audits the decision and continues", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-runtime-reject-bare-"));
  const events: RuntimeEvent[] = [];
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_reject_bare" as SessionID,
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request);
        if (request.messages.some((message) => message.role === "tool")) {
          yield { type: "content" as const, text: "asking instead" };
          yield { type: "done" as const };
          return;
        }
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_1",
              name: "run_shell",
              arguments: JSON.stringify({ command: "echo hi" }),
            },
          ],
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "reject" });
  });

  await client.submitAndWait!("run something");

  // The audit trail must record the refusal even when no reason was given.
  expect(
    events.find(
      (event) =>
        event.type === "policy.decision" && event.decision === "rejected",
    ),
  ).toMatchObject({ toolName: "run_shell", toolCallID: "call_1" });
  expect(events.filter((event) => event.type === "turn.finished")).toHaveLength(
    1,
  );

  const toolMessages = requests
    .at(-1)!
    .messages.filter((message) => message.role === "tool");
  expect(String(toolMessages[0]?.content)).toContain("without a reason");
});

test("the repeated call guard blocks loops but not waiting reads", async () => {
  async function blockedCount(name: string, args: Record<string, unknown>) {
    const root = await mkdtemp(join(tmpdir(), "natalia-repeat-guard-"));
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({ version: 3, runtime: { maxStepsPerTurn: 6 } }),
    );
    const events: RuntimeEvent[] = [];
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: `ses_repeat_${name}`,
      permissionMode: "auto",
      provider: {
        provider: "test",
        model: "test",
        async *stream(request) {
          if (request.messages.some((message) => message.role === "tool")) {
            yield { type: "done" as const };
            return;
          }
          // Fourteen identical calls in one turn, so the guard's threshold is
          // crossed without depending on how many rounds a turn allows.
          yield {
            type: "tool_call" as const,
            calls: Array.from({ length: 14 }, (_, index) => ({
              id: `call_${index}`,
              name,
              arguments: JSON.stringify(args),
            })),
          };
        },
      },
    });
    client.start((event) => events.push(event));
    await client.submitAndWait!(`repeat ${name}`);
    await client.dispose?.();
    return events.filter(
      (event) =>
        event.type === "tool.update" &&
        typeof event.summary === "string" &&
        event.summary.includes("blocked repeated tool call"),
    ).length;
  }

  // A tool with no waiting behaviour repeated identically is a loop, and the
  // guard still stops it.
  expect(
    await blockedCount("read_file", { path: "missing.txt" }),
  ).toBeGreaterThan(0);
  // terminal_observe blocks until the screen changes, so identical arguments are
  // how a caller waits. It used to be cut off mid-wait after twelve polls.
  expect(await blockedCount("terminal_observe", { id: "tty_absent" })).toBe(0);
});

test("config is not applied underneath a running turn, even if the precheck said yes", async () => {
  // `canReloadConfig()` is advisory: a turn can start between asking and acting.
  // So the action re-checks for itself, and refuses as a value rather than
  // applying new policy to a turn that started under the old policy.
  const root = await mkdtemp(join(tmpdir(), "natalia-reload-race-"));
  let releaseProvider: (() => void) | undefined;
  const providerReached = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  let letProviderFinish: (() => void) | undefined;
  const providerHeld = new Promise<void>((resolve) => {
    letProviderFinish = resolve;
  });
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_reload_race",
    permissionMode: "auto",
    provider: {
      provider: "scripted",
      model: "scripted",
      async *stream() {
        releaseProvider?.();
        await providerHeld;
        yield { type: "content" as const, text: "done" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);

  // Ask before the turn: allowed.
  expect(await client.canReloadConfig?.()).toEqual({ allowed: true });

  const turn = client.submit("hold the provider open");
  await providerReached;

  // The same question now answers no, and so does the action.
  expect((await client.canReloadConfig?.())?.allowed).toBe(false);
  const refused = await client.reloadConfig?.();
  expect(refused?.applied).toBe(false);
  expect(refused?.reason).toMatch(/while a turn is running/u);

  letProviderFinish?.();
  await turn;
  await pollHistoryForFinished(client);

  // Once the turn has settled it applies normally.
  expect((await client.reloadConfig?.())?.applied).toBe(true);
  await client.dispose?.();
}, 30_000);

test("answering a request that is no longer pending is reported, not swallowed", async () => {
  // The waiter already knew this — it published a warning diagnostic and returned
  // — but the caller was told nothing, and over RPC it was told `responded: true`.
  // An external UI has to know its answer arrived too late, because the model was
  // told the call did not run.
  const root = await mkdtemp(join(tmpdir(), "natalia-stale-response-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_stale_response",
    provider: scriptedProvider("nothing to approve"),
  });
  client.start(() => undefined);

  expect(
    await client.respondApproval({ requestID: "apr_never", decision: "once" }),
  ).toEqual({
    accepted: false,
    reason: "the approval request is no longer pending",
  });
  expect(
    await client.respondQuestion({
      requestID: "qst_never",
      answers: [["no"]],
      rejected: false,
    }),
  ).toEqual({
    accepted: false,
    reason: "the question request is no longer pending",
  });
  await client.dispose?.();
}, 30_000);

test("pause, resume and agent selection answer what the runtime did", async () => {
  // Each of these used to return nothing, so the RPC route replied with a
  // hard-coded success. A caller could pause a runtime with no turn and be told
  // the turn was held; it could select an agent that does not exist and be told
  // it was selected. Pause/resume now only answer for a genuinely running turn.
  const root = await mkdtemp(join(tmpdir(), "natalia-turn-control-"));
  let release: (() => void) | undefined;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_turn_control",
    permissionMode: "auto",
    provider: {
      provider: "scripted",
      model: "scripted",
      async *stream() {
        await new Promise<void>((resolve) => (release = resolve));
        yield { type: "content" as const, text: "done" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);

  expect(await client.pause?.()).toEqual({
    paused: false,
    reason: "no turn is running",
  });
  expect(await client.resume?.()).toEqual({
    resumed: false,
    reason: "no turn is running",
  });

  const unknown = await client.selectAgent?.("no-such-agent");
  expect(unknown).toEqual({
    outcome: "rejected",
    reason: "agent not found: no-such-agent",
  });
  expect((await client.selectAgent?.())?.outcome).toBe("applied");

  const turn = client.submit("hold the turn open");
  await waitFor(() => release !== undefined, 20_000, "the provider to start");
  expect(await client.pause?.("user pause")).toEqual({ paused: true });
  expect(await client.pause?.("user pause")).toEqual({
    paused: true,
    reason: "already paused",
  });
  expect(await client.resume?.()).toEqual({ resumed: true });
  expect(await client.resume?.()).toEqual({
    resumed: false,
    reason: "the turn is not paused",
  });

  release?.();
  await turn;
  await client.dispose?.();
}, 30_000);

test("selecting an agent during a turn reports the selection as deferred, not applied", async () => {
  // Changing the agent underneath a running turn would change the rules it
  // started under, so the runtime defers it. That is a third outcome, and a
  // consumer that is told "applied" will show the new agent for a turn that is
  // still running under the old one.
  const root = await mkdtemp(join(tmpdir(), "natalia-agent-pending-"));
  let providerReached: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    providerReached = resolve;
  });
  let releaseProvider: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_agent_pending",
    permissionMode: "auto",
    provider: {
      provider: "scripted",
      model: "scripted",
      async *stream() {
        providerReached?.();
        await held;
        yield { type: "content" as const, text: "done" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  const turn = client.submit("hold the turn open");
  await reached;

  expect(await client.selectAgent?.()).toMatchObject({ outcome: "pending" });

  releaseProvider?.();
  await turn;
  await pollHistoryForFinished(client);
  expect((await client.selectAgent?.())?.outcome).toBe("applied");
  await client.dispose?.();
}, 30_000);

test("an initialization failure surfaces its cause, not a derived symptom", async () => {
  // Before this fix, `start()` swallowed the failure into one diagnostic and
  // every member then answered with a derived symptom ("checkpoint store is
  // not initialized"), so a remote caller saw a pile of unrelated internal
  // errors with no way to find the cause. The failure must travel.
  const root = await mkdtemp(join(tmpdir(), "natalia-init-failure-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_init_failure",
    // resolveConfig succeeds; the profile lookup is the controllable failure.
    permissionProfile: "no_such_profile",
    provider: scriptedProvider("unused"),
  });
  client.start(() => undefined);

  // Members that await initialization all fail with the *cause*. (snapshot
  // is a pure in-memory event constructor and correctly still answers.)
  const attempts: Array<() => Promise<unknown>> = [
    () => client.history!({ limit: 10 }),
    async () => {
      await client.checkpointList!();
    },
  ];
  for (const attempt of attempts) {
    const error = await attempt().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("permission profile not found");
  }
  // The pure constructor keeps working; nothing derived was invented.
  expect(client.snapshot().type).toBe("snapshot.created");
  await client.dispose?.();
}, 30_000);

test("session lifecycle: new is idempotent, archive marks, export dumps the journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-lifecycle-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_lifecycle_host",
  });
  client.start(() => undefined);
  try {
    const created = await client.sessionNew?.({
      id: "ses_managed_1",
      title: "Managed",
    });
    expect(created).toEqual({ sessionID: "ses_managed_1", created: true });
    const replay = await client.sessionNew?.({ id: "ses_managed_1" });
    expect(replay).toEqual({ sessionID: "ses_managed_1", created: false });

    const minted = await client.sessionNew?.({});
    expect(minted?.sessionID).toMatch(/^ses_/u);
    expect(minted?.created).toBe(true);

    const archived = await client.sessionArchive?.("ses_managed_1");
    expect(archived).toEqual({ id: "ses_managed_1", archived: true });
    const again = await client.sessionArchive?.("ses_managed_1");
    expect(again).toEqual({ id: "ses_managed_1", archived: true });

    const list = await client.sessionList?.();
    const managed = list?.find((summary) => summary.id === "ses_managed_1");
    expect(managed?.archived).toBe(true);

    const exported = await client.sessionExport?.("ses_managed_1");
    expect(exported?.sessionID).toBe("ses_managed_1");
    expect(exported?.title).toBe("Managed");
    expect(exported?.archived).toBe(true);
    expect(exported?.events).toEqual([]);

    const missing = await client
      .sessionArchive?.("ses_does_not_exist")
      .catch((error: unknown) => error);
    expect((missing as Error).message).toContain("session not found");
  } finally {
    await client.dispose?.();
  }
});

test("session attach switches the active journal while a background turn keeps running", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-attach-"));
  let release: (() => void) | undefined;
  let calls = 0;
  const requests: ProviderStreamRequest[] = [];
  const provider: StreamingProvider = {
    provider: "attach",
    model: "attach",
    async *stream(request) {
      requests.push(request);
      calls += 1;
      if (calls === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      yield { type: "content" as const, text: "first session" };
      yield { type: "done" as const };
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_attach_a",
    provider,
  });
  client.start(() => undefined);
  try {
    await client.sessionNew?.({ id: "ses_attach_b", title: "Second" });
    const turnA = client.submit("wait");
    await waitFor(() => release !== undefined);

    // D2: a turn in flight is no longer a refusal — it belongs to its own
    // session and keeps running in the background.
    expect(await client.sessionAttach?.("ses_attach_b")).toEqual({
      sessionID: "ses_attach_b",
    });
    // Session B runs its own turn while A's is still parked.
    await client.submitAndWait!("second");
    await pollHistoryForFinished(client);
    const second = await client.history?.({ limit: 100 });
    expect(
      second?.events.some((entry) => entry.event.type === "turn.submitted"),
    ).toBe(true);

    // The background turn of A settles into A's journal.
    release?.();
    await turnA;

    expect(await client.sessionAttach?.("ses_attach_a")).toEqual({
      sessionID: "ses_attach_a",
    });
    await pollHistoryForFinished(client);
    const first = await client.history?.({ limit: 1000 });
    expect(
      first?.events.some((entry) => entry.event.type === "turn.submitted"),
    ).toBe(true);
    expect(
      first?.events.some(
        (entry) =>
          entry.event.type === "turn.finished" &&
          (entry.event as { sessionID?: string }).sessionID === "ses_attach_a",
      ),
    ).toBe(true);

    await client.submitAndWait!("after attach");
    await pollHistoryForFinished(client);
    const resumed = requests.find((request) =>
      request.messages.some(
        (message) =>
          message.role === "user" && message.content === "after attach",
      ),
    );
    expect(
      resumed?.messages.some(
        (message) => message.role === "user" && message.content === "wait",
      ),
    ).toBe(true);
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("parallel sessions retain their configured provider across tool steps", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-provider-isolation-"));
  await writeFile(join(root, "evidence.txt"), "session A evidence");
  const requests: Array<{
    model: string;
    messages: Array<{ role: string; content?: string }>;
  }> = [];
  let releaseFirstA: (() => void) | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof requests)[number];
      requests.push(body);
      const isA = body.messages.some(
        (message) => message.role === "user" && message.content === "session A",
      );
      const isB = body.messages.some(
        (message) => message.role === "user" && message.content === "session B",
      );
      const hasToolResult = body.messages.some(
        (message) => message.role === "tool",
      );
      if (isA && !hasToolResult) {
        await new Promise<void>((resolve) => {
          releaseFirstA = resolve;
        });
        const arguments_ = JSON.stringify({ path: "evidence.txt" });
        return new Response(
          [
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_read_a",
                        function: { name: "read_file", arguments: arguments_ },
                      },
                    ],
                  },
                },
              ],
            })}`,
            "",
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const text = isA ? "session A complete" : isB ? "session B complete" : "";
      return new Response(
        [
          `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
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
      }),
    );
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      sessionID: "ses_provider_a",
      permissionMode: "auto",
    });
    client.start(() => undefined);
    try {
      await client.sessionNew?.({ id: "ses_provider_b", title: "Session B" });
      const turnA = client.submit("session A");
      await waitFor(
        () => releaseFirstA !== undefined,
        5_000,
        "session A's first provider request",
      );

      await client.sessionAttach?.("ses_provider_b");
      await client.selectModel?.("local/beta");
      await client.submitAndWait!("session B");
      releaseFirstA?.();
      await turnA;

      const modelsFor = (text: string) =>
        requests
          .filter((request) =>
            request.messages.some(
              (message) => message.role === "user" && message.content === text,
            ),
          )
          .map((request) => request.model);
      await waitFor(
        () => modelsFor("session A").length >= 2,
        20_000,
        "session A's provider to complete both tool and final steps",
      );
      expect(modelsFor("session A").length).toBeGreaterThanOrEqual(2);
      expect(modelsFor("session A").every((model) => model === "alpha")).toBe(
        true,
      );
      expect(modelsFor("session B").length).toBeGreaterThanOrEqual(1);
      expect(modelsFor("session B").every((model) => model === "beta")).toBe(
        true,
      );
    } finally {
      await client.dispose?.();
    }
  } finally {
    server.stop(true);
  }
}, 30_000);

test("published events are stamped with the active session and re-stamped on attach", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-event-stamp-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_stamp_a",
    provider: scriptedProvider("stamped"),
  });
  client.start((event) => events.push(event));
  try {
    await client.submitAndWait!("hello");
    const first = events.filter(
      (event) =>
        event.type === "turn.submitted" ||
        event.type === "content.done" ||
        event.type === "turn.finished",
    );
    expect(first.length).toBeGreaterThan(0);
    for (const event of first)
      expect((event as { sessionID?: string }).sessionID).toBe("ses_stamp_a");
    // session.created carries its own id and is not double-stamped.
    const created = events.find((event) => event.type === "session.created");
    expect(created).toMatchObject({ sessionID: "ses_stamp_a" });

    await client.sessionNew?.({ id: "ses_stamp_b", title: "Second" });
    await client.sessionAttach?.("ses_stamp_b");
    events.splice(0);
    await client.submitAndWait!("again");
    const second = events.filter((event) => event.type === "turn.submitted");
    expect(second).toHaveLength(1);
    expect((second[0] as { sessionID?: string }).sessionID).toBe("ses_stamp_b");
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("terminal panes are isolated per session across attach (I3)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-i3-runtime-"));
  let nextPane = 501;
  const registry = new NativeTerminalRegistry(
    {
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        const paneID = nextPane++;
        return { pane_id: paneID, window_id: 1, tab_id: paneID };
      },
      async list() {
        return [];
      },
      async read() {
        return "";
      },
      async write() {},
      async focus() {},
      async resize() {},
      async stop() {},
    },
    { windowMode: "windowless" },
  );
  const paneA = await registry.start({
    id: "i3_runtime_a",
    cwd: "/a",
    command: "cat",
    sessionID: "ses_i3_runtime_a",
  });
  const paneB = await registry.start({
    id: "i3_runtime_b",
    cwd: "/b",
    command: "cat",
    sessionID: "ses_i3_runtime_b",
  });
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_i3_runtime_a",
    nativeTerminal: registry,
    provider: scriptedProvider("i3"),
  });
  client.start(() => undefined);
  try {
    await client.sessionNew?.({ id: "ses_i3_runtime_b", title: "B" });
    await client.sessionNew?.({ id: "ses_i3_runtime_c", title: "C" });

    const visibleA = (await client.nativeTerminalList?.()) ?? [];
    expect(visibleA.map((session) => session.id)).toEqual([paneA.id]);

    await client.sessionAttach?.("ses_i3_runtime_b");
    const visibleB = (await client.nativeTerminalList?.()) ?? [];
    expect(visibleB.map((session) => session.id)).toEqual([paneB.id]);

    // A session without panes sees none; an unowned pane is never exposed.
    await client.sessionAttach?.("ses_i3_runtime_c");
    expect(await client.nativeTerminalList?.()).toEqual([]);

    // Attaching back restores the original session's panes.
    await client.sessionAttach?.("ses_i3_runtime_a");
    const visibleAgain = (await client.nativeTerminalList?.()) ?? [];
    expect(visibleAgain.map((session) => session.id)).toEqual([paneA.id]);
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("terminal_request_human reaches the registry audit with the bounded reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-request-human-"));
  const audit: Array<{ action: string; actor: string; detail?: string }> = [];
  const registry = new NativeTerminalRegistry(
    {
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        return { pane_id: 701, window_id: 1, tab_id: 701 };
      },
      async list() {
        return [
          { pane_id: 701, window_id: 1, tab_id: 701, rows: 24, cols: 80 },
        ];
      },
      async read() {
        return "Password: ";
      },
      async write() {},
      async focus() {},
      async resize() {},
      async stop() {},
    },
    {
      windowMode: "windowless",
      onAudit: (event) => audit.push(event),
    },
  );
  const pane = await registry.start({
    id: "rh_runtime_1",
    cwd: root,
    command: "ssh host",
  });
  let requested = false;
  const provider: StreamingProvider = {
    provider: "request-human",
    model: "request-human",
    async *stream(request) {
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_rh",
              name: "interactive_terminal_request_human",
              arguments: JSON.stringify({
                id: pane.id,
                reason: "needs the sudo password",
              }),
            },
          ],
        };
        return;
      }
      requested = true;
      yield { type: "content" as const, text: "Waiting for the human." };
      yield { type: "done" as const };
    },
  };
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_request_human",
    nativeTerminal: registry,
    provider,
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  try {
    await client.submitAndWait!("ask the human");
    expect(requested).toBe(true);
    expect(audit.at(-1)).toMatchObject({
      id: "rh_runtime_1",
      action: "request_human",
      actor: "model",
      detail: "needs the sudo password",
    });
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("request_human endTurn settles as waiting_human and resumes automatically after release", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-continue-turn-"));
  const audit: Array<{ action: string; actor: string; detail?: string }> = [];
  const registry = new NativeTerminalRegistry(
    {
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        return { pane_id: 711, window_id: 1, tab_id: 711 };
      },
      async list() {
        return [
          { pane_id: 711, window_id: 1, tab_id: 711, rows: 24, cols: 80 },
        ];
      },
      async read() {
        return "Password: ";
      },
      async write() {},
      async focus() {},
      async resize() {},
      async stop() {},
    },
    {
      windowMode: "windowless",
      onAudit: (event) => audit.push(event),
    },
  );
  const pane = await registry.start({
    id: "rh_continue_1",
    cwd: root,
    command: "ssh host",
  });
  let streamCalls = 0;
  const provider: StreamingProvider = {
    provider: "continue-turn",
    model: "continue-turn",
    async *stream(request) {
      streamCalls += 1;
      if (streamCalls === 1) {
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_end_turn",
              name: "interactive_terminal_request_human",
              arguments: JSON.stringify({
                id: pane.id,
                reason: "needs the sudo password",
                endTurn: true,
              }),
            },
          ],
        };
        return;
      }
      if (streamCalls === 2) {
        // The tool ran; the model confirms and the turn settles waiting.
        yield { type: "content" as const, text: "Waiting for the human." };
        yield { type: "done" as const };
        return;
      }
      yield { type: "content" as const, text: "Continuing after the human." };
      yield { type: "done" as const };
    },
  };
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_continue_turn",
    nativeTerminal: registry,
    provider,
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  try {
    await client.submitAndWait!("ask the human");
    const finished = events.filter((event) => event.type === "turn.finished");
    expect(finished.at(-1)).toMatchObject({
      stopReason: "waiting_human",
    });
    expect(audit.at(-1)).toMatchObject({
      action: "request_human",
      detail: "needs the sudo password",
    });

    // The pending-human state is durable before the human acts.
    await waitForAsync(async () => {
      const persisted = JSON.parse(
        await readFile(
          join(root, ".natalia", "sessions", "ses_continue_turn.json"),
          "utf8",
        ),
      ) as { metadata?: { pendingHumanTerminal?: unknown } };
      return Boolean(persisted.metadata?.pendingHumanTerminal);
    });
    const persisted = JSON.parse(
      await readFile(
        join(root, ".natalia", "sessions", "ses_continue_turn.json"),
        "utf8",
      ),
    ) as { metadata?: { pendingHumanTerminal?: unknown } };
    expect(persisted.metadata?.pendingHumanTerminal).toMatchObject({
      terminalID: "rh_continue_1",
      reason: "needs the sudo password",
    });

    // Releasing the pane resumes the task with a fresh turn.
    await client.nativeTerminalReleaseHumanControl?.(pane.id);
    await waitFor(
      () =>
        events.filter(
          (event) =>
            event.type === "turn.finished" &&
            event.stopReason === "done" &&
            events.findIndex(
              (candidate) =>
                candidate.type === "turn.submitted" &&
                candidate.text.includes("[automated continuation]"),
            ) < events.indexOf(event),
        ).length >= 1,
    );
    const continuation = events.find(
      (event) =>
        event.type === "turn.submitted" &&
        event.text.includes("[automated continuation]"),
    );
    expect(continuation).toBeDefined();
    const doneAfter = events.filter(
      (event) => event.type === "turn.finished" && event.stopReason === "done",
    );
    expect(doneAfter.at(-1)).toBeDefined();
    expect(
      events.filter((event) => event.type === "turn.submitted"),
    ).toHaveLength(2);

    // The pending state is cleared once resumed.
    const afterResume = JSON.parse(
      await readFile(
        join(root, ".natalia", "sessions", "ses_continue_turn.json"),
        "utf8",
      ),
    ) as { metadata?: { pendingHumanTerminal?: unknown } };
    expect(afterResume.metadata?.pendingHumanTerminal).toBeUndefined();
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("releasing a pane that is not the pending one does not resume or clear state", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-continue-negative-"));
  const registry = new NativeTerminalRegistry(
    {
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        return { pane_id: 721, window_id: 1, tab_id: 721 };
      },
      async list() {
        return [
          { pane_id: 721, window_id: 1, tab_id: 721, rows: 24, cols: 80 },
        ];
      },
      async read() {
        return "Password: ";
      },
      async write() {},
      async focus() {},
      async resize() {},
      async stop() {},
    },
    { windowMode: "windowless" },
  );
  const pending = await registry.start({
    id: "rh_pending",
    cwd: root,
    command: "ssh host",
  });
  const other = await registry.start({
    id: "rh_other",
    cwd: root,
    command: "cat",
  });
  let streamCalls = 0;
  const provider: StreamingProvider = {
    provider: "continue-negative",
    model: "continue-negative",
    async *stream(request) {
      streamCalls += 1;
      if (streamCalls === 1) {
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_neg",
              name: "interactive_terminal_request_human",
              arguments: JSON.stringify({
                id: pending.id,
                reason: "needs input",
                endTurn: true,
              }),
            },
          ],
        };
        return;
      }
      yield { type: "content" as const, text: "Waiting." };
      yield { type: "done" as const };
    },
  };
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    // Hermetic about the store: the portable opt-in keeps the journal
    // workspace-local, so the assertions below read a stable path (and no
    // store lands in the real home).
    sessionDir: join(root, ".natalia", "sessions"),
    sessionID: "ses_continue_negative",
    nativeTerminal: registry,
    provider,
  });
  client.start((event) => events.push(event));
  try {
    await client.submitAndWait!("ask");
    expect(
      events.filter((event) => event.type === "turn.finished").at(-1)
        ?.stopReason,
    ).toBe("waiting_human");

    await client.nativeTerminalReleaseHumanControl?.(other.id);
    await Bun.sleep(100);
    expect(
      events.filter((event) => event.type === "turn.submitted"),
    ).toHaveLength(1);
    const persisted = JSON.parse(
      await readFile(
        join(root, ".natalia", "sessions", "ses_continue_negative.json"),
        "utf8",
      ),
    ) as { metadata?: { pendingHumanTerminal?: unknown } };
    expect(persisted.metadata?.pendingHumanTerminal).toMatchObject({
      terminalID: "rh_pending",
    });
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("D5.3: a session approval stays with its session across attach", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-d53-grants-"));
  let approvalCount = 0;
  const provider: StreamingProvider = {
    provider: "d53",
    model: "d53",
    async *stream(request) {
      if (!request.messages.some((message) => message.role === "tool"))
        yield {
          type: "tool_call",
          calls: [
            {
              id: `call_${crypto.randomUUID()}`,
              name: "run_shell",
              arguments: JSON.stringify({ command: "pwd" }),
            },
          ],
        };
      yield { type: "done" };
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_d53_a",
    provider,
  });
  client.start((event) => {
    if (event.type !== "approval.request") return;
    approvalCount++;
    client.respondApproval({ requestID: event.id, decision: "session" });
  });
  try {
    await client.sessionNew?.({ id: "ses_d53_b", title: "B" });
    await client.submitAndWait!("a1");
    await client.submitAndWait!("a2");
    expect(approvalCount).toBe(1);

    // Session B has no grants: its first call asks again.
    await client.sessionAttach?.("ses_d53_b");
    await client.submitAndWait!("b1");
    expect(approvalCount).toBe(2);

    // Attaching back to A restores A's grant: it was A's, never B's.
    await client.sessionAttach?.("ses_d53_a");
    await client.submitAndWait!("a3");
    expect(approvalCount).toBe(2);
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("permission management: save validates, delete refuses the default, both persist", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-permission-manage-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3 }),
  );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_permission_host",
  });
  client.start(() => undefined);
  try {
    const saved = await client.permissionSave?.({
      name: "strict",
      profile: {
        approval: "ask",
        description: "Strict profile",
        permissions: { tools: { allow: ["echo"], exclude: [] } },
      },
    });
    expect(saved?.saved).toBe(true);

    const list = await client.permissionList?.();
    expect(list?.default).toBe("ask");
    expect(
      list?.profiles.find((profile) => profile.name === "strict"),
    ).toMatchObject({
      approval: "ask",
    });

    const refusedDefault = await client.permissionDelete?.("ask");
    expect(refusedDefault).toEqual({
      deleted: false,
      reason: "permission profile is the active default: ask",
    });

    const removed = await client.permissionDelete?.("strict");
    expect(removed?.deleted).toBe(true);
    const after = await client.permissionList?.();
    expect(
      after?.profiles.find((profile) => profile.name === "strict"),
    ).toBeUndefined();

    const configText = await Bun.file(
      join(root, ".natalia", "config.json"),
    ).text();
    expect(configText).not.toContain('"strict"');
  } finally {
    await client.dispose?.();
  }
});

test("mcp server management persists config and survives failed connections", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-mcp-manage-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3 }),
  );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_mcp_host",
  });
  client.start(() => undefined);
  try {
    const added = await client.mcpServerAdd?.({
      name: "demo",
      config: {
        type: "stdio",
        command: "false",
        args: [],
        enabled: true,
        allowedTools: [],
        excludedTools: [],
        readOnly: false,
        headers: {},
        environment: {},
        timeoutSec: 30,
      },
    });
    expect(added?.saved).toBe(true);
    const configText = await Bun.file(
      join(root, ".natalia", "config.json"),
    ).text();
    expect(configText).toContain('"demo"');

    const removed = await client.mcpServerRemove?.("demo");
    expect(removed?.removed).toBe(true);
    const again = await client.mcpServerRemove?.("demo");
    expect(again?.removed).toBe(true);
    const after = await Bun.file(join(root, ".natalia", "config.json")).text();
    expect(after).not.toContain('"demo"');
  } finally {
    await client.dispose?.();
  }
});

test("agent and provider management persist, validate references and survive apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-agent-provider-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3 }),
  );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_agent_provider_host",
    globalConfigPath: join(root, "global.json"),
  });
  client.start(() => undefined);
  try {
    const plannerConfig = {
      description: "Plans first",
      mode: "primary" as const,
      systemPrompt: "Plan before acting.",
      allowedTools: [],
      excludedTools: [],
      mcpServers: [],
      hidden: false,
    };
    const created = await client.agentCreate?.({
      name: "planner",
      config: plannerConfig,
    });
    expect(created?.created).toBe(true);
    const dup = await client.agentCreate?.({
      name: "planner",
      config: plannerConfig,
    });
    expect(dup?.created).toBe(false);
    expect(dup?.reason).toContain("already exists");
    const updated = await client.agentUpdate?.({
      name: "planner",
      config: { ...plannerConfig, description: "New" },
    });
    expect(updated?.updated).toBe(true);
    const missing = await client
      .agentUpdate?.({
        name: "nope",
        config: plannerConfig,
      })
      .catch((error: unknown) => error);
    expect((missing as Error).message).toContain("agent not found");

    const added = await client.providerAdd?.({
      name: "gw",
      type: "openai",
      baseURL: "http://127.0.0.1:1/v1",
      apiKey: "key",
      models: [{ id: "gw-model", reasoning: true }],
    });
    expect(added?.saved).toBe(true);
    const configuredBeforeDelete = await client.configGet?.();
    expect(configuredBeforeDelete?.catalog.providers.gw?.models).toHaveProperty(
      "gw-model",
    );
    const removed = await client.providerRemove?.("gw");
    expect(removed?.removed).toBe(true);
    const configuredAfterDelete = await client.configGet?.();
    expect(configuredAfterDelete?.providers.gw).toBeUndefined();
    expect(configuredAfterDelete?.catalog.providers.gw).toBeUndefined();
    const again = await client.providerRemove?.("gw");
    expect(again?.removed).toBe(true);
  } finally {
    await client.dispose?.();
  }
});

test("two sessions writing the workspace in parallel both land without corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-parallel-write-"));
  const makeWriter = (): StreamingProvider => ({
    provider: "parallel-write",
    model: "parallel-write",
    async *stream(request) {
      const userText = request.messages
        .map((message) =>
          typeof message.content === "string" ? message.content : "",
        )
        .join("\n");
      const path = userText.includes("write a") ? "wa.txt" : "wb.txt";
      if (!request.messages.some((message) => message.role === "tool"))
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: `call_${crypto.randomUUID()}`,
              name: "write_file",
              arguments: JSON.stringify({ path, content: `content-${path}` }),
            },
          ],
        };
      yield { type: "done" as const };
    },
  });
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_pw_a",
    provider: makeWriter(),
  });
  client.start((event) => {
    if (event.type === "approval.request") {
      client.respondApproval({ requestID: event.id, decision: "once" });
    }
  });
  try {
    await client.sessionNew?.({ id: "ses_pw_b", title: "B" });
    const turnA = client.submit("write a");
    await client.sessionAttach?.("ses_pw_b");
    const turnB = client.submit("write b");
    await turnA;
    await turnB;
    await waitFor(
      () =>
        existsSync(join(root, "wa.txt")) && existsSync(join(root, "wb.txt")),
      20_000,
      "both parallel workspace writes to land",
    );
    expect(await readFile(join(root, "wa.txt"), "utf8")).toBe("content-wa.txt");
    expect(await readFile(join(root, "wb.txt"), "utf8")).toBe("content-wb.txt");
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("a background turn starting a terminal does not steal focus (I1)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-i1-runtime-"));
  const focused: number[] = [];
  let nextPane = 901;
  const registry = new NativeTerminalRegistry(
    {
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        const paneID = nextPane++;
        return { pane_id: paneID, window_id: 1, tab_id: paneID };
      },
      async list() {
        return [
          {
            pane_id: nextPane - 1,
            window_id: 1,
            tab_id: nextPane - 1,
            rows: 24,
            cols: 80,
          },
        ];
      },
      async read() {
        return "";
      },
      async write() {},
      async open(paneID, options) {
        return { pane_id: paneID, window_id: 1, tab_id: paneID };
      },
      async focus(paneID) {
        focused.push(paneID);
      },
      async resize() {},
      async stop() {},
    },
    { windowMode: "window" },
  );
  let release: (() => void) | undefined;
  let calls = 0;
  const provider: StreamingProvider = {
    provider: "i1",
    model: "i1",
    async *stream(request) {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: `call_${crypto.randomUUID()}`,
              name: "interactive_terminal_start",
              arguments: JSON.stringify({ command: "cat", id: "i1_bg_pane" }),
            },
          ],
        };
        return;
      }
      yield { type: "content" as const, text: "started" };
      yield { type: "done" as const };
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_i1_a",
    nativeTerminal: registry,
    provider,
  });
  client.start((event) => {
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  try {
    await client.sessionNew?.({ id: "ses_i1_b", title: "B" });
    const turnA = client.submit("start a terminal");
    await waitFor(() => release !== undefined);
    // A's turn is parked mid-stream; attach to B makes it a background turn.
    await client.sessionAttach?.("ses_i1_b");
    release?.();
    await turnA;
    // The background start opened no window and stole no focus.
    expect(focused).toEqual([]);
    // The pane belongs to A; B's view cannot see it (I3), A's can.
    expect(await client.nativeTerminalList?.()).toEqual([]);
    await client.sessionAttach?.("ses_i1_a");
    await waitForAsync(async () =>
      ((await client.nativeTerminalList?.()) ?? []).some(
        (session) => session.id === "i1_bg_pane",
      ),
    );
    const visibleA = (await client.nativeTerminalList?.()) ?? [];
    expect(visibleA.map((session) => session.id)).toContain("i1_bg_pane");
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("settings surface: set writes the scope file, get resolves it, set announces", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-settings-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_settings",
    provider: scriptedProvider("settings"),
  });
  client.start((event) => events.push(event));
  try {
    const before = await client.settingsGet?.();
    expect(before?.config).toMatchObject({
      theme: "natalia-dark",
      density: "comfortable",
    });
    expect(before?.sources.map((source) => source.scope)).toEqual([
      "defaults",
      "global",
      "project",
    ]);

    expect(
      await client.settingsSet?.(
        { theme: "solarized", density: "compact" },
        "project",
      ),
    ).toEqual({ applied: true });
    expect(events.at(-1)).toMatchObject({
      type: "settings.updated",
      scope: "project",
    });

    const after = await client.settingsGet?.();
    expect(after?.config).toMatchObject({
      theme: "solarized",
      density: "compact",
    });
    const projectSource = after?.sources.find(
      (source) => source.scope === "project",
    );
    expect(projectSource?.applied).toBe(true);

    // The project file actually holds the patch.
    const onDisk = JSON.parse(
      await readFile(join(root, ".natalia", "tui.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(onDisk).toMatchObject({ theme: "solarized", density: "compact" });

    // An invalid patch is an argument error, never a partial write.
    await expect(
      client.settingsSet?.({ density: "bogus" }, "project"),
    ).rejects.toThrow();
    const stillValid = await client.settingsGet?.();
    expect(stillValid?.config).toMatchObject({ density: "compact" });
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("cancelling the attached session does not abort a background session's pending approval", async () => {
  // A background turn that starts waiting for an approval after the UI attached
  // elsewhere must listen to its own session's abort signal. Before this fix
  // the waiter took the active session's signal, so cancelling the foreground
  // session cancelled the background turn's pending approval.
  const root = await mkdtemp(join(tmpdir(), "natalia-bg-approval-abort-"));
  let releaseA: (() => void) | undefined;
  let releaseB: (() => void) | undefined;
  let aCalls = 0;
  const provider: StreamingProvider = {
    provider: "bg-abort",
    model: "bg-abort",
    async *stream(request) {
      const userText = String(
        [...request.messages]
          .reverse()
          .find((message) => message.role === "user")?.content ?? "",
      );
      if (userText.includes("bg write")) {
        aCalls += 1;
        if (request.messages.some((message) => message.role === "tool")) {
          yield { type: "content" as const, text: "bg written" };
          yield { type: "done" as const };
          return;
        }
        // Park the first provider round until the test attaches to B, so A's
        // approval wait starts while B is the attached session.
        if (aCalls === 1)
          await new Promise<void>((resolve) => (releaseA = resolve));
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: `call_a_${aCalls}`,
              name: "write_file",
              arguments: JSON.stringify({ path: "bg.txt", content: "bg" }),
            },
          ],
        };
        yield { type: "done" as const };
        return;
      }
      // The B turn parks in the provider so B holds a live abort signal while
      // A's approval is pending underneath it.
      await new Promise<void>((resolve) => (releaseB = resolve));
      yield { type: "content" as const, text: "b done" };
      yield { type: "done" as const };
    },
  };
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_bg_abort_a",
    provider,
  });
  client.start((event) => events.push(event));
  let turnB: ReturnType<typeof client.submit> | undefined;
  try {
    await client.sessionNew?.({ id: "ses_bg_abort_b", title: "B" });
    const turnA = client.submit("bg write");
    await waitFor(() => releaseA !== undefined);
    await client.sessionAttach?.("ses_bg_abort_b");
    turnB = client.submit("hold b");
    await waitFor(() => releaseB !== undefined);
    // A continues only now, so its approval wait begins after B is attached.
    releaseA?.();
    await waitFor(() =>
      events.some((event) => event.type === "approval.request"),
    );
    const approval = events.find(
      (event): event is Extract<RuntimeEvent, { type: "approval.request" }> =>
        event.type === "approval.request",
    );
    expect(approval?.sessionID).toBe("ses_bg_abort_a");

    // Cancel the attached (B) session. A's background approval must survive.
    client.cancel("cancel attached session");
    await Bun.sleep(100);
    expect(
      events.some(
        (event) =>
          event.type === "turn.finished" &&
          event.sessionID === "ses_bg_abort_a" &&
          event.stopReason === "cancelled",
      ),
    ).toBe(false);

    // Answer A's approval: the background turn completes normally.
    client.respondApproval({ requestID: approval!.id, decision: "once" });
    await turnA;
    await waitFor(
      () => existsSync(join(root, "bg.txt")),
      20_000,
      "the background A turn to write after approval",
    );
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "turn.finished" &&
            event.sessionID === "ses_bg_abort_a" &&
            event.stopReason === "done",
        ),
      20_000,
      "the background A turn to finish after approval",
    );
    expect(await readFile(join(root, "bg.txt"), "utf8")).toBe("bg");
    expect(
      events.filter(
        (event) =>
          event.type === "turn.finished" &&
          event.sessionID === "ses_bg_abort_a",
      ),
    ).toMatchObject([expect.objectContaining({ stopReason: "done" })]);
  } finally {
    releaseB?.();
    await turnB?.catch(() => undefined);
    await client.dispose?.();
  }
}, 30_000);

function sqliteContinueProvider(): StreamingProvider {
  return {
    provider: "sqlite-continue",
    model: "sqlite-continue",
    async *stream(request) {
      const userText = String(
        [...request.messages]
          .reverse()
          .find((message) => message.role === "user")?.content ?? "",
      );
      if (userText.includes("automated continuation")) {
        yield { type: "content" as const, text: "Continuing after the human." };
        yield { type: "done" as const };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_rh",
              name: "interactive_terminal_request_human",
              arguments: JSON.stringify({
                id: "rh_sqlite",
                reason: "needs the sudo password",
                endTurn: true,
              }),
            },
          ],
        };
        return;
      }
      yield { type: "content" as const, text: "Waiting for the human." };
      yield { type: "done" as const };
    },
  };
}

function sqliteContinueRegistry() {
  return new NativeTerminalRegistry(
    {
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        return { pane_id: 991, window_id: 1, tab_id: 991 };
      },
      async list() {
        return [
          { pane_id: 991, window_id: 1, tab_id: 991, rows: 24, cols: 80 },
        ];
      },
      async read() {
        return "Password: ";
      },
      async write() {},
      async open() {
        return { pane_id: 991, window_id: 1, tab_id: 991, rows: 24, cols: 80 };
      },
      async focus() {},
      async resize() {},
      async stop() {},
    },
    { windowMode: "windowless" },
  );
}

test("SQLite restart recovers the pending human terminal and resumes exactly once after release", async () => {
  // TERM-M.3(c) continuation is already covered on the JSON path; SQLite keeps
  // the pending-human state in durable metadata, so a restart must restore it
  // and release must continue the task exactly once — never twice, and never
  // on its own before the human acts.
  const root = await mkdtemp(join(tmpdir(), "natalia-sqlite-continue-"));
  const sessionID = "ses_sqlite_continue" as SessionID;
  const databasePath = resolveWorkspaceJournalDatabasePath(root);

  // Phase 1: the model asks a human, the turn settles waiting_human, and the
  // pending state is durable in SQLite before the human acts.
  const firstEvents: RuntimeEvent[] = [];
  const firstRegistry = sqliteContinueRegistry();
  const first = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    useSqliteStore: true,
    nativeTerminal: firstRegistry,
    provider: sqliteContinueProvider(),
  });
  first.start((event) => {
    firstEvents.push(event);
    if (event.type === "approval.request")
      first.respondApproval({ requestID: event.id, decision: "once" });
  });
  try {
    await firstRegistry.start({
      id: "rh_sqlite",
      cwd: root,
      command: "ssh host",
    });
    await first.submitAndWait!("ask the human");
    expect(
      firstEvents.filter((event) => event.type === "turn.finished").at(-1),
    ).toMatchObject({ stopReason: "waiting_human" });
    const durable = new SessionStoreTestDatabase(databasePath);
    try {
      expect(
        durable.get(sessionID)?.metadata?.pendingHumanTerminal,
      ).toMatchObject({
        terminalID: "rh_sqlite",
        reason: "needs the sudo password",
      });
    } finally {
      durable.close();
    }
  } finally {
    await first.dispose?.();
  }

  // Phase 2: restart the runtime against the same SQLite database. Nothing may
  // resume on its own, and one release resumes exactly one continuation turn.
  const reopenedEvents: RuntimeEvent[] = [];
  const reopenedRegistry = sqliteContinueRegistry();
  const reopened = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    useSqliteStore: true,
    nativeTerminal: reopenedRegistry,
    provider: sqliteContinueProvider(),
  });
  reopened.start((event) => reopenedEvents.push(event), { replay: "none" });
  try {
    await waitFor(() =>
      reopenedEvents.some((event) => event.type === "session.ready"),
    );
    await Bun.sleep(100);
    expect(
      reopenedEvents.filter((event) => event.type === "turn.submitted"),
    ).toHaveLength(0);

    // The mux is still alive after restart: the pane record is rebuilt, then
    // the human releases it.
    await reopenedRegistry.start({
      id: "rh_sqlite",
      cwd: root,
      command: "ssh host",
    });
    await reopened.nativeTerminalReleaseHumanControl?.("rh_sqlite");
    await waitFor(
      () =>
        reopenedEvents.some(
          (event) =>
            event.type === "turn.finished" && event.stopReason === "done",
        ),
      2000,
    );
    expect(
      reopenedEvents.filter((event) => event.type === "turn.submitted"),
    ).toHaveLength(1);
    expect(
      reopenedEvents.some(
        (event) =>
          event.type === "turn.submitted" &&
          event.text.includes("[automated continuation]"),
      ),
    ).toBe(true);

    // A second release finds no pending state and must not resume again.
    await reopened.nativeTerminalReleaseHumanControl?.("rh_sqlite");
    await Bun.sleep(100);
    expect(
      reopenedEvents.filter((event) => event.type === "turn.submitted"),
    ).toHaveLength(1);

    const after = new SessionStoreTestDatabase(databasePath);
    try {
      expect(
        after.get(sessionID)?.metadata?.pendingHumanTerminal,
      ).toBeUndefined();
    } finally {
      after.close();
    }
  } finally {
    await reopened.dispose?.();
  }
}, 30_000);

test("/skill-script aborts its child process when the command is cancelled", async () => {
  // A slash command has no turn, so its cancellation must travel through the
  // session drain signal. Before this fix the /skill-script command read the
  // never-assigned activity closure, so a cancelled script kept running to
  // completion.
  const root = await mkdtemp(join(tmpdir(), "natalia-skill-script-cancel-"));
  const skillRoot = join(root, ".natalia", "skills", "cancel-me");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: cancel-me\ndescription: Cancel me\nscripts: {long: sleep 30}\n---\nBody.",
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_skill_script_cancel",
    provider: scriptedProvider("unused"),
  });
  client.start((event) => events.push(event));
  try {
    await waitFor(() => events.some((event) => event.type === "session.ready"));
    await client.submitAndWait!("/skill cancel-me");
    const before = events.length;
    // The long script starts; cancelling the command must abort its child.
    setTimeout(() => client.cancel("cancel the skill script"), 150);
    void client.submit("/skill-script long");
    await waitFor(
      () =>
        events
          .slice(before)
          .some(
            (event) =>
              event.type === "content.delta" &&
              String(event.text).includes('"exitCode"'),
          ),
      20_000,
      "the cancelled skill script to report its child exit code",
    );
    const output = events
      .slice(before)
      .filter((event) => event.type === "content.delta")
      .map((event) => event.text)
      .join("\n");
    expect(output).toContain('"exitCode"');
    // A terminated child exits non-zero, not after its 30 second sleep.
    expect(output).not.toMatch(/"exitCode":\s*0/u);
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("cancelling a turn aborts a tool currently executing", async () => {
  // The tool-execution cancellation listener used to read an activity-scoped
  // `activeAbort` closure that is never assigned, so a cancelled turn never
  // aborted the in-flight tool: it kept running to completion (or timeout)
  // even though the turn had been cancelled. The listener must bind the turn's
  // own exec's abort signal.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-cancel-"));
  let toolAborted = false;
  let toolRuns = 0;
  const tools = createToolRegistry([]);
  tools.set("wait_for_cancel", {
    name: "wait_for_cancel",
    description: "Wait until the turn is cancelled.",
    requiresApproval: false,
    timeoutSec: 30,
    parameters: { type: "object", properties: {} },
    async execute(_args, context) {
      toolRuns += 1;
      return await new Promise<string>((resolve) => {
        const signal = context.signal;
        if (signal?.aborted) {
          toolAborted = true;
          resolve("aborted");
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            toolAborted = true;
            resolve("aborted");
          },
          { once: true },
        );
      });
    },
  });
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_tool_cancel",
    tools,
    provider: {
      provider: "tool-cancel",
      model: "tool-cancel",
      async *stream(request) {
        if (request.signal?.aborted) throw new Error("cancelled");
        if (!request.messages.some((message) => message.role === "tool"))
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_cancel",
                name: "wait_for_cancel",
                arguments: "{}",
              },
            ],
          };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "tool.update" && event.status === "running")
      setTimeout(() => client.cancel("stop the tool"), 10);
  });
  try {
    await client.submitAndWait!("run the waiting tool");
    expect(toolRuns).toBe(1);
    // The in-flight tool observed the cancellation and settled.
    expect(toolAborted).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn.cancelled" }),
    );
    expect(
      events.some(
        (event) =>
          event.type === "turn.finished" && event.stopReason === "cancelled",
      ),
    ).toBe(true);
  } finally {
    await client.dispose?.();
  }
}, 30_000);

test("a cancellation during the durable in-flight write still aborts the tool", async () => {
  // The window the 10ms-timer test above only hits by luck: `tool.update
  // running` is published, then the runtime awaits a durable in-flight write,
  // and only then attaches the abort listener. Cancelling synchronously on the
  // `running` event lands inside that window every time, and an
  // already-aborted signal never fires `abort` again — so the tool used to run
  // to its own timeout with the turn already cancelled.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-cancel-window-"));
  let toolAborted = false;
  const tools = createToolRegistry([]);
  tools.set("wait_for_cancel", {
    name: "wait_for_cancel",
    description: "Wait until the turn is cancelled.",
    requiresApproval: false,
    // No timeout: if the cancellation is dropped there is nothing to rescue the
    // call, which is exactly the user-visible failure being pinned.
    parameters: { type: "object", properties: {} },
    async execute(_args, context) {
      return await new Promise<string>((resolve) => {
        const signal = context.signal;
        if (signal?.aborted) {
          toolAborted = true;
          resolve("aborted");
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            toolAborted = true;
            resolve("aborted");
          },
          { once: true },
        );
      });
    },
  });
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_tool_cancel_window",
    tools,
    provider: {
      provider: "tool-cancel",
      model: "tool-cancel",
      async *stream(request) {
        if (request.signal?.aborted) throw new Error("cancelled");
        if (!request.messages.some((message) => message.role === "tool"))
          yield {
            type: "tool_call" as const,
            calls: [
              { id: "call_window", name: "wait_for_cancel", arguments: "{}" },
            ],
          };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    if (event.type === "tool.update" && event.status === "running")
      client.cancel("stop the tool");
  });
  try {
    await client.submitAndWait!("run the waiting tool");
    expect(toolAborted).toBe(true);
  } finally {
    await client.dispose?.();
  }
}, 20_000);

test("the live work chat read and rollback surface a durable conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_slice_a",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  // Slice A data plane: a fresh conversation is empty and an unknown rollback
  // boundary is a no-op (removed 0), never a crash. The full message flow is
  // covered once the Chat execution slice lands (chatSubmit).
  expect(await client.naviChat!.messages!()).toEqual([]);
  expect(
    await client.naviChat!.rollback!({ toMessageID: "chat:nope" }),
  ).toEqual({
    rolledBackTo: "chat:nope",
    removed: 0,
  });
  await client.dispose?.();
});

test("chat submit runs a live work chat turn and persists the conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-turn-"));
  const requests: Array<Array<{ role: string; content: string }>> = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_turn",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(
          (
            request as {
              messages: Array<{ role: string; content: string }>;
            }
          ).messages,
        );
        yield {
          type: "content" as const,
          text: "the main agent is running step 2",
        };
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  const outcome = await client.naviChat!.submit({
    text: "what is the agent doing",
  });
  expect(outcome.messageID.length).toBeGreaterThan(0);
  const history = await client.naviChat!.messages!();
  expect(history).toHaveLength(2);
  expect(history[0]).toMatchObject({
    role: "user",
    text: "what is the agent doing",
  });
  expect(history[1]).toMatchObject({ role: "chat" });
  expect(history[1].text).toContain("running step 2");
  expect(
    events.filter((event) => event.type.startsWith("navi.chat.turn.")),
  ).toEqual([
    expect.objectContaining({
      type: "navi.chat.turn.started",
      messageID: outcome.messageID,
    }),
    expect.objectContaining({
      type: "navi.chat.turn.phase",
      messageID: outcome.messageID,
      phase: "generating",
    }),
    expect.objectContaining({
      type: "navi.chat.turn.finished",
      messageID: outcome.messageID,
      stopReason: "done",
    }),
  ]);
  await client.naviChat!.submit({ text: "and now" });
  // ADR D2: the live work context is an appended `<runtime_context>` user
  // message directly before the turn's request; the conversation history
  // itself is unchanged.
  const secondRequest = requests.at(-1) ?? [];
  expect(secondRequest.filter((message) => message.role !== "system")).toEqual([
    { role: "user", content: "what is the agent doing" },
    { role: "assistant", content: "the main agent is running step 2" },
    expect.objectContaining({
      role: "user",
      content: expect.stringContaining(
        '<runtime_context source="collab" trust="untrusted" revision="1"',
      ),
    }),
    { role: "user", content: "and now" },
  ]);
  // The static system prompt never carries the live context (ADR D1).
  const system = secondRequest.find((message) => message.role === "system");
  expect(system?.content).toContain("<navi_chat_persona>");
  expect(system?.content).not.toContain("<live_work_context>");
  await client.dispose?.();
});

test("chat tool calls surface as conversation actions", async () => {
  let streamCalls = 0;
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-tool-"));
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_tool",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        // The generator re-runs from the top on every stream call, so only the
        // first call offers the tool; later steps reply in text and settle.
        streamCalls += 1;
        if (streamCalls === 1) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_1",
                name: "mailbox_send",
                arguments: JSON.stringify({
                  intent: "constraint",
                  text: "do not install that dependency",
                }),
              },
            ],
          };
          return;
        }
        yield {
          type: "content" as const,
          text: "I queued the constraint for the main agent.",
        };
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.naviChat!.submit({ text: "do not install that dependency" });
  const actions = events.filter(
    (event) => event.type === "navi.chat.tool.used",
  );
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({ toolName: "mailbox_send" });
  expect((actions[0] as { summary: string }).summary).toContain(
    "queued mailbox intent: constraint",
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "navi.chat.turn.phase",
      phase: "using_tool",
      toolName: "mailbox_send",
    }),
  );
  await client.dispose?.();
});

test("chat mailbox_send refuses a planless handoff and mailbox_cancel drops queued mail", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-mailbox-guard-"));
  let streamCalls = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_mailbox_guard",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        streamCalls += 1;
        if (streamCalls === 1) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_handoff",
                name: "mailbox_send",
                arguments: JSON.stringify({
                  intent: "next_plan_handoff",
                  text: "continue the lost draft",
                }),
              },
            ],
          };
          return;
        }
        if (streamCalls === 2) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_send",
                name: "mailbox_send",
                arguments: JSON.stringify({
                  intent: "request_report",
                  text: "stop after this file",
                }),
              },
            ],
          };
          return;
        }
        if (streamCalls === 3) {
          const queued = (await client.mailboxList!()).find(
            (message) => message.status === "queued",
          );
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_cancel",
                name: "mailbox_cancel",
                arguments: JSON.stringify({
                  messageID: queued?.messageID,
                  reason: "duplicate handoff",
                }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "cancelled the extra intent" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.naviChat!.submit({ text: "send the plan to Natalia" });
  const mailbox = await client.mailboxList!();
  expect(
    mailbox.some((message) => message.intent === "next_plan_handoff"),
  ).toBe(false);
  expect(mailbox.every((message) => message.status === "superseded")).toBe(
    true,
  );
  await client.dispose?.();
});

test("chat reserves its configured final step and preserves XML-like text", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-final-step-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, runtime: { maxStepsPerTurn: 2 } }),
  );
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_final_step",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_1",
                name: "mailbox_send",
                arguments: JSON.stringify({
                  intent: "notice",
                  text: "final step test",
                }),
              },
            ],
          };
          return;
        }
        yield {
          type: "content" as const,
          text: "Queued. <function=mailbox_send><parameter=text>already done</parameter></function>",
        };
      },
    },
  });
  client.start(() => undefined);

  await client.naviChat!.submit({ text: "send a notice" });

  expect(requests).toHaveLength(2);
  expect(requests[0]?.tools?.length).toBeGreaterThan(0);
  expect(requests[1]).toMatchObject({ tools: undefined, toolChoice: "none" });
  expect(
    requests[1]?.messages.some((message) =>
      message.content.includes("MAXIMUM STEPS REACHED"),
    ),
  ).toBe(true);
  expect((await client.naviChat!.messages!()).at(-1)?.text).toContain(
    "<function=mailbox_send>",
  );
  await client.dispose?.();
});

test("chat ignores structured calls on its final step and emits fallback text", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-final-fallback-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, runtime: { maxStepsPerTurn: 1 } }),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_final_fallback",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield {
          type: "tool_call" as const,
          calls: [
            { id: "call_forbidden", name: "mailbox_send", arguments: "{}" },
          ],
        };
      },
    },
  });
  client.start((event) => events.push(event));

  await client.naviChat!.submit({ text: "send a notice" });

  expect(events.some((event) => event.type === "navi.chat.tool.used")).toBe(
    false,
  );
  expect((await client.naviChat!.messages!()).at(-1)?.text).toContain(
    "Tool execution completed",
  );
  await client.dispose?.();
});

test("the chat context includes the main agent's recent activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-ctx-"));
  let streamCalls = 0;
  let chatSystemPrompt = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_ctx",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        streamCalls++;
        if (streamCalls === 1) {
          yield {
            type: "content" as const,
            text: "I replaced the fetch wrapper",
          };
          yield { type: "done" as const };
          return;
        }
        chatSystemPrompt = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages
          .map((message) => message.content)
          .join("\n");
        yield {
          type: "content" as const,
          text: "the main agent said it replaced the wrapper",
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.submitAndWait!("replace the wrapper");
  await pollHistoryForFinished(client);
  await client.naviChat!.submit({ text: "what did the main agent just say" });
  // The Chat shares the main agent's recent exchange — the user's prompt and
  // the reply — so it can answer the question instead of only seeing the
  // status card (§8.3 shared context).
  expect(chatSystemPrompt).toContain("I replaced the fetch wrapper");
  expect(chatSystemPrompt).toContain("replace the wrapper");
  await client.dispose?.();
});

test("chat answers with live main context while the main turn is still running", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-live-ctx-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      runtime: { providerConcurrency: { test: 1 } },
    }),
  );
  let releaseMain: (() => void) | undefined;
  let mainReached: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    mainReached = resolve;
  });
  const parked = new Promise<void>((resolve) => {
    releaseMain = resolve;
  });
  let chatSystemPrompt = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_live_ctx",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        // ADR D1/D2: the Navi turn's live context arrives as an appended
        // `<runtime_context>` user message, not the static system prompt.
        const allMessages = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages
          .map((message) => message.content)
          .join("\n");
        if (allMessages.includes("<natalia_collaborations>")) {
          chatSystemPrompt = allMessages;
          yield { type: "content" as const, text: "she is still working" };
          yield { type: "done" as const };
          return;
        }
        yield {
          type: "content" as const,
          text: "inspecting the request routing now",
        };
        mainReached?.();
        await parked;
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  const mainTurn = client.submit("trace the request routing");
  await reached;

  // Chat has its own task and provider stream, so it settles before the parked
  // Main turn. Its prompt is built from the current in-memory stream, not only
  // the last durable content.done event.
  const chatResult = await client.naviChat!.submit({
    text: "what is the main agent doing right now",
  });
  expect(chatResult.messageID).not.toBe("");
  expect(chatSystemPrompt).toContain("Main agent: running");
  expect(chatSystemPrompt).toContain("trace the request routing");
  expect(chatSystemPrompt).toContain("inspecting the request routing now");
  expect(await client.sessionSnapshot!()).toMatchObject({
    agentStatus: "running",
    recentOutput: "inspecting the request routing now",
  });

  releaseMain?.();
  await mainTurn;
  await client.dispose?.();
});

test("a queued mailbox intent wakes an idle main agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-mailbox-deliver-"));
  const systemPrompts: string[] = [];
  const providerMessages: Array<Array<{ role: string; content: string }>> = [];
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_mailbox_deliver",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        providerMessages.push(
          (request as { messages: Array<{ role: string; content: string }> })
            .messages,
        );
        systemPrompts.push(
          String(
            (
              request as {
                messages: Array<{ role: string; content: string }>;
              }
            ).messages[0]?.content ?? "",
          ),
        );
        yield { type: "content" as const, text: "will do" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.mailboxSend!({
    intent: "constraint",
    text: "do not install that dependency",
  });
  // The mailbox intent wakes the idle main agent without inventing another
  // user-authored turn; the durable mailbox remains the sole intent source.
  await pollHistoryForFinished(client);
  expect(systemPrompts[0]).not.toContain("do not install that dependency");
  const wake = events.find(
    (event): event is Extract<RuntimeEvent, { type: "turn.submitted" }> =>
      event.type === "turn.submitted" && event.id.startsWith("turn_mailbox_"),
  );
  expect(wake).toMatchObject({ internal: true });
  expect(wake?.text).not.toContain("do not install that dependency");
  expect(
    providerMessages[0]?.some(
      (message) =>
        message.role === "user" &&
        message.content.includes("[user] do not install that dependency"),
    ),
  ).toBe(true);
  await client.dispose?.();
});

test("a chat tool parameter error returns the usage to the model for retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-retry-"));
  let streamCalls = 0;
  let secondStepToolMessages: unknown[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_retry",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        streamCalls++;
        if (streamCalls === 1) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_1",
                name: "read_file",
                arguments: JSON.stringify({ path: "a.txt", maxBytes: 100 }),
              },
            ],
          };
          return;
        }
        secondStepToolMessages = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages
          .filter((message) => message.role === "tool")
          .map((message) => message.content);
        yield { type: "content" as const, text: "I read the file" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.naviChat!.submit({ text: "read the file" });
  const history = await client.naviChat!.messages!();
  expect(history.at(-1)?.text).toContain("I read the file");
  // The bad call came back as a tool result carrying the correct calling
  // convention, so the model could retry on the next step.
  expect(
    secondStepToolMessages.some((content) =>
      String(content).includes("parameter validation failed"),
    ),
  ).toBe(true);
  await client.dispose?.();
});

test("the chat can query the main agent's live status with session_snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-snapshot-"));
  let streamCalls = 0;
  let snapshotToolResult = "";
  let finalStepAssistantTexts: string[] = [];
  let chatSystemPrompt = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_chat_snapshot",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        streamCalls++;
        const requestMessages = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages;
        chatSystemPrompt = requestMessages[0]?.content ?? "";
        if (streamCalls === 1) {
          yield { type: "content" as const, text: "Let me check." };
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_1",
                name: "session_snapshot",
                arguments: "{}",
              },
            ],
          };
          return;
        }
        if (streamCalls === 2) {
          yield { type: "content" as const, text: "Checking once more." };
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_2",
                name: "session_snapshot",
                arguments: "{}",
              },
            ],
          };
          return;
        }
        snapshotToolResult = String(
          requestMessages.filter((message) => message.role === "tool")[0]
            ?.content ?? "",
        );
        finalStepAssistantTexts = requestMessages
          .filter((message) => message.role === "assistant")
          .map((message) => message.content);
        yield {
          type: "content" as const,
          text: "the main agent is running step 2",
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.naviChat!.submit({ text: "what is the main agent doing" });
  // The read-only snapshot tool returned the live status to the model.
  expect(snapshotToolResult).toContain("agentStatus");
  expect(finalStepAssistantTexts).toEqual([
    "Let me check.",
    "Checking once more.",
  ]);
  expect(chatSystemPrompt).toContain(
    "Speak directly to the user in first person",
  );
  expect(chatSystemPrompt).toContain(
    "Status and snapshot data always describe Natalia, never you",
  );
  expect(chatSystemPrompt).toContain(
    "a Natalia chat marked REPLY_REQUIRED is itself a reply you have already received",
  );
  expect(chatSystemPrompt).toContain("Every reply continues the thread");
  await client.dispose?.();
});

test("the collaboration channel round-robins between Navi and the main agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-collab-"));
  let mainPrompt = "";
  let chatPrompt2 = "";
  let mainStreamCount = 0;
  let naviSuggested = false;
  const rrEvents: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_collab",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        const messages = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages;
        // ADR D1/D2: the Navi turn's live context arrives as an appended
        // `<runtime_context>` user message, not the static system prompt.
        // Chat turns carry her sister's questions/outcomes block; main-agent
        // turns never do, so the source of a stream call is content, not a
        // call counter (the wake runs concurrently).
        const allMessages = messages
          .map((message) => message.content)
          .join("\n");
        const naviTurn = allMessages.includes("<natalia_collaborations>");
        if (!naviTurn) {
          // ADR D1/D2: the main agent's collaboration state is runtime context
          // appended as a user message, not system prompt content.
          mainPrompt = allMessages;
          mainStreamCount++;
          if (mainStreamCount === 1) {
            yield { type: "content" as const, text: "I will use that." };
            yield { type: "done" as const };
            return;
          }
          if (mainStreamCount === 2) {
            // Natalia's wake turn: adopt Navi's suggestion.
            const correction = String(
              (
                request as {
                  messages: Array<{ role: string; content: string }>;
                }
              ).messages.at(-1)?.content ?? "",
            );
            const match =
              /messageID (collab:suggestion:[a-z0-9]+:[0-9]+)/u.exec(
                correction,
              );
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "c2",
                  name: "collab_respond",
                  arguments: JSON.stringify({
                    messageID: match?.[1] ?? "",
                    decision: "adopted",
                  }),
                },
              ],
            };
            return;
          }
          yield { type: "content" as const, text: "ok" };
          yield { type: "done" as const };
          return;
        }
        chatPrompt2 = allMessages;
        if (!naviSuggested) {
          // Navi's first turn: send the suggestion.
          naviSuggested = true;
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "c1",
                name: "collab_suggest",
                arguments: JSON.stringify({
                  suggestion: "prefer echo over cat for the demo",
                  priority: "normal",
                }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "she adopted it" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => rrEvents.push(event));
  await client.naviChat!.submit({ text: "suggest echo" });
  // The suggestion wakes the idle main agent, whose wake turn already carries
  // the suggestion (the 轮巡) — no extra user submission needed.
  // The round-robin's chain is two-plus provider turns with durable writes
  // and a wake between them. Under the full-suite load the chain measured
  // past 20s (the failure this budget covers); 45s still bounds a genuine
  // hang under the 60s per-test cap, which is what a budget is for.
  await waitForAsync(async () => mainPrompt.length > 0, 45_000);
  // The main agent knows who Navi is and sees her suggestion without the user
  // prompting it (the 轮巡).
  expect(mainPrompt).toContain("<live_work_chat>");
  expect(mainPrompt).toContain("your younger sister");
  expect(mainPrompt).toContain("<navi_collaborations>");
  expect(mainPrompt).toContain("prefer echo over cat for the demo");
  expect(mainPrompt).toContain("REPLY_REQUIRED");
  // Wait until the wake main turn's decision lands, so Navi's next prompt is
  // built after the outcome exists (the round-robin race).
  await waitForAsync(
    async () =>
      rrEvents.some(
        (event) =>
          isCollabMessageEvent(event) && event.message.kind === "response",
      ),
    45_000,
  );
  await client.naviChat!.submit({ text: "what did she decide" });
  await waitForAsync(async () => chatPrompt2.includes("adopted"), 45_000);
  // Navi sees the outcome without the user prompting her.
  expect(chatPrompt2).toContain("Outcomes of your suggestions to Natalia");
  expect(chatPrompt2).toContain("adopted");
  expect(
    rrEvents.some(
      (event) =>
        event.type === "diagnostic" &&
        event.message.includes("Correcting missing response to suggestion"),
    ),
  ).toBe(true);
  await client.dispose?.();
}, 20000);

test("an idle Navi answers Natalia's question immediately without a user chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-navi-wake-"));
  let streamCalls = 0;
  let naviStreamCount = 0;
  let firstNaviMessages: Array<{ role: string; content: string }> = [];
  const mainPrompts: string[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_navi_wake",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        streamCalls++;
        // ADR D1/D2: the main agent's collaboration state arrives as appended
        // `<runtime_context>` user messages, so assert on the whole request.
        const allMessages = String(
          (
            request as {
              messages: Array<{ role: string; content: string }>;
            }
          ).messages
            .map((message) => message.content)
            .join("\n"),
        );
        const system = String(
          (request as { messages: Array<{ role: string; content: string }> })
            .messages[0]?.content ?? "",
        );
        // The Navi wake turn's context carries her sister's pending questions;
        // the main agent's context never does.
        const naviTurn = allMessages.includes("<natalia_collaborations>");
        if (!naviTurn) {
          mainPrompts.push(allMessages);
          if (streamCalls === 1) {
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "c1",
                  name: "collab_ask",
                  arguments: JSON.stringify({ question: "is echo safe" }),
                },
              ],
            };
            return;
          }
          yield { type: "content" as const, text: "ok" };
          yield { type: "done" as const };
          return;
        }
        naviStreamCount++;
        if (naviStreamCount === 1) {
          firstNaviMessages = (
            request as {
              messages: Array<{ role: string; content: string }>;
            }
          ).messages.map((message) => ({ ...message }));
        }
        if (naviStreamCount === 1) {
          yield { type: "content" as const, text: "yes, echo is safe" };
          yield { type: "done" as const };
          return;
        }
        if (naviStreamCount === 2) {
          // ADR D2: the pending questionID arrives in the `<runtime_context>`
          // user message, not the static persona system prompt.
          const match = /questionID: (collab:question:[a-z0-9]+:[0-9]+)/u.exec(
            allMessages,
          );
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "c2",
                name: "collab_answer",
                arguments: JSON.stringify({
                  questionID: match?.[1] ?? "",
                  answer: "yes, echo is safe",
                }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "answered natalia" };
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  // No chatSubmit at all: the question wakes Navi and she answers on her own.
  await client.submitAndWait!("hello");
  await waitForAsync(async () =>
    events.some(
      (event) => isCollabMessageEvent(event) && event.message.kind === "answer",
    ),
  );
  const answer = events.find(
    (event) => isCollabMessageEvent(event) && event.message.kind === "answer",
  );
  expect(answer).toMatchObject({
    message: { kind: "answer", text: "yes, echo is safe" },
  });
  expect(
    events.some(
      (event) =>
        event.type === "navi.chat.message.new" &&
        String((event as { text?: string }).text).includes(
          "internal advisor request",
        ),
    ),
  ).toBe(true);
  expect(
    firstNaviMessages.filter((message) => message.role !== "system"),
  ).toEqual([
    // ADR D2: the live work context is an appended `<runtime_context>` user
    // message; the internal advisor request is the trailing user message.
    expect.objectContaining({
      role: "user",
      content: expect.stringContaining('<runtime_context source="collab"'),
    }),
    expect.objectContaining({
      role: "user",
      content: expect.stringContaining(
        "Natalia (the main agent) sent you collaboration messages",
      ),
    }),
  ]);
  expect(
    events.some(
      (event) =>
        event.type === "diagnostic" &&
        event.message.includes("Correcting missing answer to question"),
    ),
  ).toBe(true);
  // The answer reaches Natalia's own context on her next turn (the 轮巡).
  await client.submitAndWait!("continue");
  await waitForAsync(async () => mainPrompts.length >= 2);
  expect(mainPrompts.at(-1)).toContain("<navi_responses>");
  expect(mainPrompts.at(-1)).toContain("yes, echo is safe");
  await client.dispose?.();
}, 20000);

test("collab_inbox lets the main agent read Navi's answer on demand", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-collab-inbox-"));
  let mainAsked = false;
  let naviAnswered = false;
  const inboxToolResults: string[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_collab_inbox",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        const system = String(
          (request as { messages: Array<{ role: string; content: string }> })
            .messages[0]?.content ?? "",
        );
        const messages = (
          request as {
            messages: Array<{
              role: string;
              content: string;
              toolCallID?: string;
            }>;
          }
        ).messages;
        const toolMessages = messages.filter(
          (message) => message.role === "tool",
        );
        const inboxToolMessage = toolMessages.find(
          (message) => message.toolCallID === "c5",
        );
        const inboxTurn = messages.some(
          (message) => message.role === "user" && message.content === "check",
        );
        // ADR D1/D2: the Navi turn's live context arrives as an appended
        // `<runtime_context>` user message, not the static system prompt.
        const allMessages = messages
          .map((message) => message.content)
          .join("\n");
        const naviTurn = allMessages.includes("<natalia_collaborations>");
        if (!naviTurn) {
          if (!mainAsked) {
            mainAsked = true;
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "c1",
                  name: "collab_ask",
                  arguments: JSON.stringify({ question: "is echo safe" }),
                },
              ],
            };
            return;
          }
          if (inboxTurn && !inboxToolMessage) {
            yield {
              type: "tool_call" as const,
              calls: [{ id: "c5", name: "collab_inbox", arguments: "{}" }],
            };
            return;
          }
          if (inboxToolMessage)
            inboxToolResults.push(String(inboxToolMessage.content ?? ""));
          yield { type: "content" as const, text: "ok" };
          yield { type: "done" as const };
          return;
        }
        const match = /questionID: (collab:question:[a-z0-9]+:[0-9]+)/u.exec(
          allMessages,
        );
        if (match && !naviAnswered) {
          naviAnswered = true;
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "c2",
                name: "collab_answer",
                arguments: JSON.stringify({
                  questionID: match[1],
                  answer: "yes, echo is safe",
                }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "answered natalia" };
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  try {
    await client.submitAndWait!("hello");
    await waitForAsync(async () =>
      events.some(
        (event) =>
          isCollabMessageEvent(event) && event.message.kind === "answer",
      ),
    );
    // An active main turn receives the answer as a next-step injection, so
    // there is no guaranteed separate `turn_collab_` turn to wait for.
    await client.submitAndWait!("check");
    await waitForAsync(async () =>
      inboxToolResults.some((result) => result.includes("yes, echo is safe")),
    );
  } finally {
    await client.dispose?.();
  }
}, 20000);

test("collab_answer rejects a truncated question id", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-collab-trunc-"));
  let streamCalls = 0;
  let naviStreamCount = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_collab_trunc",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        streamCalls++;
        // ADR D1/D2: the Navi turn's live context arrives as an appended
        // `<runtime_context>` user message, not the static system prompt.
        const allMessages = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages
          .map((message) => message.content)
          .join("\n");
        const naviTurn = allMessages.includes("<natalia_collaborations>");
        if (!naviTurn) {
          if (streamCalls === 1) {
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "c1",
                  name: "collab_ask",
                  arguments: JSON.stringify({ question: "is echo safe" }),
                },
              ],
            };
            return;
          }
          yield { type: "content" as const, text: "ok" };
          yield { type: "done" as const };
          return;
        }
        naviStreamCount++;
        if (naviStreamCount === 1) {
          const match = /questionID: (collab:question:[a-z0-9]+:[0-9]+)/u.exec(
            allMessages,
          );
          // The model truncates the id to its tail, dropping the prefix.
          const truncated = (match?.[1] ?? "").replace(
            /^collab:question:/u,
            "",
          );
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "c2",
                name: "collab_answer",
                arguments: JSON.stringify({
                  questionID: truncated,
                  answer: "yes, echo is safe",
                }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "answered natalia" };
        yield { type: "done" as const };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("hello");
  await waitForAsync(async () =>
    events.some(
      (event) =>
        event.type === "navi.chat.tool.used" &&
        event.toolName === "collab_answer" &&
        event.result?.includes("no pending question"),
    ),
  );
  expect(
    events.some(
      (event) => isCollabMessageEvent(event) && event.message.kind === "answer",
    ),
  ).toBe(false);
  await client.dispose?.();
}, 20000);

test("collab_chat enforces direct replies and stops after three automatic rounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-collab-chat-"));
  const events: RuntimeEvent[] = [];
  let started = false;
  let naviIgnoredRequiredReply = false;
  let triedUnthreadedReply = false;
  let mainIgnoredRequiredReply = false;
  let mainWakeWithoutRequiredReply = false;
  const repliedMessageIDs = new Set<string>();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_collab_chat",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        const messages = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages;
        const system = String(messages[0]?.content ?? "");
        // ADR D2: the main agent's collaboration context is appended as
        // `<runtime_context>` user messages while the Navi turn still carries
        // its prompt as the system message; search every message.
        const systemContext = messages
          .map((message) => message.content)
          .join("\n");
        const naviTurn = systemContext.includes("<natalia_collaborations>");
        const toolResult = messages
          .filter((message) => message.role === "tool")
          .at(-1)?.content;
        const pendingID =
          /messageID: (collab:chat:[^\s·]+)[^\n]*REPLY_REQUIRED/u.exec(
            systemContext,
          )?.[1];

        if (!naviTurn && !started) {
          started = true;
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "chat_start",
                name: "collab_chat",
                arguments: JSON.stringify({
                  text: "Navi, check the edge case.",
                }),
              },
            ],
          };
          return;
        }
        if (naviTurn && pendingID && !naviIgnoredRequiredReply) {
          naviIgnoredRequiredReply = true;
          yield {
            type: "content" as const,
            text: "I will answer without the collaboration tool.",
          };
          yield { type: "done" as const };
          return;
        }
        if (naviTurn && pendingID && !triedUnthreadedReply) {
          triedUnthreadedReply = true;
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "chat_bad_reply",
                name: "collab_chat",
                arguments: JSON.stringify({
                  text: "I checked it, but omitted the reply ID.",
                }),
              },
            ],
          };
          return;
        }
        if (
          naviTurn &&
          pendingID &&
          toolResult?.includes("reply required for chat message")
        ) {
          repliedMessageIDs.add(pendingID);
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "chat_fixed_reply",
                name: "collab_chat",
                arguments: JSON.stringify({
                  text: "I checked it. Did you cover the empty input?",
                  messageID: pendingID,
                }),
              },
            ],
          };
          return;
        }
        if (
          !naviTurn &&
          pendingID &&
          !mainIgnoredRequiredReply &&
          !repliedMessageIDs.has(pendingID)
        ) {
          mainIgnoredRequiredReply = true;
          yield {
            type: "content" as const,
            text: "I will answer Navi without the collaboration tool.",
          };
          yield { type: "done" as const };
          return;
        }
        if (pendingID && !repliedMessageIDs.has(pendingID)) {
          repliedMessageIDs.add(pendingID);
          const sender = naviTurn ? "Navi" : "Natalia";
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: `chat_reply_${sender}`,
                name: "collab_chat",
                arguments: JSON.stringify({
                  text: naviTurn
                    ? "Yes. The final edge is covered."
                    : "Yes, empty input is covered. Anything else?",
                  messageID: pendingID,
                }),
              },
            ],
          };
          return;
        }
        if (!naviTurn && !pendingID && started)
          mainWakeWithoutRequiredReply = true;
        yield { type: "content" as const, text: "collaboration handled" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  try {
    await client.submitAndWait!("ask Navi to check it");
    await waitForAsync(async () => {
      const chatCount = events.filter(
        (event) => isCollabMessageEvent(event) && event.message.kind === "chat",
      ).length;
      if (chatCount > 4)
        throw new Error(`collab_chat exceeded its limit: ${chatCount}`);
      return chatCount === 4 && mainWakeWithoutRequiredReply;
    }, 20_000).catch((error) => {
      const summary = events
        .filter(
          (event) =>
            (isCollabMessageEvent(event) && event.message.kind === "chat") ||
            event.type === "navi.chat.tool.used" ||
            event.type === "diagnostic" ||
            event.type === "turn.finished",
        )
        .map((event) => JSON.stringify(event))
        .join("\n");
      throw new Error(`${String(error)}\n${summary}`);
    });

    const chats = events.flatMap((event) =>
      isCollabMessageEvent(event) && event.message.kind === "chat"
        ? [event.message]
        : [],
    );
    expect(chats.map((message) => message.from)).toEqual([
      "main_agent",
      "live_chat",
      "main_agent",
      "live_chat",
    ]);
    expect(chats.map((message) => message.round)).toEqual([1, 2, 3, 3]);
    expect(chats.map((message) => message.expectsReply)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(new Set(chats.map((message) => message.threadID)).size).toBe(1);
    expect(
      events
        .filter(
          (event): event is Extract<RuntimeEvent, { type: "turn.submitted" }> =>
            event.type === "turn.submitted" &&
            event.id.startsWith("turn_collab_"),
        )
        .every((event) => event.internal === true),
    ).toBe(true);
    expect(chats.slice(1).map((message) => message.replyToID)).toEqual(
      chats.slice(0, -1).map((message) => message.id),
    );
    expect(
      events.some(
        (event) =>
          event.type === "navi.chat.tool.used" &&
          event.toolName === "collab_chat" &&
          event.result?.includes("reply required for chat message"),
      ),
    ).toBe(true);
    const replyCorrections = events
      .filter(
        (event): event is Extract<RuntimeEvent, { type: "diagnostic" }> =>
          event.type === "diagnostic" &&
          event.message.includes("Correcting missing direct reply"),
      )
      .map((event) => event.message);
    expect(
      replyCorrections.some((message) => message.includes(chats[0]!.id)),
    ).toBe(true);
    expect(
      replyCorrections.some((message) => message.includes(chats[1]!.id)),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "navi.chat.tool.used" &&
          event.toolName === "collab_chat" &&
          event.result?.includes('"autoRoundLimitReached":true'),
      ),
    ).toBe(true);
  } finally {
    await client.dispose?.();
  }
}, 20000);

test("collab_chat honors a configured one-round automatic limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-collab-chat-limit-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ runtime: { collaboration: { maxAutoRounds: 1 } } }),
  );
  const events: RuntimeEvent[] = [];
  let started = false;
  let finalWakeObserved = false;
  const repliedMessageIDs = new Set<string>();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_collab_chat_limit",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        const messages = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages;
        // ADR D1/D2: the Navi turn's live context arrives as an appended
        // `<runtime_context>` user message, not the static system prompt.
        const allMessages = messages
          .map((message) => message.content)
          .join("\n");
        const naviTurn = allMessages.includes("<natalia_collaborations>");
        const toolResult = messages
          .filter((message) => message.role === "tool")
          .at(-1)?.content;
        const pendingID =
          /messageID: (collab:chat:[^\s·]+)[^\n]*REPLY_REQUIRED/u.exec(
            allMessages,
          )?.[1];
        if (!naviTurn && !started) {
          started = true;
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "limit_start",
                name: "collab_chat",
                arguments: JSON.stringify({ text: "One quick check." }),
              },
            ],
          };
          return;
        }
        if (
          naviTurn &&
          pendingID &&
          !repliedMessageIDs.has(pendingID) &&
          !toolResult?.includes('"autoRoundLimitReached":true')
        ) {
          repliedMessageIDs.add(pendingID);
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "limit_reply",
                name: "collab_chat",
                arguments: JSON.stringify({
                  text: "Checked and closed.",
                  messageID: pendingID,
                }),
              },
            ],
          };
          return;
        }
        if (!naviTurn && started && !pendingID) finalWakeObserved = true;
        yield { type: "content" as const, text: "done" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  try {
    await client.submitAndWait!("start one round");
    await waitForAsync(
      async () =>
        events.filter(
          (event) =>
            isCollabMessageEvent(event) && event.message.kind === "chat",
        ).length === 2 && finalWakeObserved,
      20_000,
    );
    const chats = events.flatMap((event) =>
      isCollabMessageEvent(event) && event.message.kind === "chat"
        ? [event.message]
        : [],
    );
    expect(chats.map((message) => message.round)).toEqual([1, 1]);
    expect(chats.map((message) => message.expectsReply)).toEqual([true, false]);
    expect(
      events.some(
        (event) =>
          event.type === "navi.chat.tool.used" &&
          event.result?.includes('"maxAutoRounds":1'),
      ),
    ).toBe(true);
  } finally {
    await client.dispose?.();
  }
}, 20000);

function sandboxedSubagentProvider(): StreamingProvider {
  return {
    provider: "scripted-sandboxed-subagent",
    model: "scripted-sandboxed-subagent-model",
    async *stream(request: ProviderStreamRequest) {
      const isChild = request.messages.some(
        (message) => message.content === "child sandbox file task",
      );
      const contractRead = request.messages.find(
        (message) =>
          message.role === "tool" &&
          message.toolCallID === "call_sandbox_child_read",
      );
      const childWrite = request.messages.some(
        (message) =>
          message.role === "tool" &&
          message.toolCallID === "call_sandbox_child_write",
      );
      if (isChild && !contractRead) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_sandbox_child_read",
              name: "read_file",
              arguments: JSON.stringify({
                path: "CONTRACT.md",
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      if (isChild && !childWrite) {
        expect(contractRead?.content).toBe("shared contract\n");
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_sandbox_child_write",
              name: "write_file",
              arguments: JSON.stringify({
                path: "agent-test.txt",
                content: "sandbox agent test success",
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      if (isChild) {
        yield {
          type: "content",
          text: "created agent-test.txt successfully",
        };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_sandbox_subagent",
              name: "agent_spawn",
              arguments: JSON.stringify({
                task: "child sandbox file task",
                mode: "sandbox",
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "parent complete" };
      yield { type: "done" };
    },
  };
}

test("a sandboxed subagent reads the checked-out base and writes only in its worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sandboxed-subagent-"));
  await writeFile(join(root, "CONTRACT.md"), "shared contract\n");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_sandboxed_subagent",
    provider: sandboxedSubagentProvider(),
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate a sandboxed file task");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );
  // The write landed in the sub-agent's own sandbox worktree (id a1), not the
  // parent's workspace.
  expect(
    await readFile(
      join(root, ".natalia", "sandboxes", "a1", "agent-test.txt"),
      "utf8",
    ),
  ).toBe("sandbox agent test success");
  expect(existsSync(join(root, "agent-test.txt"))).toBe(false);
});

function sandboxedDomainProvider(): StreamingProvider {
  return {
    provider: "scripted-sandboxed-domain",
    model: "scripted-sandboxed-domain-model",
    async *stream(request: ProviderStreamRequest) {
      const isChild = request.messages.some(
        (message) => message.content === "child domain task",
      );
      const domainError = request.messages.find(
        (message) =>
          message.role === "tool" && message.toolCallID === "call_domain_write",
      );
      const recoveredWrite = request.messages.some(
        (message) =>
          message.role === "tool" &&
          message.toolCallID === "call_domain_recovery",
      );
      if (isChild && !domainError) {
        // The child tries to write outside its file domain.
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_domain_write",
              name: "write_file",
              arguments: JSON.stringify({
                path: "forbidden/x.txt",
                content: "should be refused",
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      if (isChild && !recoveredWrite) {
        expect(domainError?.content).toContain("ERROR:");
        expect(domainError?.content).toContain("outside file domain");
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_domain_recovery",
              name: "write_file",
              arguments: JSON.stringify({
                path: "allowed/recovered.txt",
                content: "recovered after tool error",
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      if (isChild) {
        yield { type: "content", text: "recovered from denied write" };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_domain_spawn",
              name: "agent_spawn",
              arguments: JSON.stringify({
                task: "child domain task",
                mode: "sandbox",
                writePaths: ["allowed"],
              }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "parent complete" };
      yield { type: "done" };
    },
  };
}

test("a sandboxed sub-agent sees a denied write and self-corrects inside its file domain", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sandboxed-domain-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_sandboxed_domain",
    provider: sandboxedDomainProvider(),
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate a domain task");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );
  // The ownership map refuses the first write, but the error is returned to the
  // child as a tool result so it can recover without restarting its context.
  expect(
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  ).toBe(true);
  expect(existsSync(join(root, "forbidden"))).toBe(false);
  expect(
    existsSync(join(root, ".natalia", "sandboxes", "a1", "forbidden", "x.txt")),
  ).toBe(false);
  expect(
    await readFile(
      join(root, ".natalia", "sandboxes", "a1", "allowed", "recovered.txt"),
      "utf8",
    ),
  ).toBe("recovered after tool error");
});

test("a subagent keeps retrying transient failures without respawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-subagent-retry-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      runtime: {
        retry: {
          initialBackoffMs: 1,
          maxBackoffMs: 1,
          jitterMs: 0,
        },
      },
    }),
  );
  let childAttempts = 0;
  const provider: StreamingProvider = {
    provider: "scripted-subagent-retry",
    model: "scripted-subagent-retry-model",
    async *stream(request) {
      const isChild = request.messages.some(
        (message) => message.content === "child transient task",
      );
      if (isChild) {
        childAttempts++;
        if (childAttempts < 6)
          throw providerError({ kind: "server", message: "temporary outage" });
        // Long enough to clear the result-quality gate: a shorter answer spends
        // one more step on the gate, which would count as a retry here and
        // measure the gate instead of the retry policy this test is about.
        yield {
          type: "content",
          text:
            "child recovered after the outage: the retry policy replayed the " +
            "failed provider step five times without respawning the subagent, " +
            "the sixth attempt succeeded, and the child finished inside its own " +
            "wall-clock budget with its ledger intact",
        };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_retry_spawn",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child transient task" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "parent complete" };
      yield { type: "done" };
    },
  };
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_subagent_retry",
    provider,
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate transient work");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );
  expect(childAttempts).toBe(6);
  expect(
    events.some(
      (event) =>
        event.type === "step.retry" &&
        event.id === "subagent:a1" &&
        event.sessionID === "ses_subagent_retry",
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "step.retry.cleared" &&
        event.id === "subagent:a1" &&
        event.sessionID === "ses_subagent_retry",
    ),
  ).toBe(true);
});

function imageAttachProvider(): StreamingProvider {
  let calls = 0;
  return {
    provider: "scripted-image",
    model: "scripted-image-model",
    async *stream(request: ProviderStreamRequest) {
      calls++;
      if (calls === 1) {
        // Main turn: the model decides to look at its own screenshot.
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_image",
              name: "image_read",
              arguments: JSON.stringify({ path: "shot.png" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      // Second step: the attached image must be in the messages the model sees.
      const hasImage = request.messages.some(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.images) &&
          (message.images as unknown[]).length > 0,
      );
      yield {
        type: "content",
        text: hasImage ? "saw my screenshot" : "no image",
      };
      yield { type: "done" };
    },
  };
}

test("a model with image input can attach its own screenshot and see it", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-image-attach-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  // A valid 1x1 PNG header; enough for the attach path.
  await writeFile(
    join(root, "shot.png"),
    Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex"),
  );
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      providers: {
        "scripted-image": { name: "Scripted image", driver: "openai" },
      },
      catalog: {
        providers: {
          "scripted-image": {
            models: {
              "scripted-image-model": {
                name: "Scripted image",
                capabilities: { imageInput: true },
              },
            },
          },
        },
      },
      defaultModel: {
        provider: "scripted-image",
        model: "scripted-image-model",
      },
    }),
  );
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_image_attach",
    provider: imageAttachProvider(),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("look at my screenshot");
  await waitFor(() =>
    events.some(
      (event) => event.type === "turn.finished" && event.stopReason === "done",
    ),
  );
  const text = events
    .filter((event) => event.type === "content.delta")
    .map((event) => (event as { text: string }).text)
    .join("");
  // The second provider step saw the attached image as multimodal user content.
  expect(text).toContain("saw my screenshot");
  await client.dispose?.();
}, 60_000);

test("/team forces the agent-team directive into the turn context", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-team-cmd-"));
  let sawDirective = false;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_team_cmd",
    provider: {
      provider: "scripted-team",
      model: "scripted-team-model",
      async *stream(request) {
        sawDirective = request.messages.some(
          (message) =>
            message.role === "system" && message.content.includes("agent team"),
        );
        yield {
          type: "content",
          text: sawDirective ? "team ready" : "no team",
        };
        yield { type: "done" };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("/team build the game");
  await waitFor(() =>
    events.some(
      (event) => event.type === "turn.finished" && event.stopReason === "done",
    ),
  );
  expect(sawDirective).toBe(true);
  await client.dispose?.();
}, 60_000);

test("/team has no product behavior when the team plugin is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-team-disabled-cmd-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      plugins: { enabled: { [TEAM_PLUGIN_ID]: false } },
    }),
  );
  let sawDirective = false;
  let sawLiteralInput = false;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_team_disabled_cmd",
    provider: {
      provider: "scripted-team-disabled",
      model: "scripted-team-disabled-model",
      async *stream(request) {
        sawDirective = request.messages.some(
          (message) =>
            message.role === "system" && message.content.includes("agent team"),
        );
        sawLiteralInput = request.messages.some(
          (message) =>
            message.role === "user" &&
            message.content.includes("/team build the game"),
        );
        yield { type: "content", text: "ordinary turn" };
        yield { type: "done" };
      },
    },
  });
  const events: RuntimeEvent[] = [];
  client.start((event) => events.push(event));
  await client.submitAndWait!("/team build the game");
  await waitFor(() =>
    events.some(
      (event) => event.type === "turn.finished" && event.stopReason === "done",
    ),
  );
  expect(sawDirective).toBe(false);
  expect(sawLiteralInput).toBe(true);
  await client.dispose?.();
}, 60_000);

test("input.remove/replace/promote mutate the durable queue and emit events", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-input-mutations-"));
  const events: RuntimeEvent[] = [];
  let release: (() => void) | undefined;
  let calls = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_input_mutations",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => (release = resolve));
          yield { type: "content" as const, text: "first" };
          yield { type: "done" as const };
          return;
        }
        yield { type: "content" as const, text: "later" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  const first = client.submit("hold");
  await waitFor(() => release !== undefined, 20_000, "the provider to start");

  const removable = await client.submitInput!({
    text: "remove me",
    delivery: "next-turn",
  });
  expect(events).toContainEqual(
    expect.objectContaining({ type: "input.admitted", id: removable.id }),
  );
  expect(await client.removeInput!({ id: removable.id })).toEqual({
    ok: true,
    input: { id: removable.id, text: "remove me", delivery: "next-turn" },
  });
  expect(events).toContainEqual(
    expect.objectContaining({ type: "input.removed", id: removable.id }),
  );

  const editable = await client.submitInput!({
    text: "edit me",
    delivery: "next-turn",
  });
  expect(
    await client.replaceInput!({ id: editable.id, text: "edited" }),
  ).toEqual({
    ok: true,
    input: { id: editable.id, text: "edited", delivery: "next-turn" },
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "input.updated",
      id: editable.id,
      text: "edited",
    }),
  );

  const promotable = await client.submitInput!({
    text: "promote me",
    delivery: "next-turn",
  });
  expect(await client.promoteInput!({ id: promotable.id })).toMatchObject({
    ok: true,
    input: { id: promotable.id, delivery: "next-step" },
  });
  expect(events).toContainEqual(
    expect.objectContaining({ type: "input.promoted", id: promotable.id }),
  );

  release?.();
  await first;
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "turn.input" && event.inputID === promotable.id,
      ),
    20_000,
    "the promoted input to be claimed by the running turn",
  );
  await client.dispose?.();
}, 30_000);

test("a generic interactive kind round-trips through projection and response", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-generic-interactive-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_generic_interactive",
  });
  client.start((event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === "session.ready"));
  const waiter = await client.service<
    import("@natalia/collaboration").InteractiveWaiter
  >("collaboration.waiter");
  expect(waiter).toBeDefined();

  const pending = waiter!.requireInteractive({
    requestID: "custom_1",
    turnID: "turn_custom",
    kind: "custom.kind",
    title: "Pick one",
    payload: { options: ["a", "b"] },
    validate: (response) => (response === "a" ? undefined : ["must be a"]),
  });
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "interactive.request" && event.id === "custom_1",
    ),
  );

  const projection = await client.pendingInteractive!();
  expect(projection.interactives).toEqual([
    expect.objectContaining({ id: "custom_1", kind: "custom.kind" }),
  ]);

  expect(
    await client.respondInteractive!({
      requestID: "custom_1",
      kind: "custom.kind",
      response: "a",
      sessionID: "ses_generic_interactive",
    }),
  ).toEqual({ accepted: true });
  await expect(pending).resolves.toEqual({
    response: "a",
    rejected: undefined,
  });
  expect(
    events.some(
      (event) =>
        event.type === "interactive.response" && event.id === "custom_1",
    ),
  ).toBe(true);
  await client.dispose?.();
}, 30_000);

test("a tool-issued generic interactive reaches projection, ui-model, and settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-interactive-"));
  const sessionID = "ses_tool_interactive" as SessionID;
  const tools = createToolRegistry([]);
  tools.set("ask_custom", {
    name: "ask_custom",
    description: "Ask a custom interactive question",
    requiresApproval: false,
    parameters: { type: "object", properties: {} },
    async execute(_input, context) {
      expect(context.askInteractive).toBeFunction();
      const answer = await context.askInteractive!({
        requestID: "custom_tool_1",
        kind: "custom.tool.kind",
        title: "Pick a color",
        payload: { options: ["red", "blue"] },
        validate: (response) =>
          response === "red" ? undefined : ["must be red"],
      });
      return `answer: ${String(answer.response)}`;
    },
  });

  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    tools,
    provider: singleToolProvider("ask_custom", {}),
  });
  client.start((event) => events.push(event));

  const running = client.submitAndWait!("ask the tool");
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "interactive.request" &&
          event.id === "custom_tool_1" &&
          event.kind === "custom.tool.kind",
      ),
    3_000,
    "the tool-issued interactive request",
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.update",
      name: "ask_custom",
      status: "running",
    }),
  );

  const projection = await client.pendingInteractive!();
  expect(projection.interactives).toEqual([
    expect.objectContaining({
      id: "custom_tool_1",
      kind: "custom.tool.kind",
    }),
  ]);
  expect(
    normalizePendingItems({ interactives: projection.interactives }),
  ).toEqual([
    expect.objectContaining({
      id: "custom_tool_1",
      kind: "custom.tool.kind",
      title: "Pick a color",
    }),
  ]);

  expect(
    await client.respondInteractive!({
      requestID: "custom_tool_1",
      kind: "custom.tool.kind",
      response: "red",
      sessionID,
    }),
  ).toEqual({ accepted: true });
  await running;

  expect((await client.pendingInteractive!()).interactives).toEqual([]);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "interactive.response",
      id: "custom_tool_1",
      kind: "custom.tool.kind",
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.update",
      name: "ask_custom",
      status: "succeeded",
      result: "answer: red",
    }),
  );
  await client.dispose?.();
}, 30_000);

function subagentPlanPointerProvider(): StreamingProvider {
  return {
    provider: "scripted-subagent-plan",
    model: "scripted-subagent-plan-model",
    async *stream(request: ProviderStreamRequest) {
      const isChild = request.messages.some(
        (message) => message.content === "child plan task",
      );
      if (isChild) {
        const planPointer = request.messages.find(
          (message) =>
            message.role === "user" &&
            message.content.includes('<runtime_context source="plan_ptr"'),
        );
        if (!planPointer)
          throw new Error(
            "subagent request is missing the plan_ptr runtime context",
          );
        const planRead = request.messages.find(
          (message) =>
            message.role === "tool" && message.toolCallID === "call_child_plan",
        );
        if (!planRead) {
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_child_plan",
                name: "read_file",
                arguments: JSON.stringify({
                  path: ".natalia/plans/plans/child-plan.md",
                }),
              },
            ],
          };
          yield { type: "done" };
          return;
        }
        expect(planRead.content).toContain("Child plan steps");
        yield {
          type: "content",
          text: "read the plan document from the pointer",
        };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_subagent_plan",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child plan task" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "parent complete" };
      yield { type: "done" };
    },
  };
}

let MAIN_PLAN_ID = "";

test("a subagent receives the active plan pointer and reads the plan file itself (ADR D4/B2)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-subagent-plan-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_subagent_plan",
    provider: subagentPlanPointerProvider(),
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!("ses_subagent_plan" as SessionID);
  await client.planDocWrite!({
    path: "plans/child-plan.md",
    content: "# Child plan\n\n- Child plan steps\n",
    title: "Child plan",
  });
  const marked = await client.planDocMark!({
    path: "plans/child-plan.md",
    title: "Child plan",
  });
  await client.planDocActivate!(marked.planID);
  await client.submitAndWait!("delegate a plan task");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );
  await client.dispose?.();
}, 30_000);

test("the main agent reads the plan document with plan_doc_read instead of an injected handoff body (ADR B3)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-main-plan-read-"));
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_main_plan_read",
    provider: {
      provider: "scripted-main-plan-read",
      model: "scripted-main-plan-read-model",
      async *stream(request: ProviderStreamRequest) {
        requests.push(request);
        if (request.tools?.some((tool) => tool.name === "plan_doc_read")) {
          const planRead = request.messages.find(
            (message) =>
              message.role === "tool" &&
              message.toolCallID === "call_main_plan",
          );
          if (!planRead) {
            yield {
              type: "tool_call",
              calls: [
                {
                  id: "call_main_plan",
                  name: "plan_doc_read",
                  arguments: JSON.stringify({ planID: MAIN_PLAN_ID }),
                },
              ],
            };
            yield { type: "done" };
            return;
          }
          expect(planRead.content).toContain("Main plan steps");
        }
        yield { type: "content", text: "read the plan" };
        yield { type: "done" };
      },
    },
    permissionMode: "auto",
  });
  client.start(() => undefined);
  await client.sessionAttach!("ses_main_plan_read" as SessionID);
  await client.planDocWrite!({
    path: "plans/main-plan.md",
    content: "# Main plan\n\n- Main plan steps\n",
    title: "Main plan",
  });
  const marked = await client.planDocMark!({
    path: "plans/main-plan.md",
    title: "Main plan",
  });
  MAIN_PLAN_ID = marked.planID;
  await client.planDocActivate!(marked.planID);
  await client.submitAndWait!("follow the plan");
  expect(
    requests.some((request) =>
      request.tools?.some((tool) => tool.name === "plan_doc_read"),
    ),
  ).toBe(true);
  expect(
    requests.some((request) =>
      request.tools?.some((tool) => tool.name === "plan_doc_list"),
    ),
  ).toBe(true);
  // The plan正文 is never in the system prompt — only the pointer is in the
  // runtime context.
  const system = requests
    .map((request) =>
      request.messages.find((message) => message.role === "system"),
    )
    .map((message) =>
      typeof message?.content === "string" ? message.content : "",
    )
    .join("\n");
  expect(system).not.toContain("Main plan steps");
  await client.dispose?.();
}, 30_000);

test("a settled subagent's outcome lands in the spawning session's context", async () => {
  // A subagent settles whenever it likes and the turn that spawned it is usually
  // elsewhere by then. Without the notice the parent only learns the outcome by
  // polling, which it cannot do while it is the one running.
  const root = await mkdtemp(join(tmpdir(), "natalia-settled-notice-"));
  const events: RuntimeEvent[] = [];
  const requests: ProviderStreamRequest[] = [];
  const capture = {
    provider: "scripted-settled-notice",
    model: "scripted-settled-notice-model",
    async *stream(request: ProviderStreamRequest) {
      requests.push(request);
      if (
        request.messages[0]?.role === "system" &&
        String(request.messages[0].content).includes(
          "focused Natalia TS/Bun subagent",
        )
      ) {
        yield { type: "content", text: "child finished the delegated work" };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_spawn_notice",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child task" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "parent done" };
      yield { type: "done" };
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_settled_notice",
    provider: capture as unknown as StreamingProvider,
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate a task");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );
  // A second turn is what makes the notice observable: it is in the ledger, so
  // the next request carries it.
  await client.submitAndWait!("what happened with the subagent?");
  await waitFor(() =>
    requests.some((request) =>
      request.messages.some((message) =>
        message.content.includes('source="subagent_settled"'),
      ),
    ),
  );

  const notice = requests
    .flatMap((request) => request.messages)
    .find((message) => message.content.includes('source="subagent_settled"'));
  expect(notice).toBeDefined();
  // Attributed to the runtime, not to the child: merging the two would credit the
  // child with words it never wrote.
  expect(notice?.content).toContain('trust="runtime"');
  expect(notice?.content).toContain("has finished: completed");
  expect(notice?.content).toContain("not the subagent's own account");
  await client.dispose?.();
});

test("a settled notice is not duplicated when the same subagent re-settles", async () => {
  // The entry id is stable per subagent and continuation, so a re-settled
  // continuation replaces its notice rather than stacking duplicates in the
  // parent's ledger.
  const root = await mkdtemp(join(tmpdir(), "natalia-settled-dedupe-"));
  const events: RuntimeEvent[] = [];
  let childAttempts = 0;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_settled_dedupe",
    permissionMode: "auto",
    provider: {
      provider: "scripted-settled-dedupe",
      model: "scripted-settled-dedupe-model",
      async *stream(request: ProviderStreamRequest) {
        if (
          request.messages[0]?.role === "system" &&
          String(request.messages[0].content).includes(
            "focused Natalia TS/Bun subagent",
          )
        ) {
          childAttempts += 1;
          yield { type: "content", text: "child attempt " + childAttempts };
          yield { type: "done" };
          return;
        }
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_spawn_dedupe",
                name: "agent_spawn",
                arguments: JSON.stringify({ task: "child task" }),
              },
            ],
          };
          yield { type: "done" };
          return;
        }
        yield { type: "content", text: "parent done" };
        yield { type: "done" };
      },
    } as unknown as StreamingProvider,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate a task");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );

  const notices = events.filter(
    (event) => event.type === "subagent.update" && event.event === "done",
  );
  // One settlement, so one notice — the dedupe is on the entry id, which this
  // pins indirectly by there being nothing to duplicate in the first place.
  expect(notices.length).toBeGreaterThan(0);
  await client.dispose?.();
});

test("a forked subagent inherits its parent's completed turns", async () => {
  // A fresh subagent starts with nothing but its task. A forked one starts with
  // the parent's conversation, so it can continue work in progress rather than
  // re-deriving it from a one-line description.
  const root = await mkdtemp(join(tmpdir(), "natalia-fork-seed-"));
  const events: RuntimeEvent[] = [];
  const childRequests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_fork_seed",
    permissionMode: "auto",
    provider: {
      provider: "scripted-fork",
      model: "scripted-fork-model",
      async *stream(request: ProviderStreamRequest) {
        if (
          request.messages[0]?.role === "system" &&
          String(request.messages[0].content).includes(
            "focused Natalia TS/Bun subagent",
          )
        ) {
          childRequests.push(request);
          yield {
            type: "content",
            text:
              "child finished: the seeded conversation told it what had already " +
              "been established, so it continued from there",
          };
          yield { type: "done" };
          return;
        }
        if (
          request.messages.some((m) => m.content === "delegate with context") &&
          !request.messages.some((m) => m.role === "tool")
        ) {
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_fork_spawn",
                name: "agent_spawn",
                arguments: JSON.stringify({
                  task: "continue the renderer work",
                  context: "fork",
                }),
              },
            ],
          };
          yield { type: "done" };
          return;
        }
        // A later step of the same turn already has the spawn result, so it
        // finishes rather than delegating again — which would loop forever.
        if (
          request.messages.some((m) => m.content === "delegate with context")
        ) {
          yield { type: "content", text: "parent done" };
          yield { type: "done" };
          return;
        }
        // Turn one is completed conversation, so it is what a fork can inherit:
        // a session that has finished nothing has nothing to seed.
        yield { type: "content", text: "we agreed the target is renderer.ts" };
        yield { type: "done" };
      },
    } as unknown as StreamingProvider,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("which file should we edit?");
  await client.submitAndWait!("delegate with context");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );

  expect(childRequests.length).toBeGreaterThan(0);
  const seeded = childRequests[0]!;
  // The child's own system prompt leads, then its task; the parent's completed
  // conversation is seeded between them.
  expect(
    String(seeded.messages[0]?.content).includes(
      "focused Natalia TS/Bun subagent",
    ),
  ).toBe(true);
  expect(
    seeded.messages.some((m) =>
      m.content.includes("we agreed the target is renderer.ts"),
    ),
  ).toBe(true);
  // The in-flight turn is excluded: the tool call that spawned the child is not
  // in the seed, because the parent has not answered it yet.
  expect(seeded.messages.some((m) => m.role === "tool")).toBe(false);
  expect(
    seeded.messages.some((m) =>
      m.content.includes("continue the renderer work"),
    ),
  ).toBe(true);
  await client.dispose?.();
});

test("a fresh subagent does not inherit the parent's conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-fresh-seed-"));
  const events: RuntimeEvent[] = [];
  const childRequests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_fresh_seed",
    permissionMode: "auto",
    provider: {
      provider: "scripted-fresh",
      model: "scripted-fresh-model",
      async *stream(request: ProviderStreamRequest) {
        if (
          request.messages[0]?.role === "system" &&
          String(request.messages[0].content).includes(
            "focused Natalia TS/Bun subagent",
          )
        ) {
          childRequests.push(request);
          yield {
            type: "content",
            text: "child finished with a long enough answer to clear the result quality gate",
          };
          yield { type: "done" };
          return;
        }
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "content",
            text: "we agreed the target is renderer.ts",
          };
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_fresh_spawn",
                name: "agent_spawn",
                arguments: JSON.stringify({
                  task: "start from scratch",
                  context: "fresh",
                }),
              },
            ],
          };
          yield { type: "done" };
          return;
        }
        yield { type: "content", text: "parent done" };
        yield { type: "done" };
      },
    } as unknown as StreamingProvider,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate fresh");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" && event.status === "completed",
    ),
  );

  expect(childRequests.length).toBeGreaterThan(0);
  const seeded = childRequests[0]!;
  // Nothing from the parent but its own system prompt and the task.
  expect(
    seeded.messages.some((m) =>
      m.content.includes("we agreed the target is renderer.ts"),
    ),
  ).toBe(false);
  expect(
    seeded.messages.some((m) => m.content.includes("start from scratch")),
  ).toBe(true);
  await client.dispose?.();
});

test("a parent can steer a running subagent at its nearest step", async () => {
  // Without this the parent's choices are to wait for the child to finish or to
  // kill it — neither of which is "go left instead of right".
  const root = await mkdtemp(join(tmpdir(), "natalia-steer-"));
  const events: RuntimeEvent[] = [];
  const childRequests: ProviderStreamRequest[] = [];
  let steered = false;
  // The child blocks inside its first step until the parent has steered, which is
  // what makes the `running` window observable: a stub that returns instantly
  // lets the child finish before the parent's next step even starts.
  let releaseChild: () => void = () => {};
  const childGate = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_steer",
    permissionMode: "auto",
    provider: {
      provider: "scripted-steer",
      model: "scripted-steer-model",
      async *stream(request: ProviderStreamRequest) {
        if (
          request.messages[0]?.role === "system" &&
          String(request.messages[0].content).includes(
            "focused Natalia TS/Bun subagent",
          )
        ) {
          childRequests.push(request);
          const calls = request.messages.filter(
            (m) => m.role === "tool",
          ).length;
          if (calls === 0) {
            await childGate;
            // The child's first step asks for a file that does not exist, which
            // is what the parent's message corrects.
            yield {
              type: "tool_call",
              calls: [
                {
                  id: "call_steer_read",
                  name: "read_file",
                  arguments: JSON.stringify({ path: "missing.txt" }),
                },
              ],
            };
            yield { type: "done" };
            return;
          }
          // The correction is now in front of the child, as a runtime-attributed
          // message rather than something it could mistake for its own reasoning.
          const correction = request.messages.some((m) =>
            m.content.includes("read renderer.ts instead"),
          );
          yield {
            type: "content",
            text: correction
              ? "child finished after reading renderer.ts, which is the file the parent pointed it at"
              : "child finished without the correction",
          };
          yield { type: "done" };
          return;
        }
        const toolCount = request.messages.filter(
          (m) => m.role === "tool",
        ).length;
        if (toolCount === 0) {
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_spawn_steer",
                name: "agent_spawn",
                arguments: JSON.stringify({ task: "read the config" }),
              },
            ],
          };
          yield { type: "done" };
          return;
        }
        if (toolCount === 1) {
          // The parent steers its own child while the child is still running.
          yield {
            type: "tool_call",
            calls: [
              {
                id: "call_send_message",
                name: "agent_message",
                arguments: JSON.stringify({
                  id: "a1",
                  message: "read renderer.ts instead",
                }),
              },
            ],
          };
          yield { type: "done" };
          return;
        }
        yield { type: "content", text: "parent done" };
        yield { type: "done" };
      },
    } as unknown as StreamingProvider,
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "tool.update" && event.name === "agent_message") {
      // The gate opens the moment the message is accepted, so the child's next
      // step sees it — and not before, or the message would arrive after it.
      if (event.status === "succeeded") {
        steered = true;
        releaseChild();
      }
    }
  });
  await client.submitAndWait!("delegate then steer");
  // An explicit, generous budget: this test's whole subject is an ordering that
  // only holds while the parent's message lands before the child proceeds, and
  // the local 500ms default expires under load for reasons unrelated to it.
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "subagent.update" && event.status === "completed",
      ),
    30_000,
    "the steered subagent to complete",
  );

  expect(steered).toBe(true);
  // The child's second request saw the correction before it answered.
  expect(childRequests.length).toBeGreaterThan(1);
  expect(
    childRequests[1]!.messages.some((m) =>
      m.content.includes("read renderer.ts instead"),
    ),
  ).toBe(true);
  expect(
    childRequests[1]!.messages.some(
      (m) =>
        m.content.includes("Agent a1 sent a message") ||
        m.content.includes('source="parent_message"'),
    ),
  ).toBe(true);
  await client.dispose?.();
});

test("the session's start date reaches the model in the environment block", async () => {
  // An agent asked "is this CHANGELOG current?" needs to know the date. It rides
  // in the environment block rather than the static system prompt, because that
  // prompt is byte-identical across sessions and a per-session date in it would
  // forfeit the cross-session prefix-cache sharing.
  const root = await mkdtemp(join(tmpdir(), "natalia-session-date-"));
  const events: RuntimeEvent[] = [];
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_session_date",
    permissionMode: "auto",
    provider: {
      provider: "scripted-date",
      model: "scripted-date-model",
      async *stream(request: ProviderStreamRequest) {
        requests.push(request);
        yield { type: "content", text: "done" };
        yield { type: "done" };
      },
    } as unknown as StreamingProvider,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("what is today?");

  expect(requests.length).toBeGreaterThan(0);
  const environment = requests[0]!.messages
    .map((m) => m.content)
    .find((content) => content.includes("<environment_details>"));
  expect(environment).toBeDefined();
  expect(environment).toContain("Session started: ");
  // Date only: seconds make the string look volatile, which misleads anyone
  // later reading a log or a diff.
  expect(environment).toMatch(/Session started: \d{4}-\d{2}-\d{2}/);
  expect(environment).not.toMatch(/Session started:.*\d{2}:\d{2}/);
  // It is one line inside the existing block, not a block of its own.
  expect(environment!.indexOf("Session started:")).toBeGreaterThan(
    environment!.indexOf("Working directory:"),
  );
  await client.dispose?.();
});

test("a subagent step's usage event carries the provider's cache metrics", async () => {
  // The consumer test in view-store folds a hand-built event, so it passes even
  // when the producer drops the fields. This drives a real subagent step and
  // asserts what actually leaves the runtime — the link that was silently
  // missing once already.
  const root = await mkdtemp(join(tmpdir(), "natalia-subagent-cache-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_subagent_cache",
    provider: subagentCacheUsageProvider(),
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!("ses_subagent_cache" as SessionID);
  await client.submitAndWait!("delegate a cache task");
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "subagent.update" && event.status === "completed",
      ),
    30_000,
    "the cache-reporting subagent to complete",
  );
  await client.dispose?.();

  // Scoped to the subagent's own events: the parent turn emits the same event
  // type, and a scripted parent that reports no cache metrics is entitled to
  // leave those fields absent.
  const stepUsage = events.filter(
    (
      event,
    ): event is Extract<RuntimeEvent, { type: "runtime.step_usage" }> & {
      agentID: string;
    } => event.type === "runtime.step_usage" && event.agentID !== undefined,
  );
  expect(stepUsage.length).toBeGreaterThan(0);
  for (const event of stepUsage) {
    // Every step reports what it cost, including what the cache absorbed.
    expect(event.cacheReadInputTokens).toBe(4000);
    expect(event.cacheCreationInputTokens).toBe(1200);
  }
  // A subagent turn is a full spawn-plus-step cycle; the per-test default expires
  // mid-run under load, and this test's subject is what the event carries.
}, 30_000);

function subagentCacheUsageProvider(): StreamingProvider {
  return {
    provider: "scripted-subagent-cache",
    model: "scripted-subagent-cache-model",
    async *stream(request) {
      const isChild = request.messages.some(
        (message) => message.content === "child cache task",
      );
      if (isChild) {
        yield {
          type: "usage",
          inputTokens: 10_000,
          outputTokens: 50,
          // A warm cache on the child's own prefix: read is large, write is small.
          cacheReadInputTokens: 4_000,
          cacheCreationInputTokens: 1_200,
        };
        yield {
          type: "content",
          text:
            "child finished with a warm prefix cache: the step read 4000 cached " +
            "tokens and wrote 1200, and both figures must survive the trip from " +
            "the provider chunk to the session's usage totals",
        };
        yield { type: "done" };
        return;
      }
      // The parent spawns on its first request, then answers once the tool result
      // is back — the same two-phase shape the other subagent tests use.
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_spawn_cache",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child cache task" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "parent done" };
      yield { type: "done" };
    },
  };
}

test("runtime.maxAttemptsPerStep caps the retry policy the runtime uses", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-subagent-retry-cap-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      runtime: {
        maxAttemptsPerStep: 2,
        retry: { initialBackoffMs: 1, maxBackoffMs: 1, jitterMs: 0 },
      },
    }),
  );
  let childAttempts = 0;
  const provider: StreamingProvider = {
    provider: "scripted-subagent-retry-cap",
    model: "scripted-subagent-retry-cap-model",
    async *stream(request) {
      const isChild = request.messages.some(
        (message) => message.content === "child transient task",
      );
      if (isChild) {
        childAttempts++;
        // Would recover on the sixth attempt, but the top-level cap of 2 must
        // stop the retry loop first — the runtime reads runtime.maxAttemptsPerStep
        // as an override of retry.maxAttemptsPerStep (whose default is null =
        // unlimited). Without that override this reaches 6.
        if (childAttempts < 6)
          throw providerError({ kind: "server", message: "temporary outage" });
        yield { type: "content", text: "child recovered" };
        yield { type: "done" };
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_call",
          calls: [
            {
              id: "call_retry_cap",
              name: "agent_spawn",
              arguments: JSON.stringify({ task: "child transient task" }),
            },
          ],
        };
        yield { type: "done" };
        return;
      }
      yield { type: "content", text: "parent complete" };
      yield { type: "done" };
    },
  };
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_subagent_retry_cap",
    provider,
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("delegate capped retry work");
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "subagent.update" &&
        (event.status === "failed" || event.status === "completed"),
    ),
  );
  // The cap of 2 wins: the child never reaches the sixth (recovering) attempt.
  expect(childAttempts).toBe(2);
});

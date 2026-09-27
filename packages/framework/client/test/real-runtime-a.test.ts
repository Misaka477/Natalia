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

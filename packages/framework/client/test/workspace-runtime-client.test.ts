import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveWorkspaceJsonSessionsDir } from "@anthelia/platform";
import {
  JsonSessionStore,
  SqliteSessionStore,
  createSessionRecord,
} from "@anthelia/session";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import {
  createWorkspaceManager,
  createWorkspaceRuntimeClient,
  type WorkspaceManager,
  type WorkspaceRuntime,
} from "../src/workspace-manager";
import {
  officialPluginWorkspace,
  officialPluginStoreRoot,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();

function emptyManager(): WorkspaceManager {
  return {
    async list() {
      return [];
    },
    async listSessions() {
      return [];
    },
    async findWorkspaceForSession() {
      return undefined;
    },
    invalidateSessionCache() {},
    async add() {
      throw new Error("unused");
    },
    async remove() {
      return { removed: true };
    },
    async activate() {
      throw new Error("unused");
    },
    async load() {},
    async workspaceRoots() {
      return [];
    },
    async workspaceAdd() {
      throw new Error("unused");
    },
    async workspaceRemove() {
      return { removed: true };
    },
    async workspaceActivate() {
      throw new Error("unused");
    },
    get() {
      return undefined;
    },
    getActive() {
      return undefined;
    },
    async summaryFor() {
      throw new Error("unused");
    },
    async workspacePermissionGet() {
      throw new Error("unused");
    },
    async workspacePermissionSet() {
      throw new Error("unused");
    },
    async workspaceToolGet() {
      throw new Error("unused");
    },
    async workspaceSessionGet() {
      return undefined;
    },
    async workspaceSessionSet() {},
    async workspaceToolSet() {
      throw new Error("unused");
    },
    async dispose() {},
  };
}

test("workspace proxy throws when native terminal is used without an active workspace", async () => {
  const client = createWorkspaceRuntimeClient(emptyManager());
  await expect(
    client.nativeTerminalStart?.({ command: "bash" }),
  ).rejects.toThrow("no active workspace");
});

test("the settings and response-cache faces are routed, not silently absent", async () => {
  // The field report: clicking the settings panel's response-cache row did
  // nothing. `runtime?.responseCache?.()` is a double optional call, so a face
  // the workspace client does not expose is a silent no-op — no error, no
  // state change. These three were not routable, so they fell through to the
  // manager's fallback, which reads an UNSARTED workspace client.
  const client = createWorkspaceRuntimeClient(emptyManager());
  for (const face of ["settingsGet", "settingsSet"] as const) {
    expect(
      typeof (client as unknown as Record<string, unknown>)[face],
      `${face} must be reachable on the workspace client`,
    ).toBe("function");
  }
  // And they reject loudly rather than resolving to nothing, so the panel can
  // report the failure instead of accepting a click and doing nothing.
  await expect(client.settingsGet?.()).rejects.toThrow("no active workspace");
});

for (const useSqliteStore of [false, true]) {
  test(`workspace restores selected session and preserves selection on settings updates (${useSqliteStore ? "sqlite" : "json"})`, async () => {
    const root = await officialPluginWorkspace("workspace-restore");
    const previousRegistry = process.env.NATALIA_WORKSPACES_FILE;
    process.env.NATALIA_WORKSPACES_FILE = join(root, "workspaces.json");
    const options = {
      pluginStoreRoot: officialPluginStoreRoot(root),
      globalConfigPath: join(root, "global-config.json"),
      sessionDir: join(root, ".natalia", "sessions"),
      useSqliteStore,
    };
    let manager = createWorkspaceManager(options);
    try {
      const store = new JsonSessionStore(join(root, ".natalia", "sessions"));
      const old = createSessionRecord("ses_old", "Old pinned");
      old.metadata = { pinned: true, lastAccessedAt: "2026-01-01T00:00:00Z" };
      const recent = createSessionRecord("ses_recent", "Recent");
      recent.metadata = { lastAccessedAt: "2026-08-01T00:00:00Z" };
      recent.events.push(
        {
          type: "navi.chat.message.added",
          id: "navi_added",
          messageID: "navi_saved",
          role: "chat",
          text: "Navi restored",
          at: "2026-08-01T00:00:00Z",
        },
        {
          type: "nia.chat.message.added",
          id: "nia_added",
          messageID: "nia_saved",
          role: "chat",
          text: "Nia restored",
          at: "2026-08-01T00:00:00Z",
        },
      );
      await store.save(old);
      await store.save(recent);
      const settingsPath = join(root, ".natalia", "workspace-settings.json");
      await writeFile(
        settingsPath,
        JSON.stringify({ activeSessionID: old.id }),
      );
      let workspace = await manager.add({ path: root });
      const client = createWorkspaceRuntimeClient(manager);
      expect((await client.runtimeStatus?.())?.sessionID).toBe(old.id);
      await client.sessionAttach?.(recent.id);
      await Promise.all([
        manager.workspacePermissionSet(workspace.workspaceID, {
          permissionProfile: "default",
          approval: "ask",
        }),
        manager.workspaceToolSet(workspace.workspaceID, {
          enabledTools: [],
          disabledTools: ["bash"],
        }),
        manager.workspaceSessionSet(workspace.workspaceID, recent.id),
      ]);
      expect(
        JSON.parse(await readFile(settingsPath, "utf8")).activeSessionID,
      ).toBe(recent.id);
      const restored = manager.get(workspace.workspaceID)!.client;
      expect(
        (await restored.naviChat?.messages?.())?.map((row) => row.text),
      ).toEqual(["Navi restored"]);
      expect(
        (await restored.niaChat?.messages?.())?.map((row) => row.text),
      ).toEqual(["Nia restored"]);
      expect(
        JSON.parse(await readFile(settingsPath, "utf8")).toolSettings
          .disabledTools,
      ).toEqual(["bash"]);
      await expect(client.sessionAttach?.("ses_missing")).rejects.toThrow();
      expect(await manager.workspaceSessionGet(workspace.workspaceID)).toBe(
        recent.id,
      );
      await manager.dispose();
      manager = createWorkspaceManager(options);
      workspace = await manager.add({ path: root });
      expect(
        (await manager.get(workspace.workspaceID)?.client.runtimeStatus?.())
          ?.sessionID,
      ).toBe(recent.id);
    } finally {
      await manager.dispose();
      if (previousRegistry === undefined)
        delete process.env.NATALIA_WORKSPACES_FILE;
      else process.env.NATALIA_WORKSPACES_FILE = previousRegistry;
    }
  });
}

test("workspace proxy chat messages await lazy runtime initialization", async () => {
  const root = await officialPluginWorkspace("workspace-chat-ready");
  const previousRegistry = process.env.NATALIA_WORKSPACES_FILE;
  process.env.NATALIA_WORKSPACES_FILE = join(root, "workspaces.json");
  const options = {
    pluginStoreRoot: officialPluginStoreRoot(root),
    globalConfigPath: join(root, "global-config.json"),
    sessionDir: join(root, ".natalia", "sessions"),
  };
  const manager = createWorkspaceManager(options);
  try {
    const store = new JsonSessionStore(join(root, ".natalia", "sessions"));
    const session = createSessionRecord("ses_chat_ready", "Chat ready");
    session.events.push(
      {
        type: "navi.chat.message.added",
        id: "navi_ready",
        messageID: "navi_ready_msg",
        role: "chat",
        text: "Navi ready",
        at: "2026-08-01T00:00:00Z",
      },
      {
        type: "nia.chat.message.added",
        id: "nia_ready",
        messageID: "nia_ready_msg",
        role: "chat",
        text: "Nia ready",
        at: "2026-08-01T00:00:00Z",
      },
    );
    await store.save(session);
    await manager.add({ path: root });
    const client = createWorkspaceRuntimeClient(manager);
    // This is the first routed call on a freshly added workspace: start() has
    // only kicked initialization off in the background, so chatMessages must
    // wait for ready instead of racing `ensureExecution`.
    expect(
      (await client.naviChat?.messages?.(session.id))?.map((row) => row.text),
    ).toEqual(["Navi ready"]);
    expect(
      (await client.niaChat?.messages?.(session.id))?.map((row) => row.text),
    ).toEqual(["Nia ready"]);
  } finally {
    await manager.dispose();
    if (previousRegistry === undefined)
      delete process.env.NATALIA_WORKSPACES_FILE;
    else process.env.NATALIA_WORKSPACES_FILE = previousRegistry;
  }
});

test("workspace proxy intelligence reads await lazy initialization", async () => {
  const root = await officialPluginWorkspace("workspace-intelligence-ready");
  const previousRegistry = process.env.NATALIA_WORKSPACES_FILE;
  process.env.NATALIA_WORKSPACES_FILE = join(root, "workspaces.json");
  const options = {
    pluginStoreRoot: officialPluginStoreRoot(root),
    globalConfigPath: join(root, "global-config.json"),
    sessionDir: join(root, ".natalia", "sessions"),
  };
  const manager = createWorkspaceManager(options);
  try {
    const store = new JsonSessionStore(join(root, ".natalia", "sessions"));
    const session = createSessionRecord(
      "ses_intelligence_ready",
      "Intelligence ready",
    );
    await store.save(session);
    await manager.add({ path: root });
    const client = createWorkspaceRuntimeClient(manager);
    // These read surfaces may be the first routed call on a fresh workspace.
    await expect(
      client.driftFindings?.({ sessionID: session.id }),
    ).resolves.toMatchObject({
      items: [],
      returned: 0,
      total: 0,
      truncated: false,
    });
    await expect(client.notices?.(session.id)).resolves.toEqual([]);
  } finally {
    await manager.dispose();
    if (previousRegistry === undefined)
      delete process.env.NATALIA_WORKSPACES_FILE;
    else process.env.NATALIA_WORKSPACES_FILE = previousRegistry;
  }
});

test("chat history survives after the newest event window", async () => {
  const root = await officialPluginWorkspace("workspace-chat-tail");
  const previousRegistry = process.env.NATALIA_WORKSPACES_FILE;
  process.env.NATALIA_WORKSPACES_FILE = join(root, "workspaces.json");
  const options = {
    pluginStoreRoot: officialPluginStoreRoot(root),
    globalConfigPath: join(root, "global-config.json"),
    sessionDir: join(root, ".natalia", "sessions"),
  };
  const manager = createWorkspaceManager(options);
  try {
    const store = new JsonSessionStore(join(root, ".natalia", "sessions"));
    const session = createSessionRecord("ses_chat_tail", "Chat tail");
    session.events.push(
      {
        type: "navi.chat.message.added",
        id: "navi_old_1",
        messageID: "navi_old_1_msg",
        role: "chat",
        text: "old navi 1",
        at: "2026-08-01T00:00:00Z",
      },
      {
        type: "navi.chat.message.added",
        id: "navi_old_2",
        messageID: "navi_old_2_msg",
        role: "chat",
        text: "old navi 2",
        at: "2026-08-01T00:00:01Z",
      },
    );
    // The shared window keeps only the newest 2000 events. Put the chat rows
    // behind that page so a window-only projection silently drops them.
    for (let index = 0; index < 2_100; index += 1)
      session.events.push({
        type: "tool.update",
        id: `fill:${index}`,
        name: "noop",
        status: "succeeded",
        summary: "noop",
      });
    await store.save(session);
    await manager.add({ path: root });
    const client = createWorkspaceRuntimeClient(manager);
    expect(
      (await client.naviChat?.messages?.(session.id))?.map((row) => row.text),
    ).toEqual(["old navi 1", "old navi 2"]);
    const page = await client.naviChat?.messagesPage?.({
      sessionID: session.id,
      limit: 1,
    });
    expect(page?.data.map((row) => row.text)).toEqual(["old navi 2"]);
    expect(page?.cursor.previous).toBeDefined();
    const older = await client.naviChat?.messagesPage?.({
      sessionID: session.id,
      cursor: page?.cursor.previous,
      limit: 1,
    });
    expect(older?.data.map((row) => row.text)).toEqual(["old navi 1"]);
  } finally {
    await manager.dispose();
    if (previousRegistry === undefined)
      delete process.env.NATALIA_WORKSPACES_FILE;
    else process.env.NATALIA_WORKSPACES_FILE = previousRegistry;
  }
});

test("subagent history pages are filtered per subagent", async () => {
  const root = await officialPluginWorkspace("workspace-subagent-page");
  const previousRegistry = process.env.NATALIA_WORKSPACES_FILE;
  process.env.NATALIA_WORKSPACES_FILE = join(root, "workspaces.json");
  const options = {
    pluginStoreRoot: officialPluginStoreRoot(root),
    globalConfigPath: join(root, "global-config.json"),
    sessionDir: join(root, ".natalia", "sessions"),
  };
  const manager = createWorkspaceManager(options);
  try {
    const store = new JsonSessionStore(join(root, ".natalia", "sessions"));
    const session = createSessionRecord("ses_subagent_page", "Subagent page");
    for (let index = 0; index < 150; index += 1)
      session.events.push({
        type: "subagent.update",
        id: "sub-1",
        status: "running",
        attached: false,
        event: "status",
        continuation: index,
      } as RuntimeEvent);
    session.events.push({
      type: "subagent.update",
      id: "sub-2",
      status: "completed",
      attached: false,
      event: "done",
    } as RuntimeEvent);
    await store.save(session);
    await manager.add({ path: root });
    const client = createWorkspaceRuntimeClient(manager);
    const latest = await client.subagentHistoryPage?.({
      sessionID: session.id,
      subagentID: "sub-1",
      limit: 100,
    });
    expect(latest?.data).toHaveLength(100);
    expect(latest?.data.every((event) => event.id === "sub-1")).toBe(true);
    expect(latest?.cursor.previous).toBeDefined();
    const older = await client.subagentHistoryPage?.({
      sessionID: session.id,
      subagentID: "sub-1",
      cursor: latest?.cursor.previous,
      limit: 100,
    });
    expect(older?.data).toHaveLength(50);
    expect(older?.data.every((event) => event.id === "sub-1")).toBe(true);
  } finally {
    await manager.dispose();
    if (previousRegistry === undefined)
      delete process.env.NATALIA_WORKSPACES_FILE;
    else process.env.NATALIA_WORKSPACES_FILE = previousRegistry;
  }
});

test("session-scoped runtime calls route to the owning workspace", async () => {
  const calls: string[] = [];
  const firstClient = {
    start() {},
    async subagents() {
      calls.push("first:subagents");
      return [];
    },
    async submit() {
      calls.push("first:submit");
      return {} as never;
    },
    async history() {
      calls.push("first:history");
      return { events: [], next: undefined } as never;
    },
  };
  const secondClient = {
    start() {},
    async subagents(sessionID: string) {
      calls.push(`second:subagents:${sessionID}`);
      return [];
    },
    async submit(_text: string, sessionID: string) {
      calls.push(`second:submit:${sessionID}`);
      return {} as never;
    },
    async history(input: { sessionID?: string }) {
      calls.push(`second:history:${input.sessionID}`);
      return { events: [], next: undefined } as never;
    },
    async selectModel(_model: string, _variant: string, sessionID: string) {
      calls.push(`second:selectModel:${sessionID}`);
      return undefined;
    },
    async workspaceRead(input: { workspaceID?: string; path: string }) {
      calls.push(`second:workspaceRead:${input.workspaceID}:${input.path}`);
      return { path: input.path, content: "", encoding: "utf8" } as never;
    },
    async agents(input: { workspaceID?: string }) {
      calls.push(`second:agents:${input.workspaceID}`);
      return [] as never;
    },
    async snapshot(input?: { sessionID?: string; workspaceID?: string }) {
      calls.push(`second:snapshot:${input?.workspaceID}`);
      return { type: "snapshot.created", id: "s1", files: [] } as never;
    },
    async pendingInteractive(input?: {
      sessionID?: string;
      workspaceID?: string;
    }) {
      calls.push(
        `second:pendingInteractive:${input?.workspaceID}:${input?.sessionID}`,
      );
      return { approvals: [], questions: [] } as never;
    },
    async checkpointListByKind(kind: string, sessionID?: string) {
      calls.push(`second:checkpointListByKind:${kind}:${sessionID}`);
      return [] as never;
    },
    async mailboxDeliver(messageID: string, sessionID?: string) {
      calls.push(`second:mailboxDeliver:${messageID}:${sessionID}`);
      return { delivered: true } as never;
    },
    async mailboxDefer(messageID: string, reason?: string, sessionID?: string) {
      calls.push(`second:mailboxDefer:${messageID}:${reason}:${sessionID}`);
      return { deferred: true } as never;
    },
    async planDocDelete(planID: string, sessionID?: string) {
      calls.push(`second:planDocDelete:${planID}:${sessionID}`);
      return { deleted: true } as never;
    },
    async planDocStatus(planID: string, sessionID?: string) {
      calls.push(`second:planDocStatus:${planID}:${sessionID}`);
      return { status: "marked" } as never;
    },
    async auditRounds(planID?: string, workspaceID?: string) {
      calls.push(`second:auditRounds:${planID}:${workspaceID}`);
      return [] as never;
    },
    async readMcpResource(server: string, uri: string, workspaceID?: string) {
      calls.push(`second:readMcpResource:${server}:${uri}:${workspaceID}`);
      return null as never;
    },
    async getMcpPrompt(
      server: string,
      name: string,
      _args: Record<string, string> | undefined,
      workspaceID?: string,
    ) {
      calls.push(`second:getMcpPrompt:${server}:${name}:${workspaceID}`);
      return null as never;
    },
    async agentDelete(name: string, workspaceID?: string) {
      calls.push(`second:agentDelete:${name}:${workspaceID}`);
      return { deleted: true } as never;
    },
    async respondApproval(response: {
      requestID: string;
      sessionID?: string;
      workspaceID?: string;
    }) {
      calls.push(
        `second:respondApproval:${response.requestID}:${response.sessionID}:${response.workspaceID}`,
      );
      return { accepted: true } as never;
    },
  };
  const first = {
    workspaceID: "ws_first",
    root: "/tmp/first",
    title: "First",
    client: firstClient as never,
    status: "active",
    permissionSettings: { permissionProfile: "default", approval: "ask" },
    toolSettings: { enabledTools: [], disabledTools: [] },
  } satisfies WorkspaceRuntime;
  const second = {
    workspaceID: "ws_second",
    root: "/tmp/second",
    title: "Second",
    client: secondClient as never,
    status: "idle",
    permissionSettings: { permissionProfile: "default", approval: "ask" },
    toolSettings: { enabledTools: [], disabledTools: [] },
  } satisfies WorkspaceRuntime;
  const manager = {
    ...emptyManager(),
    getActive: () => first,
    get: (workspaceID: string) =>
      workspaceID === first.workspaceID
        ? first
        : workspaceID === second.workspaceID
          ? second
          : undefined,
    findWorkspaceForSession: async (sessionID: string) =>
      sessionID.startsWith("ses_second") ? second : first,
  } as WorkspaceManager;
  const client = createWorkspaceRuntimeClient(manager);

  const sessionID = "ses_second" as SessionID;
  await client.subagents!(sessionID);
  await client.submit!("hello", sessionID);
  await client.history!({ sessionID });
  await client.selectModel!("model", "default", sessionID);
  await client.workspaceRead!({
    workspaceID: second.workspaceID,
    path: "src/index.ts",
  });
  await client.agents!({ workspaceID: second.workspaceID });
  await client.snapshot!({ workspaceID: second.workspaceID });
  await client.pendingInteractive!({
    sessionID,
    workspaceID: second.workspaceID,
  });
  await client.checkpointListByKind!("manual", sessionID);
  await client.mailboxDeliver!("msg_1", sessionID);
  await client.mailboxDefer!("msg_1", "later", sessionID);
  await client.planDocDelete!("plan_1", sessionID);
  await client.planDocStatus!("plan_1", sessionID);
  await client.auditRounds!("plan_1", second.workspaceID);
  await client.readMcpResource!("demo", "demo://resource", second.workspaceID);
  await client.getMcpPrompt!("demo", "lookup", undefined, second.workspaceID);
  await client.agentDelete!("build", second.workspaceID);
  await client.respondApproval!({
    requestID: "apr_1",
    decision: "once",
    sessionID,
    workspaceID: second.workspaceID,
  });

  expect(calls).toEqual([
    `second:subagents:${sessionID}`,
    `second:submit:${sessionID}`,
    `second:history:${sessionID}`,
    `second:selectModel:${sessionID}`,
    `second:workspaceRead:${second.workspaceID}:src/index.ts`,
    `second:agents:${second.workspaceID}`,
    `second:snapshot:${second.workspaceID}`,
    `second:pendingInteractive:${second.workspaceID}:${sessionID}`,
    `second:checkpointListByKind:manual:${sessionID}`,
    `second:mailboxDeliver:msg_1:${sessionID}`,
    `second:mailboxDefer:msg_1:later:${sessionID}`,
    `second:planDocDelete:plan_1:${sessionID}`,
    `second:planDocStatus:plan_1:${sessionID}`,
    `second:auditRounds:plan_1:${second.workspaceID}`,
    `second:readMcpResource:demo:demo://resource:${second.workspaceID}`,
    `second:getMcpPrompt:demo:lookup:${second.workspaceID}`,
    `second:agentDelete:build:${second.workspaceID}`,
    `second:respondApproval:apr_1:${sessionID}:${second.workspaceID}`,
  ]);

  await expect(
    client.pendingInteractive!({
      sessionID,
      workspaceID: first.workspaceID,
    }),
  ).rejects.toThrow("does not belong to workspace");
  expect(calls).toEqual([
    `second:subagents:${sessionID}`,
    `second:submit:${sessionID}`,
    `second:history:${sessionID}`,
    `second:selectModel:${sessionID}`,
    `second:workspaceRead:${second.workspaceID}:src/index.ts`,
    `second:agents:${second.workspaceID}`,
    `second:snapshot:${second.workspaceID}`,
    `second:pendingInteractive:${second.workspaceID}:${sessionID}`,
    `second:checkpointListByKind:manual:${sessionID}`,
    `second:mailboxDeliver:msg_1:${sessionID}`,
    `second:mailboxDefer:msg_1:later:${sessionID}`,
    `second:planDocDelete:plan_1:${sessionID}`,
    `second:planDocStatus:plan_1:${sessionID}`,
    `second:auditRounds:plan_1:${second.workspaceID}`,
    `second:readMcpResource:demo:demo://resource:${second.workspaceID}`,
    `second:getMcpPrompt:demo:lookup:${second.workspaceID}`,
    `second:agentDelete:build:${second.workspaceID}`,
    `second:respondApproval:apr_1:${sessionID}:${second.workspaceID}`,
  ]);
});

test("workspace falls back to last access, ignores pins/archive/stale selection, then uses seed for an empty workspace", async () => {
  const root = await officialPluginWorkspace("workspace-recent");
  const previousRegistry = process.env.NATALIA_WORKSPACES_FILE;
  process.env.NATALIA_WORKSPACES_FILE = join(root, "workspaces.json");
  const options = {
    pluginStoreRoot: officialPluginStoreRoot(root),
    globalConfigPath: join(root, "global-config.json"),
    sessionDir: join(root, ".natalia", "sessions"),
  };
  let manager = createWorkspaceManager(options);
  try {
    const store = new JsonSessionStore(join(root, ".natalia", "sessions"));
    const seed =
      `ses_${createHash("sha256").update(root).digest("hex").slice(0, 12)}` as const;
    let workspace = await manager.add({ path: root });
    expect(
      (await manager.get(workspace.workspaceID)?.client.runtimeStatus?.())
        ?.sessionID,
    ).toBe(seed);
    await manager.dispose();
    await store.delete(seed as `ses_${string}`);
    const old = createSessionRecord("ses_old", "Pinned");
    old.metadata = { pinned: true, lastAccessedAt: "2026-01-01T00:00:00Z" };
    const recent = createSessionRecord("ses_recent", "Recent");
    recent.metadata = { lastAccessedAt: "2026-08-01T00:00:00Z" };
    const archived = createSessionRecord("ses_archived", "Archived");
    archived.metadata = {
      archived: true,
      lastAccessedAt: "2026-09-01T00:00:00Z",
    };
    await store.save(old);
    await store.save(recent);
    await store.save(archived);
    for (const settings of [{}, { activeSessionID: "ses_deleted" }]) {
      await writeFile(
        join(root, ".natalia", "workspace-settings.json"),
        JSON.stringify(settings),
      );
      manager = createWorkspaceManager(options);
      workspace = await manager.add({ path: root });
      expect(
        (await manager.get(workspace.workspaceID)?.client.runtimeStatus?.())
          ?.sessionID,
      ).toBe(recent.id);
      await manager.dispose();
    }
  } finally {
    await manager.dispose();
    if (previousRegistry === undefined)
      delete process.env.NATALIA_WORKSPACES_FILE;
    else process.env.NATALIA_WORKSPACES_FILE = previousRegistry;
  }
});

test("SQLite restore uses last access instead of pins or deleted legacy JSON", async () => {
  const root = await officialPluginWorkspace("workspace-sqlite-recent");
  const previousRegistry = process.env.NATALIA_WORKSPACES_FILE;
  process.env.NATALIA_WORKSPACES_FILE = join(root, "workspaces.json");
  const manager = createWorkspaceManager({
    pluginStoreRoot: officialPluginStoreRoot(root),
    globalConfigPath: join(root, "global-config.json"),
    sessionDir: join(root, ".natalia", "sessions"),
    useSqliteStore: true,
  });
  try {
    const database = new SqliteSessionStore(
      join(root, ".natalia", "sessions.db"),
    );
    database.create("ses_pinned", "Pinned");
    database.updateMetadata("ses_pinned", {
      pinned: true,
      lastAccessedAt: "2026-01-01T00:00:00Z",
    });
    database.create("ses_recent", "Recent");
    database.updateMetadata("ses_recent", {
      lastAccessedAt: "2026-08-01T00:00:00Z",
    });
    database.close();
    const legacy = createSessionRecord("ses_deleted", "Deleted JSON leftover");
    legacy.metadata = { lastAccessedAt: "2026-09-01T00:00:00Z" };
    await new JsonSessionStore(join(root, ".natalia", "sessions")).save(legacy);
    await writeFile(
      join(root, ".natalia", "workspace-settings.json"),
      JSON.stringify({ activeSessionID: legacy.id }),
    );
    const workspace = await manager.add({ path: root });
    const client = manager.get(workspace.workspaceID)!.client;
    expect((await client.runtimeStatus?.())?.sessionID).toBe("ses_recent");
    expect(
      (await client.sessionList?.())?.some((row) => row.id === legacy.id),
    ).toBe(false);
  } finally {
    await manager.dispose();
    if (previousRegistry === undefined)
      delete process.env.NATALIA_WORKSPACES_FILE;
    else process.env.NATALIA_WORKSPACES_FILE = previousRegistry;
  }
});

test("workspaceAdd updates the title for an already-registered root", async () => {
  const root = await officialPluginWorkspace("workspace-title-update");
  const previousRegistry = process.env.NATALIA_WORKSPACES_FILE;
  const registryPath = join(root, "workspaces.json");
  process.env.NATALIA_WORKSPACES_FILE = registryPath;
  const manager = createWorkspaceManager({
    pluginStoreRoot: officialPluginStoreRoot(root),
    globalConfigPath: join(root, "global-config.json"),
    sessionDir: join(root, ".natalia", "sessions"),
  });
  try {
    const created = await manager.workspaceAdd({ path: root });
    expect(created.title).toBe(root.split("/").pop()!);
    const renamed = await manager.workspaceAdd({
      path: root,
      title: "Renamed workspace",
    });
    expect(renamed.workspaceID).toBe(created.workspaceID);
    expect(renamed.title).toBe("Renamed workspace");
    expect(JSON.parse(await readFile(registryPath, "utf8"))).toEqual([
      { path: root, title: "Renamed workspace", active: true },
    ]);
  } finally {
    await manager.dispose();
    if (previousRegistry === undefined)
      delete process.env.NATALIA_WORKSPACES_FILE;
    else process.env.NATALIA_WORKSPACES_FILE = previousRegistry;
  }
});

test("sessions aggregate across workspaces and attach routes to the owner", async () => {
  const firstRoot = await officialPluginWorkspace("workspace-routing-a");
  const secondRoot = await officialPluginWorkspace("workspace-routing-b");
  const previousRegistry = process.env.NATALIA_WORKSPACES_FILE;
  const registryPath = join(firstRoot, "workspaces.json");
  process.env.NATALIA_WORKSPACES_FILE = registryPath;
  const firstStore = new JsonSessionStore(
    join(firstRoot, ".natalia", "sessions"),
  );
  const secondStore = new JsonSessionStore(
    join(secondRoot, ".natalia", "sessions"),
  );
  const firstSession = createSessionRecord(
    "ses_first_workspace",
    "First workspace session",
  );
  const secondSession = createSessionRecord(
    "ses_second_workspace",
    "Second workspace session",
  );
  await firstStore.save(firstSession);
  await secondStore.save(secondSession);
  const manager = createWorkspaceManager({
    pluginStoreRoot: officialPluginStoreRoot(firstRoot),
    globalConfigPath: join(firstRoot, "global-config.json"),
  });
  try {
    const first = await manager.workspaceAdd({ path: firstRoot });
    const second = await manager.workspaceAdd({ path: secondRoot });
    const client = createWorkspaceRuntimeClient(manager);
    client.start?.(() => undefined);
    let sessions = (await client.sessionList?.()) ?? [];
    for (
      let attempt = 0;
      attempt < 50 &&
      !(
        sessions.some((session) => session.workspaceID === first.workspaceID) &&
        sessions.some((session) => session.workspaceID === second.workspaceID)
      );
      attempt++
    ) {
      await Bun.sleep(20);
      sessions = (await client.sessionList?.()) ?? [];
    }
    expect(sessions.map((session) => session.workspaceID)).toEqual(
      expect.arrayContaining([first.workspaceID, second.workspaceID]),
    );
    await client.sessionAttach?.(secondSession.id);
    expect(manager.getActive()?.workspaceID).toBe(second.workspaceID);
    expect(await manager.workspaceSessionGet(second.workspaceID)).toBe(
      secondSession.id,
    );
  } finally {
    await manager.dispose();
    if (previousRegistry === undefined)
      delete process.env.NATALIA_WORKSPACES_FILE;
    else process.env.NATALIA_WORKSPACES_FILE = previousRegistry;
  }
});

test("workspace delete replaces an inactive workspace's active session", async () => {
  const firstRoot = await officialPluginWorkspace("workspace-delete-active-a");
  const secondRoot = await officialPluginWorkspace("workspace-delete-active-b");
  const previousRegistry = process.env.NATALIA_WORKSPACES_FILE;
  const registryPath = join(firstRoot, "workspaces.json");
  process.env.NATALIA_WORKSPACES_FILE = registryPath;
  // The store layer resolves each workspace's journal (the §1.6 startup
  // migration moves a seeded legacy workspace-local store outside); the
  // seeds must land where the runtimes will actually read.
  const firstStore = new JsonSessionStore(
    resolveWorkspaceJsonSessionsDir(firstRoot),
  );
  const secondStore = new JsonSessionStore(
    resolveWorkspaceJsonSessionsDir(secondRoot),
  );
  const firstSession = createSessionRecord("ses_delete_a", "First");
  const secondSession = createSessionRecord("ses_delete_b", "Second");
  await firstStore.save(firstSession);
  await secondStore.save(secondSession);
  const manager = createWorkspaceManager({
    pluginStoreRoot: officialPluginStoreRoot(firstRoot),
    globalConfigPath: join(firstRoot, "global-config.json"),
  });
  try {
    const first = await manager.workspaceAdd({ path: firstRoot });
    const second = await manager.workspaceAdd({ path: secondRoot });
    const client = createWorkspaceRuntimeClient(manager);
    client.start?.(() => undefined);
    await client.sessionAttach?.(firstSession.id);
    await client.sessionAttach?.(secondSession.id);
    expect(manager.getActive()?.workspaceID).toBe(second.workspaceID);

    // `firstSession` is no longer globally active, but its own workspace
    // runtime still has it attached. The facade must replace that attachment
    // before retrying the delete, otherwise the active-session guard wins.
    await expect(
      client.sessionDelete?.(firstSession.id),
    ).resolves.toMatchObject({ id: firstSession.id });
    expect(await firstStore.load(firstSession.id as never)).toBeUndefined();
    const remaining = await firstStore.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).not.toBe(firstSession.id);
    expect(await manager.workspaceSessionGet(first.workspaceID)).toBe(
      remaining[0]?.id,
    );
  } finally {
    await manager.dispose();
    if (previousRegistry === undefined)
      delete process.env.NATALIA_WORKSPACES_FILE;
    else process.env.NATALIA_WORKSPACES_FILE = previousRegistry;
  }
});

test("load restores the persisted active workspace", async () => {
  const firstRoot = await officialPluginWorkspace("workspace-active-a");
  const secondRoot = await officialPluginWorkspace("workspace-active-b");
  const previousRegistry = process.env.NATALIA_WORKSPACES_FILE;
  const registryPath = join(firstRoot, "workspaces.json");
  process.env.NATALIA_WORKSPACES_FILE = registryPath;
  await writeFile(
    registryPath,
    JSON.stringify([
      { path: firstRoot, title: "A", active: false },
      { path: secondRoot, title: "B", active: true },
    ]),
  );
  const manager = createWorkspaceManager({
    pluginStoreRoot: officialPluginStoreRoot(firstRoot),
    globalConfigPath: join(firstRoot, "global-config.json"),
  });
  try {
    await manager.load();
    expect(manager.getActive()?.root).toBe(secondRoot);
  } finally {
    await manager.dispose();
    if (previousRegistry === undefined)
      delete process.env.NATALIA_WORKSPACES_FILE;
    else process.env.NATALIA_WORKSPACES_FILE = previousRegistry;
  }
});

import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { access } from "node:fs/promises";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { LEGACY_STATE_DIR_NAMES } from "@anthelia/platform";
import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import { createLocalSessionService } from "@anthelia/session-store";
import {
  RuntimeRefusal,
  type RuntimeSessionSummary,
  type WorkspaceSummary,
  type WorkspacePermissionSettings,
  type WorkspaceToolSettings,
} from "@anthelia/contracts";
import { createRealRuntimeClient } from "./runtime/main";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";

export type WorkspaceManagerOptions = Pick<
  RealRuntimeClientOptions,
  | "pluginStoreRoot"
  | "globalConfigPath"
  | "useSqliteStore"
  | "sessionDir"
  | "checkpointDir"
  | "operationLogsDir"
  | "vaultDir"
  | "contextWindowCachePath"
>;

export type WorkspaceRuntime = {
  workspaceID: string;
  root: string;
  title: string;
  client: RuntimeServiceClient;
  status: WorkspaceSummary["status"];
  permissionSettings: WorkspacePermissionSettings;
  toolSettings: WorkspaceToolSettings;
  /** Set when the facade starts this workspace's runtime client. */
  started?: boolean;
};

function workspaceSettingsPath(root: string) {
  return join(root, ".natalia", "workspace-settings.json");
}

async function readSettings(root: string): Promise<{
  permissionSettings: WorkspacePermissionSettings;
  toolSettings: WorkspaceToolSettings;
  activeSessionID?: string;
}> {
  try {
    const raw = JSON.parse(
      await readFile(workspaceSettingsPath(root), "utf8"),
    ) as Partial<{
      permissionSettings?: WorkspacePermissionSettings;
      toolSettings?: WorkspaceToolSettings;
      activeSessionID?: string;
    }>;
    return {
      permissionSettings: raw.permissionSettings ?? {
        permissionProfile: "default",
        approval: "ask",
      },
      toolSettings: raw.toolSettings ?? {
        enabledTools: [],
        disabledTools: [],
      },
      activeSessionID:
        typeof raw.activeSessionID === "string" && raw.activeSessionID.trim()
          ? raw.activeSessionID
          : undefined,
    };
  } catch {
    return {
      permissionSettings: {
        permissionProfile: "default",
        approval: "ask",
      },
      toolSettings: {
        enabledTools: [],
        disabledTools: [],
      },
      activeSessionID: undefined,
    };
  }
}

const settingsWrites = new Map<string, Promise<unknown>>();

function writeSettings(
  root: string,
  update: {
    permissionSettings?: WorkspacePermissionSettings;
    toolSettings?: WorkspaceToolSettings;
    activeSessionID?: string;
  },
) {
  // Attach and settings edits may finish together; serialize read/modify/write.
  const write = (settingsWrites.get(root) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => saveSettings(root, update));
  settingsWrites.set(root, write);
  void write
    .finally(() => {
      if (settingsWrites.get(root) === write) settingsWrites.delete(root);
    })
    .catch(() => undefined);
  return write;
}

async function saveSettings(
  root: string,
  update: {
    permissionSettings?: WorkspacePermissionSettings;
    toolSettings?: WorkspaceToolSettings;
    activeSessionID?: string;
  },
) {
  const path = workspaceSettingsPath(root);
  const current = await readSettings(root);
  const next = {
    permissionSettings: update.permissionSettings ?? current.permissionSettings,
    toolSettings: update.toolSettings ?? current.toolSettings,
    ...((update.activeSessionID ?? current.activeSessionID) !== undefined
      ? { activeSessionID: update.activeSessionID ?? current.activeSessionID }
      : {}),
  };
  await mkdir(join(root, ".natalia"), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

function workspaceRegistryPath() {
  return process.env.NATALIA_WORKSPACES_FILE ?? liveWorkspaceRegistryPath();
}

/** The explicit override wins outright — a legacy fallback never applies. */
function explicitWorkspaceRegistryPath(): string | undefined {
  return process.env.NATALIA_WORKSPACES_FILE;
}

/** The live state directory — where writes go. */
function liveWorkspaceRegistryPath() {
  return join(homedir(), ".config", "natalia", "workspaces.json");
}

/** The legacy `natalia-cli` location an existing install already wrote. */
function legacyWorkspaceRegistryPaths() {
  return LEGACY_STATE_DIR_NAMES.map((name) =>
    join(homedir(), ".config", name, "workspaces.json"),
  );
}

/**
 * The registry to READ: the live path if it exists, else the first legacy
 * path that does. An existing install's registry is honored; nothing is
 * copied or deleted, and the next write lands on the live name.
 */
async function readWorkspaceRegistryPath() {
  const explicit = explicitWorkspaceRegistryPath();
  if (explicit) return explicit;
  const live = liveWorkspaceRegistryPath();
  try {
    await access(live);
    return live;
  } catch {
    // fall through to the legacy candidates
  }
  for (const candidate of legacyWorkspaceRegistryPaths())
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  return live;
}

type WorkspaceRegistryEntry = {
  path: string;
  title?: string;
  /** Persisted across manager restarts so the last active workspace reopens. */
  active?: boolean;
};

async function readWorkspaceRegistry(): Promise<WorkspaceRegistryEntry[]> {
  try {
    const raw = JSON.parse(
      await readFile(await readWorkspaceRegistryPath(), "utf8"),
    ) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (entry): entry is WorkspaceRegistryEntry =>
        typeof entry === "object" && entry !== null,
    );
  } catch {
    return [];
  }
}

async function writeWorkspaceRegistry(entries: WorkspaceRegistryEntry[]) {
  const path = workspaceRegistryPath();
  await mkdir(join(homedir(), ".config", "natalia"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(path, `${JSON.stringify(entries, null, 2)}\n`, {
    mode: 0o600,
  });
}

function workspaceSessionDir(root: string, base?: string) {
  if (!base) return undefined;
  const safe = root.replace(/[^a-zA-Z0-9_-]+/gu, "_").slice(-80);
  return join(base, safe);
}

function workspaceCheckpointDir(root: string, base?: string) {
  if (!base) return undefined;
  const safe = root.replace(/[^a-zA-Z0-9_-]+/gu, "_").slice(-80);
  return join(base, safe);
}

export type WorkspaceManager = {
  list(): Promise<WorkspaceSummary[]>;
  listSessions(): Promise<RuntimeSessionSummary[]>;
  findWorkspaceForSession(
    sessionID: string,
  ): Promise<WorkspaceRuntime | undefined>;
  invalidateSessionCache(workspaceID?: string): void;
  add(input: { path: string; title?: string }): Promise<WorkspaceSummary>;
  remove(workspaceID: string): Promise<{ removed: boolean }>;
  activate(workspaceID: string): Promise<WorkspaceSummary>;
  load(): Promise<void>;
  workspaceRoots(): Promise<WorkspaceSummary[]>;
  workspaceAdd(input: {
    path: string;
    title?: string;
  }): Promise<WorkspaceSummary>;
  workspaceRemove(workspaceID: string): Promise<{ removed: boolean }>;
  workspaceActivate(workspaceID: string): Promise<WorkspaceSummary>;
  get(workspaceID: string): WorkspaceRuntime | undefined;
  getActive(): WorkspaceRuntime | undefined;
  summaryFor(workspace: WorkspaceRuntime): Promise<WorkspaceSummary>;
  workspacePermissionGet(
    workspaceID: string,
  ): Promise<WorkspacePermissionSettings>;
  workspacePermissionSet(
    workspaceID: string,
    settings: WorkspacePermissionSettings,
  ): Promise<WorkspacePermissionSettings>;
  workspaceSessionGet(workspaceID: string): Promise<string | undefined>;
  workspaceSessionSet(workspaceID: string, sessionID: string): Promise<void>;
  workspaceToolGet(workspaceID: string): Promise<WorkspaceToolSettings>;
  workspaceToolSet(
    workspaceID: string,
    settings: WorkspaceToolSettings,
  ): Promise<WorkspaceToolSettings>;
  dispose(): Promise<void>;
};

/**
 * Host-level multi-workspace manager. Each workspace owns its own real runtime
 * client and runtime state; all workspaces share the same global config path
 * and plugin store (no per-workspace global config/plugins).
 */
async function migrateLegacyWorkspaceSessions(
  root: string,
  legacyBase?: string,
): Promise<void> {
  if (!legacyBase) return;
  const legacyDir = workspaceSessionDir(root, legacyBase)!;
  const targetDir = join(root, ".natalia", "sessions");
  if (legacyDir === targetDir) return;
  try {
    const entries = (await readdir(legacyDir).catch(() => [])) as string[];
    const files = entries.filter((name) => name.endsWith(".json"));
    if (!files.length) return;
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    let migrated = 0;
    for (const name of files) {
      const source = join(legacyDir, name);
      const target = join(targetDir, name);
      try {
        await rename(source, target);
      } catch {
        continue;
      }
      migrated++;
    }
    await rm(legacyDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    // Host-facade boundary (decisions §6): this manager runs BEFORE any
    // runtime exists, so there is no service directory to log through —
    // console stays until the host-face data plane (T4) lands, and the
    // console guard allowlists this file with that reason.
    console.warn(
      "[workspace-session] migrated",
      migrated,
      "session files to",
      targetDir,
    );
  } catch (error) {
    console.warn("[workspace-session] legacy migration failed", error);
  }
}

export function createWorkspaceManager(
  options: WorkspaceManagerOptions = {},
): WorkspaceManager {
  const runtimes = new Map<string, WorkspaceRuntime>();
  let activeWorkspaceID: string | undefined;

  function registryEntries(): WorkspaceRegistryEntry[] {
    return [...runtimes.values()].map((runtime) => ({
      path: runtime.root,
      title: runtime.title,
      active: runtime.workspaceID === activeWorkspaceID,
    }));
  }

  const SESSION_CACHE_TTL_MS = 1_000;
  const sessionCache = new Map<
    string,
    { sessions: RuntimeSessionSummary[]; loadedAt: number }
  >();
  /** session id -> owning workspace id, the manager-level membership index. */
  const sessionWorkspaceIndex = new Map<string, string>();

  function replaceSessionIndex(
    workspaceID: string,
    sessions: readonly RuntimeSessionSummary[],
  ) {
    for (const [sessionID, owner] of sessionWorkspaceIndex) {
      if (owner === workspaceID) sessionWorkspaceIndex.delete(sessionID);
    }
    for (const session of sessions) {
      sessionWorkspaceIndex.set(session.id, workspaceID);
    }
  }

  function invalidateSessionCache(workspaceID?: string) {
    if (!workspaceID) {
      sessionCache.clear();
      sessionWorkspaceIndex.clear();
      return;
    }
    sessionCache.delete(workspaceID);
    for (const [sessionID, owner] of sessionWorkspaceIndex) {
      if (owner === workspaceID) sessionWorkspaceIndex.delete(sessionID);
    }
  }

  async function readLocalSessions(
    runtime: WorkspaceRuntime,
  ): Promise<RuntimeSessionSummary[]> {
    const rows = await createLocalSessionService(
      runtime.root,
      options.sessionDir,
    ).list({
      useSqliteStore: options.useSqliteStore ?? false,
    });
    return rows.map((row) => ({
      id: row.id,
      workspaceID: runtime.workspaceID,
      title: row.title,
      createdAt: row.createdAt,
      ...(row.lastAccessedAt ? { lastAccessedAt: row.lastAccessedAt } : {}),
      pinned: row.pinned,
      ...(row.archived !== undefined ? { archived: row.archived } : {}),
      events: row.events,
      pendingInputs: row.pendingInputs,
      cancelled: false,
      resumable: true,
      status: row.pendingInputs > 0 ? "running" : "idle",
    }));
  }

  async function listRuntimeSessions(
    runtime: WorkspaceRuntime,
    options?: { force?: boolean },
  ): Promise<RuntimeSessionSummary[]> {
    const cached = sessionCache.get(runtime.workspaceID);
    // A started runtime has the live, status-aware mirror. An inactive or
    // not-yet-started workspace is read from its local session store and
    // cached, so listing never initializes every workspace at once and
    // repeated refreshes do not re-scan every store.
    if (runtime.started && runtime.client.sessionList) {
      try {
        const rows = await runtime.client.sessionList();
        const sessions = rows.map((session) => ({
          ...session,
          workspaceID: runtime.workspaceID,
        }));
        sessionCache.set(runtime.workspaceID, {
          sessions,
          loadedAt: Date.now(),
        });
        replaceSessionIndex(runtime.workspaceID, sessions);
        return sessions;
      } catch {
        // Fall through to the cached/local mirror below.
      }
    }
    if (
      !options?.force &&
      cached &&
      Date.now() - cached.loadedAt < SESSION_CACHE_TTL_MS
    ) {
      return cached.sessions;
    }
    try {
      const sessions = await readLocalSessions(runtime);
      sessionCache.set(runtime.workspaceID, {
        sessions,
        loadedAt: Date.now(),
      });
      replaceSessionIndex(runtime.workspaceID, sessions);
      return sessions;
    } catch {
      return cached?.sessions ?? [];
    }
  }

  async function listSessions(): Promise<RuntimeSessionSummary[]> {
    const groups = await Promise.all(
      [...runtimes.values()].map((runtime) => listRuntimeSessions(runtime)),
    );
    return groups.flat();
  }

  async function findWorkspaceForSession(
    sessionID: string,
  ): Promise<WorkspaceRuntime | undefined> {
    const indexed = sessionWorkspaceIndex.get(sessionID);
    if (indexed) {
      const runtime = runtimes.get(indexed);
      if (runtime) return runtime;
    }
    // The index can predate an externally-created session. Force one local
    // refresh per workspace before giving up.
    for (const runtime of runtimes.values()) {
      const sessions = await listRuntimeSessions(runtime, { force: true });
      if (sessions.some((session) => session.id === sessionID)) return runtime;
    }
    return undefined;
  }

  async function activeSessionRecency(ws: WorkspaceRuntime): Promise<number> {
    try {
      const settings = await readSettings(ws.root);
      const rows = await createLocalSessionService(
        ws.root,
        options.sessionDir,
      ).list({
        useSqliteStore: options.useSqliteStore ?? false,
      });
      const active =
        rows.find((row) => row.id === settings.activeSessionID) ??
        [...rows].sort((left, right) =>
          (right.lastAccessedAt ?? right.createdAt).localeCompare(
            left.lastAccessedAt ?? left.createdAt,
          ),
        )[0];
      const value = Date.parse(
        active?.lastAccessedAt ?? active?.createdAt ?? "",
      );
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  async function summary(ws: WorkspaceRuntime): Promise<WorkspaceSummary> {
    const sessions = await listRuntimeSessions(ws);
    return {
      workspaceID: ws.workspaceID,
      root: ws.root,
      title: ws.title,
      status: ws.status,
      sessionCount: sessions.length,
      runningSessionCount: sessions.filter(
        (session) => session.pendingInputs > 0 || session.status === "running",
      ).length,
    };
  }

  async function activate(workspaceID: string): Promise<WorkspaceSummary> {
    const ws = runtimes.get(workspaceID);
    if (!ws) throw new Error(`workspace not found: ${workspaceID}`);
    activeWorkspaceID = workspaceID;
    ws.status = "active";
    for (const other of runtimes.values()) {
      if (other.workspaceID !== workspaceID && other.status === "active")
        other.status = "idle";
    }
    await writeWorkspaceRegistry(registryEntries());
    return await summary(ws);
  }

  async function addWorkspace(input: { path: string; title?: string }) {
    const root = resolve(input.path);
    const existing = [...runtimes.values()].find((ws) => ws.root === root);
    if (existing) {
      const nextTitle = input.title?.trim();
      if (nextTitle && nextTitle !== existing.title) {
        existing.title = nextTitle;
        await writeWorkspaceRegistry(registryEntries());
      }
      return await summary(existing);
    }

    await migrateLegacyWorkspaceSessions(root, options.sessionDir);
    const settings = await readSettings(root);
    const sessions = (
      await createLocalSessionService(root, options.sessionDir).list({
        useSqliteStore: options.useSqliteStore ?? false,
      })
    ).filter((session) => !session.archived);
    const activeSessionID =
      sessions.find((session) => session.id === settings.activeSessionID)?.id ??
      sessions.sort((left, right) =>
        (right.lastAccessedAt ?? right.createdAt).localeCompare(
          left.lastAccessedAt ?? left.createdAt,
        ),
      )[0]?.id;
    const client = createRealRuntimeClient({
      workspaceRoot: root,
      pluginStoreRoot: options.pluginStoreRoot,
      globalConfigPath: options.globalConfigPath,
      useSqliteStore: options.useSqliteStore,
      contextWindowCachePath: options.contextWindowCachePath,
      // Every store-layout option the manager accepts reaches the client:
      // accepting them for the migration alone left the runtime reading
      // the default external store while the caller (or a test) seeded the
      // opted-in one — two stores, one of them invisible.
      ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
      ...(options.checkpointDir
        ? { checkpointDir: options.checkpointDir }
        : {}),
      ...(options.operationLogsDir
        ? { operationLogsDir: options.operationLogsDir }
        : {}),
      ...(options.vaultDir ? { vaultDir: options.vaultDir } : {}),
      ...(activeSessionID ? { sessionID: activeSessionID } : {}),
    });
    const ws: WorkspaceRuntime = {
      workspaceID: `ws_${randomUUID().replace(/-/gu, "").slice(0, 12)}`,
      root,
      title: input.title ?? root.split("/").pop() ?? root,
      client,
      status: "idle",
      permissionSettings: settings.permissionSettings,
      toolSettings: settings.toolSettings,
    };
    runtimes.set(ws.workspaceID, ws);
    if (!activeWorkspaceID) await activate(ws.workspaceID);
    await writeWorkspaceRegistry(registryEntries());
    return await summary(ws);
  }

  async function removeWorkspace(workspaceID: string) {
    const ws = runtimes.get(workspaceID);
    if (!ws) return { removed: true };
    await ws.client.dispose?.();
    runtimes.delete(workspaceID);
    invalidateSessionCache(workspaceID);
    if (activeWorkspaceID === workspaceID) {
      const next = runtimes.values().next().value;
      activeWorkspaceID = next?.workspaceID;
      if (next) next.status = "active";
    }
    await writeWorkspaceRegistry(registryEntries());
    return { removed: true };
  }

  return {
    async load() {
      const entries = await readWorkspaceRegistry();
      for (const entry of entries) {
        if (
          entry.path &&
          ![...runtimes.values()].some((ws) => ws.root === resolve(entry.path))
        ) {
          await addWorkspace({ path: entry.path, title: entry.title });
        }
      }
      const preferredEntry = entries.find((entry) => entry.active);
      const preferredWorkspace = preferredEntry
        ? [...runtimes.values()].find(
            (runtime) => runtime.root === resolve(preferredEntry.path),
          )
        : undefined;
      if (preferredWorkspace) {
        await activate(preferredWorkspace.workspaceID);
        return;
      }
      if (runtimes.size <= 1) return;
      // Older registries had no active marker. Recover the workspace whose
      // selected session was touched most recently, matching what the user was
      // last looking at before the app closed.
      let newest:
        | { workspace: WorkspaceRuntime; timestamp: number }
        | undefined;
      for (const workspace of runtimes.values()) {
        const timestamp = await activeSessionRecency(workspace);
        if (!newest || timestamp > newest.timestamp)
          newest = { workspace, timestamp };
      }
      if (newest) await activate(newest.workspace.workspaceID);
    },
    listSessions,
    findWorkspaceForSession,
    invalidateSessionCache,
    async list() {
      return Promise.all([...runtimes.values()].map(summary));
    },
    async workspaceRoots() {
      return Promise.all([...runtimes.values()].map(summary));
    },
    workspaceAdd: addWorkspace,
    workspaceRemove: removeWorkspace,
    workspaceActivate: activate,
    async workspacePermissionGet(workspaceID) {
      const ws = runtimes.get(workspaceID);
      if (!ws) throw new Error(`workspace not found: ${workspaceID}`);
      return ws.permissionSettings;
    },
    async workspacePermissionSet(workspaceID, settings) {
      const ws = runtimes.get(workspaceID);
      if (!ws) throw new Error(`workspace not found: ${workspaceID}`);
      const saved = await writeSettings(ws.root, {
        permissionSettings: settings,
      });
      ws.permissionSettings = saved.permissionSettings;
      return ws.permissionSettings;
    },
    async workspaceSessionGet(workspaceID) {
      const ws = runtimes.get(workspaceID);
      if (!ws) throw new Error(`workspace not found: ${workspaceID}`);
      return (await readSettings(ws.root)).activeSessionID;
    },
    async workspaceSessionSet(workspaceID, sessionID) {
      const ws = runtimes.get(workspaceID);
      if (!ws) throw new Error(`workspace not found: ${workspaceID}`);
      await writeSettings(ws.root, { activeSessionID: sessionID });
    },
    async workspaceToolGet(workspaceID) {
      const ws = runtimes.get(workspaceID);
      if (!ws) throw new Error(`workspace not found: ${workspaceID}`);
      return ws.toolSettings;
    },
    async workspaceToolSet(workspaceID, settings) {
      const ws = runtimes.get(workspaceID);
      if (!ws) throw new Error(`workspace not found: ${workspaceID}`);
      const saved = await writeSettings(ws.root, { toolSettings: settings });
      ws.toolSettings = saved.toolSettings;
      return ws.toolSettings;
    },
    add: addWorkspace,
    remove: removeWorkspace,
    activate,
    get(workspaceID) {
      return runtimes.get(workspaceID);
    },
    getActive() {
      return activeWorkspaceID ? runtimes.get(activeWorkspaceID) : undefined;
    },
    async summaryFor(workspace: WorkspaceRuntime) {
      return summary(workspace);
    },
    async dispose() {
      for (const ws of runtimes.values()) await ws.client.dispose?.();
      runtimes.clear();
      activeWorkspaceID = undefined;
    },
  };
}

/**
 * A RuntimeClient facade that delegates all active-workspace methods to the
 * currently active real runtime and exposes workspace management on the same
 * object. Host shells can pass this as `UiPluginContext.runtime`.
 */
export function createWorkspaceRuntimeClient(
  manager: WorkspaceManager,
): RuntimeServiceClient & WorkspaceManager {
  const listeners = new Set<
    (event: import("@anthelia/contracts").RuntimeEvent) => void
  >();
  const startedClients = new Set<string>();
  let started = false;

  function emit(event: import("@anthelia/contracts").RuntimeEvent) {
    for (const listener of listeners) listener(event);
  }

  function decorateSession<T extends RuntimeSessionSummary>(
    session: T,
    workspace: WorkspaceRuntime,
  ): T {
    const summarySession = session as RuntimeSessionSummary;
    const status =
      summarySession.status ??
      (summarySession.cancelled
        ? "error"
        : summarySession.pendingInputs > 0
          ? "running"
          : summarySession.resumable
            ? "idle"
            : "stopped");
    return { ...session, workspaceID: workspace.workspaceID, status };
  }

  function startWorkspaceClient(workspace: WorkspaceRuntime) {
    workspace.started = true;
    if (startedClients.has(workspace.workspaceID)) return;
    startedClients.add(workspace.workspaceID);
    workspace.client.start((event) => {
      if (event.type.startsWith("session.")) {
        manager.invalidateSessionCache(workspace.workspaceID);
      }
      emit({ ...event, workspaceID: workspace.workspaceID });
    });
  }

  function startActiveClient() {
    const active = manager.getActive();
    if (active) startWorkspaceClient(active);
  }

  function isActiveSessionDeleteRefusal(error: unknown): boolean {
    return (
      error instanceof Error &&
      error.message.includes("cannot delete the active runtime session")
    );
  }

  /**
   * The runtime refuses to delete the session it is currently attached to.
   * When a workspace-scoped call targets that active session, attach another
   * session in the same workspace before retrying the delete. If the workspace
   * has only the doomed session, create one replacement so the runtime still
   * has a live attachment to serve when the workspace is opened again.
   */
  async function replaceActiveSessionForDelete(
    owner: WorkspaceRuntime,
    sessionID: string,
  ): Promise<void> {
    const client = owner.client as RuntimeServiceClient;
    const sessions = (await client.sessionList?.()) ?? [];
    const replacement = sessions.find(
      (session) => session.id !== sessionID && !session.archived,
    );
    if (replacement) {
      if (typeof client.sessionAttach !== "function")
        throw new Error(
          "cannot delete the active session: runtime does not support session attach",
        );
      await client.sessionAttach(replacement.id);
      await manager.workspaceSessionSet(owner.workspaceID, replacement.id);
      return;
    }
    if (typeof client.sessionNew !== "function")
      throw new Error(
        "cannot delete the active session: runtime does not support creating a replacement session",
      );
    const created = await client.sessionNew();
    if (!created?.sessionID)
      throw new Error(
        "cannot delete the active session: runtime did not create a replacement session",
      );
    if (typeof client.sessionAttach !== "function")
      throw new Error(
        "cannot delete the active session: runtime does not support session attach",
      );
    await client.sessionAttach(created.sessionID);
    await manager.workspaceSessionSet(owner.workspaceID, created.sessionID);
  }

  function emitWorkspace(event: import("@anthelia/contracts").RuntimeEvent) {
    emit(event);
  }

  const sessionIDFirstArg = new Set([
    "confirmedWorkspaceChanges",
    "teamPRList",
    "resume",
    "modelSelection",
    "reasoningEffort",
    "nativeTerminalList",
    "checkpointList",
    "sandboxList",
    "runtimeStatus",
    "constitutionRules",
    "constitutionDocRules",
    "decisionRecords",
    "mailboxList",
    "planDocList",
    "planDocActive",
    "planDocDeactivate",
    "evidenceRecords",
    "completions",
    "sessionSnapshot",
    "driftFindings",
    "registeredTools",
    "subagents",
    "subagentHistory",
  ]);

  const sessionIDSecondArg = new Set([
    "submit",
    "cancel",
    "pause",
    "selectAgent",
    "setReasoningEffort",
    "diagnostics",
    "recordDecision",
    "recordValidation",
    "recordCompletion",
    "evaluateDrift",
    "acknowledgeDriftFinding",
    "reopenDriftFinding",
    "promoteConstitutionDocRule",
    "updateConstitutionDocRule",
    "planTaskStates",
    "workGraphIntegrity",
    "unattributedChanges",
    "requestOverride",
    "nativeTerminalRead",
    "nativeTerminalClaimHumanInput",
    "nativeTerminalRevokeApprovalScope",
    "nativeTerminalReleaseHumanControl",
    "nativeTerminalBeginSecureInput",
    "nativeTerminalEndSecureInput",
    "nativeTerminalStop",
    "checkpointListByKind",
    "checkpointPreview",
    "sandboxDiff",
    "sandboxResources",
    "sandboxMerge",
    "sandboxDelete",
    "mailboxDeliver",
    "mailboxAcknowledge",
    "planDocDelete",
    "planDocStatus",
    "planDocActivate",
  ]);

  const sessionIDThirdArg = new Set([
    "selectModel",
    "mailboxDefer",
    "mailboxSupersede",
  ]);

  const objectSessionArg = new Set([
    "submitAndWait",
    "submitInput",
    "history",
    "messages",
    "nativeTerminalStart",
    "nativeTerminalWrite",
    "nativeTerminalResize",
    "checkpointRollback",
    "checkpointRename",
    "sandboxResourceOutput",
    "sandboxResourceStop",
    "mailboxSend",
    "planDocRead",
    "planDocWrite",
    "planDocMark",
    "planDocUpdateStatus",
    "subagentHistoryPage",
    "pendingInteractive",
    "commandExecute",
    "snapshot",
    "lastSubmission",
    "workGraphNodes",
    "workGraphEdges",
    "respondApproval",
    "respondQuestion",
    "respondInteractive",
  ]);

  const workspaceScopedMethods = new Set([
    "workspaceFiles",
    "workspaceSearch",
    "workspaceList",
    "workspaceRead",
    "resourceRead",
    "workspaceWrite",
    "workspaceCreate",
    "workspaceRename",
    "workspaceDelete",
    "workspaceGlob",
    "workspaceDiff",
    "workspaceGitDiff",
    "gitRefs",
    "roundDiff",
    "workspaceWriteConflicts",
    "astDiff",
    "astDiffBatch",
    "astRefactorPreview",
    "astService",
    "astRefactorPlan",
    "astApplyRefactor",
    "mcpCatalog",
    "mcpServerAdd",
    "agents",
    "modelCatalog",
    "skills",
    "agentCreate",
    "agentUpdate",
    "commandCatalog",
    "uploadAttachment",
    "attachmentDataUrl",
    "capabilities",
    "projectionContributions",
    // Workspace-scoped settings faces. Without a route these fell through to
    // the manager's own fallback, which reads `active.client` WITHOUT starting
    // it — so a click on a panel's settings row hit an unstarted (or absent)
    // workspace and did nothing at all, with no error surfaced.
    "settingsGet",
    "settingsSet",
  ]);

  const workspaceIDSecondArg = new Set([
    "auditRounds",
    "mcpServerRemove",
    "agentDelete",
  ]);
  const workspaceIDThirdArg = new Set(["readMcpResource"]);
  const workspaceIDFourthArg = new Set(["getMcpPrompt"]);

  const sessionScopedMethods = new Set([
    ...sessionIDFirstArg,
    ...sessionIDSecondArg,
    ...sessionIDThirdArg,
    ...objectSessionArg,
  ]);

  const routableMethods = new Set([
    ...sessionScopedMethods,
    ...workspaceScopedMethods,
    ...workspaceIDSecondArg,
    ...workspaceIDThirdArg,
    ...workspaceIDFourthArg,
  ]);

  function workspaceIDFromArgs(
    prop: string,
    args: unknown[],
  ): string | undefined {
    if (workspaceIDSecondArg.has(prop) && typeof args[1] === "string")
      return args[1];
    if (workspaceIDThirdArg.has(prop) && typeof args[2] === "string")
      return args[2];
    if (workspaceIDFourthArg.has(prop) && typeof args[3] === "string")
      return args[3];
    const first = args[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const value = (first as { workspaceID?: unknown }).workspaceID;
      if (typeof value === "string") return value;
    }
    return undefined;
  }

  function sessionIDFromArgs(
    prop: string,
    args: unknown[],
  ): string | undefined {
    const stringAt = (index: number) =>
      typeof args[index] === "string" ? (args[index] as string) : undefined;
    if (sessionIDFirstArg.has(prop)) return stringAt(0);
    if (sessionIDSecondArg.has(prop)) return stringAt(1);
    if (sessionIDThirdArg.has(prop)) return stringAt(2);
    const first = args[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const value = (first as { sessionID?: unknown }).sessionID;
      if (typeof value === "string") return value;
    }
    return undefined;
  }

  async function resolveRoutedWorkspace(
    prop: string,
    args: unknown[],
  ): Promise<WorkspaceRuntime | undefined> {
    const explicitWorkspaceID = workspaceIDFromArgs(prop, args);
    const requestedSessionID = sessionIDFromArgs(prop, args);
    if (explicitWorkspaceID) {
      const owner = manager.get(explicitWorkspaceID);
      if (!owner) return undefined;
      if (requestedSessionID) {
        const sessionOwner =
          await manager.findWorkspaceForSession(requestedSessionID);
        if (!sessionOwner || sessionOwner.workspaceID !== owner.workspaceID) {
          throw new RuntimeRefusal(
            `session ${requestedSessionID} does not belong to workspace ${explicitWorkspaceID}`,
          );
        }
      }
      return owner;
    }
    if (requestedSessionID) {
      return (
        (await manager.findWorkspaceForSession(requestedSessionID)) ??
        manager.getActive()
      );
    }
    return manager.getActive();
  }

  const handler: ProxyHandler<object> = {
    get(_target, prop, _receiver) {
      if (prop === "start") {
        return (
          onEvent?: (event: import("@anthelia/contracts").RuntimeEvent) => void,
        ) => {
          if (onEvent) listeners.add(onEvent);
          started = true;
          startActiveClient();
        };
      }
      if (prop === "workspaceAdd") {
        return async (input: { path: string; title?: string }) => {
          const wasEmpty = !manager.getActive();
          const result = await manager.workspaceAdd(input);
          if (started && (wasEmpty || result.status === "active"))
            startActiveClient();
          if (started)
            emitWorkspace({
              type: "workspace.added",
              workspace: result,
              workspaceID: result.workspaceID,
            });
          return result;
        };
      }
      if (prop === "workspaceActivate") {
        return async (workspaceID: string) => {
          const result = await manager.workspaceActivate(workspaceID);
          if (started) startActiveClient();
          if (started)
            emitWorkspace({
              type: "workspace.activated",
              workspace: result,
              workspaceID: result.workspaceID,
            });
          return result;
        };
      }
      if (prop === "workspaceRemove") {
        return async (workspaceID: string) => {
          const result = await manager.workspaceRemove(workspaceID);
          if (started) {
            emitWorkspace({
              type: "workspace.removed",
              workspaceID,
            });
            const next = manager.getActive();
            if (next) {
              emitWorkspace({
                type: "workspace.activated",
                workspace: await manager.summaryFor(next),
                workspaceID: next.workspaceID,
              });
            }
          }
          return result;
        };
      }
      if (prop === "sessionList") {
        return async () => {
          const sessions = await manager.listSessions();
          return sessions.map((session) => {
            const owner = session.workspaceID
              ? manager.get(session.workspaceID)
              : undefined;
            return owner ? decorateSession(session, owner) : session;
          });
        };
      }
      if (
        prop === "sessionRename" ||
        prop === "sessionPin" ||
        prop === "sessionDuplicate" ||
        prop === "sessionFork" ||
        prop === "sessionRollbackMessages" ||
        prop === "sessionDelete" ||
        prop === "sessionArchive" ||
        prop === "sessionRestore" ||
        prop === "sessionExport" ||
        prop === "sessionAttach" ||
        prop === "sessionTouch"
      ) {
        return async (...args: unknown[]) => {
          const sessionID = args[0];
          if (typeof sessionID !== "string") return undefined;
          const owner =
            (await manager.findWorkspaceForSession(sessionID)) ??
            manager.getActive();
          if (!owner) return undefined;
          const fn = (owner.client as unknown as Record<PropertyKey, unknown>)[
            prop
          ];
          if (typeof fn !== "function") return undefined;
          if (prop === "sessionAttach") {
            await manager.workspaceActivate(owner.workspaceID);
            startWorkspaceClient(owner);
            if (started)
              emitWorkspace({
                type: "workspace.activated",
                workspace: await manager.summaryFor(owner),
                workspaceID: owner.workspaceID,
              });
          } else {
            startWorkspaceClient(owner);
          }
          let result: unknown;
          try {
            result = await (
              fn as (...call: unknown[]) => Promise<unknown>
            ).apply(owner.client, args);
          } catch (error) {
            if (
              prop !== "sessionDelete" ||
              !isActiveSessionDeleteRefusal(error)
            )
              throw error;
            await replaceActiveSessionForDelete(owner, sessionID);
            result = await (
              fn as (...call: unknown[]) => Promise<unknown>
            ).apply(owner.client, args);
          }
          manager.invalidateSessionCache(owner.workspaceID);
          if (
            prop === "sessionAttach" &&
            result &&
            typeof result === "object" &&
            "sessionID" in result &&
            typeof result.sessionID === "string"
          ) {
            await manager.workspaceSessionSet(
              owner.workspaceID,
              result.sessionID,
            );
          }
          if (
            result &&
            typeof result === "object" &&
            "id" in result &&
            "title" in result &&
            !("workspaceID" in result)
          ) {
            return decorateSession(result as RuntimeSessionSummary, owner);
          }
          return result;
        };
      }
      if (prop === "sessionNew") {
        return async (input?: {
          id?: string;
          title?: string;
          workspaceID?: string;
        }) => {
          const workspaceID = input?.workspaceID;
          const owner = workspaceID
            ? manager.get(workspaceID)
            : manager.getActive();
          if (!owner) return undefined;
          const fn = (owner.client as unknown as Record<PropertyKey, unknown>)[
            prop
          ];
          if (typeof fn !== "function") return undefined;
          startWorkspaceClient(owner);
          const result = await (
            fn as (...call: unknown[]) => Promise<unknown>
          ).apply(owner.client, [input]);
          manager.invalidateSessionCache(owner.workspaceID);
          return result;
        };
      }
      if (prop === "naviChat" || prop === "niaChat") {
        const stream = prop;
        const sessionForMethod = (method: string, args: unknown[]) => {
          if (method === "submit" || method === "messagesPage") {
            const first = args[0];
            return first && typeof first === "object"
              ? (first as { sessionID?: string }).sessionID
              : undefined;
          }
          if (method === "rollback" || method === "setModelProfile")
            return typeof args[1] === "string" ? args[1] : undefined;
          return typeof args[0] === "string" ? args[0] : undefined;
        };
        const surface: Record<
          string,
          (...args: unknown[]) => Promise<unknown>
        > = {};
        for (const method of [
          "submit",
          "abort",
          "messages",
          "messagesPage",
          "rollback",
          "modelProfile",
          "setModelProfile",
        ]) {
          surface[method] = async (...args: unknown[]) => {
            const sessionID = sessionForMethod(method, args);
            const owner = sessionID
              ? ((await manager.findWorkspaceForSession(sessionID)) ??
                manager.getActive())
              : manager.getActive();
            if (!owner) return undefined;
            startWorkspaceClient(owner);
            const target = (
              owner.client as unknown as Record<
                string,
                Record<string, unknown> | undefined
              >
            )[stream];
            const fn = target?.[method];
            return typeof fn === "function"
              ? await (fn as (...call: unknown[]) => Promise<unknown>).apply(
                  target,
                  args,
                )
              : undefined;
          };
        }
        return surface;
      }
      if (typeof prop === "string" && routableMethods.has(prop)) {
        return async (...args: unknown[]) => {
          const owner = await resolveRoutedWorkspace(prop, args);
          if (!owner) {
            // Refuse, do not resolve to undefined: these are the faces a user
            // CLICKS in the settings panel. A silent undefined is
            // indistinguishable from a working runtime that answered "no" —
            // which is how a settings row came to accept a click and then do
            // nothing at all.
            if (
              prop.startsWith("nativeTerminal") ||
              prop === "settingsGet" ||
              prop === "settingsSet"
            )
              throw new Error(
                prop.startsWith("nativeTerminal")
                  ? "no active workspace: open or activate a workspace before using the terminal"
                  : `no active workspace: ${prop} needs a runtime`,
              );
            return undefined;
          }
          const fn = (owner.client as unknown as Record<PropertyKey, unknown>)[
            prop
          ];
          if (typeof fn !== "function") return undefined;
          startWorkspaceClient(owner);
          const result = await (
            fn as (...call: unknown[]) => Promise<unknown>
          ).apply(owner.client, args);
          if (prop === "planDocActivate" || prop === "planDocDeactivate")
            manager.invalidateSessionCache(owner.workspaceID);
          return result;
        };
      }
      if (prop in manager) {
        const value = (manager as unknown as Record<PropertyKey, unknown>)[
          prop
        ];
        return typeof value === "function" ? value.bind(manager) : value;
      }
      const active = manager.getActive();
      if (!active) {
        if (
          typeof prop === "string" &&
          (prop.startsWith("nativeTerminal") ||
            prop === "subscribeTerminalOutput")
        ) {
          const unavailable = () => {
            throw new Error(
              "no active workspace: open or activate a workspace before using the terminal",
            );
          };
          return prop === "subscribeTerminalOutput"
            ? unavailable
            : async () => unavailable();
        }
        return undefined;
      }
      const value = (active.client as unknown as Record<PropertyKey, unknown>)[
        prop
      ];
      return typeof value === "function" ? value.bind(active.client) : value;
    },
  };
  return new Proxy({}, handler) as RuntimeServiceClient & WorkspaceManager;
}

import {
  checkpointDisplayLine,
  compactionDisplayLine,
  globWorkspaceFiles,
  listWorkspaceFiles,
  readWorkspaceFile,
  retryDisplayLine,
  searchWorkspaceFiles,
} from "@natalia/client";
import { layerCensus } from "./layer-census";
import { configuredBashPath, resolveBashExecutable } from "@anthelia/platform";
import {
  defaultConfigV3,
  defaultGlobalConfigPath,
  loadConfigFile,
  loadTrustStore,
  migrateConfig,
  migrationSummaryText,
  modelSelectionStatus,
  removeTrust,
  resolveConfig,
  resolveEffectiveModel,
} from "@anthelia/config";
import type { RuntimeEvent } from "@anthelia/contracts";
import { ContextWindowResolver } from "@anthelia/runtime";
import {
  createLocalSessionService,
  type LocalSessionRow,
  type SessionMetadataBundle,
} from "@anthelia/session-store";
export type StartupDiagnostics = {
  configPath: string;
  migrationSummary: string;
  tty: boolean;
  automation: boolean;
};

export async function startupDiagnostics(
  configPath: string,
  tty = Boolean(process.stdout.isTTY),
): Promise<StartupDiagnostics> {
  const loaded = await loadConfigFile(configPath);
  return {
    configPath,
    migrationSummary: migrationSummaryText(loaded.summary),
    tty,
    automation: !tty,
  };
}

export async function plainStatus(configPath: string) {
  const loaded = await loadConfigFile(configPath);
  const ref = loaded.config.defaultModel;
  if (!ref) throw new Error("missing default model: none configured");
  const effective = resolveEffectiveModel(loaded.config, ref);
  if (!effective) throw new Error("missing default model: none configured");
  const resolver = new ContextWindowResolver();
  const resolved = await resolver.resolve({
    provider: effective.providerID,
    model: effective.ref.model,
    explicitContextWindow: effective.limits.contextWindow,
    useModelsDevCatalog: true,
  });
  return {
    mode: process.stdout.isTTY ? "tty" : "plain",
    model: effective.ref.model,
    provider: effective.providerID,
    contextWindow: resolved,
  };
}

export function plainEventLine(event: RuntimeEvent) {
  return (
    checkpointDisplayLine(event) ??
    retryDisplayLine(event) ??
    compactionDisplayLine(event) ??
    event.type
  );
}

export type SessionListRow = LocalSessionRow;

export async function listLocalSessions(workspaceRoot = process.cwd()) {
  return createLocalSessionService(workspaceRoot).list();
}

export async function deleteLocalSession(
  id: string,
  workspaceRoot = process.cwd(),
) {
  return createLocalSessionService(workspaceRoot).delete(id);
}

export async function showLocalSession(
  id: string,
  workspaceRoot = process.cwd(),
) {
  return createLocalSessionService(workspaceRoot).show(id);
}

export async function localWorkGraph(
  sessionID: string,
  workspaceRoot = process.cwd(),
) {
  return createLocalSessionService(workspaceRoot).workGraph(sessionID);
}

export function workGraphLines(
  graph: Awaited<ReturnType<typeof localWorkGraph>>,
) {
  return [
    `session: ${graph.sessionID}`,
    `nodes: ${graph.nodes.length}`,
    ...graph.nodes.map(
      (node) =>
        `  ${node.kind} ${node.nodeID}: ${node.summary}${node.target ? ` -> ${node.target}` : ""}`,
    ),
    `edges: ${graph.edges.length}`,
    ...graph.edges.map(
      (edge) => `  ${edge.kind}: ${edge.sourceID} -> ${edge.targetID}`,
    ),
  ];
}

export async function renameLocalSession(
  id: string,
  title: string,
  workspaceRoot = process.cwd(),
) {
  return createLocalSessionService(workspaceRoot).rename(id, title);
}

export async function setLocalSessionPinned(
  id: string,
  pinned: boolean,
  workspaceRoot = process.cwd(),
) {
  return createLocalSessionService(workspaceRoot).setPinned(id, pinned);
}

export async function duplicateLocalSession(
  id: string,
  input: { title?: string; newID?: string; workspaceRoot?: string } = {},
) {
  return createLocalSessionService(input.workspaceRoot).duplicate(id, input);
}

export type { SessionMetadataBundle };

export async function exportLocalSessionMetadata(
  id: string,
  workspaceRoot = process.cwd(),
): Promise<SessionMetadataBundle> {
  return createLocalSessionService(workspaceRoot).exportMetadata(id);
}

export async function importLocalSessionMetadata(
  bundle: SessionMetadataBundle,
  input: { workspaceRoot?: string; id?: string; title?: string } = {},
) {
  return createLocalSessionService(input.workspaceRoot).importMetadata(
    bundle,
    input,
  );
}

export async function doctorReport(input: {
  configPath: string;
  workspaceRoot?: string;
}) {
  // Doctor REPORTS absence, it never dies on it: the installer
  // advertises this command as the very first run, executed from
  // wherever the user stands (often a directory with no project
  // config). Project file, then global, then schema defaults — the
  // sources list below still tells the truth about what was missing.
  const loaded = await loadConfigFile(input.configPath).catch(
    async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      try {
        return await loadConfigFile(defaultGlobalConfigPath());
      } catch (globalError) {
        if ((globalError as NodeJS.ErrnoException).code !== "ENOENT")
          throw globalError;
        return migrateConfig(defaultConfigV3());
      }
    },
  );
  const resolved = await resolveConfig({
    workspaceRoot: input.workspaceRoot ?? process.cwd(),
    globalPath: input.configPath,
  });
  const defaultRef = loaded.config.defaultModel;
  const selection = defaultRef
    ? modelSelectionStatus(loaded.config, defaultRef)
    : {
        ref: { provider: "", model: "" },
        key: "",
        configured: false,
        usable: false,
        policyAllowed: false,
        selected: false,
        reason: "model_not_configured",
      };
  const sessions = await listLocalSessions(input.workspaceRoot);
  return {
    configPath: input.configPath,
    migration: migrationSummaryText(loaded.summary),
    defaultModel: selection,
    sessions: {
      count: sessions.length,
      pendingInputs: sessions.reduce(
        (sum, session) => sum + session.pendingInputs,
        0,
      ),
    },
    runtime: {
      tty: Boolean(process.stdout.isTTY),
      automation: !process.stdout.isTTY,
    },
    sources: resolved.sources.map((source) => ({
      scope: source.scope,
      path: source.path,
      applied: source.applied,
      diagnostic: source.diagnostic,
    })),
    // P4: which layers this build contains (build manifest, else live
    // workspace scopes, else honestly none).
    layers: await layerCensus(),
  };
}

export function sessionTable(rows: SessionListRow[]) {
  if (!rows.length) return "no sessions";
  return [
    "ID\tTITLE\tEVENTS\tPENDING\tPINNED",
    ...rows.map((session) =>
      [
        session.id,
        session.title.replace(/\s+/gu, " "),
        session.events,
        session.pendingInputs,
        session.pinned ? "yes" : "no",
      ].join("\t"),
    ),
  ].join("\n");
}

export function parseAttachmentFlags(argv: string[]) {
  const attachments: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== "--attach") continue;
    const path = argv[index + 1];
    if (!path || path.startsWith("--"))
      throw new Error("--attach requires a workspace-relative path");
    attachments.push(path);
    index++;
  }
  return attachments;
}

export function promptArguments(argv: string[]) {
  const attachments = parseAttachmentFlags(argv);
  const text = argv
    .filter((value, index) => {
      if (value === "--attach") return false;
      if (index > 0 && argv[index - 1] === "--attach") return false;
      return value !== "--json";
    })
    .join(" ")
    .trim();
  return { text, attachments };
}

export async function workspaceFilesystemCommand(input: {
  action: "list" | "read" | "glob" | "search";
  workspaceRoot?: string;
  path?: string;
  pattern?: string;
  query?: string;
  include?: string;
  offset?: number;
  limit?: number;
}) {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  if (input.action === "list")
    return await listWorkspaceFiles({
      workspaceRoot,
      path: input.path,
      offset: input.offset,
      limit: input.limit,
    });
  if (input.action === "read") {
    if (!input.path) throw new Error("fs read requires a path");
    return await readWorkspaceFile({
      workspaceRoot,
      path: input.path,
      offset: input.offset,
      limit: input.limit,
    });
  }
  if (input.action === "glob") {
    if (!input.pattern) throw new Error("fs glob requires a pattern");
    return await globWorkspaceFiles({
      workspaceRoot,
      pattern: input.pattern,
      path: input.path,
      limit: input.limit,
    });
  }
  if (!input.query) throw new Error("fs search requires a query");
  return await searchWorkspaceFiles({
    workspaceRoot,
    query: input.query,
    include: input.include,
    limit: input.limit,
  });
}

/** The trust database, for `natalia trust list`. */
export async function trustList(workspaceRoot: string) {
  const store = await loadTrustStore(workspaceRoot);
  return Object.entries(store).map(([key, entry]) => ({
    key,
    source: entry.source,
    version: entry.version,
    installedAt: entry.installedAt,
  }));
}

/** Removes a trust record, for `natalia trust remove`. */
export async function trustRemove(workspaceRoot: string, key: string) {
  const store = await removeTrust(workspaceRoot, key);
  return { removed: !store[key], key };
}

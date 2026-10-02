import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp as createTemporaryDirectory,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultConfigV3,
  migrateProjectModelConfigToGlobal,
  saveConfigFile,
} from "@anthelia/config";
import {
  JsonSessionStore,
  SqliteSessionStore,
  createSessionRecord,
} from "@anthelia/session";
import {
  deleteLocalSession,
  duplicateLocalSession,
  exportLocalSessionMetadata,
  importLocalSessionMetadata,
  doctorReport,
  listLocalSessions,
  parseAttachmentFlags,
  promptArguments,
  renameLocalSession,
  setLocalSessionPinned,
  sessionTable,
  showLocalSession,
  localWorkGraph,
  workGraphLines,
  workspaceFilesystemCommand,
} from "../src";

const temporaryDirectories = new Set<string>();
let testPluginDistribution: string;
let testNataliaInstance: string;
const previousNodeEnvironment = process.env.NODE_ENV;
const previousTestPluginDistribution =
  process.env.NATALIA_TEST_OFFICIAL_PLUGIN_DISTRIBUTION;
const previousNpmCache = process.env.npm_config_cache;

beforeAll(async () => {
  testNataliaInstance = await createTemporaryDirectory(
    join(tmpdir(), "natalia-instance-"),
  );
  // Plugin installation shells out to npm. Point its cache at the test temp
  // directory so a read-only or unavailable user cache cannot fail the suite.
  process.env.npm_config_cache = join(testNataliaInstance, "npm-cache");
  await mkdir(process.env.npm_config_cache, { recursive: true });
  testPluginDistribution = join(testNataliaInstance, "plugins");
  await cp(
    join(import.meta.dir, "../../../dist/ts/plugins"),
    testPluginDistribution,
    {
      recursive: true,
    },
  );
  const terminalRoot = join(testPluginDistribution, "natalia-tool-terminal");
  await rm(join(terminalRoot, "wezterm"), { recursive: true, force: true });
  const terminalPackagePath = join(terminalRoot, "package.json");
  const terminalPackage = JSON.parse(
    await readFile(terminalPackagePath, "utf8"),
  ) as { files: string[] };
  terminalPackage.files = terminalPackage.files.filter(
    (entry) => entry !== "wezterm",
  );
  await writeFile(terminalPackagePath, JSON.stringify(terminalPackage));
  process.env.NODE_ENV = "test";
  process.env.NATALIA_TEST_OFFICIAL_PLUGIN_DISTRIBUTION =
    testPluginDistribution;
});

async function mkdtemp(prefix: string) {
  const path = await createTemporaryDirectory(prefix);
  temporaryDirectories.add(path);
  return path;
}

afterEach(async () => {
  const paths = [...temporaryDirectories];
  temporaryDirectories.clear();
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  await rm(testNataliaInstance, { recursive: true, force: true });
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;
  if (previousTestPluginDistribution === undefined)
    delete process.env.NATALIA_TEST_OFFICIAL_PLUGIN_DISTRIBUTION;
  else
    process.env.NATALIA_TEST_OFFICIAL_PLUGIN_DISTRIBUTION =
      previousTestPluginDistribution;
  if (previousNpmCache === undefined) delete process.env.npm_config_cache;
  else process.env.npm_config_cache = previousNpmCache;
});

test("CLI Work Graph reader projects only safe nodes and edges", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-workgraph-"));
  const store = new JsonSessionStore(join(root, ".natalia", "sessions"));
  const session = createSessionRecord("ses_cli_graph", "Graph");
  session.events.push(
    {
      type: "workgraph.node_added",
      id: "node",
      nodeID: "wg:change:turn:file.ts",
      kind: "workspace_change",
      summary: "write_file changed",
      target: "file.ts",
      sessionID: "ses_cli_graph",
    },
    {
      type: "workgraph.edge_added",
      id: "edge",
      sourceID: "wg:tool:turn:call",
      targetID: "wg:change:turn:file.ts",
      kind: "modified",
    },
    {
      type: "tool.update",
      id: "call",
      name: "write_file",
      status: "succeeded",
      summary: "write_file succeeded",
      result: "SECRETFILEBODY",
    },
  );
  await store.save(session);
  const graph = await localWorkGraph("ses_cli_graph", root);
  expect(graph.nodes).toHaveLength(1);
  expect(graph.edges).toHaveLength(1);
  expect(JSON.stringify(graph)).not.toContain("SECRETFILEBODY");
  expect(workGraphLines(graph)).toContain(
    "  modified: wg:tool:turn:call -> wg:change:turn:file.ts",
  );
});

test("CLI session helpers list and delete local durable sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sessions-"));
  const store = new JsonSessionStore(join(root, ".natalia", "sessions"));
  const record = createSessionRecord(
    "ses_cli" as import("@anthelia/contracts").SessionID,
    "CLI session",
  );
  record.events.push({ type: "diagnostic", level: "info", message: "saved" });
  record.inbox = [
    {
      id: "input",
      sessionID: record.id,
      text: "pending",
      delivery: "next-turn",
      admittedAt: "2026-01-01T00:00:00.000Z",
      admittedSeq: 1,
    },
  ];
  await store.save(record);
  expect(await listLocalSessions(root)).toMatchObject([
    { id: "ses_cli", events: 1, pendingInputs: 1 },
  ]);
  expect(sessionTable(await listLocalSessions(root))).toContain("CLI session");
  expect(await deleteLocalSession("ses_cli", root)).toEqual({
    id: "ses_cli",
    deleted: true,
    removedAttachments: 0,
  });
  expect(await listLocalSessions(root)).toEqual([]);
});

test("CLI session helpers list and show SQLite-backed unattended episodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sqlite-sessions-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  const store = new SqliteSessionStore(join(root, ".natalia", "sessions.db"));
  const id =
    "ses_unattended_episode" as import("@anthelia/contracts").SessionID;
  store.create(id, "Natalia unattended episode epi_unattended_episode");
  store.appendEvents(id, [
    {
      type: "turn.submitted",
      id: "turn",
      text: "/doctor",
      byteLength: 7,
      lineCount: 1,
      sha256: "doctor",
      episodeID: "epi_unattended_episode",
    },
    {
      type: "turn.finished",
      id: "turn",
      stopReason: "done",
      episodeID: "epi_unattended_episode",
    },
  ]);
  store.close();

  expect(await listLocalSessions(root)).toContainEqual(
    expect.objectContaining({ id, events: 2 }),
  );
  expect(await showLocalSession(id, root)).toMatchObject({
    id,
    events: 2,
    pendingInputs: 0,
  });
});

test("CLI session metadata export/import omits event and attachment contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-bundle-"));
  const store = new JsonSessionStore(join(root, ".natalia", "sessions"));
  const record = createSessionRecord(
    "ses_bundle" as import("@anthelia/contracts").SessionID,
    "Bundle source",
  );
  record.metadata = { pinned: true };
  record.events.push({
    type: "content.delta",
    id: "turn",
    text: "private content",
  });
  await store.save(record);
  const bundle = await exportLocalSessionMetadata("ses_bundle", root);
  expect(JSON.stringify(bundle)).not.toContain("private content");
  expect(bundle).toMatchObject({
    version: 1,
    source: { id: "ses_bundle" },
    pinned: true,
  });
  expect(
    await importLocalSessionMetadata(bundle, {
      workspaceRoot: root,
      id: "ses_bundle_import",
    }),
  ).toEqual({
    id: "ses_bundle_import",
    title: "Bundle source",
    importedFrom: "ses_bundle",
  });
  expect(await showLocalSession("ses_bundle_import", root)).toMatchObject({
    events: 0,
    pinned: true,
  });
});

test("CLI session delete reclaims an attachment orphaned by the removed session", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-delete-attachment-"));
  const store = new JsonSessionStore(join(root, ".natalia", "sessions"));
  const record = createSessionRecord(
    "ses_attachment" as import("@anthelia/contracts").SessionID,
    "Attachment session",
  );
  record.events.push({
    type: "turn.submitted",
    id: "turn",
    text: "inspect",
    byteLength: 7,
    lineCount: 1,
    sha256: "turn",
    attachments: [
      {
        id: "att_cli",
        path: ".natalia/attachments/att_cli-image.png",
        filename: "image.png",
        mediaType: "image/png",
        byteLength: 8,
        sha256: "attachment",
      },
    ],
  });
  await store.save(record);
  const attachmentRoot = join(root, ".natalia", "attachments");
  await mkdir(attachmentRoot, { recursive: true });
  await writeFile(
    join(attachmentRoot, "att_cli-image.png"),
    "orphan after delete",
  );
  expect(await deleteLocalSession("ses_attachment", root)).toMatchObject({
    deleted: true,
    removedAttachments: 1,
  });
  expect(
    await Bun.file(join(attachmentRoot, "att_cli-image.png")).exists(),
  ).toBe(false);
});

test("CLI run attachment flags preserve prompt text and validate values", () => {
  expect(
    promptArguments([
      "inspect",
      "this",
      "--attach",
      "image.png",
      "--attach",
      "notes.md",
    ]),
  ).toEqual({ text: "inspect this", attachments: ["image.png", "notes.md"] });
  expect(
    promptArguments(["inspect", "--json", "--attach", "image.png"]),
  ).toEqual({ text: "inspect", attachments: ["image.png"] });
  expect(() => parseAttachmentFlags(["--attach"])).toThrow(
    "--attach requires a workspace-relative path",
  );
  expect(() => parseAttachmentFlags(["--attach", "--json"])).toThrow(
    "--attach requires a workspace-relative path",
  );
});

test("CLI filesystem commands share protected workspace APIs", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-filesystem-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.ts"), "const answer = 42\n");
  expect(
    await workspaceFilesystemCommand({ action: "list", workspaceRoot: root }),
  ).toEqual({
    entries: [{ path: "src/", type: "directory" }],
    truncated: false,
  });
  expect(
    await workspaceFilesystemCommand({
      action: "read",
      workspaceRoot: root,
      path: "src/main.ts",
      offset: 1,
      limit: 1,
    }),
  ).toMatchObject({ offset: 1, truncated: false });
  expect(
    await workspaceFilesystemCommand({
      action: "glob",
      workspaceRoot: root,
      pattern: "**/*.ts",
    }),
  ).toEqual([{ path: "src/main.ts", type: "file" }]);
  expect(
    await workspaceFilesystemCommand({
      action: "search",
      workspaceRoot: root,
      query: "answer",
    }),
  ).toEqual([{ path: "src/main.ts", line: 1, text: "const answer = 42" }]);
  await expect(
    workspaceFilesystemCommand({
      action: "read",
      workspaceRoot: root,
      path: "../outside",
    }),
  ).rejects.toThrow("workspace path must remain inside workspace");
});

test("CLI session helpers expose safe metadata and local mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-actions-"));
  const store = new JsonSessionStore(join(root, ".natalia", "sessions"));
  const record = createSessionRecord(
    "ses_actions" as import("@anthelia/contracts").SessionID,
    "Initial title",
  );
  record.events.push({
    type: "content.delta",
    id: "turn",
    text: "private event detail",
  });
  await store.save(record);
  expect(await showLocalSession("ses_actions", root)).toMatchObject({
    id: "ses_actions",
    title: "Initial title",
    events: 1,
  });
  expect(await renameLocalSession("ses_actions", "Renamed", root)).toEqual({
    id: "ses_actions",
    title: "Renamed",
  });
  expect(await setLocalSessionPinned("ses_actions", true, root)).toEqual({
    id: "ses_actions",
    pinned: true,
  });
  expect(
    await duplicateLocalSession("ses_actions", {
      newID: "ses_copy",
      title: "Copy",
      workspaceRoot: root,
    }),
  ).toEqual({ id: "ses_copy", title: "Copy", duplicatedFrom: "ses_actions" });
  expect(
    (await listLocalSessions(root)).map((session) => session.id).sort(),
  ).toEqual(["ses_actions", "ses_copy"]);
});

test("CLI doctor reports safe config/model/session availability", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-doctor-"));
  const config = defaultConfigV3();
  config.providers.local = {
    name: "local",
    driver: "openai",
    enabled: true,
    connection: { apiKey: "local-key" },
    requestDefaults: { stream: true, headers: {}, options: {} },
  };
  config.catalog.providers.local = {
    models: {
      model: {
        name: "model",
        status: "stable",
        source: "manual",
        capabilities: {
          toolCall: true,
          reasoning: true,
          thinking: true,
          imageInput: false,
          videoInput: false,
        },
        limits: { contextWindow: "auto", maxOutputTokens: null },
      },
    },
  };
  config.defaultModel = { provider: "local", model: "model" };
  const path = join(root, "config.json");
  await saveConfigFile(config, path);
  expect(
    await doctorReport({ configPath: path, workspaceRoot: root }),
  ).toMatchObject({
    defaultModel: { selected: true },
    sessions: { count: 0 },
    // P4: the doctor testifies about layers — a source checkout reads
    // its live workspace scopes.
    layers: { source: "node_modules" },
    sources: [
      { scope: "defaults", applied: true },
      { scope: "global", path, applied: true },
      {
        scope: "project",
        path: join(root, ".natalia", "config.json"),
        applied: false,
        diagnostic: "missing",
      },
    ],
  });
});

test("CLI doctor states that shell and terminal egress is not bounded here", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-doctor-egress-"));
  const path = join(root, "config.json");
  await saveConfigFile(defaultConfigV3(), path);
  const child = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "..", "src", "main.ts"),
      "doctor",
      "--workspace",
      root,
    ],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NATALIA_CONFIG: path },
    },
  );
  expect(child.exitCode).toBe(0);
  const output = new TextDecoder().decode(child.stdout);
  expect(output).toContain(
    "the application-layer host allowlist only covers fetch-style tools",
  );
  expect(output).toContain("run_shell and native terminal input");
  expect(output).toContain("firewall or container network");
  // 30s, and it is not padding: this spawns a REAL CLI subprocess — the
  // plugin bootstrap, the runtime boot, then the doctor — so the budget
  // crosses a process boundary and the 5s default is a lottery under load
  // (the harness's own documented lesson for runtime conditions). It runs
  // in well under a second when the host is idle.
}, 30_000);

test("legacy tool list is absent after plugin lifecycle migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-list-"));
  const child = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "..", "src", "main.ts"),
      "tool",
      "list",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  expect(child.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(child.stderr)).toContain(
    "unknown command: tool",
  );
});

test("old top-level install and uninstall no longer write tool activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-old-install-"));
  for (const command of ["install", "uninstall"]) {
    const child = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "..", "src", "main.ts"),
        command,
        "todo",
        "--workspace",
        root,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(child.exitCode).not.toBe(0);
  }
  expect(existsSync(join(root, ".natalia", "config.json"))).toBe(false);
  expect(existsSync(join(root, ".natalia", "tools"))).toBe(false);
});

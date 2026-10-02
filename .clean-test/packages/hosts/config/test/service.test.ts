import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateProjectModelConfigToGlobal,
  resolveConfig,
  updateConfigAtScope,
  updateGlobalConfig,
} from "../src";

test("global-scope settings survive across different workspaces", async () => {
  const rootA = await mkdtemp(join(tmpdir(), "natalia-global-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "natalia-global-b-"));
  const globalPath = join(
    await mkdtemp(join(tmpdir(), "natalia-global-home-")),
    "config.json",
  );
  // Write a user-level setting (team.maxConcurrent) to the GLOBAL scope.
  await updateGlobalConfig({ team: { maxConcurrent: 8 } }, globalPath);
  // A completely different workspace still sees it — this is what a workspace
  // switch relies on: settings follow the user, not the directory.
  const b = await resolveConfig({ workspaceRoot: rootB, globalPath });
  expect(b.config.team?.maxConcurrent).toBe(8);
  const a = await resolveConfig({ workspaceRoot: rootA, globalPath });
  expect(a.config.team?.maxConcurrent).toBe(8);
});

test("partial terminal overlay keeps the default pty backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-terminal-backend-"));
  const globalPath = join(root, "global.json");
  expect(
    (await resolveConfig({ workspaceRoot: root, globalPath })).config.runtime
      .terminal.backend,
  ).toBe("pty");
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      runtime: { terminal: { windowMode: "window" } },
    }),
  );
  expect(
    (await resolveConfig({ workspaceRoot: root, globalPath })).config.runtime
      .terminal,
  ).toEqual({ windowMode: "window", backend: "pty" });
});

test("collaboration auto rounds default to three and accept project overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-collaboration-config-"));
  const globalPath = join(root, "global.json");
  expect(
    (await resolveConfig({ workspaceRoot: root, globalPath })).config.runtime
      .collaboration.maxAutoRounds,
  ).toBe(3);

  await updateConfigAtScope(
    root,
    { runtime: { collaboration: { maxAutoRounds: 7 } } },
    "project",
    { globalPath },
  );
  expect(
    (await resolveConfig({ workspaceRoot: root, globalPath })).config.runtime
      .collaboration.maxAutoRounds,
  ).toBe(7);
});

test("the advisor model defaults to absent — the advisor is not required to differ from main", async () => {
  // The user's amendment (block C): an absent advisorModel means the
  // consult runs on Navi's chat model — the same family as the main
  // agent's — because the advisor's value is an independent second read,
  // not a capability tier.
  const root = await mkdtemp(join(tmpdir(), "natalia-advisor-config-"));
  const globalPath = join(root, "global.json");
  expect(
    (await resolveConfig({ workspaceRoot: root, globalPath })).config.runtime
      .collaboration.advisorModel,
  ).toBeUndefined();

  await updateConfigAtScope(
    root,
    { runtime: { collaboration: { advisorModel: "gpt-5.1-codex" } } },
    "project",
    { globalPath },
  );
  expect(
    (await resolveConfig({ workspaceRoot: root, globalPath })).config.runtime
      .collaboration.advisorModel,
  ).toBe("gpt-5.1-codex");
});

test("legacy project model settings migrate once without moving other settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-model-migration-"));
  const globalPath = join(root, "global.json");
  const projectPath = join(root, ".natalia", "config.json");
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    globalPath,
    JSON.stringify({
      providers: {
        shared: {
          name: "Shared",
          driver: "openai",
          connection: { apiKey: "global-key" },
        },
      },
    }),
  );
  await writeFile(
    projectPath,
    JSON.stringify({
      providers: {
        shared: { connection: { baseURL: "https://project.invalid" } },
      },
      catalog: {
        providers: { shared: { models: { model: { name: "model" } } } },
      },
      defaultModel: { provider: "shared", model: "model" },
      context: { compactionThresholdPercent: 92 },
    }),
  );

  const first = await migrateProjectModelConfigToGlobal(root, { globalPath });
  expect(first.migrated).toEqual(["providers", "catalog", "defaultModel"]);
  expect(first.config.providers.shared).toMatchObject({
    connection: {
      apiKey: "global-key",
      baseURL: "https://project.invalid",
    },
  });
  expect(first.config.defaultModel).toEqual({
    provider: "shared",
    model: "model",
  });
  expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
    context: { compactionThresholdPercent: 92 },
  });

  const second = await migrateProjectModelConfigToGlobal(root, { globalPath });
  expect(second.migrated).toEqual([]);
});

test("project writes route model settings globally and preserve legacy data", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-global-models-"));
  const globalPath = join(root, "global.json");
  const projectPath = join(root, ".natalia", "config.json");
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    projectPath,
    JSON.stringify({
      providers: { legacy: { name: "Legacy" } },
      catalog: { providers: { legacy: { models: {} } } },
      modelOverrides: { "legacy/model": { enabled: true } },
      defaultModel: { provider: "legacy", model: "model" },
      context: { compactionThresholdPercent: 80 },
    }),
  );

  await updateConfigAtScope(
    root,
    {
      providers: {
        global: {
          name: "Global",
          driver: "openai",
          connection: { apiKey: "test-only" },
        },
      },
      catalog: {
        providers: {
          global: { models: { model: { name: "model" } } },
        },
      },
      modelOverrides: { "global/model": { enabled: true } },
      defaultModel: { provider: "global", model: "model" },
      context: { compactionThresholdPercent: 91 },
    },
    "project",
    { globalPath },
  );

  const global = JSON.parse(await readFile(globalPath, "utf8"));
  expect(global).toMatchObject({
    providers: { global: { name: "Global" } },
    catalog: {
      providers: { global: { models: { model: { name: "model" } } } },
    },
    modelOverrides: { "global/model": { enabled: true } },
    defaultModel: { provider: "global", model: "model" },
  });
  expect(global.context).toBeUndefined();

  const project = JSON.parse(await readFile(projectPath, "utf8"));
  expect(project).toEqual({
    providers: { legacy: { name: "Legacy" } },
    catalog: { providers: { legacy: { models: {} } } },
    modelOverrides: { "legacy/model": { enabled: true } },
    defaultModel: { provider: "legacy", model: "model" },
    context: { compactionThresholdPercent: 91 },
  });

  const resolved = await resolveConfig({ workspaceRoot: root, globalPath });
  expect(resolved.config.providers.global?.name).toBe("Global");
  expect(resolved.config.providers.legacy).toBeUndefined();
  expect(resolved.config.context.compactionThresholdPercent).toBe(91);
});

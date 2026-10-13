import { expect, test } from "bun:test";
import { configV4Schema } from "@anthelia/contracts";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfigFile, saveConfigFile } from "../src/file";
import { defaultConfigV4, migrateConfig } from "../src/migration";
import { VersionedMigrationRegistry } from "../src/registry";
import { loadOrCreateConfigFile } from "../src/file";
import { resolveConfig } from "../src/service";
import { createSetupSnapshot } from "../src/setup";

function configuredConfig() {
  return configV4Schema.parse({
    ...defaultConfigV4(),
    providers: {
      openai: {
        name: "OpenAI",
        driver: "openai-compatible",
        enabled: true,
        connection: {
          baseURL: "https://api.example/v1",
          apiKey: "test-only",
        },
      },
    },
    catalog: {
      providers: {
        openai: { models: { "test-model": { name: "test-model" } } },
      },
    },
    defaultModel: { provider: "openai", model: "test-model" },
  });
}

test("setup snapshot exposes detection source and manual override", () => {
  const migrated = migrateConfig(configuredConfig());
  const snapshot = createSetupSnapshot(migrated.config, "openai/test-model", {
    tokens: 200000,
    source: "known_catalog",
    confidence: "medium",
    diagnostic: "catalog",
  });
  expect(snapshot.contextWindow.manualOverrideAllowed).toBe(true);
  expect(snapshot.contextWindow.source).toBe("known_catalog");
  expect(snapshot.outputLimit.semantics).toBe("omitted");
  expect(snapshot.secretFields).toContain("providers.*.connection.apiKey");
});

test("config v4 save/load roundtrip preserves an omitted output limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "natalia-config-v4-"));
  try {
    const path = join(dir, "config.json");
    const config = configuredConfig();
    await saveConfigFile(config, path);
    const loaded = await loadConfigFile(path);
    expect(loaded.config.version).toBe(4);
    expect(
      loaded.config.catalog.providers.openai?.models["test-model"]?.limits
        .maxOutputTokens,
    ).toBeUndefined();
    expect(loaded.summary.changed).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("config save atomically replaces the target without leaving temporary files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "natalia-config-atomic-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(path, '{"old":true}\n');
    await saveConfigFile(configuredConfig(), path);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 4,
    });
    expect(
      (await readdir(dir)).filter((name) => name.includes(".tmp-")).length,
    ).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("versioned migration registry applies steps and reports unsupported versions", async () => {
  const registry = new VersionedMigrationRegistry<{
    version: number;
    value: string;
  }>(2);
  registry.register({
    id: "legacy-to-v1",
    fromVersion: "legacy",
    toVersion: 1,
    apply: (input) => ({ ...input, version: 1, value: `${input.value}:v1` }),
  });
  registry.register({
    id: "v1-to-v2",
    fromVersion: 1,
    toVersion: 2,
    apply: (input) => ({ ...input, version: 2, value: `${input.value}:v2` }),
  });

  const migrated = await registry.migrate({
    fromVersion: "legacy",
    value: { version: 0, value: "start" },
  });
  expect(migrated.applied).toEqual(["legacy-to-v1", "v1-to-v2"]);
  expect(migrated.value).toEqual({ version: 2, value: "start:v1:v2" });

  const unsupported = await registry.migrate({
    fromVersion: 99,
    value: { version: 99, value: "old" },
  });
  expect(unsupported.diagnostics[0]).toMatchObject({
    code: "migration.unsupported_version",
    supported: false,
  });
});

test("TS config settings store creates a schema-valid config when absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "natalia-config-create-"));
  try {
    const result = await loadOrCreateConfigFile(join(dir, "config.json"));
    expect(result.config.version).toBe(4);
    expect(result.config.defaultModel).toBeNull();
    expect(result.summary.changed).toContain("created default config");
    expect(await readFile(join(dir, "config.json"), "utf8")).toContain(
      '"version": 4',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("layered config reads model settings only from the global scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-config-layered-"));
  const globalPath = join(root, "global.json");
  const projectPath = join(root, ".natalia", "config.json");
  try {
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(
      globalPath,
      JSON.stringify({
        version: 4,
        providers: {
          openai: {
            name: "OpenAI",
            driver: "openai-compatible",
            connection: { apiKey: "global-key" },
            requestDefaults: { stream: false },
          },
        },
        catalog: {
          providers: {
            openai: { models: { "gpt-test": { name: "gpt-test" } } },
          },
        },
        modelOverrides: {
          "openai/gpt-test": { requestDefaults: { temperature: 0.7 } },
        },
        defaultModel: { provider: "openai", model: "gpt-test" },
      }),
    );
    await writeFile(
      projectPath,
      JSON.stringify({
        version: 4,
        providers: {
          openai: {
            name: "OpenAI Project",
            connection: { baseURL: "https://project.example/v1" },
          },
        },
        modelOverrides: {
          "openai/gpt-test": { requestDefaults: { temperature: 0.2 } },
        },
        context: { compactionThresholdPercent: 90 },
      }),
    );
    const resolved = await resolveConfig({ workspaceRoot: root, globalPath });
    // Project model settings are legacy data and cannot override the global
    // provider, catalog, override, or default model.
    expect(resolved.config.providers.openai).toMatchObject({
      name: "OpenAI",
      connection: {
        apiKey: "global-key",
      },
      requestDefaults: { stream: false },
    });
    expect(
      resolved.config.catalog.providers.openai?.models["gpt-test"],
    ).toMatchObject({ name: "gpt-test" });
    expect(resolved.config.modelOverrides["openai/gpt-test"]).toMatchObject({
      requestDefaults: { temperature: 0.7 },
    });
    expect(resolved.config.defaultModel).toEqual({
      provider: "openai",
      model: "gpt-test",
    });
    expect(resolved.config.context.compactionEnabled).toBe(true);
    expect(resolved.config.context.compactionThresholdPercent).toBe(90);
    expect(resolved.sources.filter((source) => source.applied)).toHaveLength(3);
    expect(
      resolved.sources.find((source) => source.scope === "project")?.diagnostic,
    ).toContain("ignored global-only settings");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("layered config isolates an invalid source and retains valid sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-config-invalid-source-"));
  const globalPath = join(root, "global.json");
  try {
    await mkdir(join(root, ".natalia"), { recursive: true });
    await writeFile(globalPath, "{ not json");
    await writeFile(
      join(root, ".natalia", "config.json"),
      JSON.stringify({
        version: 4,
        context: { compactionThresholdPercent: 91 },
      }),
    );
    const resolved = await resolveConfig({ workspaceRoot: root, globalPath });
    expect(resolved.config.context.compactionThresholdPercent).toBe(91);
    // The rejected source names the reason, so the operator can find the
    // offending file content instead of only learning that something failed.
    expect(resolved.sources).toContainEqual({
      scope: "global",
      path: globalPath,
      applied: false,
      diagnostic: expect.stringContaining("invalid_config: JSON Parse error"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * 洞 4's acceptance: the version contract. A newer config is REFUSED with
 * both numbers (never silently misread), the window and the deadline are
 * named, and the v3→v4 conversion records what it dropped and why.
 */

test("a v4 config parses as-is with an empty summary", () => {
  const result = migrateConfig(configuredConfig());
  expect(result.summary.fromVersion).toBe(4);
  expect(result.summary.changed).toEqual([]);
  expect(result.config.version).toBe(4);
});

test("a v3 config converts, naming the field the deleted mechanism left behind", () => {
  const legacy = {
    ...configuredConfig(),
    version: 3,
    backgroundReview: { evolutionTrigger: true },
  };
  const result = migrateConfig(legacy);
  expect(result.config.version).toBe(4);
  expect(result.summary.fromVersion).toBe(3);
  expect(result.summary.changed).toEqual(["version 3 -> v4"]);
  // The dropped switch is NAMED with its reason — a converter that
  // silently stripped it would leave a config claiming a setting nothing
  // reads.
  expect(result.summary.warnings).toEqual([
    expect.stringContaining("dropped backgroundReview.evolutionTrigger"),
  ]);
  expect(
    (result.config.backgroundReview as { evolutionTrigger?: boolean })
      .evolutionTrigger,
  ).toBeUndefined();
});

test("a NEWER config is refused with both numbers — never silently misread", () => {
  // The acceptance's core: a v5 file read by this v4 runtime must not
  // parse as v4 (every field v5 added would vanish and the load would
  // report success on a config nobody read).
  expect(() => migrateConfig({ ...configuredConfig(), version: 5 })).toThrow(
    /this config is v5; this runtime reads up to v4/,
  );
});

test("a version below the read window is refused by name", () => {
  // The window is two major versions back (v2..v4 today): the migration
  // room an upgrade at v4 leaves. v1 is below it.
  expect(() => migrateConfig({ ...configuredConfig(), version: 1 })).toThrow(
    /below the read window \(v2\.\.v4\)/,
  );
});

test("inside the window with no converter is refused saying exactly that", () => {
  // v2 is inside the window by AGE but this runtime has never seen a v2
  // shape — refused with that reason named, never guessed at. When v5
  // ships the window slides to v3..v5 and v3 keeps its converter; v2 falls
  // out below the window then.
  expect(() => migrateConfig({ ...configuredConfig(), version: 2 })).toThrow(
    /inside the read window \(v2\.\.v4\) but this runtime has no converter/,
  );
});

test("no date deadline: the clock never enters the judgement", () => {
  // The rule this design follows: a hard DATE may only exist together with
  // the upgrade tooling, and it must leave at least two major versions of
  // room. No tooling ships a date today, so a v3 config converts whenever
  // it is read — the deadline is the VERSION at which the window slides
  // past it (v6 for a v4 upgrade), not a day anybody had to calendar.
  const legacy = { ...configuredConfig(), version: 3 };
  expect(migrateConfig(legacy).config.version).toBe(4);
  // The same file, read "years later": same answer, because nothing here
  // reads the clock.
  expect(migrateConfig(legacy).config.version).toBe(4);
});

test("a config with no integer version is refused with what it got", () => {
  expect(() => migrateConfig({ providers: {} })).toThrow(
    /carries no integer version/,
  );
  expect(() => migrateConfig("not a config")).toThrow(/carries no version/);
});

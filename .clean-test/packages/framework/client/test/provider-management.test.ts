import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configV3Schema } from "@anthelia/contracts";
import {
  buildModelCatalog,
  resolveConfig,
  updateConfigAtScope,
} from "@anthelia/config";
import { createSelectionSurface } from "../src/runtime/provider-selection/selection";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "natalia-provider-management-"));
  const globalPath = join(root, "global.json");
  let config = configV3Schema.parse({
    version: 3,
    providers: {
      target: {
        name: "Target",
        driver: "openai-compatible",
        connection: { apiKey: "test-secret" },
      },
      keep: { name: "Keep", driver: "openai-compatible" },
    },
    catalog: {
      providers: {
        target: { models: { model: { name: "model" } } },
        keep: { models: { model: { name: "keep" } } },
      },
    },
    modelOverrides: {
      "target/model": { name: "Target override" },
      "keep/model": { name: "Keep override" },
    },
  });
  await updateConfigAtScope(root, config, "global", { globalPath });
  const executions = new Map<string, SessionExecutionState>();
  const ctx = {
    ports: {
      getReady: async () => {},
      getTsRuntimeConfig: () => config,
      getWorkspaceRoot: () => root,
      getExecutionBySession: () => executions,
      getActiveExec: () => undefined,
      getSelectedModel: () => undefined,
      applyConfigFromDisk: async () => {
        config = (await resolveConfig({ workspaceRoot: root, globalPath }))
          .config;
      },
    },
  } as unknown as RuntimeContext;
  return {
    surface: createSelectionSurface(ctx, { globalConfigPath: globalPath }),
    config: () => config,
    executions,
    globalPath,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test("provider deletion atomically removes its credentials, catalog and overrides only", async () => {
  const h = await harness();
  try {
    expect(await h.surface.providerRemove!("target")).toEqual({
      removed: true,
    });
    const config = h.config();
    expect(config.providers.target).toBeUndefined();
    expect(config.catalog.providers.target).toBeUndefined();
    expect(config.modelOverrides["target/model"]).toBeUndefined();
    expect(config.providers.keep?.name).toBe("Keep");
    expect(config.catalog.providers.keep?.models.model?.name).toBe("keep");
    expect(config.modelOverrides["keep/model"]?.name).toBe("Keep override");
    expect(await readFile(h.globalPath, "utf8")).not.toContain("test-secret");
    expect(await h.surface.providerRemove!("target")).toEqual({
      removed: true,
    });
  } finally {
    await h.dispose();
  }
});

test("provider model additions, edits and deletions replace the picker catalog", async () => {
  const h = await harness();
  const save = (
    models?: Array<{ id: string; name?: string; reasoning?: boolean }>,
  ) =>
    h.surface.providerAdd!({
      name: "target",
      type: "openai-compatible",
      apiKey: "test-secret",
      models,
    });
  const listed = () =>
    buildModelCatalog(h.config()).find((provider) => provider.id === "target")!
      .models;
  try {
    await save([
      { id: "model" },
      { id: "new-model", name: "New", reasoning: false },
    ]);
    expect(
      listed()
        .map((model) => model.id)
        .sort(),
    ).toEqual(["model", "new-model"]);
    await save([{ id: "new-model", name: "Edited", reasoning: true }]);
    expect(listed()).toHaveLength(1);
    expect(listed()[0]).toMatchObject({
      id: "new-model",
      name: "Edited",
      capabilities: { reasoning: true },
    });
    expect(h.config().catalog.providers.target?.models.model).toBeUndefined();
    expect(h.config().modelOverrides["target/model"]).toBeUndefined();
    await save(); // Omitting models changes provider settings without clearing its catalog.
    expect(listed()).toHaveLength(1);
    await save([]);
    expect(listed()).toEqual([]);
    expect(h.config().catalog.providers.target?.models).toEqual({});
    expect(h.config().catalog.providers.keep?.models.model).toBeDefined();
    expect(h.config().modelOverrides["keep/model"]).toBeDefined();
  } finally {
    await h.dispose();
  }
});

test.each(["default", "agent", "mode", "session", "navi", "nia"])(
  "provider deletion preserves config when referenced by %s",
  async (reference) => {
    const h = await harness();
    try {
      const config = h.config();
      if (reference === "default")
        config.defaultModel = { provider: "target", model: "model" };
      if (reference === "agent")
        config.agents = configV3Schema.parse({
          version: 3,
          agents: { reviewer: { model: "target/model" } },
        }).agents;
      if (reference === "mode") config.agentModes.ask!.model = "target/model";
      if (["session", "navi", "nia"].includes(reference)) {
        h.executions.set("background", {
          session: { id: "background" },
          ...(reference === "session"
            ? { selectedModel: { modelID: "target/model" } }
            : reference === "navi"
              ? {
                  naviChatModelProfile: {
                    normal: { modelID: "target/model" },
                  },
                }
              : {
                  niaChatModelProfile: {
                    normal: { modelID: "target/model" },
                  },
                }),
        } as unknown as SessionExecutionState);
      }
      const before = await readFile(h.globalPath, "utf8");
      const result = await h.surface.providerRemove!("target");
      if (reference === "default") {
        // Removing the provider that supplies the global default is allowed;
        // the runtime switches the default to the first remaining model.
        expect(result.removed).toBe(true);
        expect(result.defaultModel).toBe("keep/model");
        const after = JSON.parse(await readFile(h.globalPath, "utf8")) as {
          defaultModel?: { provider: string; model: string };
        };
        expect(after.defaultModel).toEqual({
          provider: "keep",
          model: "model",
        });
        return;
      }
      expect(result.removed).toBe(false);
      expect(result.reason).toContain("referenced");
      expect(await readFile(h.globalPath, "utf8")).toBe(before);
    } finally {
      await h.dispose();
    }
  },
);

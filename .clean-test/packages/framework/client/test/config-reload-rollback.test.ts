import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateConfig } from "@anthelia/config";
import { createConfigReload } from "../src/runtime/config-reload";
import { createTestContext } from "@anthelia/runtime-services";
import { createToolPublish } from "../src/runtime/tool-publish";
import type { RuntimeContext } from "@anthelia/substrate";

// A config reload mutates live runtime state in place; if a later step throws,
// rollbackReload puts the previous state back. This exercises that path — which
// otherwise has no direct test — and pins one piece of it: the agent_spawn tool
// description is re-derived from the agent registry during a reload, so the
// rollback must re-derive it from the registry it restores, not leave the failed
// config's subagent types advertised.

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "natalia-reload-rollback-"));
  const agentSpawn = { name: "agent_spawn", description: "seed" };
  const tools = new Map<
    string,
    { name: string; description: string; requiresApproval?: boolean }
  >([["agent_spawn", agentSpawn]]);
  let config: unknown;
  let registry: unknown;
  let failPermissionSettings = false;
  let failContextConfig = false;
  const published: Array<{ type: string; name: string }> = [];
  const diagnostics: string[] = [];

  const ctx = {
    state: {
      tools,
      frameworkServices: undefined,
      pluginStoreRoot: undefined,
      // The reload path resolves optional services through the directory; an
      // empty context reproduces the port stub's "nothing provided".
      serviceDirectory: createTestContext([]),
    },
    ports: {
      getWorkspaceRoot: () => root,
      getTsRuntimeConfig: () => config,
      setTsRuntimeConfig: (next: unknown) => {
        config = next;
      },
      getMaxSteps: () => 0,
      setMaxSteps: () => {},
      getRetryPolicy: () => ({}),
      setRetryPolicy: () => {},
      getProviderConcurrencyLimiter: () => ({}),
      setProviderConcurrencyLimiter: () => {},
      getSelectedAgent: () => undefined,
      setSelectedAgent: () => {},
      getAgentRegistry: () => registry,
      setAgentRegistry: (next: unknown) => {
        registry = next;
      },
      getExecutionBySession: () => new Map(),
      getInteractive: () => undefined,
      // The reload re-derives the spawn description before this runs, so making
      // it throw on the second call fails the reload right after that mutation.
      reloadPermissionSettings: () => {
        if (failPermissionSettings)
          throw new Error("injected permission-settings failure");
      },
      getPermissionMode: () => "default",
      setPermissionMode: () => {},
      getSelectedPermissionProfile: () => undefined,
      setSelectedPermissionProfile: () => {},
      getDefaultPermissionMode: () => "default",
      getDefaultPermissionProfile: () => undefined,
      setDefaultPermissionMode: () => {},
      setDefaultPermissionProfile: () => {},
      getProvider: () => ({}),
      setProvider: () => {},
      getProviderSource: () => "ts_config",
      setProviderSource: () => {},
      getRuntimeContextConfig: () => ({}),
      setRuntimeContextConfig: () => {},
      applyAgentPolicy: () => {},
      getPluginsController: () => ({
        catalog: () => [],
        reconcileDesired: async (
          _entries: unknown,
          plugins: { enabled?: Record<string, boolean> } | undefined,
        ) => {
          tools.clear();
          tools.set("agent_spawn", agentSpawn);
          if (plugins?.enabled?.beta)
            tools.set("beta_tool", { name: "beta_tool", description: "" });
        },
      }),
      runPluginLifecyclePostReconcile: async () => {},
      publish: (event: { type: string; name?: string; message?: string }) => {
        if (
          event.type === "tool.registered" ||
          event.type === "tool.unregistered" ||
          event.type.startsWith("composition.")
        )
          published.push({ type: event.type, name: event.name ?? "" });
        else if (event.type === "diagnostic" && event.message)
          diagnostics.push(event.message);
      },
      publishForSession: () => {},
      scheduleRuntimeStatusSnapshot: () => {},
      resolveService: () => undefined,
      getTools: () => tools,
      getCapabilityRegistry: () => ({
        ownerOf: () => undefined,
        scopeOf: () => undefined,
      }),
      getContextWindowResolver: () => ({}),
      refreshExecutionContextConfig: async () => {},
      modelRefKeyForSelection: () => "key",
      resolveContextStatusConfig: async () => {
        if (failContextConfig)
          throw new Error("injected context-config failure");
        return {};
      },
      applyAgentProvider: () => {},
      publishToolCatalogChanges: () => {},
    },
  } as unknown as RuntimeContext;
  const options = { globalConfigPath: join(root, "absent-global.json") };
  // Use the real tool-catalog publisher so the diff is actually emitted.
  ctx.ports.publishToolCatalogChanges = createToolPublish(
    ctx,
    options,
  ).publishToolCatalogChanges;
  const reload = createConfigReload(ctx, options);
  return {
    root,
    agentSpawn,
    published,
    diagnostics,
    globalConfigPath: options.globalConfigPath,
    resetRecorded() {
      published.length = 0;
      diagnostics.length = 0;
    },
    setFailPermissionSettings: (value: boolean) => {
      failPermissionSettings = value;
    },
    setFailContextConfig: (value: boolean) => {
      failContextConfig = value;
    },
    reload,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

const alpha = { mode: "subagent", description: "Alpha explorer" } as const;
const beta = { mode: "subagent", description: "Beta reviewer" } as const;

test("a failed config reload restores the agent_spawn description to the prior config", async () => {
  const h = await harness();
  try {
    await updateConfig(h.root, { version: 3, agents: { alpha } });
    const first = await h.reload.applyConfigFromDisk();
    expect(first.applied).toBe(true);
    expect(h.agentSpawn.description).toContain("alpha");
    expect(h.agentSpawn.description).not.toContain("beta");

    // Add a second subagent type, then make the reload fail after the spawn
    // description has already been re-derived from the new registry.
    await updateConfig(h.root, { agents: { alpha, beta } });
    h.setFailPermissionSettings(true);
    const second = await h.reload.applyConfigFromDisk();
    expect(second.applied).toBe(false);

    // Rolled back to the first config: beta must no longer be advertised.
    expect(h.agentSpawn.description).not.toContain("beta");
    expect(h.agentSpawn.description).toContain("alpha");
  } finally {
    await h.dispose();
  }
});

test("a failed reload re-publishes the tool catalog so the projection matches the rollback", async () => {
  const h = await harness();
  try {
    await updateConfig(h.root, { version: 3, agents: { alpha } });
    expect((await h.reload.applyConfigFromDisk()).applied).toBe(true);

    // Config B enables an extra plugin tool; fail the reload only after the new
    // tool catalog has been published (at context-config resolution).
    await updateConfig(h.root, {
      agents: { alpha },
      plugins: { enabled: { beta: true } },
    });
    h.setFailContextConfig(true);
    expect((await h.reload.applyConfigFromDisk()).applied).toBe(false);

    // The failed reload advertised beta_tool; the rollback must retract it so
    // the UI stops projecting a tool the restored registry no longer has.
    expect(h.published).toContainEqual({
      type: "tool.unregistered",
      name: "beta_tool",
    });
  } finally {
    await h.dispose();
  }
});

const adapterProvider = (format: string, module: string) => ({
  name: "P",
  driver: "openai-compatible",
  connection: { apiKey: "x" },
  protocol: { format, module },
});

test("a failed reload restores the previous config's provider adapter modules", async () => {
  const h = await harness();
  try {
    // Config A names an adapter module that does not exist, so loading it fails
    // and publishes a diagnostic (registers nothing).
    await updateConfig(
      h.root,
      { version: 3, providers: { p: adapterProvider("fa", "a.ts") } },
      { globalPath: h.globalConfigPath },
    );
    expect((await h.reload.applyConfigFromDisk()).applied).toBe(true);
    expect(h.diagnostics.some((m) => m.includes("a.ts"))).toBe(true);

    // Config B swaps the module; fail the reload only after the adapter set has
    // been swapped (at context-config resolution).
    h.resetRecorded();
    await updateConfig(
      h.root,
      { version: 3, providers: { p: adapterProvider("fb", "b.ts") } },
      { globalPath: h.globalConfigPath },
    );
    h.setFailContextConfig(true);
    expect((await h.reload.applyConfigFromDisk()).applied).toBe(false);

    // The rollback must restore the previous config's adapter set: its "a.ts"
    // load diagnostic is published again, proving the failed config's "b.ts"
    // was withdrawn and A's reloaded rather than left live.
    expect(h.diagnostics.some((m) => m.includes("b.ts"))).toBe(true);
    expect(h.diagnostics.some((m) => m.includes("a.ts"))).toBe(true);
  } finally {
    await h.dispose();
  }
});

test("a successful reload records the candidate then commits it", async () => {
  const h = await harness();
  try {
    await updateConfig(h.root, { version: 3, agents: { alpha } });
    h.published.length = 0;
    const applied = await h.reload.applyConfigFromDisk();
    expect(applied.applied).toBe(true);
    const composition = h.published.filter((event) =>
      event.type.startsWith("composition."),
    );
    // G2 journal signature: the attempt is recorded, then the outcome. The
    // ids are content hashes, so the pair is verified by shape and order.
    expect(composition.map((event) => event.type)).toEqual([
      "composition.proposed",
      "composition.switched",
    ]);
  } finally {
    await h.dispose();
  }
});

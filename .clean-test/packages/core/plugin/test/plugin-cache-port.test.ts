import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolRegistry } from "@anthelia/tools";
import {
  createPluginRegistry,
  loadPluginEntries,
  pluginManifestSchema,
  type PluginAPI,
  type PluginCachePort,
} from "../src";

/**
 * The plugin cache port at the activation seam (`ctx.cache`): capability
 * gating (the `cache` integration point), delegation to the host's port,
 * and the loud failure when a host wired no fabric. The port's own
 * validation and the fabric's unregisterKind have their own tests
 * (substrate / rina); this file is the kernel half.
 */

/** A host port recording every call, so the delegation is observable. */
function recordingPort() {
  const calls: string[] = [];
  const port: PluginCachePort = {
    registerKind(kind) {
      calls.push(`register:${kind.id}`);
      return () => calls.push(`unregister:${kind.id}`);
    },
    async compute<T>(
      kindID: string,
      key: string,
      compute: () => T | Promise<T>,
    ) {
      calls.push(`compute:${kindID}:${key}`);
      return await compute();
    },
    metrics(kindID) {
      calls.push(`metrics:${kindID ?? "*"}`);
      return {};
    },
  };
  return { calls, port };
}

/** A plugin fixture: its setup exercises the port and stores the answers. */
async function pluginEntry(
  root: string,
  input: { id: string; integrationPoints: string[] },
) {
  const directory = join(root, input.id);
  await mkdir(directory, { recursive: true });
  const manifest = pluginManifestSchema.parse({
    apiVersion: 2,
    id: input.id,
    version: "1.0.0",
    name: input.id,
    entry: "index.ts",
    scope: "workspace",
    integrationPoints: input.integrationPoints,
  });
  await writeFile(
    join(directory, "natalia.plugin.json"),
    JSON.stringify(manifest),
  );
  await writeFile(
    join(directory, "index.ts"),
    `export default () => ({
      setup(api) {
        const dispose = api.cache.registerKind({
          id: "${input.id}.kind",
          deterministic: true,
          invalidation: "path",
          captureEvidence: (key) => key,
          validEvidence: (evidence, key) => evidence === key,
        });
        globalThis.__portCalls = [];
        globalThis.__portCalls.push("registered");
        api.cache.compute("${input.id}.kind", "k", () => "value").then(() => {
          globalThis.__portCalls.push("computed");
        });
        api.cache.metrics("${input.id}.kind");
        globalThis.__portKindDispose = dispose;
      },
    });`,
  );
  return { manifest, path: join(directory, "natalia.plugin.json") };
}

test("the cache port delegates to the host and unregisters on unload", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-cache-port-"));
  const entry = await pluginEntry(root, {
    id: "fixture.cache.owner",
    integrationPoints: ["cache"],
  });
  const { calls, port } = recordingPort();
  const registry = createPluginRegistry({
    tools: createToolRegistry([]),
    cache: port,
  });
  await loadPluginEntries({ entries: [entry], registry });
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toEqual([
    "register:fixture.cache.owner.kind",
    "compute:fixture.cache.owner.kind:k",
    "metrics:fixture.cache.owner.kind",
  ]);
  expect((globalThis as { __portCalls?: string[] }).__portCalls).toEqual([
    "registered",
    "computed",
  ]);
  // Unload runs the registration disposers in reverse: the kind dies with
  // the plugin, which is the ownership discipline the fabric's
  // unregisterKind implements.
  await registry.unload(entry.manifest.id);
  expect(calls).toContain("unregister:fixture.cache.owner.kind");
});

test("the cache port is capability-gated: no integration point, no cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-cache-gate-"));
  const entry = await pluginEntry(root, {
    id: "fixture.cache.gate",
    integrationPoints: [],
  });
  const audits: Array<{
    pluginID: string;
    action: string;
    detail?: string;
    timestamp: number;
  }> = [];
  const registry = createPluginRegistry({
    tools: createToolRegistry([]),
    cache: recordingPort().port,
    onAudit: (audit) => audits.push(audit),
  });
  await loadPluginEntries({ entries: [entry], registry });
  expect(audits).toContainEqual({
    pluginID: "fixture.cache.gate",
    action: "denied",
    detail: "cache",
    timestamp: expect.any(Number),
  });
  expect(registry.active("fixture.cache.gate")).toBe(false);
});

test("the cache port fails loud when the host wired no fabric", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-cache-absent-"));
  const entry = await pluginEntry(root, {
    id: "fixture.cache.absent",
    integrationPoints: ["cache"],
  });
  const audits: string[] = [];
  const registry = createPluginRegistry({
    tools: createToolRegistry([]),
    onAudit: (audit) => audits.push(audit.detail ?? ""),
  });
  await loadPluginEntries({ entries: [entry], registry });
  // No silent uncached path: the activation fails naming the host's gap.
  expect(audits.join("\n")).toContain("cache is not available in this host");
  expect(registry.active("fixture.cache.absent")).toBe(false);
});

test("a plugin that never touches the port activates without it", async () => {
  // The port being optional on the type must not gate activation: a
  // plugin built before the port existed must load identically.
  const root = await mkdtemp(join(tmpdir(), "plugin-cache-silent-"));
  const manifest = pluginManifestSchema.parse({
    apiVersion: 2,
    id: "fixture.cache.silent",
    version: "1.0.0",
    name: "silent",
    entry: "index.ts",
    scope: "workspace",
    integrationPoints: [],
  });
  await writeFile(join(root, "natalia.plugin.json"), JSON.stringify(manifest));
  await writeFile(
    join(root, "index.ts"),
    "export default () => ({ setup() {} });",
  );
  const registry = createPluginRegistry({
    tools: createToolRegistry([]),
    cache: recordingPort().port,
  });
  await loadPluginEntries({
    entries: [{ manifest, path: join(root, "natalia.plugin.json") }],
    registry,
  });
  expect(registry.active("fixture.cache.silent")).toBe(true);
});

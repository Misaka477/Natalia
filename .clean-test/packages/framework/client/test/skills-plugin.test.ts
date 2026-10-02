import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "@anthelia/capability";
import { createToolRegistry } from "@anthelia/tools";
import { createPluginsController } from "@anthelia/substrate";
import type { Plugin } from "@anthelia/plugin";

function host(workspaceRoot: string) {
  const capabilityRegistry = new CapabilityRegistry();
  const tools = createToolRegistry([]);
  const controller = createPluginsController({
    workspaceRoot,
    tools,
    capabilityRegistry,
    publish: () => undefined,
  });
  return { capabilityRegistry, tools, controller };
}

test("failed default setup rolls back its capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-rollback-"));
  const { capabilityRegistry, controller } = host(root);
  controller.init();
  const broken: Plugin = {
    manifest: {
      apiVersion: 1,
      id: "natalia-broken",
      version: "1.0.0",
      name: "Broken",
      description: "",
      entry: "natalia:broken",
      capabilities: ["tools"],
      scope: "workspace",
      provides: [],
      requires: [],
    },
    setup() {
      throw new Error("broken setup");
    },
  };
  await expect(
    controller.reconcileDesired(
      [
        {
          id: broken.manifest.id,
          enabled: true,
          fingerprint: "broken",
          manifest: broken.manifest,
          load: async () => broken,
        },
      ],
      {},
    ),
  ).rejects.toThrow("broken setup");
  expect(capabilityRegistry.has("natalia-broken")).toBe(false);
});

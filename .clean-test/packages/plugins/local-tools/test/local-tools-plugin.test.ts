import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginAPI } from "@anthelia/plugin";
import type { RuntimeTool } from "@anthelia/tools";
import { createLocalToolsPlugin, LOCAL_TOOLS_PLUGIN_ID } from "../src";
import { localToolsReload } from "@anthelia/runtime-services";

async function fixtureFamily(root: string, toolName: string) {
  const dir = join(root, "fixture.a");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "natalia.tool.json"),
    JSON.stringify({ entry: "index.ts" }),
  );
  await writeFile(
    join(dir, "index.ts"),
    `export default { id: "fixture.a", name: "Fixture", version: "1.0.0",
description: "Fixture", scope: "session", tools: [{ name: "${toolName}",
description: "Run", requiresApproval: false, parameters: { type: "object", properties: {} },
async execute() { return "ok"; } }] };`,
  );
  return dir;
}

function pluginAPI(input: {
  tools: Map<string, RuntimeTool>;
  services: Map<string, unknown>;
  releases: string[];
}): PluginAPI {
  return {
    tools: {
      register(tool: RuntimeTool) {
        input.tools.set(tool.name, tool);
        return () => {
          input.releases.push(tool.name);
          input.tools.delete(tool.name);
        };
      },
      registerAlias: () => () => undefined,
    },
    services: {
      provide(name: string, value: unknown) {
        input.services.set(name, value);
        return () => {
          input.services.delete(name);
        };
      },
      get: (name: string) => input.services.get(name) as never,
      on: () => () => undefined,
    },
  } as unknown as PluginAPI;
}

test("local tools plugin registers families and replaces them on reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-local-tools-plugin-"));
  const dir = await fixtureFamily(root, "fixture_run");
  const tools = new Map<string, RuntimeTool>();
  const services = new Map<string, unknown>();
  const releases: string[] = [];
  const plugin = createLocalToolsPlugin({ roots: [root] });

  await plugin.setup(pluginAPI({ tools, services, releases }));
  expect(plugin.manifest.id).toBe(LOCAL_TOOLS_PLUGIN_ID);
  expect(tools.has("fixture_run")).toBe(true);

  await fixtureFamily(root, "fixture_run_v2");
  const reload = services.get(localToolsReload.id) as (
    familyID: string,
  ) => Promise<unknown>;
  await reload("fixture.a");
  expect(releases).toContain("fixture_run");
  expect(tools.has("fixture_run")).toBe(false);
  expect(tools.has("fixture_run_v2")).toBe(true);
  await plugin.dispose?.();
});

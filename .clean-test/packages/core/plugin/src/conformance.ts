import type { RuntimeTool, ToolRegistry } from "@anthelia/tools";
import { createPluginRegistry } from "./registry";
import type { Plugin } from "./types";

export async function runPluginConformance(input: {
  plugin: Plugin;
  config?: unknown;
}) {
  const tools = new Map<string, RuntimeTool>();
  const contributed: string[] = [];
  const releases: string[] = [];
  const registry = createPluginRegistry({
    tools: {
      set(name, tool) {
        tools.set(name, tool);
      },
      get(name) {
        return tools.get(name);
      },
      delete(name) {
        tools.delete(name);
      },
    } as ToolRegistry,
    registerOwner: () => ({
      contribute: (_kind, name) => {
        contributed.push(name);
        return () => {
          releases.push(name);
        };
      },
      release: () => undefined,
    }),
  });
  const result: Array<{ name: string; passed: boolean; detail?: string }> = [];
  let setupFailed: unknown;
  try {
    await registry.load(input.plugin, input.config);
  } catch (error) {
    setupFailed = error;
  }
  result.push({
    name: "manifest-and-setup",
    passed: !setupFailed,
    ...(setupFailed
      ? {
          detail:
            setupFailed instanceof Error
              ? setupFailed.message
              : String(setupFailed),
        }
      : {}),
  });
  if (!setupFailed) {
    result.push({
      name: "tool-ownership",
      passed:
        contributed.length > 0 && contributed.every((name) => tools.has(name)),
      detail:
        contributed.length === 0 ? "plugin contributed no tools" : undefined,
    });
    const sample = [...tools.entries()][0];
    result.push({
      name: "approval-boundary",
      passed: sample ? sample[1].requiresApproval === false : false,
      detail: sample ? undefined : "plugin contributed no tools to check",
    });
    await registry.unload(input.plugin.manifest.id);
    result.push({
      name: "owned-registration-cleanup",
      passed:
        tools.size === 0 &&
        contributed.every((name) => releases.includes(name)),
      detail:
        tools.size || contributed.length !== releases.length
          ? "plugin registrations remained after unload"
          : undefined,
    });
  }
  return result;
}

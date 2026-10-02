/**
 * Generic process UI adapter host.
 *
 * One host path for every UI: it resolves the workspace config, discovers
 * enabled installed and path plugins through `discoverDesiredPluginEntries`,
 * loads only adapter-capable process plugins into one process registry,
 * and materializes the requested UI adapter kind(s) against one shared
 * `createUiAdapterMountInput(runtime)`. Closing is idempotent and fail-closed:
 * materializer, then registry/controller, then runtime.
 *
 * The TUI is a UI like any other and runs through this same host (as an extra
 * desired entry), which is why extra desired entries are accepted. The host
 * stays minimal: no private control channel, no UI feature knowledge.
 */
import { CapabilityRegistry } from "@anthelia/capability";
import { resolveConfig, type ResolvedConfig } from "@anthelia/config";
import type { RuntimeClient, UiAdapterMountInput } from "@anthelia/contracts";
import {
  createDesiredPluginController,
  createPluginAdapterMaterializer,
  createPluginRegistry,
  createUiAdapterMountInput,
  manifestIntegrationPoints,
  resolveDesiredPluginCatalog,
  type DesiredPluginEntry,
  type PluginAdapterInstance,
} from "@anthelia/plugin";
import { createToolRegistry } from "@anthelia/tools";
import { discoverDesiredPluginEntries } from "@anthelia/substrate";
import { registerPluginOwner } from "@anthelia/substrate";

export type UiAdapterHostOptions = {
  pluginStoreRoot?: string;
  workspaceRoot: string;
  runtime: RuntimeClient;
  /** UI adapter kind(s) to materialize. Empty lists only load and inspect. */
  kinds: readonly string[];
  /** Overrides the global config path (NATALIA_CONFIG). */
  configPath?: string;
  resolve?: (input: {
    workspaceRoot: string;
    globalPath?: string;
  }) => Promise<ResolvedConfig>;
  discover?: typeof discoverDesiredPluginEntries;
  /** In-process desired entries (the TUI, for example) share the same path. */
  extraEntries?: DesiredPluginEntry[];
  report?: (message: string) => void;
};

export type UiAdapterHost = {
  kinds: readonly string[];
  mountInput?: UiAdapterMountInput;
  instances: PluginAdapterInstance[];
  availableKinds(): string[];
  close(): Promise<void>;
};

export async function createUiAdapterHost(
  input: UiAdapterHostOptions,
): Promise<UiAdapterHost> {
  const report = input.report ?? (() => undefined);
  const onError = (id: string, error: unknown) =>
    report(
      `plugin ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  let kernel: CapabilityRegistry;
  let controller: ReturnType<typeof createDesiredPluginController>;
  let materializer: ReturnType<typeof createPluginAdapterMaterializer>;
  let mountInput: UiAdapterMountInput | undefined;
  let instances: PluginAdapterInstance[] = [];
  let closed = false;
  try {
    const resolved = await (input.resolve ?? resolveConfig)({
      workspaceRoot: input.workspaceRoot,
      ...(input.configPath ? { globalPath: input.configPath } : {}),
    });
    const plugins = resolved.config.plugins;
    kernel = new CapabilityRegistry();
    const registry = createPluginRegistry({
      tools: createToolRegistry([]),
      registerOwner: (manifest) => registerPluginOwner(manifest, kernel),
    });
    controller = createDesiredPluginController({ registry, onError });
    await controller.reconcileDesired(async () => {
      const users = input.pluginStoreRoot
        ? await (input.discover ?? discoverDesiredPluginEntries)({
            pluginStoreRoot: input.pluginStoreRoot,
            packages: plugins.packages,
            enabled: plugins.enabled,
            declaredIDs: (input.extraEntries ?? []).map((entry) => entry.id),
            onError,
          })
        : [];
      return resolveDesiredPluginCatalog({
        entries: [...(input.extraEntries ?? []), ...users].filter(
          isAdapterProcessEntry,
        ),
        previous: controller.previous,
        onError,
      });
    }, plugins.settings);
    materializer = createPluginAdapterMaterializer(kernel);
    if (input.kinds.length) {
      mountInput = createUiAdapterMountInput(input.runtime);
      for (const kind of input.kinds)
        instances.push(await materializer.materialize(kind, mountInput));
    }
  } catch (error) {
    await close();
    throw error;
  }

  return {
    kinds: [...input.kinds],
    mountInput,
    instances,
    availableKinds: () =>
      kernel.contributions("adapters").map((entry) => entry.name),
    close,
  };

  async function close() {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    try {
      await materializer?.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await controller?.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await input.runtime.dispose?.();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, "ui adapter host cleanup failed");
  }
}

function isAdapterProcessEntry(entry: DesiredPluginEntry): boolean {
  const manifest = entry.manifest;
  return (
    manifest !== undefined &&
    manifest.scope === "process" &&
    manifestIntegrationPoints(manifest).includes("adapters")
  );
}

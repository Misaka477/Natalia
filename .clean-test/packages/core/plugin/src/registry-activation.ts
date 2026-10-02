import type { PluginIntegrationPoint } from "./manifest";
import type { UiAdapterMountInput } from "@anthelia/contracts";
import type { MountedPlugin, RegistryState } from "./registry-state";
import type {
  PluginAPI,
  PluginAdapterContributionRegistry,
  PluginCommand,
  PluginContributionKind,
  PluginNamedContributionRegistry,
  PluginContributionOwner,
} from "./types";

/**
 * The host wired no fabric: the port fails loud at use. A silent
 * uncached path would hand plugins the Map+TTL sin with extra steps
 * (the RINA admission rule's whole point), so there is no fallback.
 */
function missingCache(): Error {
  return new Error(
    "cache is not available in this host (the runtime wires the fabric as the rina.cache service)",
  );
}

export async function activatePlugin(
  state: RegistryState,
  entry: MountedPlugin,
) {
  const { plugin } = entry;
  const manifest = plugin.manifest;
  const snapshot = state.serviceSnapshot(manifest);
  entry.missingServices = snapshot.missingServices;
  if (snapshot.missingServices.length) {
    entry.status = "pending";
    entry.error = undefined;
    return;
  }
  if (
    entry.status === "failed" &&
    state.sameProviders(entry.lastAttemptedProviders, snapshot.providers)
  )
    return;
  entry.status = "activating";
  entry.error = undefined;
  entry.lastAttemptedProviders = snapshot.providers;
  const listeners = new Set<(event: unknown) => void>();
  const commands = new Map<string, PluginCommand>();
  const providedServices = new Map<string, number>();
  const disposers: Array<() => void> = [];
  const abort = new AbortController();
  const effects = new Set<Promise<unknown>>();
  let listenerSequence = 0;
  let contributionOwner: PluginContributionOwner | undefined;
  try {
    contributionOwner = await state.input.registerOwner?.(manifest);
  } catch (error) {
    entry.status = "failed";
    entry.error = error instanceof Error ? error.message : String(error);
    state.writeAudit(manifest.id, "failed", entry.error);
    throw error;
  }
  const ownedDisposer = (...releases: Array<() => void>) =>
    state.once(() => {
      const errors = state.cleanup(releases);
      if (errors[0] !== undefined) throw errors[0];
    });
  function namedRegistry(
    point: PluginIntegrationPoint,
    kind: PluginContributionKind,
  ): PluginNamedContributionRegistry {
    return {
      register(contribution) {
        state.assertCapability(manifest, point);
        if (!contribution.name)
          throw new Error(`plugin ${manifest.id} contributed unnamed ${kind}`);
        const dispose = state.once(
          contributionOwner?.contribute(
            kind,
            contribution.name,
            contribution,
          ) ?? (() => undefined),
        );
        disposers.push(dispose);
        return dispose;
      },
    };
  }
  const api: PluginAPI = {
    config: entry.config,
    tools: {
      register(tool) {
        state.assertCapability(manifest, "tools");
        const name = tool.name;
        const ownedTool = {
          ...tool,
          name,
          requiresApproval: tool.requiresApproval,
        };
        if (state.input.tools.get(name) !== undefined)
          throw new Error(`plugin tool already registered: ${name}`);
        const releaseKernel = contributionOwner?.contribute(
          "tools",
          name,
          ownedTool,
        );
        state.input.tools.set(name, ownedTool);
        const dispose = ownedDisposer(
          ...(releaseKernel ? [releaseKernel] : []),
          () => {
            if (state.input.tools.get(name) === ownedTool)
              state.input.tools.delete(name);
          },
        );
        disposers.push(dispose);
        return dispose;
      },
      registerAlias(alias, target) {
        state.assertCapability(manifest, "tools");
        const dispose = state.once(state.input.tools.addAlias(alias, target));
        disposers.push(dispose);
        return dispose;
      },
    },
    services: {
      provide(name, value) {
        if (!manifest.provides.includes(name))
          throw new Error(
            `plugin ${manifest.id} provided undeclared service: ${name}`,
          );
        state.assertCapability(manifest, "services");
        const releaseKernel = contributionOwner?.contribute(
          "services",
          name,
          value,
        );
        providedServices.set(name, (providedServices.get(name) ?? 0) + 1);
        const dispose = ownedDisposer(
          ...(releaseKernel ? [releaseKernel] : []),
          () => {
            const remaining = (providedServices.get(name) ?? 1) - 1;
            if (remaining > 0) providedServices.set(name, remaining);
            else providedServices.delete(name);
          },
        );
        disposers.push(dispose);
        return dispose;
      },
      get: <T>(name: string) => state.input.service?.<T>(name),
      on: <T>(name: string, listener: (value: T | undefined) => void) => {
        const unsubscribe = state.input.onServiceUpdate?.((update) => {
          if (update.name === name) listener(state.input.service?.<T>(name));
        });
        const dispose = state.once(unsubscribe ?? (() => undefined));
        disposers.push(dispose);
        return dispose;
      },
    },
    events: {
      on(
        typeOrListener: string | ((event: unknown) => void),
        typedListener?: (event: unknown) => void,
      ) {
        state.assertCapability(manifest, "events");
        const listener =
          typeof typeOrListener === "function"
            ? typeOrListener
            : (event: unknown) => {
                if (
                  event &&
                  typeof event === "object" &&
                  "type" in event &&
                  event.type === typeOrListener
                )
                  typedListener?.(event);
              };
        const name = `${manifest.id}:listener:${++listenerSequence}`;
        const releaseKernel = contributionOwner?.contribute(
          "listeners",
          name,
          listener,
        );
        listeners.add(listener);
        const dispose = ownedDisposer(
          ...(releaseKernel ? [releaseKernel] : []),
          () => listeners.delete(listener),
        );
        disposers.push(dispose);
        return dispose;
      },
    },
    commands: {
      register(command) {
        state.assertCapability(manifest, "commands");
        const name = command.name;
        if (state.commandOwners.has(name))
          throw new Error(`plugin command already registered: ${name}`);
        const ownedCommand = {
          ...command,
          name,
          category: command.category ?? manifest.name,
        };
        const releaseKernel = contributionOwner?.contribute(
          "commands",
          name,
          ownedCommand,
        );
        commands.set(name, ownedCommand);
        state.commandOwners.set(name, manifest.id);
        const dispose = ownedDisposer(
          ...(releaseKernel ? [releaseKernel] : []),
          () => {
            commands.delete(name);
            state.commandOwners.delete(name);
          },
        );
        disposers.push(dispose);
        return dispose;
      },
    },
    resources: namedRegistry("resources", "resources"),
    projections: namedRegistry("projections", "projections"),
    workflows: namedRegistry("workflows", "workflows"),
    settingsSchema: namedRegistry("settingsSchema", "settingsSchema"),
    adapters: (() => {
      const registry = namedRegistry(
        "adapters",
        "adapters",
      ) as PluginAdapterContributionRegistry;
      registry.registerUi = (contribution) =>
        registry.register({
          name: contribution.kind,
          adapterType: "ui",
          async create(input: UiAdapterMountInput) {
            await contribution.mount(input);
            return { dispose: contribution.dispose };
          },
        });
      return registry;
    })(),
    scheduler: {
      add: namedRegistry("schedulerJobs", "schedulerJobs").register,
    },
    effects: {
      signal: abort.signal,
      run<T>(effect: (signal: AbortSignal) => Promise<T>) {
        if (abort.signal.aborted)
          return Promise.reject(
            new Error(`plugin is unloading: ${manifest.id}`),
          );
        const task = Promise.resolve().then(() => effect(abort.signal));
        effects.add(task);
        void task.finally(() => effects.delete(task)).catch(() => undefined);
        return task;
      },
    },
    // The cache port: capability-gated like every other surface, and loud
    // when the host wired no fabric (an uncached silent path would be the
    // Map+TTL sin with extra steps).
    cache: {
      registerKind(kind) {
        state.assertCapability(manifest, "cache");
        const host = state.input.cache;
        if (!host) throw missingCache();
        const dispose = host.registerKind(kind);
        // The port's registration joins the activation's cleanup: a
        // plugin's kind dies with the plugin, and the reverse cleanup
        // runs these in registration order (the same promise as tools).
        disposers.push(dispose);
        return dispose;
      },
      compute<T>(kindID: string, key: string, compute: () => T | Promise<T>) {
        state.assertCapability(manifest, "cache");
        const host = state.input.cache;
        if (!host) return Promise.reject(missingCache());
        return host.compute<T>(kindID, key, compute);
      },
      metrics(kindID) {
        state.assertCapability(manifest, "cache");
        const host = state.input.cache;
        if (!host) throw missingCache();
        return host.metrics(kindID);
      },
    },
    ...(state.input.runtimeConfig
      ? { runtimeConfig: state.input.runtimeConfig }
      : {}),
  };
  try {
    await plugin.setup(api);
    const missing = manifest.provides.filter(
      (name) => !providedServices.has(name),
    );
    if (missing.length)
      throw new Error(
        `plugin ${manifest.id} did not provide declared services: ${missing.join(", ")}`,
      );
  } catch (error) {
    try {
      await plugin.dispose?.();
    } catch {
      // best-effort cleanup; a dispose failure must not mask the activation error
    }
    abort.abort();
    await Promise.allSettled(effects);
    state.cleanup(disposers);
    try {
      contributionOwner?.release();
    } catch {
      // best-effort release during rollback
    }
    entry.epoch = undefined;
    entry.status = "failed";
    entry.error = error instanceof Error ? error.message : String(error);
    state.writeAudit(manifest.id, "failed", entry.error);
    throw error;
  }
  entry.epoch = {
    listeners,
    commands,
    dispose: disposers,
    abort,
    effects,
    contributionOwner,
  };
  entry.requiredProviders = snapshot.providers;
  entry.status = "active";
  state.input.onChange?.();
}

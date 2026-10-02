import type {
  RuntimeClient,
  RuntimeEvent,
  UiAdapterMountInput,
} from "@anthelia/contracts";

/**
 * The command half of a UI adapter mount input. Kept pure — it never calls
 * `runtime.start` — so a consumer that already owns the event subscription (for
 * example the TUI shell, which installs its own sink) can build the command
 * host without disturbing it.
 */
export function createUiAdapterCommandHost(
  runtime: RuntimeClient,
): UiAdapterMountInput["commands"] {
  return {
    list: async () => (await runtime.commandCatalog?.()) ?? [],
    async execute(input) {
      const command = (await runtime.commandCatalog?.())?.find(
        (entry) => entry.name === input.name,
      );
      if (!command) throw new Error(`command unavailable: ${input.name}`);
      if (!runtime.commandExecute)
        throw new Error("runtime command execution unavailable");
      await runtime.commandExecute(input);
    },
  };
}

export function createUiAdapterMountInput(
  runtime: RuntimeClient,
): UiAdapterMountInput {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  runtime.start((event) => {
    for (const listener of listeners) listener(event);
  });
  return {
    runtime,
    events: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    commands: createUiAdapterCommandHost(runtime),
  };
}

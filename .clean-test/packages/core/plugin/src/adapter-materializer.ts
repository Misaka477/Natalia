import type {
  PluginAdapterContribution,
  PluginAdapterInstance,
  PluginAdapterRegistryView,
} from "./types";

export function createPluginAdapterMaterializer(
  registry: PluginAdapterRegistryView,
) {
  const instances: Array<{
    name: string;
    ownerID: string;
    instance: PluginAdapterInstance;
  }> = [];
  let closed = false;
  return {
    async materialize<
      Context,
      Instance extends PluginAdapterInstance = PluginAdapterInstance,
    >(name: string, context: Context): Promise<Instance> {
      if (closed) throw new Error("adapter materializer is closed");
      if (instances.some((entry) => entry.name === name))
        throw new Error(`adapter is already materialized: ${name}`);
      const contribution = registry.contribution<
        PluginAdapterContribution<Context, Instance>
      >("adapters", name);
      const ownerID = registry.ownerOf("adapters", name);
      if (!contribution || !ownerID)
        throw new Error(`adapter is not available: ${name}`);
      const instance = await contribution.create(context);
      if (!instance || typeof instance.dispose !== "function")
        throw new Error(`adapter returned an invalid instance: ${name}`);
      instances.push({ name, ownerID, instance });
      return instance;
    },
    active: () => instances.map(({ name, ownerID }) => ({ name, ownerID })),
    async close() {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      for (const { instance } of [...instances].reverse())
        try {
          await instance.dispose();
        } catch (error) {
          errors.push(error);
        }
      instances.length = 0;
      if (errors.length)
        throw new AggregateError(errors, "adapter cleanup failed");
    },
  };
}

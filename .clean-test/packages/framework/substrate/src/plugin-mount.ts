/**
 * Runtime plugin mount sequence.
 *
 * This is the one assembly seam the composition root delegates to: initialize
 * the plugin controller and reconcile the complete desired catalog. Keeping
 * this sequence in one
 * named function makes the bootstrap ordering explicit and testable, and keeps
 * the runtime's product behavior out of the mount bookkeeping.
 *
 * Defaults and discovered entries enter one source-neutral dependency catalog.
 */
import type { createPluginsController } from "./plugins-controller";

export async function mountPlugins(input: {
  controller: ReturnType<typeof createPluginsController>;
  config: import("./plugins-controller").PluginConfigSnapshot;
}): Promise<void> {
  input.controller.init();
  await input.controller.reconcileDesired([], input.config);
}

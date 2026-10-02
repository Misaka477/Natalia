import type { UiPlugin } from "@natalia/ui-host";

export type UiPluginRegistryEntry = {
  id: string;
  name: string;
  version: string;
  create: () => UiPlugin;
};

/**
 * Host-level UI plugins that are not contributed by an installed runtime
 * plugin package.
 *
 * Feature panels are loaded dynamically through the plugin catalog /
 * /plugins/<id>/ui.js path. This registry is kept empty until a host-only UI
 * plugin needs a static registration path.
 */
export const UI_PLUGIN_REGISTRY: UiPluginRegistryEntry[] = [];

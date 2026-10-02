import { definePlugin, type PluginManifest } from "@anthelia/plugin";

export const PENDING_INBOX_PLUGIN_ID = "natalia-pending-inbox";

export const PENDING_INBOX_PLUGIN_MANIFEST: PluginManifest = {
  apiVersion: 2,
  id: PENDING_INBOX_PLUGIN_ID,
  version: "1.0.0",
  name: "Pending Inbox",
  description: "Approvals and questions in one side panel.",
  entry: "index.js",
  scope: "process",
  provides: [],
  requires: [],
  optionalRequires: [],
  conflicts: [],
  dependencies: [],
  hooks: {},
  integrationPoints: [],
  ui: {
    entry: "ui/plugin.js",
    panels: [
      {
        id: "pending",
        title: "待处理",
        region: "side",
        order: 5,
      },
    ],
  },
};

export default definePlugin({
  manifest: PENDING_INBOX_PLUGIN_MANIFEST,
  setup() {
    // Renderer-only feature plugin. The runtime entry is intentionally a no-op
    // so the package installs and enables through the unified plugin catalog,
    // while its panel comes from the renderer-side `ui.entry`.
  },
});

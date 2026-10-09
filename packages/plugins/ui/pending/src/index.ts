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
  // No panel (T4-4): the side tab is gone and the composer takeover is the
  // surface. The ui entry stays so an already-installed copy still loads and
  // disposes cleanly, but it registers nothing — the presenters moved to the
  // web plugin, and two owners would throw in the host.
  ui: {
    entry: "ui/plugin.js",
    panels: [],
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

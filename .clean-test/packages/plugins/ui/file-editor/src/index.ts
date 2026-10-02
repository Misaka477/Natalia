import { definePlugin, type PluginManifest } from "@anthelia/plugin";

export const FILE_EDITOR_PLUGIN_ID = "natalia-file-editor";

export const FILE_EDITOR_PLUGIN_MANIFEST: PluginManifest = {
  apiVersion: 2,
  id: FILE_EDITOR_PLUGIN_ID,
  version: "1.0.0",
  name: "File Editor",
  description: "File tree and CodeMirror editor.",
  entry: "index.js",
  scope: "workspace",
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
        id: "files",
        title: "文件",
        region: "side",
      },
    ],
  },
};

export default definePlugin({
  manifest: FILE_EDITOR_PLUGIN_MANIFEST,
  setup() {
    // File Editor is currently a renderer-only feature plugin. The runtime
    // entry is intentionally a no-op so it can be installed/enabled through the
    // unified plugin catalog, while its UI comes from the same package's
    // renderer-side ui entry.
  },
});

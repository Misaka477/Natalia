import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

const root = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(root, "../..");
const mcpUiSrc = resolve(workspace, "packages/plugins/mcp/src/ui");
const skillsUiSrc = resolve(workspace, "packages/plugins/skills/src/ui");
const uiKitSrc = resolve(workspace, "packages/plugins/ui/kit/src");
const pluginSrc = resolve(workspace, "packages/plugins/ui/web/src");
const frameworkDiffSrc = resolve(workspace, "packages/framework/diff/src");
const solidJs = resolve(root, "node_modules/solid-js");

function solidJsxSource(): Plugin {
  const pragma = "/** @jsxImportSource solid-js */\n";
  return {
    name: "natalia-solid-jsx-source",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0] ?? id;
      if (!file.endsWith(".tsx") && !file.endsWith(".jsx")) return;
      if (
        !file.startsWith(mcpUiSrc) &&
        !file.startsWith(skillsUiSrc) &&
        !file.startsWith(uiKitSrc) &&
        !file.startsWith(pluginSrc) &&
        !file.startsWith(frameworkDiffSrc) &&
        !file.startsWith(resolve(root, "src"))
      )
        return;
      if (code.includes("@jsxImportSource")) return;
      return { code: pragma + code, map: null };
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [
    solidJsxSource(),
    solid({
      include: [
        `${mcpUiSrc}/**/*.{js,ts,jsx,tsx}`,
        `${skillsUiSrc}/**/*.{js,ts,jsx,tsx}`,
        `${uiKitSrc}/**/*.{js,ts,jsx,tsx}`,
        `${pluginSrc}/**/*.{js,ts,jsx,tsx}`,
        `${frameworkDiffSrc}/**/*.{js,ts,jsx,tsx}`,
        `${root}/src/**/*.{js,ts,jsx,tsx}`,
      ],
    }),
  ],
  resolve: {
    dedupe: ["solid-js", "solid-js/web"],
    alias: {
      // The browser graph hashes with node:crypto in five modules (the
      // session inbox's facts, the composition profile, the plugin
      // package hash, the store-path id, the hash-tree) — Vite externalizes
      // the builtin and a NAMED import from the stub is a hard build
      // failure. The platform's pure sha256 (cross-checked against
      // node:crypto in its tests) answers exactly that surface; anything
      // beyond sha256/hex fails loud inside it.
      "node:crypto": resolve(
        workspace,
        "packages/hosts/platform/src/content-hash.ts",
      ),
      // The session package's node-free entry: the barrel re-exports the
      // two stores (node:fs / bun:sqlite), and a browser consumer never
      // writes a session store — it talks to the daemon over RPC. The
      // browser build gets facts-without-stores; the node entry stays
      // whole at ./index.
      "@anthelia/session": resolve(
        workspace,
        "packages/framework/session/src/browser.ts",
      ),
      "@natalia/governance-ledger": resolve(
        workspace,
        "packages/domains/governance-ledger/src/browser.ts",
      ),
      "solid-js/web": resolve(solidJs, "web"),
      "solid-js/jsx-runtime": resolve(solidJs, "dist/solid.js"),
      "solid-js/jsx-dev-runtime": resolve(solidJs, "dist/solid.js"),
      "solid-js": solidJs,
      "@natalia/transport": resolve(
        workspace,
        "packages/hosts/transport/src/rpc-client.ts",
      ),
      "@natalia/plugin-mcp/ui": mcpUiSrc,
      "@natalia/plugin-skills/ui": skillsUiSrc,
    },
  },
  esbuild: { jsx: "automatic", jsxImportSource: "solid-js" },
  optimizeDeps: {
    esbuildOptions: {
      jsx: "automatic",
      jsxImportSource: "solid-js",
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    fs: { allow: [workspace] },
  },
});

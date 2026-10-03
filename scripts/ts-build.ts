import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build as viteBuild } from "vite";
import solid from "vite-plugin-solid";

/**
 * Two modes, one script:
 *
 * - default (the release mode): everything, including staging the WezTerm
 *   fork's native executables — which must exist because the fork is built
 *   on Ubuntu inside podman (build-wezterm-ubuntu.ts). A checkout without
 *   them (CI, a fresh clone) fails loudly here rather than shipping a
 *   plugin distribution whose terminal cannot start.
 * - `NATALIA_BUILD_SKIP_NATIVE=1` (the distribution mode, `npm run
 *   build:distribution`): everything the TEST SUITE needs — the CLI bundle
 *   and the 16-plugin official distribution — with the native staging
 *   skipped. This is what makes a fresh CI checkout verifiable: the client
 *   tests read `dist/ts/plugins`, and producing it must not require a
 *   containerized native build.
 */
const skipNative = process.env.NATALIA_BUILD_SKIP_NATIVE === "1";
if (skipNative)
  console.log(
    "distribution mode: native executable staging skipped " +
      "(set no NATALIA_BUILD_SKIP_NATIVE for the release build)",
  );

const target =
  process.env.NATALIA_BUILD_TARGET ?? `${process.platform}-${process.arch}`;
const version = process.env.NATALIA_TS_VERSION ?? "0.0.0-ts7";
const outdir = process.env.NATALIA_BUILD_OUTDIR ?? "dist/ts";
const result = await Bun.build({
  entrypoints: ["apps/cli/src/main.ts"],
  outdir,
  target: "bun",
  format: "esm",
  naming: "natalia-ts.[ext]",
  define: {
    "process.env.NATALIA_TS_VERSION": JSON.stringify(version),
    "process.env.NATALIA_BUILD_TARGET": JSON.stringify(target),
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("TS release build failed");
}
await mkdir(outdir, { recursive: true });

type PluginManifest = {
  apiVersion: number;
  id: string;
  version: string;
  entry: string;
  // Declared, not reached through the index signature: the two `ui.entry`
  // accesses below were `unknown`-typed, so nothing checked them.
  ui?: { entry: string };
  [key: string]: unknown;
};
type PackageManifest = {
  name: string;
  version: string;
  license?: string;
  [key: string]: unknown;
};

const pluginRoots = [
  "packages/plugins/local-tools",
  "packages/plugins/ui/file-editor",
  "packages/plugins/ui/pending",
  "packages/plugins/browser",
  "packages/plugins/native-terminal",
  "packages/plugins/skills",
  "packages/plugins/team",
  "packages/plugins/mcp",
  "packages/plugins/tools/ask",
  "packages/plugins/tools/fs-read",
  "packages/plugins/tools/fs-write",
  "packages/plugins/tools/process",
  "packages/plugins/tools/search",
  "packages/plugins/tools/shell",
  "packages/plugins/tools/todo",
  "packages/plugins/tools/web",
] as const;
const pluginsOutdir = resolve(outdir, "plugins");
await rm(pluginsOutdir, { recursive: true, force: true });
await mkdir(pluginsOutdir, { recursive: true });

const pluginOutputs: string[] = [];
for (const root of pluginRoots) {
  const sourcePackage = (await Bun.file(
    join(root, "package.json"),
  ).json()) as PackageManifest;
  const manifest = (await Bun.file(
    join(root, "natalia.plugin.json"),
  ).json()) as PluginManifest;
  if (sourcePackage.version !== manifest.version)
    throw new Error(`${root}: package and plugin manifest versions disagree`);
  if (manifest.entry !== "index.js")
    throw new Error(`${root}: release plugin entry must be index.js`);

  // Browser's plugin manifest id is accepted as natalia-tool-browser by the
  // runtime, but the official plugin store directory/installer id is
  // natalia-browser. Keep the on-disk directory aligned with the official
  // plugin catalog so existing tests and plugin-store layouts stay stable.
  const outputDir =
    manifest.id === "natalia-tool-browser" ? "natalia-browser" : manifest.id;
  const packageOutdir = join(pluginsOutdir, outputDir);
  await mkdir(packageOutdir, { recursive: true });
  const build = await Bun.build({
    entrypoints: [join(root, "src/index.ts")],
    outdir: packageOutdir,
    target: "bun",
    format: "esm",
    naming: "index.js",
    packages: "bundle",
  });
  if (!build.success) {
    for (const log of build.logs) console.error(log);
    throw new Error(`${root}: plugin release build failed`);
  }

  const releaseFiles = [manifest.entry, "natalia.plugin.json", "LICENSE"];
  const releaseManifest: PluginManifest = { ...manifest };
  if (manifest.ui) {
    const uiEntry = "ui/plugin.js";
    const uiOutdir = join(packageOutdir, "ui");
    await viteBuild({
      root: process.cwd(),
      configFile: false,
      logLevel: "error",
      plugins: [solid()],
      build: {
        emptyOutDir: true,
        outDir: uiOutdir,
        cssCodeSplit: false,
        lib: {
          entry: resolve(process.cwd(), root, manifest.ui.entry),
          formats: ["es"],
          fileName: () => "plugin.js",
        },
        target: "esnext",
        minify: false,
        rollupOptions: {
          output: {
            assetFileNames: "plugin.[ext]",
          },
        },
      },
    });
    releaseManifest.ui = {
      ...manifest.ui,
      entry: uiEntry,
      ...((await Bun.file(join(uiOutdir, "plugin.css")).exists())
        ? { css: "ui/plugin.css" }
        : {}),
    };
    releaseFiles.push(uiEntry);
    const uiCss = join(uiOutdir, "plugin.css");
    if (await Bun.file(uiCss).exists()) releaseFiles.push("ui/plugin.css");
  }
  if (manifest.id === "natalia-tool-terminal") {
    const worker = await Bun.build({
      entrypoints: [join(root, "src/wezterm-command-worker.ts")],
      outdir: packageOutdir,
      target: "bun",
      format: "esm",
      naming: "wezterm-command-worker.js",
      packages: "bundle",
    });
    if (!worker.success)
      throw new Error(`${root}: terminal worker build failed`);
    // The shell-integration rc scripts. Without these a pane starts, its argv
    // points at `--rcfile <this package>/shell-integration-bash.sh`, and bash
    // finds nothing — so the command-level read never comes alive on an installed
    // copy, which is exactly what happened: the scripts were verified in a pty and
    // never staged, so the verification covered the source tree and not a release.
    // They ride the release regardless of NATALIA_BUILD_SKIP_NATIVE: that flag
    // stages the wezterm binaries, not the text files a pane sources.
    for (const script of [
      "shell-integration-bash.sh",
      "shell-integration-zsh.sh",
    ]) {
      const from = join(root, "src", script);
      if (!(await Bun.file(from).exists()))
        throw new Error(`${root}: missing shell integration script ${script}`);
      await cp(from, join(packageOutdir, script));
    }
    const nativeRelease = join(root, "wezterm/target/release");
    const nativeOutdir = join(packageOutdir, "wezterm");
    const executableSuffix = process.platform === "win32" ? ".exe" : "";
    // The fork's three binaries follow the retirement: they ride a WINDOWS
    // build only, because the mux is the Windows pane's PTY until the ConPTY
    // bridge flips (issue #2). A POSIX build stages none — the self-developed
    // pty backend needs no terminal executables, measured by the terminal
    // suite passing with the three executables hidden. The ConPTY bridge, by
    // contrast, is our own native and stays on the Windows list: without it
    // the store copy has no bridge and every Windows panel silently falls
    // back to the mux's screen-dump path.
    const executables = (
      process.platform === "win32"
        ? [
            "wezterm",
            "wezterm-gui",
            "wezterm-mux-server",
            "natalia-conpty-bridge",
          ]
        : []
    ).map((name) => `${name}${executableSuffix}`);
    if (executables.length === 0) {
      // Nothing native to stage on this platform. A stale copy from an
      // earlier native build is trimmed, so the plugin's release files can
      // say the tier does not exist rather than advertising it.
      await rm(nativeOutdir, { recursive: true, force: true });
    } else if (skipNative) {
      // The distribution stays truthful about what it carries: the release
      // manifest omits the native tier rather than advertising it.
      console.log(
        `${root}: distribution mode — the wezterm executables are not staged`,
      );
    } else {
      for (const executable of executables)
        if (!(await Bun.file(join(nativeRelease, executable)).exists()))
          throw new Error(`${root}: missing terminal executable ${executable}`);
      await mkdir(nativeOutdir, { recursive: true });
      for (const executable of executables)
        await cp(
          join(nativeRelease, executable),
          join(nativeOutdir, executable),
        );
      // Staged means listed: the manifest's `files` is the release
      // bundle's truth, so a staged tier the manifest omits is a tier the
      // package drops.
      releaseFiles.push("wezterm");
    }
    releaseFiles.push("wezterm-command-worker.js");
  }

  const releasePackage = {
    name: sourcePackage.name,
    version: manifest.version,
    type: "module",
    license: sourcePackage.license ?? "Apache-2.0",
    exports: {
      ".": `./${manifest.entry}`,
      ...(manifest.ui ? { "./ui": `./${releaseManifest.ui!.entry}` } : {}),
    },
    files: releaseFiles,
  };
  await Bun.write(
    join(packageOutdir, "package.json"),
    `${JSON.stringify(releasePackage, null, 2)}\n`,
  );
  await Bun.write(
    join(packageOutdir, "natalia.plugin.json"),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
  );
  await Bun.write(join(packageOutdir, "LICENSE"), Bun.file(resolve("LICENSE")));

  const module = await import(
    `${Bun.pathToFileURL(join(packageOutdir, manifest.entry)).href}?build=${Date.now()}`
  );
  const plugin =
    typeof module.default === "function" ? module.default() : module.default;
  if (!plugin || typeof plugin.setup !== "function")
    throw new Error(
      `${root}: built entry must default-export a Plugin or factory`,
    );
  if (plugin.manifest?.version !== manifest.version)
    throw new Error(`${root}: exported plugin and manifest versions disagree`);
  const emitted = await Bun.file(join(packageOutdir, manifest.entry)).text();
  if (/\b(?:from\s*|import\s*\()?["']@natalia\//u.test(emitted))
    throw new Error(`${root}: built entry contains a bare @natalia import`);
  for (const entry of await readdir(packageOutdir))
    pluginOutputs.push(resolve(packageOutdir, entry));
}

if (pluginRoots.length !== 16)
  throw new Error(`expected 16 release plugins, got ${pluginRoots.length}`);
for (const artifact of [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "THIRD_PARTY_LICENSES.txt",
])
  await Bun.write(
    resolve(outdir, artifact),
    Bun.file(resolve(process.cwd(), artifact)),
  );
console.log(
  JSON.stringify(
    {
      version,
      target,
      outputs: [
        ...result.outputs.map((output) => output.path),
        ...pluginOutputs,
        ...[
          "LICENSE",
          "NOTICE",
          "THIRD_PARTY_NOTICES.md",
          "THIRD_PARTY_LICENSES.txt",
        ].map((artifact) => resolve(outdir, artifact)),
      ],
    },
    null,
    2,
  ),
);

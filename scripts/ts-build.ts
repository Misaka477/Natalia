import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { build as viteBuild } from "vite";
import solid from "vite-plugin-solid";
import { RUNTIME_WORKERS_DIR } from "../packages/hosts/platform/src/runtime-worker";

/**
 * Two modes, one script:
 *
 * - default (the release mode): everything, including staging our own PTY
 *   bridges — the ConPTY bridge on Windows, the Rust bridge on POSIX — which
 *   must exist because they are built by their own scripts
 *   (`native-terminal:build-conpty:windows` / `:build-pty-bridge`). A checkout
 *   without them (CI, a fresh clone) fails loudly here rather than shipping a
 *   plugin distribution whose terminal cannot start.
 * - the distribution mode (`bun scripts/ts-build.ts --skip-native`, what
 *   `npm run build:distribution` runs): everything the TEST SUITE needs — the
 *   CLI bundle and the 16-plugin official distribution — with the native
 *   staging skipped. This is what makes a fresh CI checkout verifiable: the
 *   client tests read `dist/ts/plugins`, and producing it must not require a
 *   containerized native build.
 *
 * The flag is read from argv as well as from the environment because
 * `NATALIA_BUILD_SKIP_NATIVE=1 bun scripts/ts-build.ts` is a POSIX env
 * prefix: cmd.exe (which `npm run` uses on Windows) rejects it outright with
 * "'NATALIA_BUILD_SKIP_NATIVE' is not recognized", so `npm run verify` could
 * not complete on Windows at all. A flag is spelled the same way in every
 * shell, and the env var keeps working for a caller that already sets it.
 */
const skipNative =
  process.argv.includes("--skip-native") ||
  process.env.NATALIA_BUILD_SKIP_NATIVE === "1";
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
  // A plugin's shipped skills directory (package-relative). Declared for the
  // same reason as `ui`: the staging below reads `skills.dir`.
  skills?: { dir: string };
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
  if (manifest.skills) {
    // The plugin's shipped skills ride the release exactly like its UI does:
    // the declared directory is staged into the package and listed in `files`,
    // so an install from the distribution carries the documents the skills
    // plugin then discovers as source "plugin". A declaration whose directory
    // is absent from the source package fails the build here rather than
    // shipping a plugin whose skills silently never appear — discovery walks
    // a missing root as empty, which is the one failure mode nobody sees.
    const skillsDir = manifest.skills.dir;
    const from = join(root, skillsDir);
    const staged = await stat(from).catch(
      () => undefined as { isDirectory(): boolean } | undefined,
    );
    if (!staged?.isDirectory())
      throw new Error(
        `${root}: declared skills directory is missing: ${skillsDir}`,
      );
    await cp(from, join(packageOutdir, skillsDir), { recursive: true });
    releaseFiles.push(skillsDir);
  }
  if (manifest.id === "natalia-tool-terminal") {
    // The shell-integration rc scripts. Without these a pane starts, its argv
    // points at `--rcfile <this package>/shell-integration-bash.sh`, and bash
    // finds nothing — so the command-level read never comes alive on an installed
    // copy, which is exactly what happened: the scripts were verified in a pty and
    // never staged, so the verification covered the source tree and not a release.
    // They ride the release regardless of NATALIA_BUILD_SKIP_NATIVE: that flag
    // stages the pty bridges, not the text files a pane sources.
    //
    // Staged means LISTED: the manifest's files is the release bundle's truth
    // (see the bridge tier below), and a script staged but not listed is a
    // script the store copy drops. That is the second half of this defect —
    // the scripts were copied here and then omitted from files, so the
    // installed plugin had no rcfile to point at. Verified on the user's
    // machine: the store copy carried pty-bridge/ and none of the three.
    // The pwsh script rides too: its SCRIPTS entry existed while the file was
    // never staged at all, so a pwsh pane on an installed copy was silent.
    for (const script of [
      "shell-integration-bash.sh",
      "shell-integration-zsh.sh",
      "shell-integration-pwsh.ps1",
    ]) {
      const from = join(root, "src", script);
      if (!(await Bun.file(from).exists()))
        throw new Error(`${root}: missing shell integration script ${script}`);
      await cp(from, join(packageOutdir, script));
      releaseFiles.push(script);
    }
    // Our own natives ride their OWN directory, staged per platform from the
    // prebuilt drop the build scripts write: the Rust PTY bridge on POSIX
    // (`native-terminal:build-pty-bridge`), the ConPTY bridge on Windows
    // (`native-terminal:build-conpty:windows`). They used to ride `wezterm/`
    // beside the fork's trio, and the release builder's wezterm-trim deleted
    // the ConPTY bridge that shared it — a Windows release shipped with no
    // bridge at all, measured. Separate directory, separate owner: a trim of
    // one tier can no longer take the other with it.
    const triple = `${process.platform === "win32" ? "windows" : "linux"}-${process.arch}`;
    const bridgeName =
      process.platform === "win32"
        ? "natalia-conpty-bridge.exe"
        : "natalia-pty-bridge";
    const bridgeFrom = join(root, "prebuilt", triple, bridgeName);
    const bridgeOutdir = join(packageOutdir, "pty-bridge");
    if (skipNative) {
      // The distribution stays truthful about what it carries: the release
      // manifest omits the native tiers rather than advertising them, and a
      // stale copy from an earlier native build is trimmed so the plugin's
      // release files can say the tier does not exist. (A store-loaded plugin
      // without the bridge falls back to the Python one, by design.)
      console.log(
        `${root}: distribution mode — the native executables are not staged`,
      );
      await rm(bridgeOutdir, { recursive: true, force: true });
    } else {
      if (!(await Bun.file(bridgeFrom).exists()))
        throw new Error(
          `${root}: missing pty bridge ${bridgeName} (expected ${bridgeFrom}; run native-terminal:build-pty-bridge / build-conpty:windows)`,
        );
      await mkdir(bridgeOutdir, { recursive: true });
      await cp(bridgeFrom, join(bridgeOutdir, bridgeName));
      // Staged means listed: the manifest's `files` is the release bundle's
      // truth, so a staged tier the manifest omits is a tier the package
      // drops.
      releaseFiles.push("pty-bridge");
    }
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

/**
 * The runtime's Worker threads, as REAL FILES.
 *
 * Every server-side pool builds its worker with
 * `new Worker(new URL("./thing.worker.ts", import.meta.url))`. `bun build
 * --compile` does NOT treat that argument as an entry point — its own log line
 * for the whole binary is `bundle 1 modules` — so the worker module was never
 * inside the executable. At runtime `import.meta.url` is
 * `file:///B:/~BUN/root/natalia.exe` (Bun's EMBEDDED filesystem), the URL
 * resolved to `B:\~BUN\root\thing.worker.ts`, and the worker's bootstrap died
 * with `BuildMessage: ModuleNotFound resolving "B:\~BUN\root\thing.worker.ts"`.
 *
 * The interesting part is HOW it failed: as an asynchronous `error` EVENT, not
 * a constructor throw. `new Worker(...)` looked like it had succeeded, nothing
 * was logged, and every task posted to the pool simply waited out its deadline.
 * Measured on bun 1.4.0 with the same source run as the control (it answered
 * its first message), and on a fresh install, whose log said:
 *
 *   [runtime] config clone worker unavailable, using structuredClone: secondary worker failed
 *   [runtime] model catalog worker unavailable … did not answer modelCatalog within 15000ms
 *
 * There is no embedding option for workers, so the answer is the one the
 * release already uses for its tree-sitter WASM files: SHIP THE MODULE AS A
 * FILE beside the executable and load it from disk.
 * `packages/hosts/platform/src/runtime-worker.ts` is the resolver that finds
 * these; the release builder copies `dist/ts/*` into the release root, so
 * `workers/` lands beside `natalia.exe` with no further staging step. Linux gets
 * the identical layout — this is a single-file-executable problem, not a
 * Windows one, and a Windows-only fix would leave the Linux release loading the
 * embedded path that does not exist there either.
 */
const workerSources = [
  "packages/framework/diff/src/runtime/diff-parse.worker.ts",
  "packages/framework/object-store/src/maintenance.worker.ts",
  "packages/framework/substrate/src/session-project.worker.ts",
  "packages/framework/client/src/runtime/ast-compute.worker.ts",
  "packages/framework/client/src/runtime/secondary.worker.ts",
  "packages/framework/session-store/src/session-load.worker.ts",
  "packages/framework/session-store/src/session-messages.worker.ts",
] as const;
const workersOutdir = resolve(outdir, RUNTIME_WORKERS_DIR);
await rm(workersOutdir, { recursive: true, force: true });
const workersBuild = await Bun.build({
  entrypoints: [...workerSources],
  outdir: workersOutdir,
  target: "bun",
  format: "esm",
  // Flat, because the consumers ask for a flat name: the resolver derives it
  // from the source module's own basename. The seven names are distinct, so
  // flattening cannot collide.
  naming: "[name].js",
  packages: "bundle",
});
if (!workersBuild.success) {
  for (const log of workersBuild.logs) console.error(log);
  throw new Error("the runtime worker build failed");
}
// Every worker either ships or the build says so. A missing one is not a missing
// optimisation — its pool's callers wait out a deadline for an answer that can
// never come, which is exactly what the packaged runtime did. And a worker that
// still imports a bare specifier would die on load in a release, where there is
// no node_modules beside the executable.
for (const source of workerSources) {
  const name = `${basename(source).replace(/\.ts$/u, "")}.js`;
  const emitted = join(workersOutdir, name);
  if (!(await Bun.file(emitted).exists()))
    throw new Error(`${source}: no worker bundle was emitted at ${emitted}`);
  const text = await Bun.file(emitted).text();
  if (/["']@anthelia\//u.test(text))
    throw new Error(
      `${name}: the worker bundle still imports a workspace package — a release ` +
        `has no node_modules beside its executable, so the worker would die on load`,
    );
}
console.log(
  `staged ${workerSources.length} runtime workers in ${workersOutdir}`,
);
const workerOutputs = workerSources.map((source) =>
  resolve(workersOutdir, `${basename(source).replace(/\.ts$/u, "")}.js`),
);

if (pluginRoots.length !== 15)
  throw new Error(`expected 15 release plugins, got ${pluginRoots.length}`);
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
        ...workerOutputs,
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

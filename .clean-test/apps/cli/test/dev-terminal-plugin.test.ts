import { expect, test } from "bun:test";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRealRuntimeClient } from "@natalia/client";
import { CapabilityRegistry } from "@anthelia/capability";
import {
  initializeOfficialPlugins,
  type PackageManagerRun,
} from "@natalia/installer";
import { terminalController } from "@anthelia/runtime-services";
import { initializeOfficialPluginsForHostCommand } from "../src/official-plugins";

const pluginDistributionRoot = resolve(
  import.meta.dir,
  "../../..",
  "dist/ts/plugins",
);
// Hard links cannot cross filesystems and /tmp is one, so the per-test store
// lives beside the distribution it links from (same reason the framework
// client suite keeps its test workspaces under dist/ts).
const testStoreRoot = resolve(
  import.meta.dir,
  "../../..",
  "dist/ts/cli-dev-pty-stores",
);

/**
 * Installs prebuilt plugins by hard-linking their packaged files instead of
 * running npm, so a test store is built from the current distribution without
 * copying 165 MB of native attachments per test. Same pattern the framework
 * client suite uses against `dist/ts/plugins`.
 */
const linkPrebuiltPackage: PackageManagerRun = async ({ args }) => {
  if (args[0] !== "install")
    throw new Error(`unsupported test package-manager operation: ${args[0]}`);
  const prefix = args[args.indexOf("--prefix") + 1];
  const source = args.at(-1);
  if (!prefix || !source)
    throw new Error("invalid test package-manager install arguments");
  const packageJSON = JSON.parse(
    await readFile(join(source, "package.json"), "utf8"),
  ) as { name: string; version: string; files?: string[] };
  const target = join(prefix, "node_modules", ...packageJSON.name.split("/"));
  await mkdir(target, { recursive: true });
  for (const file of new Set([
    "package.json",
    "natalia.plugin.json",
    ...(packageJSON.files ?? []),
  ])) {
    // Native executable packaging is verified by the release lifecycle test.
    if (file === "wezterm") continue;
    const destination = join(target, file);
    await mkdir(dirname(destination), { recursive: true });
    const sourcePath = join(source, file);
    if ((await stat(sourcePath)).isDirectory())
      await cp(sourcePath, destination, { recursive: true });
    else await link(sourcePath, destination);
  }
  // The installer identifies the installed package from the store's dependency
  // diff, so the linking stand-in must book the same records npm would.
  const dependencies = JSON.parse(
    await readFile(join(prefix, "package.json"), "utf8").catch(() => "{}"),
  ) as { dependencies?: Record<string, string> };
  dependencies.dependencies = {
    ...(dependencies.dependencies ?? {}),
    [packageJSON.name]: packageJSON.version,
  };
  await writeFile(
    join(prefix, "package.json"),
    JSON.stringify({ dependencies: dependencies.dependencies }, null, 2),
  );
  const lockPath = join(prefix, "package-lock.json");
  const packages = JSON.parse(
    await readFile(lockPath, "utf8").catch(() => "{}"),
  ) as { packages?: Record<string, unknown> };
  packages.packages = {
    ...(packages.packages ?? {}),
    [`node_modules/${packageJSON.name}`]: { version: packageJSON.version },
  };
  await writeFile(
    lockPath,
    JSON.stringify(
      { lockfileVersion: 3, packages: packages.packages },
      null,
      2,
    ),
  );
};

test("dev official terminal plugin shim loads and starts a PTY", async () => {
  await initializeOfficialPluginsForHostCommand(["serve"]);
  // The shared dev plugin store only initializes once (its marker never
  // invalidates), so it can hold a build older than the plugin sources — a
  // stale terminal build is exactly how this test used to fail with a PTY that
  // never echoed input. Build a per-test store from the current distribution
  // instead; it cannot go stale.
  await mkdir(testStoreRoot, { recursive: true });
  const storeRoot = await mkdtemp(join(testStoreRoot, "store-"));
  await initializeOfficialPlugins({
    pluginStoreRoot: storeRoot,
    distributionRoot: pluginDistributionRoot,
    runPackageManager: linkPrebuiltPackage,
  });
  const packageRoot = join(
    storeRoot,
    "node_modules/@natalia/plugin-native-terminal",
  );
  const manifest = (await Bun.file(
    join(packageRoot, "natalia.plugin.json"),
  ).json()) as { entry: string };
  const shim = join(packageRoot, manifest.entry);
  const loaded = (await import(pathToFileURL(shim).href)) as {
    default?: unknown;
  };
  expect(typeof loaded.default).toBe("function");

  const root = await mkdtemp(join(tmpdir(), "natalia-dev-pty-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      runtime: { terminal: { windowMode: "windowless" } },
    }),
  );
  const kernel = new CapabilityRegistry();
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_dev_pty",
    pluginStoreRoot: storeRoot,
    capabilityRegistry: kernel,
    sessionDir: join(root, ".natalia", "sessions"),
    checkpointDir: join(root, ".natalia", "checkpoints"),
  });
  try {
    client.start(() => undefined);
    await client.runtimeStatus?.();
    expect(kernel.has("natalia-tool-terminal")).toBe(true);
    expect(kernel.service(terminalController.id)).toBeDefined();
    const started = await client.nativeTerminalStart?.({
      // A pane command runs inside the managed profile-sourcing shell
      // (`sh -lc`), so a bare `bash` would source the developer's ~/.bashrc — conda/nvm/agent
      // snippets there are the machine's, not the test's, and a slow or
      // blocked profile turns this smoke test into a hang. `--norc
      // --noprofile` keeps the interactive-shell behaviour under test
      // (prompt, input echo, command execution) on a deterministic shell.
      command: "exec bash --norc --noprofile",
      id: "ses_dev_pty",
      sessionID: "ses_dev_pty",
    });
    expect(started?.host).toBe("pty");
    expect(started?.status).toBe("running");
    // Readiness is proven by the shell executing our command, not by the
    // prompt's shape: PS1 differs per machine and shell (bash "$", zsh "%",
    // conda-injected prefixes), and input written before the shell reads is
    // buffered by the PTY line discipline, so sending immediately is safe.
    await client.nativeTerminalWrite?.({
      id: started!.id,
      input: "printf '__PTY_READY__\\n'\n",
    });
    const deadline = Date.now() + 10_000;
    let snapshot = await client.nativeTerminalRead?.(started!.id);
    while (!snapshot?.text.includes("__PTY_READY__") && Date.now() < deadline) {
      await Bun.sleep(50);
      snapshot = await client.nativeTerminalRead?.(started!.id);
    }
    expect(snapshot?.text).toContain("__PTY_READY__");
  } finally {
    await client.dispose?.();
    await rm(storeRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

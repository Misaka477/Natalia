import { join, resolve } from "node:path";
import {
  createRealRuntimeClient,
  createUiAdapterHost,
  createWorkspaceManager,
  createWorkspaceRuntimeClient,
  type UiAdapterHost,
} from "@natalia/client";
import { createRecordedFetch } from "@natalia/transport";
import { createHttpTransportHost } from "./transport-host";
import { createPluginUiResolver } from "./plugin-ui";
import { ensureFirstUseWorkspace } from "./first-use-workspace";
import { serveStaticDirectory } from "./serve-web";
import { ensureNataliaConfigPath, nataliaConfigPath } from "./config-home";
import { promptArguments } from "./index";
import {
  valueAfter,
  waitSignal,
  settleShutdown,
  exitAfterShutdown,
  withoutOption,
} from "./command-helpers";
import {
  officialPluginDistributionRoot,
  pluginStoreRoot,
} from "./official-plugins";
import { perfLog } from "@anthelia/runtime-services";
import { nataliaCachePath, nataliaHomeJoin } from "@anthelia/platform";

export async function handleRuntimeCommand(argv: string[]) {
  const command = argv[0];
  const commandStart = performance.now();
  if (command === "serve-web") {
    // The release's own static server for the shipped web shell. The dev flow
    // runs `apps/cef-desktop/serve-web.ts`, which resolves a REPO-relative path;
    // an installed copy has no repo, so this is the same job pointed at a
    // directory the caller names.
    // The directory arrives as `--root <dir>` from the Windows launcher. The
    // positional form is still accepted, but `--root` is read FIRST: looking
    // only at argv[1] made `--root <install>\web` read as "no argument given"
    // and fall back to a cwd-relative `web`, which an install does not have.
    const flaggedRoot = valueAfter(argv, "--root");
    const positionalRoot =
      argv[1] && !argv[1].startsWith("-") ? argv[1] : undefined;
    const root = resolve(flaggedRoot ?? positionalRoot ?? "web");
    if (!(await Bun.file(join(root, "index.html")).exists()))
      throw new Error(
        `serve-web: ${root} has no index.html — a release serves its own web/ ` +
          `directory (run build:web, then pass its directory)`,
      );
    const port = Number(valueAfter(argv, "--port") ?? "8790");
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("serve-web requires a valid port");
    // The runtime's endpoint, written by `serve` when it came up. A page cannot
    // discover it: the port is chosen at launch and the token is per-runtime.
    // Without this the shell falls back to a hardcoded port and an
    // unauthenticated request, and every RPC fails.
    const endpointPath = nataliaHomeJoin({}, "run", "runtime-endpoint.json");
    const bootstrap = (await Bun.file(endpointPath)
      .json()
      .catch(() => undefined)) as { url?: string; token?: string } | undefined;
    const served = await serveStaticDirectory({
      root,
      port,
      ...(bootstrap ? { bootstrap } : {}),
    });
    console.log(`[serve-web] ${served.url} -> ${root}`);
    return true;
  }
  if (command === "serve" || command === "--serve") {
    const port = parseServePort(argv);
    // The ONE home's config, not `<cwd>/.natalia/global-config.json`. The
    // working directory is the install folder for a Start Menu launch, so the
    // old spelling put the user's model configuration inside the install tree
    // — and the uninstaller deletes that tree. It was also a second name
    // (`global-config.json`) for the file `config.json` elsewhere, so two
    // readers could disagree about which file was the configuration.
    const globalConfigPath = nataliaConfigPath();
    // Created before the manager reads it. `serve` is what the Windows
    // launcher starts first, so a strict read here is what an installed copy
    // died on: the same ENOENT as the CLI's own faces, one layer down.
    await ensureNataliaConfigPath(globalConfigPath);
    console.log("[serve] globalConfigPath", globalConfigPath);
    const manager = createWorkspaceManager({
      pluginStoreRoot: pluginStoreRoot(),
      // Where the official plugins are installed FROM. The store lives in the
      // one home, so it is no longer a sibling of the distribution — deriving
      // it from the store pointed at `<home>/plugins`, which does not exist,
      // and installing an official plugin from the shell failed there.
      pluginDistributionRoot: officialPluginDistributionRoot(),
      globalConfigPath,
      // The one home, never the working directory. These two are the JSON
      // store's own roots (the SQLite store is per-workspace), and a
      // cwd-relative one put them inside the install tree for a Start Menu
      // launch — the tree the uninstaller deletes, so the fallback store
      // died with an uninstall. Existing data under the old spelling is not
      // moved here: it is keyed by workspace and the move belongs to the
      // workspace manager, which knows each real root.
      sessionDir: nataliaHomeJoin({}, "workspace-sessions"),
      checkpointDir: nataliaHomeJoin({}, "workspace-checkpoints"),
      // The web server is the long-lived API surface for a workspace; persist
      // sessions into the same per-workspace SQLite store used by the TUI.
      useSqliteStore: true,
      // A CACHE, so it follows the one home's cache directory rather than the
      // server's working directory: the working directory is the install
      // folder for a Start Menu launch, and a cache written there is deleted
      // by the uninstaller and invisible to every diagnostic that looks in
      // the home.
      contextWindowCachePath: nataliaCachePath("context-window.json"),
      // The self-iteration handoff. Every workspace's runtime is created
      // by the manager, so the closure below is the only way a session
      // reaches a session in ANOTHER tree — and it has to be injected
      // before the first client exists, which is why it reads the manager
      // lazily rather than closing over it at construction time.
      iterateBranch: (baseline, request) =>
        manager.iterateBranch(baseline, request),
    });
    await manager.load();
    // A fresh install has no workspace registry, and every runtime face
    // resolves through the manager's ACTIVE workspace. The first workspace is
    // the OS Documents one — a fixed path, whatever the process was started
    // from — so the INSTALL tree can never become a workspace: its
    // `<workspace>/.natalia` would sit inside the tree the uninstaller
    // deletes. Deleting that workspace records the refusal, and a later
    // launch does not create it again. A host with no Documents directory
    // gets no workspace at all, and the shell shows its empty state — which
    // carries the add-workspace entry point.
    if (!manager.getActive()) await ensureFirstUseWorkspace(manager);
    perfLog(
      `[perf] runtime manager loaded +${(performance.now() - commandStart).toFixed(1)}ms`,
    );
    const client = createWorkspaceRuntimeClient(manager);
    const serveStart = performance.now();
    const transport = createHttpTransportHost({
      client,
      port,
      token: process.env.NATALIA_TRANSPORT_TOKEN,
      terminalWrite: true,
      pluginUiResolver: createPluginUiResolver(pluginStoreRoot()),
    });
    perfLog(
      `[perf] runtime serve ready +${(performance.now() - serveStart).toFixed(1)}ms`,
    );
    perfLog(
      `[perf] runtime serve ready total +${(performance.now() - commandStart).toFixed(1)}ms`,
    );
    console.log(
      JSON.stringify({
        url: transport.server.url,
        auth: process.env.NATALIA_TRANSPORT_TOKEN
          ? "bearer required"
          : "disabled",
      }),
    );
    // The runtime's own address and token, written where the web server can
    // read them. A browser page cannot discover either: the port is chosen at
    // launch and the token is per-runtime. The shell used to hardcode
    // `http://127.0.0.1:8790` with no token, so every RPC from the page failed
    // — connection refused when the runtime sat on another port, then 401 when
    // it sat on the right one (both measured). `serve-web` injects this into
    // the HTML it serves as `window.__NATALIA_RUNTIME__`.
    await Bun.write(
      nataliaHomeJoin({}, "run", "runtime-endpoint.json"),
      JSON.stringify({
        url: transport.server.url,
        ...(process.env.NATALIA_TRANSPORT_TOKEN
          ? { token: process.env.NATALIA_TRANSPORT_TOKEN }
          : {}),
      }),
    );
    await waitSignal();
    await settleShutdown("runtime transport close", () => transport.close());
    await settleShutdown("runtime manager dispose", () => manager.dispose());
    // Exit here rather than falling off the end: every step above reports
    // its own result, and the only thing left is to go. Without this the
    // process stays alive after a clean dispose and the person at the
    // terminal gets no signal at all until the hard watchdog fires 20
    // seconds later — which is how one Ctrl+C became a long silence and an
    // exit nobody could attribute.
    exitAfterShutdown();
    return true;
  }
  if (command === "run" || command === "--once") {
    const permission = valueAfter(argv, "--permission");
    if (argv.includes("--permission") && !permission)
      throw new Error("--permission requires a profile name");
    const { text, attachments } = promptArguments(
      withoutOption(argv.slice(1), "--permission"),
    );
    if (!text) throw new Error("run requires a prompt");
    await runOnce(text, argv.includes("--json"), attachments, permission);
    return true;
  }
  if (command === "eval" || command === "--stdio") {
    const client = createRealRuntimeClient({
      pluginStoreRoot: pluginStoreRoot(),
      sessionDir: resolve(process.cwd(), ".natalia", "sessions"),
      checkpointDir: resolve(process.cwd(), ".natalia", "checkpoints"),
    });
    let failed = false;
    try {
      client.start((event) => {
        if (event.type === "turn.finished" && event.stopReason === "error")
          failed = true;
        console.log(JSON.stringify(event));
      });
      for (const line of (await Bun.stdin.text()).split(/\r?\n/u)) {
        if (!line.trim()) continue;
        const request = JSON.parse(line) as {
          prompt?: string;
          delivery?: "next-turn" | "next-step";
          attachments?: string[];
          cancel?: string;
          pause?: string;
          resume?: boolean;
        };
        if (request.cancel) client.cancel(request.cancel);
        if (request.pause) client.pause?.(request.pause);
        if (request.resume) client.resume?.();
        if (
          request.prompt &&
          client.submitInput &&
          (request.delivery === "next-turn" || request.attachments?.length)
        )
          await client.submitInput({
            text: request.prompt,
            delivery: request.delivery,
            attachments: request.attachments,
          });
        else if (request.prompt) await client.submit(request.prompt);
      }
    } finally {
      await client.dispose?.();
    }
    if (failed) process.exitCode = 1;
    return true;
  }
  if (command === "ui") {
    const kind = argv[1];
    if (argv[1]?.startsWith("--"))
      throw new Error(`ui requires a UI adapter kind, got flag ${argv[1]}`);
    const client = createRealRuntimeClient({
      pluginStoreRoot: pluginStoreRoot(),
      sessionDir: resolve(process.cwd(), ".natalia", "sessions"),
      checkpointDir: resolve(process.cwd(), ".natalia", "checkpoints"),
    });
    const host: UiAdapterHost = await createUiAdapterHost({
      workspaceRoot: process.cwd(),
      pluginStoreRoot: pluginStoreRoot(),
      runtime: client,
      kinds: kind ? [kind] : [],
      configPath: process.env.NATALIA_CONFIG,
      report: (message) => console.error(`natalia: ${message}`),
    });
    try {
      if (!kind) {
        const available = [...host.availableKinds()].sort();
        if (!available.length)
          throw new Error("no UI adapters are installed or enabled");
        console.log(available.join("\n"));
        return true;
      }
      console.log(`natalia: ui adapter ${kind} mounted`);
      await waitSignal();
    } finally {
      await settleShutdown("ui host close", () => host.close());
    }
    return true;
  }
  if (command === "record") {
    const cassettePath = argv[1];
    if (!cassettePath) throw new Error("record requires a cassette path");
    const client = createRealRuntimeClient({
      pluginStoreRoot: pluginStoreRoot(),
    });
    const transport = createHttpTransportHost({
      client,
      port: Number(argv[2] ?? "8787"),
      pluginUiResolver: createPluginUiResolver(pluginStoreRoot()),
    });
    globalThis.fetch = createRecordedFetch({
      mode: "record",
      cassettePath,
    }) as typeof fetch;
    console.log(
      JSON.stringify({ url: transport.server.url, cassette: cassettePath }),
    );
    await waitSignal();
    await settleShutdown("record transport close", () => transport.close());
    await settleShutdown("record client dispose", () => client.dispose?.());
    exitAfterShutdown();
    return true;
  }
  return false;
}

export function parseServePort(argv: string[]) {
  // The port has always been the first positional argument (`natalia serve
  // 8787`). `--port N` is accepted too, because the Windows launcher — and
  // anyone reading the other subcommands — reaches for the flag form, and a
  // `--port` that silently became the positional made `serve` throw "requires a
  // valid port" with the flag sitting right there in the command line.
  const flagged = valueAfter(argv, "--port");
  const raw = flagged ?? argv[1] ?? "8787";
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    throw new Error("serve requires a valid port");
  return port;
}

async function runOnce(
  prompt: string,
  json: boolean,
  attachments: string[],
  permissionProfile?: string,
) {
  const client = createRealRuntimeClient({
    pluginStoreRoot: pluginStoreRoot(),
    permissionProfile,
    sessionDir: resolve(process.cwd(), ".natalia", "sessions"),
    checkpointDir: resolve(process.cwd(), ".natalia", "checkpoints"),
  });
  let text = "";
  let failed = false;
  try {
    client.start((event) => {
      if (event.type === "turn.finished" && event.stopReason === "error")
        failed = true;
      if (json) console.log(JSON.stringify(event));
      else if (event.type === "content.delta") text += event.text;
    });
    if (attachments.length && client.submitInput)
      await client.submitInput({ text: prompt, attachments });
    else await client.submit(prompt);
    if (!json && text) console.log(text);
  } finally {
    await client.dispose?.();
  }
  if (failed) process.exitCode = 1;
}

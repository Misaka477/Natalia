import { resolve } from "node:path";
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
import { promptArguments } from "./index";
import {
  valueAfter,
  waitSignal,
  settleShutdown,
  logActiveHandles,
  withoutOption,
} from "./command-helpers";
import { pluginStoreRoot } from "./official-plugins";
import { perfLog } from "@anthelia/runtime-services";

export async function handleRuntimeCommand(argv: string[]) {
  const command = argv[0];
  const commandStart = performance.now();
  if (command === "serve" || command === "--serve") {
    const port = parseServePort(argv);
    const globalConfigPath =
      process.env.NATALIA_CONFIG ??
      resolve(process.cwd(), ".natalia", "global-config.json");
    console.log("[serve] globalConfigPath", globalConfigPath);
    const manager = createWorkspaceManager({
      pluginStoreRoot: pluginStoreRoot(),
      globalConfigPath,
      sessionDir: resolve(process.cwd(), ".natalia", "workspace-sessions"),
      checkpointDir: resolve(
        process.cwd(),
        ".natalia",
        "workspace-checkpoints",
      ),
      // The web server is the long-lived API surface for a workspace; persist
      // sessions into the same per-workspace SQLite store used by the TUI.
      useSqliteStore: true,
      contextWindowCachePath: resolve(
        process.cwd(),
        ".natalia",
        "context-window-cache.json",
      ),
    });
    await manager.load();
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
    await waitSignal();
    await settleShutdown("runtime transport close", () => transport.close());
    await settleShutdown("runtime manager dispose", () => manager.dispose());
    logActiveHandles();
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
    return true;
  }
  return false;
}

export function parseServePort(argv: string[]) {
  const port = Number(argv[1] ?? "8787");
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

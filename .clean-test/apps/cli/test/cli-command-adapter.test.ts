import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliCommandAdapterHost } from "../src/cli-command-adapter";
import {
  parsePluginMaintenanceArgs,
  runPluginMaintenanceCommand,
} from "../src/plugin-maintenance";
import { initializeOfficialPluginsForHostCommand } from "../src/official-plugins";

test("CLI adapter host owns one idempotent instance", async () => {
  let starts = 0;
  let disposals = 0;
  const host = await createCliCommandAdapterHost(() => {
    starts += 1;
    return {
      done: Promise.resolve(),
      dispose() {
        disposals += 1;
      },
    };
  });
  expect(starts).toBe(1);
  await host.done;
  await host.close();
  await host.close();
  expect(disposals).toBe(1);
});

test("CLI adapter startup failure is surfaced without disposal", async () => {
  let starts = 0;
  await expect(
    createCliCommandAdapterHost(() => {
      starts += 1;
      throw new Error("CLI startup failed");
    }),
  ).rejects.toThrow("CLI startup failed");
  expect(starts).toBe(1);
});

test("recognized host commands initialize official plugins in the distribution sibling store", async () => {
  const calls: Array<{
    pluginStoreRoot: string;
    distributionRoot: string;
  }> = [];
  // One representative per recognized group: runtime, daemon, local. The
  // task/flow group was removed along with the feature.
  for (const command of ["run", "daemon-status", "status"]) {
    expect(
      await initializeOfficialPluginsForHostCommand(
        [command],
        async (input) => {
          calls.push(input);
          return { initialized: false, installed: [] };
        },
      ),
    ).toBe(true);
  }
  expect(calls).toHaveLength(3);
  expect(
    calls.every(({ pluginStoreRoot }) =>
      pluginStoreRoot.endsWith("dist/ts/plugin-store"),
    ),
  ).toBe(true);
  expect(
    calls.every(({ distributionRoot }) =>
      distributionRoot.endsWith("dist/ts/plugins"),
    ),
  ).toBe(true);
  expect(
    calls.every(
      ({ pluginStoreRoot, distributionRoot }) =>
        pluginStoreRoot === join(distributionRoot, "..", "plugin-store"),
    ),
  ).toBe(true);
  expect(
    calls.every(
      ({ pluginStoreRoot }) => !pluginStoreRoot.includes("workspace"),
    ),
  ).toBe(true);
});

test("unknown and deprecated command paths do not initialize plugins", async () => {
  let calls = 0;
  for (const argv of [["unknown"], ["--once"], ["--diagnostics"]])
    expect(
      await initializeOfficialPluginsForHostCommand(argv, async () => {
        calls += 1;
        return { initialized: false, installed: [] };
      }),
    ).toBe(false);
  expect(calls).toBe(0);
});

test("the default local status path initializes official plugins", async () => {
  let calls = 0;
  expect(
    await initializeOfficialPluginsForHostCommand([], async () => {
      calls += 1;
      return { initialized: false, installed: [] };
    }),
  ).toBe(true);
  expect(calls).toBe(1);
});

test("official reinstall has explicit parsing and lifecycle routing", async () => {
  const parsed = parsePluginMaintenanceArgs([
    "plugin",
    "reinstall",
    "natalia-tool-ask",
  ]);
  let routed:
    | {
        pluginID: string;
        pluginStoreRoot: string;
        distributionRoot: string;
      }
    | undefined;
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await runPluginMaintenanceCommand([], parsed, {
      reinstallOfficialPlugin: async (input) => {
        routed = input;
        return { installed: true } as never;
      },
    });
  } finally {
    console.log = originalLog;
  }
  expect(routed).toMatchObject({
    pluginID: "natalia-tool-ask",
  });
  expect(routed!.distributionRoot.endsWith("dist/ts/plugins")).toBe(true);
  expect(routed!.pluginStoreRoot.endsWith("dist/ts/plugin-store")).toBe(true);
  expect(routed!.pluginStoreRoot).toBe(
    join(routed!.distributionRoot, "..", "plugin-store"),
  );
  expect(routed!.pluginStoreRoot).not.toContain("/workspace");
  for (const argv of [
    ["plugin", "uninstall", "demo", "--workspace", "/workspace"],
    ["plugin", "reinstall", "natalia-tool-ask", "--workspace", "/workspace"],
    ["plugin", "doctor", "--workspace", "/workspace"],
    ["plugin", "reconcile", "--workspace", "/workspace"],
  ])
    expect(() => parsePluginMaintenanceArgs(argv)).toThrow(
      "does not accept --workspace",
    );
  expect(() =>
    parsePluginMaintenanceArgs(["plugin", "reinstall", "not-official"]),
  ).toThrow("unknown official plugin");
});

test("plugin maintenance excludes framework transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-transport-maintenance-"));
  await mkdir(join(root, ".natalia"));
  await writeFile(
    join(root, ".natalia", "official-plugins-initialized-v1"),
    "initialized\n",
  );
  const listed = JSON.parse(text(runCli(root, "plugin", "list").stdout));
  expect(
    listed.some(
      (candidate: { id: string }) => candidate.id === "natalia-transport",
    ),
  ).toBe(false);
});

test("plugin maintenance parser rejects missing, extra, and unknown arguments", () => {
  for (const argv of [
    ["plugin", "enable"],
    ["plugin", "list", "extra"],
    ["plugin", "disable", "one", "two"],
    ["plugin", "list", "--unknown"],
    ["plugin", "list", "-x"],
    ["plugin", "list", "--workspace"],
    ["plugin", "list", "--workspace", "/one", "--workspace", "/two"],
    ["plugin", "create", "demo"],
    ["plugin", "create", "demo", "--id"],
    ["plugin", "create", "one", "two", "--id", "demo.plugin"],
    ["plugin", "install", "demo", "--id", "demo.plugin"],
    ["plugin", "create", "demo", "--id", "demo.plugin", "--template", "web"],
    ["plugin", "create", "demo", "--id", "demo.plugin", "--language", "python"],
  ]) {
    expect(() => parsePluginMaintenanceArgs(argv)).toThrow();
  }
});

test("plugin create writes a publishable JavaScript package", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-create-"));
  const directory = join(root, "demo-plugin");
  const result = runCli(
    root,
    "plugin",
    "create",
    directory,
    "--id",
    "demo.plugin",
    "--package",
    "@demo/natalia-plugin",
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(text(result.stdout))).toMatchObject({
    created: true,
    directory,
    pluginID: "demo.plugin",
    packageName: "@demo/natalia-plugin",
    template: "command",
    language: "js",
    entry: "src/index.js",
  });
  const manifest = JSON.parse(
    await readFile(join(directory, "natalia.plugin.json"), "utf8"),
  );
  const packageJSON = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  expect(manifest).toMatchObject({
    id: "demo.plugin",
    entry: "src/index.js",
    hooks: {},
    integrationPoints: ["commands"],
  });
  expect(packageJSON).toMatchObject({
    name: "@demo/natalia-plugin",
    files: ["src", "natalia.plugin.json"],
    exports: { ".": "./src/index.js" },
  });
  expect(await readFile(join(directory, "src", "index.js"), "utf8")).toContain(
    "definePlugin",
  );
  expect(
    runCli(root, "plugin", "create", directory, "--id", "demo.plugin").exitCode,
  ).not.toBe(0);
});

test("plugin create writes tool and UI adapter templates", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-plugin-create-templates-"),
  );
  const toolDirectory = join(root, "demo-tool");
  const uiDirectory = join(root, "demo-ui");
  const tool = runCli(
    root,
    "plugin",
    "create",
    toolDirectory,
    "--id",
    "demo.echo",
    "--template",
    "tool",
  );
  const ui = runCli(
    root,
    "plugin",
    "create",
    uiDirectory,
    "--id",
    "demo.web",
    "--package",
    "@demo/natalia-ui-web",
    "--template",
    "ui",
  );
  expect(tool.exitCode).toBe(0);
  expect(ui.exitCode).toBe(0);
  expect(JSON.parse(text(tool.stdout))).toMatchObject({
    created: true,
    template: "tool",
  });
  expect(JSON.parse(text(ui.stdout))).toMatchObject({
    created: true,
    template: "ui",
    kind: "ui.demo.web",
  });
  expect(
    JSON.parse(
      await readFile(join(toolDirectory, "natalia.plugin.json"), "utf8"),
    ),
  ).toMatchObject({
    integrationPoints: ["tools"],
    scope: "workspace",
  });
  expect(
    JSON.parse(
      await readFile(join(uiDirectory, "natalia.plugin.json"), "utf8"),
    ),
  ).toMatchObject({
    integrationPoints: ["adapters"],
    scope: "process",
  });
  expect(
    await readFile(join(toolDirectory, "src", "index.js"), "utf8"),
  ).toContain("api.tools.register");
  expect(
    await readFile(join(uiDirectory, "src", "index.js"), "utf8"),
  ).toContain("api.adapters.registerUi");
  expect(
    JSON.parse(await readFile(join(uiDirectory, "package.json"), "utf8"))
      .dependencies["@anthelia/contracts"],
  ).toBeDefined();
});

test("plugin create writes a UI panel plugin package", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-create-ui-panel-"));
  const directory = join(root, "demo-panel");
  const result = runCli(
    root,
    "plugin",
    "create",
    directory,
    "--id",
    "demo.panel",
    "--package",
    "@demo/natalia-ui-panel",
    "--template",
    "ui-panel",
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(text(result.stdout))).toMatchObject({
    created: true,
    template: "ui-panel",
  });
  const manifest = JSON.parse(
    await readFile(join(directory, "natalia.plugin.json"), "utf8"),
  );
  expect(manifest).toMatchObject({
    id: "demo.panel",
    integrationPoints: [],
    scope: "process",
    ui: {
      entry: "src/ui/plugin.js",
      panels: [
        {
          id: "demo-panel",
          title: "Demo Panel",
          region: "side",
        },
      ],
    },
  });
  expect(
    JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
      .dependencies["@natalia/ui-host"],
  ).toBeDefined();
  expect(await readFile(join(directory, "src/ui/plugin.js"), "utf8")).toContain(
    "defineUiPlugin",
  );
});

test("plugin create writes TypeScript source with a JavaScript install entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-create-ts-"));
  const directory = join(root, "demo-ts");
  const result = runCli(
    root,
    "plugin",
    "create",
    directory,
    "--id",
    "demo.ts",
    "--template",
    "tool",
    "--language",
    "ts",
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(text(result.stdout))).toMatchObject({
    created: true,
    template: "tool",
    language: "ts",
    entry: "src/index.js",
  });
  const packageJSON = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  expect(packageJSON.exports).toEqual({ ".": "./src/index.js" });
  expect(packageJSON.files).toEqual([
    "src/index.js",
    "src/index.ts",
    "natalia.plugin.json",
  ]);
  expect(
    JSON.parse(await readFile(join(directory, "natalia.plugin.json"), "utf8"))
      .entry,
  ).toBe("src/index.js");
  expect(await readFile(join(directory, "src", "index.ts"), "utf8")).toContain(
    "input: { text: string }",
  );
  expect(await readFile(join(directory, "src", "index.js"), "utf8")).toContain(
    "api.tools.register",
  );
});

function runCli(root: string, ...argv: string[]) {
  return Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "..", "src", "main.ts"), ...argv],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
}

function text(value: Uint8Array) {
  return new TextDecoder().decode(value);
}

import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWezTermHost,
  reclaimStaleMuxRuntimeDirs,
  writeWezTermNativeDomainConfig,
  NativeTerminalRegistry,
  resolveNataliaWezTermForkExecutable,
  resolveWezTermExecutable,
} from "../src/index";

/**
 * The input-arbitration tests drive the same in-memory registry paths as on
 * POSIX, but on Windows with bun 1.3.14 they wedge the test runner itself:
 * no output, no per-test timeout, no exit. This is a runner-level defect, not
 * an assertion failure, so they stay fully active on POSIX and are skipped
 * only on Windows until the runner bug is resolved upstream.
 */
const arbitrationTest = process.platform === "win32" ? test.skip : test;

/** A short-lived process whose pid is already stale, for ESRCH-shaped tests. */
function spawnAlreadyExitedProcess() {
  return Bun.spawn(
    process.platform === "win32" ? ["cmd", "/c", "exit", "0"] : ["true"],
    { stdout: "ignore", stderr: "ignore" },
  );
}

test("does not fall back to an arbitrary system WezTerm executable", () => {
  expect(
    resolveWezTermExecutable({
      os: "linux",
      forkBuildDir: "/does-not-exist",
      which: () => "/usr/bin/wezterm",
    }),
  ).toBeUndefined();
  expect(
    resolveWezTermExecutable({
      os: "win32",
      forkBuildDir: "/does-not-exist",
      which: () => "C:\\WezTerm\\wezterm.exe",
    }),
  ).toBeUndefined();
});

test("uses an explicit host executable without falling back to system WezTerm", () => {
  expect(
    resolveWezTermExecutable({
      configured: "/opt/natalia/wezterm",
      which: () => "/usr/bin/wezterm",
    }),
  ).toBe("/opt/natalia/wezterm");
});

test("requires the managed patched fork when no explicit override is set", () => {
  expect(
    resolveNataliaWezTermForkExecutable({
      os: "linux",
      buildDir: "/does-not-exist",
    }),
  ).toBeUndefined();
  expect(
    resolveWezTermExecutable({
      os: "linux",
      forkBuildDir: "/opt/natalia/wezterm/target/release",
      which: () => "/usr/bin/wezterm",
    }),
  ).toBeUndefined();
});

test("maps native pane lifecycle to WezTerm CLI", async () => {
  const calls: string[][] = [];
  const launches: Array<{
    args: string[];
    environment?: Record<string, string | undefined>;
  }> = [];
  const inputs: Array<string | undefined> = [];
  let opened = false;
  const host = createWezTermHost({
    executable: "wezterm",
    configFile: "/tmp/natalia.lua",
    run: async (_executable, args, stdin) => {
      calls.push(args);
      inputs.push(stdin);
      if (args.includes("move-pane-to-new-tab")) opened = true;
      if (args.includes("spawn"))
        return { stdout: "42\n", stderr: "", exitCode: 0 };
      if (args.includes("list"))
        return {
          stdout: JSON.stringify([
            {
              pane_id: 42,
              window_id: opened ? 8 : 7,
              tab_id: opened ? 10 : 9,
              title: "Interactive agent",
              size: { rows: 24, cols: 80 },
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      return {
        stdout: args.includes("get-text") ? "agent screen\n" : "",
        stderr: "",
        exitCode: 0,
      };
    },
    launch: async (_executable, args, environment) => {
      launches.push({ args, environment });
    },
  });
  await expect(
    host.spawn({
      cwd: "/repo",
      command: ["interactive-agent"],
      workspace: "natalia",
    }),
  ).resolves.toMatchObject({ pane_id: 42, window_id: 7 });
  await expect(host.read(42)).resolves.toBe("agent screen\n");
  await host.write(42, "hello\r");
  await host.focus(42);
  await host.resize(42, 26, 84);
  await host.stop(42);
  expect(launches).toEqual([]);
  expect(calls).toEqual(
    expect.arrayContaining([
      [
        "--config-file",
        "/tmp/natalia.lua",
        "cli",
        "--no-auto-start",
        "--prefer-mux",
        "spawn",
        "--cwd",
        "/repo",
        "--new-window",
        "--workspace",
        "natalia",
        "--",
        "interactive-agent",
      ],
      [
        "--config-file",
        "/tmp/natalia.lua",
        "cli",
        "--no-auto-start",
        "--prefer-mux",
        "list",
        "--format",
        "json",
      ],
      [
        "--config-file",
        "/tmp/natalia.lua",
        "cli",
        "--no-auto-start",
        "--prefer-mux",
        "get-text",
        "--pane-id",
        "42",
        "--start-line",
        "-200",
      ],
      [
        "--config-file",
        "/tmp/natalia.lua",
        "cli",
        "--no-auto-start",
        "--prefer-mux",
        "send-text",
        "--pane-id",
        "42",
        "--no-paste",
      ],
      [
        "--config-file",
        "/tmp/natalia.lua",
        "cli",
        "--no-auto-start",
        "--prefer-mux",
        "activate-pane",
        "--pane-id",
        "42",
      ],
      [
        "--config-file",
        "/tmp/natalia.lua",
        "cli",
        "--no-auto-start",
        "--prefer-mux",
        "list",
        "--format",
        "json",
      ],
      [
        "--config-file",
        "/tmp/natalia.lua",
        "cli",
        "--no-auto-start",
        "--prefer-mux",
        "adjust-pane-size",
        "--pane-id",
        "42",
        "--amount",
        "2",
        "Down",
      ],
      [
        "--config-file",
        "/tmp/natalia.lua",
        "cli",
        "--no-auto-start",
        "--prefer-mux",
        "adjust-pane-size",
        "--pane-id",
        "42",
        "--amount",
        "4",
        "Right",
      ],
      [
        "--config-file",
        "/tmp/natalia.lua",
        "cli",
        "--no-auto-start",
        "--prefer-mux",
        "kill-pane",
        "--pane-id",
        "42",
      ],
    ]),
  );
  expect(inputs).toContain("hello\r");
});

test("reuses a ready private mux socket for CLI and GUI attach", async () => {
  const calls: Array<{
    executable: string;
    args: string[];
    environment?: Record<string, string | undefined>;
  }> = [];
  const launches: Array<Record<string, string | undefined> | undefined> = [];
  const environment = {
    WEZTERM_UNIX_SOCKET: "/run/user/1000/natalia/mux.sock",
  };
  let guiAttached = false;
  const host = createWezTermHost({
    executable: "/opt/natalia/wezterm",
    environment,
    muxRuntimeDir: "/run/user/1000/natalia/mux-runtime",
    run: async (executable, args, _stdin, commandEnvironment) => {
      calls.push({ executable, args, environment: commandEnvironment });
      if (args.includes("spawn"))
        return { stdout: "42\n", stderr: "", exitCode: 0 };
      if (args.includes("list-clients"))
        return {
          stdout: guiAttached
            ? JSON.stringify([{ focused_pane_id: 42 }])
            : "[]",
          stderr: "",
          exitCode: 0,
        };
      if (args.includes("ls-fonts"))
        return {
          stdout: '你 wezterm.font("Noto Sans Mono CJK SC")',
          stderr: "",
          exitCode: 0,
        };
      if (args.includes("list"))
        return {
          stdout: JSON.stringify([
            {
              pane_id: 42,
              window_id: 8,
              tab_id: 9,
              is_active: true,
              size: { rows: 24, cols: 80 },
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    launch: async (_executable, _args, launchEnvironment) => {
      launches.push(launchEnvironment);
      guiAttached = true;
    },
  });
  await host.spawn({ cwd: "/repo", command: ["bash"] });
  await host.open!(42, { environment: { NATALIA_TERMINAL_ID: "terminal_1" } });
  expect(calls).not.toContainEqual(
    expect.objectContaining({ executable: "/opt/natalia/wezterm-mux-server" }),
  );
  expect(launches).toEqual([
    {
      ...environment,
      XDG_RUNTIME_DIR: "/run/user/1000/natalia/mux-runtime",
      NATALIA_TERMINAL_ID: "terminal_1",
    },
  ]);
});

test("spawns later Terminal sessions directly in the existing Hub window", async () => {
  const calls: string[][] = [];
  const host = createWezTermHost({
    executable: "wezterm",
    run: async (_executable, args) => {
      calls.push(args);
      if (args.includes("spawn"))
        return { stdout: "88\n", stderr: "", exitCode: 0 };
      if (args.includes("list"))
        return {
          stdout: JSON.stringify([
            {
              pane_id: 88,
              window_id: 501,
              tab_id: 77,
              is_active: true,
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  await host.spawn({
    cwd: "/repo",
    command: ["btop"],
    workspace: "natalia",
    muxWindowID: 501,
  });
  expect(calls).toContainEqual([
    "cli",
    "--no-auto-start",
    "--prefer-mux",
    "spawn",
    "--cwd",
    "/repo",
    "--window-id",
    "501",
    "--",
    "btop",
  ]);
  expect(calls.flat()).not.toContain("--new-window");
  expect(calls.flat()).not.toContain("move-pane-to-new-tab");
});

test("opens the Terminal Hub through one connect client", async () => {
  const launches: string[][] = [];
  const host = createWezTermHost({
    executable: "wezterm",
    nativeDomain: {
      name: "natalia",
      socketPath: "/run/user/1000/natalia/wezterm/sock",
      configFile: "/tmp/natalia.lua",
    },
    run: async (_executable, args) => {
      if (args.includes("list-clients"))
        return { stdout: "[]", stderr: "", exitCode: 0 };
      if (args.includes("ls-fonts"))
        return {
          stdout: '你 wezterm.font("Noto Sans Mono CJK SC")',
          stderr: "",
          exitCode: 0,
        };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    launch: async (_executable, args) => {
      launches.push(args);
    },
  });
  await host.openHub!();
  expect(launches).toEqual([
    [
      "--config-file",
      "/tmp/natalia.lua",
      "connect",
      "natalia",
      "--workspace",
      "natalia",
    ],
  ]);
});

test("refuses to open the Hub while CJK glyph fallback resolves to Last Resort", async () => {
  const host = createWezTermHost({
    executable: "wezterm",
    run: async (_executable, args) => {
      if (args.includes("list-clients"))
        return { stdout: "[]", stderr: "", exitCode: 0 };
      if (args.includes("ls-fonts"))
        return {
          stdout: '你 wezterm.font("Last Resort")',
          stderr: "",
          exitCode: 0,
        };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    launch: async () => {
      throw new Error("must not launch with tofu fallback");
    },
  });
  await expect(host.openHub!()).rejects.toThrow(
    "CJK glyph fallback is unavailable",
  );
});

test("first Hub attach removes only the private mux bootstrap pane", async () => {
  const calls: string[][] = [];
  const host = createWezTermHost({
    executable: "wezterm",
    run: async (_executable, args) => {
      calls.push(args);
      if (args.includes("list-clients"))
        return {
          stdout: JSON.stringify([{ focused_pane_id: 2 }]),
          stderr: "",
          exitCode: 0,
        };
      if (args.includes("list"))
        return {
          stdout: JSON.stringify([
            { pane_id: 1, window_id: 1, tab_id: 1, is_active: true },
            { pane_id: 2, window_id: 2, tab_id: 2, is_active: true },
          ]),
          stderr: "",
          exitCode: 0,
        };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    launch: async () => {},
  });
  await host.open!(2, { discardBootstrapPanes: true, launch: false });
  expect(calls).toContainEqual([
    "cli",
    "--no-auto-start",
    "--prefer-mux",
    "kill-pane",
    "--pane-id",
    "1",
  ]);
  expect(calls).not.toContainEqual(
    expect.arrayContaining(["kill-pane", "--pane-id", "2"]),
  );
});

test("does not launch a second GUI client for an existing Terminal Hub", async () => {
  const launches: string[][] = [];
  const host = createWezTermHost({
    executable: "wezterm",
    run: async (_executable, args) => {
      if (args.includes("list-clients"))
        return {
          stdout: JSON.stringify([{ focused_pane_id: 42 }]),
          stderr: "",
          exitCode: 0,
        };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    launch: async (_executable, args) => {
      launches.push(args);
    },
  });
  await host.openHub!();
  expect(launches).toEqual([]);
});

test("writes a named Unix domain config for the fork GUI client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "natalia-wezterm-domain-"));
  const domain = await writeWezTermNativeDomainConfig({
    directory,
    socketPath: "/run/user/1000/natalia/wezterm/sock",
  });
  expect(domain.name).toBe("natalia");
  const config = await readFile(domain.configFile, "utf8");
  expect(config).toContain(
    "socket_path = [[/run/user/1000/natalia/wezterm/sock]]",
  );
  expect(config).toContain("wezterm.font_with_fallback");
  if (process.platform === "win32") expect(config).toContain("Microsoft YaHei");
  else expect(config).toContain("Noto Sans Mono CJK SC");
});

test("fails a stalled WezTerm control command within its timeout", async () => {
  const host = createWezTermHost({
    executable: "wezterm",
    timeoutMs: 1,
    run: async () => await new Promise(() => {}),
    launch: async () => {},
  });
  await expect(host.focus(42)).rejects.toThrow(
    "WezTerm command timed out after 1ms: cli activate-pane --pane-id 42",
  );
});

test("passes an explicit scrollback line range to WezTerm", async () => {
  const calls: string[][] = [];
  const host = createWezTermHost({
    executable: "wezterm",
    run: async (_executable, args) => {
      calls.push(args);
      return { stdout: "selected lines", stderr: "", exitCode: 0 };
    },
    launch: async () => {},
  });
  await expect(
    host.read(7, { startLine: 120, endLine: 180, maxLines: 60 }),
  ).resolves.toBe("selected lines");
  expect(calls.at(-1)).toEqual([
    "cli",
    "--no-auto-start",
    "--prefer-mux",
    "get-text",
    "--pane-id",
    "7",
    "--start-line",
    "120",
    "--end-line",
    "180",
  ]);
});

test("native registry keeps model I/O on the host-rendered pane", async () => {
  const writes: Array<{ paneID: number; data: string }> = [];
  const audit: string[] = [];
  const host = {
    kind: "wezterm" as const,
    executable: "wezterm",
    async spawn() {
      return { pane_id: 19, window_id: 2, tab_id: 3, rows: 24, cols: 80 };
    },
    async list() {
      return [{ pane_id: 19, window_id: 2, tab_id: 3, rows: 24, cols: 80 }];
    },
    async read(paneID: number) {
      return `pane ${paneID} output`;
    },
    async write(paneID: number, data: string) {
      writes.push({ paneID, data });
    },
    async focus() {},
    async resize() {},
    async stop() {},
  };
  const registry = new NativeTerminalRegistry(host, {
    onAudit: (event) => audit.push(event.action),
  });
  const session = await registry.start({
    id: "native_1",
    cwd: "/repo",
    command: "interactive-agent",
  });
  await registry.write(session.id, "hello\r");
  await expect(
    registry.write(session.id, "deduplicated", { idempotencyKey: "write_1" }),
  ).resolves.toMatchObject({ delivery: "accepted" });
  await expect(
    registry.write(session.id, "deduplicated", { idempotencyKey: "write_1" }),
  ).resolves.toMatchObject({ delivery: "duplicate" });
  await expect(
    registry.write(session.id, "different input", {
      idempotencyKey: "write_1",
    }),
  ).rejects.toThrow("reused with different input");
  await registry.write(session.id, "model keeps control after open");
  await registry.claimHumanInput(session.id);
  await expect(registry.write(session.id, "blocked")).rejects.toThrow(
    "controlled by a human",
  );
  registry.releaseHumanControl(session.id);
  await registry.claimHumanInput(session.id);
  registry.beginSecureInput(session.id);
  await expect(registry.read(session.id)).rejects.toThrow(
    "hidden during secure",
  );
  await expect(registry.write(session.id, "blocked")).rejects.toThrow(
    "controlled by a human",
  );
  expect(() => registry.releaseHumanControl(session.id)).toThrow(
    "secure input",
  );
  registry.endSecureInput(session.id);
  registry.releaseHumanControl(session.id);
  await registry.write(session.id, "model again");
  await expect(registry.read(session.id)).resolves.toMatchObject({
    text: "pane 19 output",
    cursorX: 0,
    cursorY: 0,
    rows: 24,
    cols: 80,
  });
  await expect(registry.observe(session.id, 0)).resolves.toMatchObject({
    changed: true,
  });
  await expect(registry.stop(session.id)).resolves.toMatchObject({
    paneID: 19,
  });
  expect(writes.map((item) => item.data).join("")).toBe(
    "hello\rdeduplicatedmodel keeps control after openmodel again",
  );
  expect(registry.list()).toMatchObject([{ id: "native_1", status: "exited" }]);
  expect(audit).toContain("secure_input");
  expect(audit.filter((action) => action === "detach").length).toBe(2);
});

test("native registry observe returns typed exit info with cursor", async () => {
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 73, window_id: 3, tab_id: 5 };
    },
    async list() {
      return [
        {
          pane_id: 73,
          window_id: 3,
          tab_id: 5,
          rows: 24,
          cols: 80,
          cursor_x: 12,
          cursor_y: 8,
        },
      ];
    },
    async read() {
      return "exit output";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const session = await registry.start({ command: "cat", cwd: "/repo" });
  await registry.stop(session.id);
  const obs = await registry.observe(session.id, 0);
  expect(obs).toMatchObject({
    reason: "exited",
    exited: true,
    cursorX: 12,
    cursorY: 8,
    rows: 24,
    cols: 80,
    changed: true,
  });
  expect(obs.text).toBe("");
});

test("native registry dispose stops only its running panes and host", async () => {
  const stopped: number[] = [];
  let disposed = 0;
  let nextPane = 301;
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      const paneID = nextPane++;
      return { pane_id: paneID, window_id: 1, tab_id: paneID };
    },
    async list() {
      return [301, 302].map((paneID) => ({
        pane_id: paneID,
        window_id: 1,
        tab_id: paneID,
        rows: 24,
        cols: 80,
      }));
    },
    async read() {
      return "";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop(paneID) {
      stopped.push(paneID);
    },
    async dispose() {
      disposed += 1;
    },
  });
  await registry.start({ id: "terminal_a", cwd: "/repo", command: "cat" });
  await registry.start({ id: "terminal_b", cwd: "/repo", command: "cat" });
  await registry.dispose();
  expect(stopped.sort()).toEqual([301, 302]);
  expect(disposed).toBe(1);
  expect(registry.list()).toEqual([]);
});

test("native starts automatically place sessions in one Terminal Hub", async () => {
  let nextPaneID = 101;
  const openCalls: Array<{
    paneID: number;
    muxWindowID?: number;
    launch?: boolean;
  }> = [];
  const spawnCalls: Array<number | undefined> = [];
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn(input) {
      spawnCalls.push(input.muxWindowID);
      const paneID = nextPaneID++;
      return { pane_id: paneID, window_id: paneID, tab_id: paneID + 100 };
    },
    async list() {
      return [101, 102].map((paneID) => ({
        pane_id: paneID,
        window_id: paneID,
        tab_id: paneID + 100,
        rows: 24,
        cols: 80,
      }));
    },
    async read() {
      return "";
    },
    async write() {},
    async open(paneID, options) {
      openCalls.push({
        paneID,
        muxWindowID: options?.muxWindowID,
        launch: options?.launch,
      });
      return {
        pane_id: paneID,
        window_id: 501,
        tab_id: paneID + 1_000,
        rows: 24,
        cols: 80,
      };
    },
    async openHub() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });

  const first = await registry.start({
    id: "terminal_first",
    cwd: "/repo",
    command: "first",
  });
  const second = await registry.start({
    id: "terminal_second",
    cwd: "/repo",
    command: "second",
  });

  expect(openCalls).toEqual([
    { paneID: 101, launch: true, muxWindowID: undefined },
  ]);
  expect(spawnCalls).toEqual([undefined, 501]);
  expect(first).toMatchObject({ paneID: 101, tabID: 1101, muxWindowID: 501 });
  expect(second).toMatchObject({ paneID: 102, tabID: 202, muxWindowID: 501 });
  expect(await registry.openHub()).toEqual({
    workspace: "natalia",
    muxWindowID: 501,
  });
});

test("native observe returns its own bounded timeout instead of tool timeout", async () => {
  let reads = 0;
  let lists = 0;
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 81, window_id: 2, tab_id: 3 };
    },
    async list() {
      lists += 1;
      return [{ pane_id: 81, window_id: 2, tab_id: 3, rows: 24, cols: 80 }];
    },
    async read() {
      reads += 1;
      return "unchanged";
    },
    async write() {},
    async open() {
      return { pane_id: 37, window_id: 2, tab_id: 3, rows: 24, cols: 80 };
    },
    async openHub() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const session = await registry.start({ cwd: "/repo", command: "cat" });
  await registry.read(session.id, { maxLines: 60 });
  const revision = registry
    .list()
    .find((item) => item.id === session.id)!.revision;
  const startedAt = performance.now();
  await expect(
    registry.observe(session.id, revision, { maxLines: 60, timeoutMs: 25 }),
  ).resolves.toMatchObject({ changed: false, reason: "timeout" });
  // Load-tolerant, but still an order of magnitude below the tool-level
  // timeout (seconds): the point is that observe honors its OWN 25ms
  // bound, not that a CI box never hiccups.
  expect(performance.now() - startedAt).toBeLessThan(600);
  expect(reads).toBeLessThanOrEqual(12);
  // One initial read plus one reconcile per bounded observe poll. Each read
  // now fetches text, selection and highlights in parallel, so the read count
  // roughly triples compared to the baseline. There must not be a second list
  // caused by observe calling the public read method.
  expect(lists).toBeLessThanOrEqual(reads + 2);
});

test("native observe wakes immediately for registry session activity", async () => {
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 82, window_id: 2, tab_id: 3 };
    },
    async list() {
      return [{ pane_id: 82, window_id: 2, tab_id: 3, rows: 24, cols: 80 }];
    },
    async read() {
      return "unchanged";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const session = await registry.start({ cwd: "/repo", command: "cat" });
  await registry.read(session.id);
  const revision = registry.list()[0]!.revision;
  const startedAt = performance.now();
  const observation = registry.observe(session.id, revision, {
    timeoutMs: 1_000,
  });
  await Bun.sleep(20);
  await registry.write(session.id, "wake");
  await expect(observation).resolves.toMatchObject({
    changed: true,
    reason: "session_activity",
  });
  expect(performance.now() - startedAt).toBeLessThan(450);
});

arbitrationTest(
  "human input cancels unsent visible model input chunks",
  async () => {
    const writes: string[] = [];
    const registry = new NativeTerminalRegistry({
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        return { pane_id: 41, window_id: 2, tab_id: 3 };
      },
      async list() {
        return [{ pane_id: 41, window_id: 2, tab_id: 3, rows: 24, cols: 80 }];
      },
      async read() {
        return "";
      },
      async write(_paneID, data) {
        writes.push(data);
        if (writes.length === 1) await Bun.sleep(20);
      },
      async focus() {},
      async resize() {},
      async stop() {},
    });
    const session = await registry.start({ cwd: "/repo", command: "cat" });
    const modelWrite = registry.write(session.id, "1".repeat(2048));
    await Bun.sleep(5);
    await registry.claimHumanInput(session.id);
    await expect(modelWrite).resolves.toMatchObject({ delivery: "cancelled" });
    expect(writes).toEqual(["1".repeat(1024)]);
    expect(registry.list()).toMatchObject([{ inputOwner: "human" }]);
  },
);

arbitrationTest(
  "a cancelled idempotent model write may be retried after control returns",
  async () => {
    const writes: string[] = [];
    const registry = new NativeTerminalRegistry({
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        return { pane_id: 43, window_id: 2, tab_id: 3 };
      },
      async list() {
        return [{ pane_id: 43, window_id: 2, tab_id: 3, rows: 24, cols: 80 }];
      },
      async read() {
        return "";
      },
      async write(_paneID, data) {
        writes.push(data);
        if (writes.length === 1) await Bun.sleep(20);
      },
      async focus() {},
      async resize() {},
      async stop() {},
    });
    const session = await registry.start({ cwd: "/repo", command: "cat" });
    const payload = "1".repeat(2048);
    const first = registry.write(session.id, payload, {
      idempotencyKey: "retry-after-human",
    });
    await Bun.sleep(5);
    await registry.claimHumanInput(session.id);
    await expect(first).resolves.toMatchObject({ delivery: "cancelled" });
    registry.releaseHumanControl(session.id);
    await expect(
      registry.write(session.id, payload, {
        idempotencyKey: "retry-after-human",
      }),
    ).resolves.toMatchObject({ delivery: "accepted" });
    expect(writes).toEqual([
      "1".repeat(1024),
      "1".repeat(1024),
      "1".repeat(1024),
    ]);
  },
);

test("reconcile marks a closed native pane exited without polling", async () => {
  let visible = true;
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 31, window_id: 2, tab_id: 3, rows: 24, cols: 80 };
    },
    async list() {
      return visible
        ? [{ pane_id: 31, window_id: 2, tab_id: 3, rows: 24, cols: 80 }]
        : [];
    },
    async read() {
      return "";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const session = await registry.start({ cwd: "/repo", command: "cat" });
  visible = false;
  await registry.reconcile({ force: true });
  expect(registry.list()).toMatchObject([
    { id: session.id, status: "exited", geometryOwner: "human" },
  ]);
  await expect(registry.write(session.id, "late")).rejects.toThrow("exited");
  await expect(registry.attach(session.id)).rejects.toThrow("exited");
  await expect(registry.resize(session.id, 30, 100)).rejects.toThrow("exited");
});

test("native registry attaches, detaches, and resizes the same pane", async () => {
  const resized: Array<[number, number, number]> = [];
  const audit: Array<{ action: string; actor: string }> = [];
  const registry = new NativeTerminalRegistry(
    {
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        return { pane_id: 37, window_id: 2, tab_id: 3, rows: 24, cols: 80 };
      },
      async list() {
        return [{ pane_id: 37, window_id: 2, tab_id: 3, rows: 24, cols: 80 }];
      },
      async read() {
        return "";
      },
      async write() {},
      async focus() {},
      async resize(paneID, rows, cols) {
        resized.push([paneID, rows, cols]);
      },
      async stop() {},
    },
    {
      onAudit: (event) => audit.push(event),
    },
  );
  const session = await registry.start({ cwd: "/repo", command: "cat" });
  await registry.write(session.id, "model input");
  await registry.attach(session.id);
  expect(registry.list()).toMatchObject([{ inputOwner: "model" }]);
  await registry.claimHumanInput(session.id);
  expect(registry.list()).toMatchObject([{ inputOwner: "human" }]);
  expect(registry.detach(session.id)).toMatchObject({ inputOwner: "model" });
  // A resize is attributed to whoever asked for it. This used to be recorded as
  // `human` unconditionally while the only caller was the model's resize tool, so
  // the audit answered "who did this" wrongly — worse than not answering.
  await expect(registry.resize(session.id, 30, 100)).resolves.toMatchObject({
    rows: 30,
    cols: 100,
  });
  expect(resized).toEqual([[37, 30, 100]]);
  await expect(
    registry.resize(session.id, 31, 101, "human"),
  ).resolves.toMatchObject({ rows: 31, cols: 101 });
  await registry.stop(session.id, "human");
  expect(audit.map(({ action, actor }) => ({ action, actor }))).toEqual([
    { action: "write", actor: "model" },
    { action: "attach", actor: "human" },
    { action: "write", actor: "human" },
    { action: "detach", actor: "human" },
    { action: "resize", actor: "model" },
    { action: "resize", actor: "human" },
    { action: "exit", actor: "human" },
  ]);
});

test("native snapshot text matches read text and includes cursor", async () => {
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 37, window_id: 2, tab_id: 3, rows: 24, cols: 80 };
    },
    async list() {
      return [
        {
          pane_id: 37,
          window_id: 2,
          tab_id: 3,
          rows: 24,
          cols: 80,
          cursor_x: 5,
          cursor_y: 3,
        },
      ];
    },
    async read() {
      return "snapshot consistency check\n";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const session = await registry.start({ command: "cat", cwd: "/repo" });
  const read = await registry.read(session.id);
  const snapshot = await registry.snapshot(session.id);
  expect(snapshot.text).toBe(read.text);
  expect(snapshot.cursorX).toBe(5);
  expect(snapshot.cursorY).toBe(3);
  expect(snapshot.rows).toBe(24);
  expect(snapshot.cols).toBe(80);
  expect(snapshot.revision).toBe(session.revision);
  await registry.stop(session.id);
});

test("native snapshot includes highlightRanges when selection is active", async () => {
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 37, window_id: 2, tab_id: 3, rows: 24, cols: 80 };
    },
    async list() {
      return [
        {
          pane_id: 37,
          window_id: 2,
          tab_id: 3,
          rows: 24,
          cols: 80,
          cursor_x: 5,
          cursor_y: 3,
        },
      ];
    },
    async read(_paneID: number, options?: Record<string, unknown>) {
      if (options?.format === "selection") {
        return JSON.stringify({
          selection: {
            mode: "char",
            ranges: [
              { startRow: 2, startCol: 4, endRow: 2, endCol: 10 },
              { startRow: 3, startCol: 0, endRow: 3, endCol: 20 },
            ],
          },
        });
      }
      if (options?.format === "highlights") {
        return JSON.stringify({
          highlights: {
            mode: "highlights",
            ranges: [
              { startRow: 2, startCol: 4, endRow: 2, endCol: 10 },
              { startRow: 3, startCol: 0, endRow: 3, endCol: 20 },
            ],
          },
        });
      }
      return "selected text\n";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const session = await registry.start({ command: "cat", cwd: "/repo" });
  const snapshot = await registry.snapshot(session.id);
  expect(snapshot.text).toBe("selected text\n");
  expect(snapshot.highlightRanges).toEqual([
    { startRow: 2, startCol: 4, endRow: 2, endCol: 10 },
    { startRow: 3, startCol: 0, endRow: 3, endCol: 20 },
    { startRow: 2, startCol: 4, endRow: 2, endCol: 10 },
    { startRow: 3, startCol: 0, endRow: 3, endCol: 20 },
  ]);
  await registry.stop(session.id);
});

test("native snapshot returns empty highlightRanges when selection is null", async () => {
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 41, window_id: 2, tab_id: 3, rows: 24, cols: 80 };
    },
    async list() {
      return [{ pane_id: 41, window_id: 2, tab_id: 3, rows: 24, cols: 80 }];
    },
    async read(_paneID: number, options?: Record<string, unknown>) {
      if (options?.format === "selection") {
        return JSON.stringify({ selection: null });
      }
      return "no selection\n";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const session = await registry.start({ command: "cat", cwd: "/repo" });
  const snapshot = await registry.snapshot(session.id);
  expect(snapshot.highlightRanges).toEqual([]);
  await registry.stop(session.id);
});

test("native observe returns highlightRanges", async () => {
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 42, window_id: 2, tab_id: 3, rows: 24, cols: 80 };
    },
    async list() {
      return [{ pane_id: 42, window_id: 2, tab_id: 3, rows: 24, cols: 80 }];
    },
    async read(_paneID: number, options?: Record<string, unknown>) {
      if (options?.format === "selection") {
        return JSON.stringify({
          selection: {
            mode: "line",
            ranges: [{ startRow: 5, startCol: 0, endRow: 5, endCol: 79 }],
          },
        });
      }
      if (options?.format === "highlights") {
        return JSON.stringify({
          highlights: {
            mode: "highlights",
            ranges: [{ startRow: 5, startCol: 0, endRow: 5, endCol: 79 }],
          },
        });
      }
      return "observed\n";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const session = await registry.start({ command: "cat", cwd: "/repo" });
  const obs = await registry.observe(session.id, 0);
  expect(obs.highlightRanges).toEqual([
    { startRow: 5, startCol: 0, endRow: 5, endCol: 79 },
    { startRow: 5, startCol: 0, endRow: 5, endCol: 79 },
  ]);
  await registry.stop(session.id);
});

test("native model can continue to observe and write after human detach", async () => {
  const writes: string[] = [];
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 37, window_id: 2, tab_id: 3, rows: 24, cols: 80 };
    },
    async list() {
      return [{ pane_id: 37, window_id: 2, tab_id: 3, rows: 24, cols: 80 }];
    },
    async read() {
      return writes.join("");
    },
    async write(_paneID, data) {
      writes.push(data);
    },
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const session = await registry.start({ command: "cat", cwd: "/repo" });
  await registry.write(session.id, "model before human\r");
  await registry.claimHumanInput(session.id);
  const beforeDetach = await registry.observe(session.id, 0);
  expect(beforeDetach.changed).toBe(true);
  registry.detach(session.id);
  await registry.write(session.id, "model after detach\r");
  expect(writes).toEqual(["model before human\r", "model after detach\r"]);
  const afterDetach = await registry.observe(
    session.id,
    beforeDetach.afterRevision,
  );
  expect(afterDetach.changed).toBe(true);
  expect(afterDetach.text).toContain("model before human");
  expect(afterDetach.text).toContain("model after detach");
  await registry.stop(session.id);
});

test("reconcile updates attached from list-clients", async () => {
  const listClientsCalls: Array<{ focused_pane_id: number }[]> = [];
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 41, window_id: 2, tab_id: 3, rows: 24, cols: 80 };
    },
    async list() {
      return [{ pane_id: 41, window_id: 2, tab_id: 3, rows: 24, cols: 80 }];
    },
    async listClients() {
      const value = listClientsCalls.at(-1) ?? [{ focused_pane_id: 41 }];
      listClientsCalls.push(value);
      return value;
    },
    async read() {
      return "";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
    async open() {
      return {
        pane_id: 41,
        window_id: 501,
        tab_id: 1041,
        rows: 24,
        cols: 80,
      };
    },
  });
  const session = await registry.start({ command: "cat", cwd: "/repo" });
  expect(registry.session(session.id).attached).toBe(true);

  listClientsCalls.push([]);
  await registry.reconcile({ force: true });
  expect(registry.session(session.id).attached).toBe(false);
});

test("cleanupStalePanes removes panes not belonging to current sessions", async () => {
  const stops: number[] = [];
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 51, window_id: 2, tab_id: 3, rows: 24, cols: 80 };
    },
    async list() {
      return [
        { pane_id: 51, window_id: 2, tab_id: 3, rows: 24, cols: 80 },
        { pane_id: 999, window_id: 2, tab_id: 4, rows: 24, cols: 80 },
      ];
    },
    async listClients() {
      return [];
    },
    async read() {
      return "";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop(paneID) {
      stops.push(paneID);
    },
    async open() {
      return {
        pane_id: 51,
        window_id: 501,
        tab_id: 1051,
        rows: 24,
        cols: 80,
      };
    },
  });
  const session = await registry.start({ command: "cat", cwd: "/repo" });
  expect(stops).toContain(999);
  expect(stops).not.toContain(51);
});

test("cross-runtime provenance recovery restores persisted session metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-terminal-provenance-"));
  const persistPath = join(root, "native-terminal-sessions.json");
  const listCalls: Array<
    {
      pane_id: number;
      window_id: number;
      tab_id: number;
      rows: number;
      cols: number;
    }[]
  > = [];
  const firstRegistry = new NativeTerminalRegistry(
    {
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        return { pane_id: 61, window_id: 2, tab_id: 3, rows: 24, cols: 80 };
      },
      async list() {
        const value = listCalls.at(-1) ?? [
          { pane_id: 61, window_id: 2, tab_id: 3, rows: 24, cols: 80 },
        ];
        listCalls.push(value);
        return value;
      },
      async listClients() {
        return [{ focused_pane_id: 61 }];
      },
      async read() {
        return "";
      },
      async write() {},
      async focus() {},
      async resize() {},
      async stop() {},
      async open() {
        return {
          pane_id: 61,
          window_id: 501,
          tab_id: 1061,
          rows: 24,
          cols: 80,
        };
      },
    },
    { persistPath },
  );
  const firstSession = await firstRegistry.start({
    id: "tty_provenance",
    command: "bash",
    cwd: "/repo",
  });
  await firstRegistry.stop(firstSession.id);
  await firstRegistry.dispose();

  const secondRegistry = new NativeTerminalRegistry(
    {
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        return { pane_id: 61, window_id: 2, tab_id: 3, rows: 24, cols: 80 };
      },
      async list() {
        const value = listCalls.at(-1) ?? [
          { pane_id: 61, window_id: 2, tab_id: 3, rows: 24, cols: 80 },
        ];
        listCalls.push(value);
        return value;
      },
      async listClients() {
        return [];
      },
      async read() {
        return "";
      },
      async write() {},
      async focus() {},
      async resize() {},
      async stop() {},
      async open() {
        return {
          pane_id: 61,
          window_id: 501,
          tab_id: 1061,
          rows: 24,
          cols: 80,
        };
      },
    },
    { persistPath },
  );
  const recovered = secondRegistry.session("tty_provenance");
  expect(recovered).toMatchObject({
    id: "tty_provenance",
    paneID: 61,
    windowID: 501,
    muxWindowID: 501,
    tabID: 1061,
    status: "exited",
    attached: false,
    command: "bash",
    cwd: "/repo",
    rows: 24,
    cols: 80,
    inputOwner: "model",
    secureInput: false,
  });
  expect(secondRegistry.list()).toHaveLength(1);
  await secondRegistry.dispose();
});

test("mux server unavailability marks running sessions as exited", async () => {
  let listCalls = 0;
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      const pane = (await this.list()).find((p) => p.pane_id === 201);
      return pane!;
    },
    async list() {
      listCalls += 1;
      if (listCalls <= 2) {
        return [
          {
            pane_id: 201,
            window_id: 1,
            tab_id: 201,
            rows: 24,
            cols: 80,
            cursor_x: 0,
            cursor_y: 0,
          },
        ];
      }
      throw new Error("WezTerm mux connection refused");
    },
    async isAlive() {
      return false;
    },
    async read() {
      return "text";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
    async listClients() {
      return [{ focused_pane_id: 201 }];
    },
  });
  const session = await registry.start({
    id: "mux-down",
    command: "cat",
    cwd: "/repo",
  });
  expect(session.status).toBe("running");

  const read = await registry.read(session.id);
  expect(read.text).toBe("text");

  await registry.reconcile({ force: true });
  expect(registry.session("mux-down").status).toBe("exited");
  expect(registry.session("mux-down").attached).toBe(false);
  expect(registry.session("mux-down").revision).toBeGreaterThan(1);
  await expect(registry.read(session.id)).rejects.toThrow(
    "terminal session has exited",
  );
  await registry.stop(session.id);
});

test("mux server transient error does not falsely mark sessions exited", async () => {
  let listCalls = 0;
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      const pane = (await this.list()).find((p) => p.pane_id === 202);
      return pane!;
    },
    async list() {
      listCalls += 1;
      if (listCalls <= 1) {
        return [
          { pane_id: 202, window_id: 1, tab_id: 202, rows: 24, cols: 80 },
        ];
      }
      throw new Error("temporary JSON parse error");
    },
    async isAlive() {
      return true;
    },
    async read() {
      return "text";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const session = await registry.start({
    id: "mux-transient",
    command: "cat",
    cwd: "/repo",
  });
  await expect(registry.reconcile({ force: true })).rejects.toThrow(
    "temporary JSON parse error",
  );
  expect(registry.session("mux-transient").status).toBe("running");
  await registry.stop(session.id);
});

test("mux recovery allows new sessions after prior sessions were marked exited", async () => {
  let listCalls = 0;
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      const paneID = listCalls < 3 ? 301 : 302;
      const pane = (await this.list()).find((p) => p.pane_id === paneID);
      return pane!;
    },
    async list() {
      listCalls += 1;
      if (listCalls <= 2) {
        return [
          { pane_id: 301, window_id: 1, tab_id: 301, rows: 24, cols: 80 },
        ];
      }
      if (listCalls === 3) {
        throw new Error("mux down");
      }
      return [{ pane_id: 302, window_id: 1, tab_id: 302, rows: 24, cols: 80 }];
    },
    async isAlive() {
      return listCalls < 3;
    },
    async read() {
      return "text";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
    async listClients() {
      return [{ focused_pane_id: listCalls < 3 ? 301 : 302 }];
    },
  });
  const first = await registry.start({
    id: "mux-recovery",
    command: "cat",
    cwd: "/repo",
  });
  expect(first.status).toBe("running");

  await registry.reconcile({ force: true });
  expect(registry.session("mux-recovery").status).toBe("running");

  await registry.reconcile({ force: true });
  expect(registry.session("mux-recovery").status).toBe("exited");

  const second = await registry.start({
    id: "mux-recovery-2",
    command: "bash",
    cwd: "/repo",
  });
  expect(second.status).toBe("running");
  expect(second.paneID).toBe(302);
  const read = await registry.read(second.id);
  expect(read.text).toBe("text");
  await registry.stop(second.id);
});

test("observe returns exited when mux dies", async () => {
  // The session is created while the mux is up and the mux dies afterwards, so
  // liveness is an explicit flag rather than a count of list calls.
  let muxAlive = true;
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      const pane = (await this.list()).find((p) => p.pane_id === 401);
      return pane!;
    },
    async list() {
      if (!muxAlive) throw new Error("WezTerm mux connection refused");
      return [{ pane_id: 401, window_id: 1, tab_id: 401, rows: 24, cols: 80 }];
    },
    async isAlive() {
      return muxAlive;
    },
    async read() {
      return "text";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const session = await registry.start({
    id: "mux-observe",
    command: "cat",
    cwd: "/repo",
  });
  muxAlive = false;
  await registry.reconcile({ force: true });
  const obs = await registry.observe(session.id, 0);
  expect(obs.exited).toBe(true);
  expect(obs.highlightRanges).toEqual([]);
  await registry.stop(session.id);
});

test("dispose succeeds when the mux server is already gone", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "natalia-mux-dispose-"));
  await mkdir(join(runtimeDir, "wezterm"), { recursive: true });
  // A pid that is recorded but no longer running is exactly the state left
  // behind when the mux server crashes. Signalling it raises ESRCH, which used
  // to be rethrown and broke the whole shutdown path.
  const deadProcess = spawnAlreadyExitedProcess();
  await deadProcess.exited;
  await writeFile(join(runtimeDir, "wezterm", "pid"), `${deadProcess.pid}\n`);
  const host = createWezTermHost({
    executable: "/opt/natalia/wezterm",
    environment: { WEZTERM_UNIX_SOCKET: join(runtimeDir, "sock") },
    muxRuntimeDir: runtimeDir,
    run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  });

  await host.dispose?.();

  // The runtime directory is cleaned up as part of a successful dispose.
  expect(await Bun.file(join(runtimeDir, "wezterm", "pid")).exists()).toBe(
    false,
  );
});

test("dispose still reports failures it cannot interpret", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "natalia-mux-dispose-fail-"));
  await mkdir(join(runtimeDir, "wezterm"), { recursive: true });
  // pid 1 is rejected before any signal is sent, so a permission failure is
  // simulated by pointing at a pid the test cannot signal.
  await writeFile(join(runtimeDir, "wezterm", "pid"), "not-a-pid\n");
  const host = createWezTermHost({
    executable: "/opt/natalia/wezterm",
    environment: { WEZTERM_UNIX_SOCKET: join(runtimeDir, "sock") },
    muxRuntimeDir: runtimeDir,
    run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  });

  // An unparseable pid is skipped rather than signalled, so dispose completes.
  await host.dispose?.();
  expect(await Bun.file(join(runtimeDir, "wezterm", "pid")).exists()).toBe(
    false,
  );
});

test("mux liveness reports a failed connection as dead", async () => {
  let exitCode = 0;
  const host = createWezTermHost({
    executable: "/opt/natalia/wezterm",
    environment: { WEZTERM_UNIX_SOCKET: "/run/user/1000/natalia/mux.sock" },
    muxRuntimeDir: "/run/user/1000/natalia/mux-runtime",
    run: async () => ({
      stdout: "",
      stderr: 'failed to connect to Socket("/run/user/1000/natalia/mux.sock")',
      exitCode,
    }),
  });

  expect(await host.isAlive?.()).toBe(true);
  // The runner resolves with a non-zero code rather than throwing, so a probe
  // that ignored the code reported a dead server as alive and no recovery ever
  // ran.
  exitCode = 1;
  expect(await host.isAlive?.()).toBe(false);
});

test("spawn restarts a mux server that died after a successful start", async () => {
  let muxAlive = true;
  const daemonizeCalls: number[] = [];
  const host = createWezTermHost({
    os: "linux",
    executable: "/opt/natalia/wezterm",
    environment: { WEZTERM_UNIX_SOCKET: "/run/user/1000/natalia/mux.sock" },
    muxRuntimeDir: "/run/user/1000/natalia/mux-runtime",
    run: async (executable, args) => {
      if (executable.endsWith("wezterm-mux-server")) {
        daemonizeCalls.push(daemonizeCalls.length);
        muxAlive = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args.includes("spawn"))
        return { stdout: "7\n", stderr: "", exitCode: 0 };
      if (args.includes("list"))
        return {
          stdout: muxAlive
            ? JSON.stringify([
                {
                  pane_id: 7,
                  window_id: 1,
                  tab_id: 1,
                  is_active: true,
                  size: { rows: 24, cols: 80 },
                },
              ])
            : "",
          stderr: "",
          exitCode: muxAlive ? 0 : 1,
        };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });

  await host.spawn({ cwd: "/tmp", command: ["bash"], workspace: "natalia" });
  expect(daemonizeCalls.length).toBe(0); // the probe found a live server

  // The server dies while the readiness promise stays resolved. Spawning used
  // to keep talking to the dead socket forever.
  muxAlive = false;
  await host.spawn({ cwd: "/tmp", command: ["bash"], workspace: "natalia" });
  expect(daemonizeCalls.length).toBe(1);
  expect(await host.isAlive?.()).toBe(true);
});

test("starting a terminal after the mux died retires the stale sessions", async () => {
  let muxAlive = true;
  let nextPane = 1;
  const registry = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      // A restarted server numbers panes from scratch, so the new pane reuses
      // the id the retired session still refers to.
      const paneID = nextPane;
      nextPane = 1;
      return { pane_id: paneID, window_id: 1, tab_id: paneID };
    },
    async list() {
      if (!muxAlive) throw new Error("failed to connect to Socket(...)");
      return [{ pane_id: 1, window_id: 1, tab_id: 1, rows: 24, cols: 80 }];
    },
    async isAlive() {
      return muxAlive;
    },
    async read() {
      return "";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });

  const first = await registry.start({
    id: "terminal_before",
    cwd: "/repo",
    command: "cat",
  });
  expect(first.status).toBe("running");

  muxAlive = false;
  const second = await registry.start({
    id: "terminal_after",
    cwd: "/repo",
    command: "cat",
  });

  // The pre-crash session must not be left claiming a pane id the new session
  // now owns.
  const before = registry.list().find((item) => item.id === "terminal_before");
  expect(before?.status).toBe("exited");
  expect(second.status).toBe("running");
});

test("a reversed read range is normalized before it reaches the terminal", async () => {
  const ranges: string[][] = [];
  const host = createWezTermHost({
    executable: "/opt/natalia/wezterm",
    run: async (_executable, args) => {
      if (args.includes("get-text")) ranges.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });

  await host.read(3, { startLine: 57, endLine: 8 });
  await host.read(3, { startLine: 8, endLine: 57 });
  await host.read(3, { startLine: -8, endLine: -57 });

  const bounds = ranges.map((args) => [
    args[args.indexOf("--start-line") + 1],
    args[args.indexOf("--end-line") + 1],
  ]);
  // Whichever way round the caller wrote it, the terminal receives ascending
  // bounds describing the same span.
  expect(bounds).toEqual([
    ["8", "57"],
    ["8", "57"],
    ["-57", "-8"],
  ]);
});

test("stale mux runtime directories are reclaimed but live ones are kept", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-reclaim-"));
  const stale = join(root, "stale");
  const live = join(root, "live");
  const mine = join(root, "mine");
  const fresh = join(root, "fresh");
  for (const dir of [stale, live, mine, fresh])
    await mkdir(join(dir, "wezterm"), { recursive: true });

  // A directory whose recorded server is gone, which is what a killed runtime
  // leaves behind.
  const dead = spawnAlreadyExitedProcess();
  await dead.exited;
  await writeFile(join(stale, "wezterm", "pid"), `${dead.pid}\n`);
  // A directory owned by a server that is still running.
  await writeFile(join(live, "wezterm", "pid"), `${process.pid}\n`);
  // Our own directory is never a candidate.
  await writeFile(join(mine, "wezterm", "pid"), `${dead.pid}\n`);

  const old = Date.now() - 3_600_000;
  for (const dir of [stale, live, mine])
    await utimes(dir, new Date(old), new Date(old));

  const reclaimed = await reclaimStaleMuxRuntimeDirs({
    root,
    keep: "mine",
    olderThanMs: 600_000,
  });

  expect(reclaimed).toBe(1);
  expect(await Bun.file(join(stale, "wezterm", "pid")).exists()).toBe(false);
  expect(await Bun.file(join(live, "wezterm", "pid")).exists()).toBe(true);
  expect(await Bun.file(join(mine, "wezterm", "pid")).exists()).toBe(true);
  // A directory younger than the grace period may belong to a runtime that has
  // not started its server yet.
  expect(await Bun.file(join(fresh, "wezterm")).exists()).toBe(false);
  expect((await readdir(root)).sort()).toEqual(["fresh", "live", "mine"]);
});

test("native registry reports the terminal device backing a pane", async () => {
  const host = {
    kind: "wezterm" as const,
    executable: "wezterm",
    async spawn() {
      return { pane_id: 31, window_id: 1, tab_id: 1, rows: 24, cols: 80 };
    },
    async list() {
      return [
        {
          pane_id: 31,
          window_id: 1,
          tab_id: 1,
          rows: 24,
          cols: 80,
          tty_name: "/dev/pts/9",
        },
        { pane_id: 32, window_id: 1, tab_id: 1, rows: 24, cols: 80 },
      ];
    },
    async read() {
      return "";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  };
  const registry = new NativeTerminalRegistry(host, {
    windowMode: "windowless",
  });
  const session = await registry.start({ command: "bash", cwd: process.cwd() });
  // The device name is what lets the runtime confirm the foreground program
  // instead of inferring it from the screen.
  await expect(registry.ttyName(session.id)).resolves.toBe("/dev/pts/9");
  await registry.dispose();
});

test("native registry reports no terminal device when the host omits it", async () => {
  const host = {
    kind: "wezterm" as const,
    executable: "wezterm",
    async spawn() {
      return { pane_id: 41, window_id: 1, tab_id: 1, rows: 24, cols: 80 };
    },
    async list() {
      return [{ pane_id: 41, window_id: 1, tab_id: 1, rows: 24, cols: 80 }];
    },
    async read() {
      return "";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  };
  const registry = new NativeTerminalRegistry(host, {
    windowMode: "windowless",
  });
  const session = await registry.start({ command: "bash", cwd: process.cwd() });
  await expect(registry.ttyName(session.id)).resolves.toBeUndefined();
  await registry.dispose();
});

arbitrationTest(
  "a human entering a secret is not disturbed by the model",
  async () => {
    // `secureInput` already guarantees the bytes are never seen by us. It did not
    // guarantee the surroundings: a pane appearing, a pane dying or a resize all
    // re-lay out the multiplexer window the human is typing into, which can move the
    // prompt, redraw over it, or steal focus mid-password. Nothing stopped the model
    // from doing any of those while a password was being typed.
    const spawned: number[] = [];
    let paneID = 40;
    const registry = new NativeTerminalRegistry({
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        paneID += 1;
        spawned.push(paneID);
        return { pane_id: paneID, window_id: 2, tab_id: 3, rows: 24, cols: 80 };
      },
      async list() {
        return spawned.map((pane) => ({
          pane_id: pane,
          window_id: 2,
          tab_id: 3,
          rows: 24,
          cols: 80,
        }));
      },
      async read() {
        return "";
      },
      async write() {},
      async focus() {},
      async resize() {},
      async stop() {},
    });

    const secret = await registry.start({ cwd: "/repo", command: "ssh host" });
    const other = await registry.start({ cwd: "/repo", command: "cat" });
    await registry.claimHumanInput(secret.id);
    registry.beginSecureInput(secret.id);

    // Everything that would move the window under the human's hands is refused,
    // including on a *different* pane, because the layout is shared.
    await expect(
      registry.start({ cwd: "/repo", command: "top" }),
    ).rejects.toThrow(/secure input/u);
    await expect(registry.resize(other.id, 30, 100, "model")).rejects.toThrow(
      /secure input/u,
    );
    await expect(registry.stop(other.id, "model")).rejects.toThrow(
      /secure input/u,
    );

    // Writing to another pane stays allowed: it changes no layout, and refusing all
    // model output during a password prompt would stall unrelated work.
    await expect(
      registry.write(other.id, "still working\n"),
    ).resolves.toBeDefined();

    // The human is never blocked from their own actions, including ending it.
    await expect(
      registry.resize(other.id, 30, 100, "human"),
    ).resolves.toBeDefined();
    registry.endSecureInput(secret.id);

    // Once the secret is entered, the model can act again.
    await expect(
      registry.start({ cwd: "/repo", command: "top" }),
    ).resolves.toBeDefined();
  },
);

test("native registry isolates panes per active session (I3)", async () => {
  let nextPane = 401;
  const registry = new NativeTerminalRegistry(
    {
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        const paneID = nextPane++;
        return { pane_id: paneID, window_id: 1, tab_id: paneID };
      },
      async list() {
        return [];
      },
      async read() {
        return "";
      },
      async write() {},
      async focus() {},
      async resize() {},
      async stop() {},
    },
    { windowMode: "windowless" },
  );
  const a = await registry.start({
    id: "i3_pane_a",
    cwd: "/a",
    command: "cat",
    sessionID: "ses_i3_a",
  });
  const b = await registry.start({
    id: "i3_pane_b",
    cwd: "/b",
    command: "cat",
    sessionID: "ses_i3_b",
  });

  // Unset active session keeps the legacy behaviour: everything visible.
  expect(registry.list().map((session) => session.id)).toEqual([
    "i3_pane_a",
    "i3_pane_b",
  ]);

  registry.setActiveSession("ses_i3_a");
  expect(registry.list().map((session) => session.id)).toEqual(["i3_pane_a"]);
  // A pane of another session is indistinguishable from an unknown id: no
  // existence probe, no leak of which session owns what.
  await expect(registry.read("i3_pane_b")).rejects.toThrow(
    "native terminal session not found",
  );

  registry.setActiveSession("ses_i3_b");
  expect(registry.list().map((session) => session.id)).toEqual(["i3_pane_b"]);
  await expect(registry.read("i3_pane_a")).rejects.toThrow(
    "native terminal session not found",
  );

  // A model-side start without an explicit id belongs to the active session.
  const c = await registry.start({
    id: "i3_pane_c",
    cwd: "/c",
    command: "cat",
  });
  expect(c.sessionID).toBe("ses_i3_b");
  expect(registry.list().map((session) => session.id)).toEqual([
    "i3_pane_b",
    "i3_pane_c",
  ]);

  registry.setActiveSession(undefined);
  expect(registry.list()).toHaveLength(3);
  await registry.dispose();
});

test("native registry request_human audits the explicit call with a bounded reason", async () => {
  const audit: Array<{
    action: string;
    actor: string;
    detail?: string;
    id?: string;
    cwd?: string;
    at?: string;
  }> = [];
  let output = "";
  const registry = new NativeTerminalRegistry(
    {
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        return { pane_id: 601, window_id: 1, tab_id: 601 };
      },
      async list() {
        return [
          { pane_id: 601, window_id: 1, tab_id: 601, rows: 24, cols: 80 },
        ];
      },
      async read() {
        return output;
      },
      async write() {},
      async focus() {},
      async resize() {},
      async stop() {},
    },
    {
      windowMode: "windowless",
      onAudit: (event) => audit.push(event),
    },
  );
  const session = await registry.start({
    id: "rh_1",
    cwd: "/repo",
    command: "ssh host",
  });
  await registry.requestHuman(session.id, "needs the sudo password");
  expect(audit.at(-1)).toEqual({
    id: "rh_1",
    cwd: "/repo",
    action: "request_human",
    actor: "model",
    at: expect.any(String),
    detail: "needs the sudo password",
  });
  // The model's own statement is not an output fact: requesting a human does
  // not count as the pane producing output.
  expect(session.mayWaitForHuman).toBeUndefined();
  await registry.dispose();
});

test("native registry request_human rejects empty, oversized, and exited-pane reasons", async () => {
  let nextPane = 602;
  const registry = new NativeTerminalRegistry(
    {
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        const paneID = nextPane++;
        return { pane_id: paneID, window_id: 1, tab_id: paneID };
      },
      async list() {
        return [];
      },
      async read() {
        return "";
      },
      async write() {},
      async focus() {},
      async resize() {},
      async stop() {},
    },
    { windowMode: "windowless" },
  );
  const session = await registry.start({
    id: "rh_2",
    cwd: "/repo",
    command: "cat",
  });
  await expect(registry.requestHuman(session.id, "")).rejects.toThrow(
    "requires a reason",
  );
  await expect(
    registry.requestHuman(session.id, "x".repeat(241)),
  ).rejects.toThrow("240 characters or fewer");
  // A 240-character reason is exactly at the limit and accepted.
  await expect(
    registry.requestHuman(session.id, "x".repeat(240)),
  ).resolves.toBeDefined();
  await registry.stop(session.id);
  await expect(
    registry.requestHuman(session.id, "still needs input"),
  ).rejects.toThrow("exited");
  await registry.dispose();
});

test("native registry mayWaitForHuman is a conservative weak fact", async () => {
  let output = "";
  let paneID = 603;
  const registry = new NativeTerminalRegistry(
    {
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        const id = paneID++;
        return { pane_id: id, window_id: 1, tab_id: id };
      },
      async list() {
        return [
          {
            pane_id: paneID - 1,
            window_id: 1,
            tab_id: paneID - 1,
            rows: 24,
            cols: 80,
          },
        ];
      },
      async read() {
        return output;
      },
      async write() {},
      async focus() {},
      async resize() {},
      async stop() {},
    },
    { windowMode: "windowless", mayWaitGraceMs: 30 },
  );
  const session = await registry.start({
    id: "mw_1",
    cwd: "/repo",
    command: "ssh host",
  });

  // No model write yet: never suggests.
  output = "Password: ";
  await registry.read(session.id);
  await registry.reconcile({ force: true });
  expect(session.mayWaitForHuman).toBe(false);

  // Model writes; output arrives after; the pane is silent past the grace.
  await registry.write(session.id, "\r");
  output = "Password: \nenter password: ";
  await registry.read(session.id);
  await registry.reconcile({ force: true });
  expect(session.mayWaitForHuman).toBe(false);
  await Bun.sleep(60);
  await registry.reconcile({ force: true });
  expect(session.mayWaitForHuman).toBe(true);

  // The model writes again: the fact clears.
  await registry.write(session.id, "hunter2\n");
  await registry.reconcile({ force: true });
  expect(session.mayWaitForHuman).toBe(false);

  // Output again, grace passes, but a human now holds input: no suggestion.
  output = "Welcome to host";
  await registry.read(session.id);
  await Bun.sleep(60);
  registry.claimHumanInput(session.id);
  await registry.reconcile({ force: true });
  expect(session.mayWaitForHuman).toBe(false);
  registry.releaseHumanControl(session.id);

  // A computation that outlives the grace reads true too — content is never
  // inspected, which is exactly why the fact says "may".
  await registry.write(session.id, "make -j8\n");
  output = "Compiling...";
  await registry.read(session.id);
  await Bun.sleep(60);
  await registry.reconcile({ force: true });
  expect(session.mayWaitForHuman).toBe(true);
  await registry.dispose();
});

test("background starts neither open the hub nor steal focus (I1)", async () => {
  const focused: number[] = [];
  const audit: Array<{ action: string; actor: string }> = [];
  let nextPane = 801;
  const registry = new NativeTerminalRegistry(
    {
      kind: "wezterm",
      executable: "wezterm",
      async spawn() {
        const paneID = nextPane++;
        return { pane_id: paneID, window_id: 1, tab_id: paneID };
      },
      async list() {
        return [
          {
            pane_id: nextPane - 1,
            window_id: 1,
            tab_id: nextPane - 1,
            rows: 24,
            cols: 80,
          },
        ];
      },
      async read() {
        return "";
      },
      async write() {},
      async open(paneID, options) {
        return { pane_id: paneID, window_id: 1, tab_id: paneID };
      },
      async focus(paneID) {
        focused.push(paneID);
      },
      async resize() {},
      async stop() {},
    },
    { windowMode: "window", onAudit: (e) => audit.push(e) },
  );
  registry.setActiveSession("ses_fg");

  const bg = await registry.start({
    id: "i1_bg",
    cwd: "/repo",
    command: "cat",
    sessionID: "ses_bg",
  });
  expect(focused).toEqual([]);
  expect(audit.at(-1)).toMatchObject({
    action: "started",
    actor: "model",
  });
  expect(bg.attached).toBe(true);

  const fg = await registry.start({
    id: "i1_fg",
    cwd: "/repo",
    command: "cat",
    sessionID: "ses_fg",
  });
  expect(focused).toEqual([fg.paneID]);
  await registry.dispose();
});

test("native registry windowless mode never opens a window and records the timeline fact", async () => {
  const audit: Array<{ action: string; actor: string }> = [];
  let opened = 0;
  const host = {
    kind: "wezterm" as const,
    executable: "wezterm",
    async spawn() {
      return { pane_id: 71, window_id: 1, tab_id: 71, rows: 24, cols: 80 };
    },
    async list() {
      return [{ pane_id: 71, window_id: 1, tab_id: 71, rows: 24, cols: 80 }];
    },
    async read() {
      return "";
    },
    async write() {},
    async open(paneID: number, _options: { muxWindowID?: number }) {
      opened += 1;
      return { pane_id: paneID, window_id: 1, tab_id: paneID };
    },
    async focus() {},
    async resize() {},
    async stop() {},
  };
  const registry = new NativeTerminalRegistry(host, {
    windowMode: "windowless",
    onAudit: (event) => audit.push(event),
  });
  const session = await registry.start({
    id: "wl_1",
    cwd: "/repo",
    command: "cat",
  });
  expect(opened).toBe(0);
  expect(audit.at(-1)).toMatchObject({
    id: "wl_1",
    action: "started",
    actor: "model",
  });
  await expect(registry.read(session.id)).resolves.toMatchObject({ text: "" });
  await registry.dispose();
});

test("native registry auto mode degrades to windowless when the window attach fails", async () => {
  const audit: Array<{ action: string; actor: string }> = [];
  let stopped = 0;
  const host = {
    kind: "wezterm" as const,
    executable: "wezterm",
    async spawn() {
      return { pane_id: 72, window_id: 1, tab_id: 72, rows: 24, cols: 80 };
    },
    async list() {
      return [{ pane_id: 72, window_id: 1, tab_id: 72, rows: 24, cols: 80 }];
    },
    async read() {
      return "";
    },
    async write() {},
    async open() {
      throw new Error("no display: WezTerm GUI could not start");
    },
    async focus() {},
    async resize() {},
    async stop() {
      stopped += 1;
    },
  };
  const registry = new NativeTerminalRegistry(host, {
    onAudit: (event) => audit.push(event),
  });
  const session = await registry.start({
    id: "auto_1",
    cwd: "/repo",
    command: "cat",
  });
  expect(stopped).toBe(0);
  expect(audit.at(-1)).toMatchObject({
    id: "auto_1",
    action: "started",
    actor: "model",
  });
  await expect(registry.read(session.id)).resolves.toMatchObject({ text: "" });
  await registry.dispose();
});

test("native registry explicit window mode fails loudly when the attach fails", async () => {
  const audit: Array<{ action: string; actor: string }> = [];
  let stopped = 0;
  const host = {
    kind: "wezterm" as const,
    executable: "wezterm",
    async spawn() {
      return { pane_id: 73, window_id: 1, tab_id: 73, rows: 24, cols: 80 };
    },
    async list() {
      return [{ pane_id: 73, window_id: 1, tab_id: 73, rows: 24, cols: 80 }];
    },
    async read() {
      return "";
    },
    async write() {},
    async open() {
      throw new Error("no display: WezTerm GUI could not start");
    },
    async focus() {},
    async resize() {},
    async stop() {
      stopped += 1;
    },
  };
  const registry = new NativeTerminalRegistry(host, {
    windowMode: "window",
    onAudit: (event) => audit.push(event),
  });
  await expect(
    registry.start({ id: "win_1", cwd: "/repo", command: "cat" }),
  ).rejects.toThrow(/no display/u);
  expect(stopped).toBe(1);
  expect(registry.list()).toHaveLength(0);
  expect(audit).toHaveLength(0);
  await registry.dispose();
});

import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "@anthelia/plugin";
import {
  NativeTerminalRegistry,
  createTerminalPlugin,
  TERMINAL_PLUGIN_ID,
  terminalToolFamily,
  terminalTools,
} from "../src";
import { terminalController } from "@anthelia/runtime-services";
import {
  createPtyTerminalController,
  type PtyFactory,
  type PtyProcess,
} from "../src";

function fakePtyForBehavior() {
  const processes: PtyProcess[] = [];
  let nextPid = 2000;
  const factory: PtyFactory = () => {
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: { exitCode: number }) => void>();
    const process: PtyProcess & {
      emit(data: string): void;
      exit(code?: number): void;
    } = {
      pid: nextPid++,
      write(data) {
        for (const listener of dataListeners)
          listener(data.replace(/\n/g, "\r\n"));
      },
      resize() {},
      kill() {
        process.exit(0);
      },
      onData(listener) {
        dataListeners.add(listener);
        return {
          dispose() {
            dataListeners.delete(listener);
          },
        };
      },
      onExit(listener) {
        exitListeners.add(listener);
        return {
          dispose() {
            exitListeners.delete(listener);
          },
        };
      },
      emit(data) {
        for (const listener of dataListeners) listener(data);
      },
      exit(code = 0) {
        for (const listener of exitListeners) listener({ exitCode: code });
      },
    };
    processes.push(process);
    return process;
  };
  return { factory, processes };
}
import {
  encodeTerminalKey,
  nativeTerminalReadPage,
  nativeTerminalSearchPage,
  ToolRegistry,
} from "@anthelia/tools";

function terminalRegistry() {
  const registry = new ToolRegistry();
  for (const tool of terminalTools()) registry.set(tool.name, tool);
  for (const [alias, target] of Object.entries(
    terminalToolFamily().aliases ?? {},
  ))
    registry.addAlias(alias, target);
  return registry;
}

test("the terminal plugin owns its tools and aliases and unloads cleanly", async () => {
  const tools = new ToolRegistry();
  const registry = createPluginRegistry({ tools });
  await registry.load(
    createTerminalPlugin({
      workspaceRoot: "/tmp",
      publish: () => undefined,
      onPerformance: () => undefined,
      runtimeID: () => "runtime-test",
      userRuntimeHome: () => undefined,
      windowMode: () => "auto",
    }),
  );
  expect(registry.list()[0]).toMatchObject({
    id: TERMINAL_PLUGIN_ID,
    scope: "session",
  });
  for (const tool of terminalTools()) expect(tools.has(tool.name)).toBe(true);
  expect(tools.has("interactive_start")).toBe(true);
  await registry.unload(TERMINAL_PLUGIN_ID);
  for (const tool of terminalTools()) expect(tools.has(tool.name)).toBe(false);
});

test("omitted backend uses the in-process PTY controller", async () => {
  const tools = new ToolRegistry();
  const services = new Map<string, unknown>();
  const plugin = createTerminalPlugin({
    workspaceRoot: "/tmp",
    publish: () => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "runtime-test",
    userRuntimeHome: () => undefined,
    windowMode: () => "auto",
  });
  await plugin.setup({
    config: {},
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
      registerAlias(alias, target) {
        return tools.addAlias(alias, target);
      },
    },
    services: {
      provide(name, value) {
        services.set(name, value);
        return () => services.delete(name);
      },
      get: () => undefined,
      on: () => () => undefined,
    },
    events: { on: () => () => undefined },
    commands: { register: () => () => undefined },
    resources: { register: () => () => undefined },
    projections: { register: () => () => undefined },
    workflows: { register: () => () => undefined },
    settingsSchema: { register: () => () => undefined },
    adapters: {
      register: () => () => undefined,
      registerUi: () => () => undefined,
    },
    scheduler: { add: () => () => undefined },
    effects: {
      signal: new AbortController().signal,
      run: async (effect) => effect(new AbortController().signal),
    },
  });
  const controller = services.get(terminalController.id) as {
    subscribeOutput?: unknown;
    close(): Promise<void>;
  };
  expect(typeof controller.subscribeOutput).toBe("function");
  await controller.close();
  await plugin.dispose?.();
});

test("interactive Terminal tools keep model I/O on one native host pane", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-interactive-"));
  const writes: string[] = [];
  const nativeTerminal = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 73, window_id: 3, tab_id: 5 };
    },
    async list() {
      return [{ pane_id: 73, window_id: 3, tab_id: 5, rows: 24, cols: 80 }];
    },
    async read() {
      return "native terminal output";
    },
    async write(_paneID, data) {
      writes.push(data);
    },
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const context = { workspaceRoot: root, terminal: nativeTerminal };
  const tools = terminalRegistry();
  const startResult = await tools
    .get("interactive_terminal_start")!
    .execute({ command: "cat", id: "tty_tools" }, context);
  const started = JSON.parse(startResult) as {
    id: string;
    status: string;
    paneID: number;
  };
  expect(started).toMatchObject({
    id: "tty_tools",
    status: "running",
    paneID: 73,
  });
  await tools
    .get("interactive_terminal_write")!
    .execute({ id: "tty_tools", input: "tool input\n" }, context);
  expect(
    JSON.parse(
      await tools
        .get("interactive_terminal_send_line")!
        .execute(
          { id: "tty_tools", text: "atomic command", idempotencyKey: "line_1" },
          context,
        ),
    ),
  ).toMatchObject({ writtenBytes: 15, submitted: true, delivery: "accepted" });
  expect(
    JSON.parse(
      await tools.get("interactive_terminal_write")!.execute(
        {
          id: "tty_tools",
          input: "idempotent input\n",
          idempotencyKey: "write_1",
        },
        context,
      ),
    ),
  ).toMatchObject({ delivery: "accepted" });
  expect(
    JSON.parse(
      await tools.get("interactive_terminal_write")!.execute(
        {
          id: "tty_tools",
          input: "idempotent input\n",
          idempotencyKey: "write_1",
        },
        context,
      ),
    ),
  ).toMatchObject({ delivery: "duplicate" });
  await tools
    .get("interactive_terminal_keys")!
    .execute({ id: "tty_tools", key: "ctrl-c" }, context);
  await nativeTerminal.openHub();
  await nativeTerminal.claimHumanInput("tty_tools");
  await expect(
    tools
      .get("interactive_terminal_write")!
      .execute({ id: "tty_tools", input: "must not interleave" }, context),
  ).rejects.toThrow("controlled by a human");
  nativeTerminal.releaseHumanControl("tty_tools");
  expect(
    await tools
      .get("interactive_terminal_read")!
      .execute({ id: "tty_tools" }, context),
  ).toContain("native terminal output");
  expect(writes.join("")).toBe(
    "tool input\natomic command\ridempotent input\n\x03",
  );
  expect(tools.has("interactive_start")).toBe(true);
  expect(tools.has("interactive_send_line")).toBe(true);
  expect(tools.has("interactive_terminal_attach")).toBe(false);
  expect(tools.has("interactive_terminal_detach")).toBe(false);
  expect(tools.has("interactive_attach")).toBe(false);
  expect(tools.has("interactive_detach")).toBe(false);
  expect(tools.get("interactive_start")?.name).toBe(
    "interactive_terminal_start",
  );
  expect([...tools.keys()]).not.toContain("interactive_start");
  await tools
    .get("interactive_terminal_stop")!
    .execute({ id: "tty_tools" }, context);
});

test("encodes normalized native terminal key sequences", () => {
  expect(encodeTerminalKey({ key: "enter" })).toBe("\r");
  expect(encodeTerminalKey({ key: "Esc" })).toBe("\x1b");
  expect(encodeTerminalKey({ key: "ArrowUp", modifiers: ["ctrl"] })).toBe(
    "\x1b[1;5A",
  );
  expect(
    encodeTerminalKey({ key: "Delete", modifiers: ["alt", "shift"] }),
  ).toBe("\x1b[3;4~");
  expect(encodeTerminalKey({ key: "F12", repeat: 2 })).toBe("\x1b[24~\x1b[24~");
  expect(encodeTerminalKey({ key: "c", modifiers: ["ctrl", "alt"] })).toBe(
    "\x1b\x03",
  );
  expect(encodeTerminalKey({ text: "你好", repeat: 2 })).toBe("你好你好");
  expect(() => encodeTerminalKey({ key: "Unknown" })).toThrow(
    "unsupported terminal key",
  );
  expect(() =>
    encodeTerminalKey({ key: "Enter", modifiers: ["ctrl"] }),
  ).toThrow("not encodable");
  expect(encodeTerminalKey({ key: "V" })).toBe("V");
  expect(encodeTerminalKey({ key: "A", modifiers: ["ctrl"] })).toBe("\x01");
  expect(encodeTerminalKey({ text: "vim" })).toBe("vim");
  expect(encodeTerminalKey({ text: "你好🚀" })).toBe("你好🚀");
});

test("unified interactive terminal input tool sends text and key sequences", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-input-"));
  const writes: string[] = [];
  const nativeTerminal = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 73, window_id: 3, tab_id: 5 };
    },
    async list() {
      return [{ pane_id: 73, window_id: 3, tab_id: 5, rows: 24, cols: 80 }];
    },
    async read() {
      return "native terminal output";
    },
    async write(_paneID, data) {
      writes.push(data);
    },
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const context = { workspaceRoot: root, terminal: nativeTerminal };
  const tools = terminalRegistry();
  await tools
    .get("interactive_terminal_start")!
    .execute({ command: "cat", id: "tty_input" }, context);
  await tools
    .get("interactive_terminal_input")!
    .execute({ id: "tty_input", text: "vim" }, context);
  expect(writes.at(-1)).toBe("vim\r");
  await tools
    .get("interactive_terminal_input")!
    .execute({ id: "tty_input", text: "vim", submit: false }, context);
  expect(writes.at(-1)).toBe("vim");
  await tools.get("interactive_terminal_input")!.execute(
    {
      id: "tty_input",
      keys: [{ key: "ArrowUp" }, { key: "Enter" }],
    },
    context,
  );
  expect(writes.at(-1)).toBe("\x1b[A\r");
  // Ordering lives inside the sequence, so text entries are sent in place.
  await tools.get("interactive_terminal_input")!.execute(
    {
      id: "tty_input",
      keys: [{ key: "i" }, { text: "hello" }, { key: "Escape" }],
    },
    context,
  );
  expect(writes.at(-1)).toBe("ihello\x1b");
  // Mixing the two fields cannot express order, and used to send every
  // character of text before the keys regardless of intent.
  await expect(
    tools.get("interactive_terminal_input")!.execute(
      {
        id: "tty_input",
        text: "vim",
        keys: [{ key: "Escape" }],
        submit: false,
      },
      context,
    ),
  ).rejects.toThrow(/cannot be combined/u);
  await tools
    .get("interactive_terminal_input")!
    .execute({ id: "tty_input", text: "Vim" }, context);
  expect(writes.at(-1)).toBe("Vim\r");
  expect(tools.has("interactive_input")).toBe(true);
  expect(tools.has("interactive_terminal_input")).toBe(true);
  await tools
    .get("interactive_terminal_stop")!
    .execute({ id: "tty_input" }, context);
});

test("interactive terminal snapshot returns cursor and revision without afterRevision", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-snapshot-"));
  const nativeTerminal = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 73, window_id: 3, tab_id: 5 };
    },
    async list() {
      return [{ pane_id: 73, window_id: 3, tab_id: 5, rows: 24, cols: 80 }];
    },
    async read() {
      return "snapshot output";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const context = { workspaceRoot: root, terminal: nativeTerminal };
  const tools = terminalRegistry();
  await tools
    .get("interactive_terminal_start")!
    .execute({ command: "cat", id: "tty_snapshot" }, context);
  const snap = JSON.parse(
    await tools
      .get("interactive_terminal_snapshot")!
      .execute({ id: "tty_snapshot" }, context),
  );
  expect(snap).toMatchObject({
    id: "tty_snapshot",
    host: "wezterm",
    text: "snapshot output",
    cursorX: 0,
    cursorY: 0,
    rows: 24,
    cols: 80,
    status: "running",
    inputOwner: "model",
  });
  expect(typeof snap.revision).toBe("number");
  expect(tools.has("interactive_snapshot")).toBe(true);
  await tools
    .get("interactive_terminal_stop")!
    .execute({ id: "tty_snapshot" }, context);
});

test("terminal observe latest mode returns current state without waiting", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-observe-"));
  const nativeTerminal = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 73, window_id: 3, tab_id: 5 };
    },
    async list() {
      return [{ pane_id: 73, window_id: 3, tab_id: 5, rows: 24, cols: 80 }];
    },
    async read() {
      return "latest output";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const context = { workspaceRoot: root, terminal: nativeTerminal };
  const tools = terminalRegistry();
  await tools
    .get("interactive_terminal_start")!
    .execute({ command: "cat", id: "tty_observe" }, context);
  const obs = JSON.parse(
    await tools
      .get("terminal_observe")!
      .execute(
        { id: "tty_observe", afterRevision: 0, mode: "latest" },
        context,
      ),
  );
  expect(obs).toMatchObject({
    id: "tty_observe",
    mode: "latest",
    text: "latest output",
    cursorX: 0,
    cursorY: 0,
    rows: 24,
    cols: 80,
    currentRevision: expect.any(Number),
  });
  await tools
    .get("interactive_terminal_stop")!
    .execute({ id: "tty_observe" }, context);
});

test("terminal observe tail mode returns only recent lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-observe-"));
  const nativeTerminal = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 73, window_id: 3, tab_id: 5 };
    },
    async list() {
      return [{ pane_id: 73, window_id: 3, tab_id: 5, rows: 24, cols: 80 }];
    },
    async read() {
      return "line1\nline2\nline3\nline4\nline5\n";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const context = { workspaceRoot: root, terminal: nativeTerminal };
  const tools = terminalRegistry();
  await tools
    .get("interactive_terminal_start")!
    .execute({ command: "cat", id: "tty_tail" }, context);
  const obs = JSON.parse(
    await tools
      .get("terminal_observe")!
      .execute(
        { id: "tty_tail", afterRevision: 0, mode: "tail", scrollbackRows: 3 },
        context,
      ),
  );
  expect(obs.text).toBe("line3\nline4\nline5");
  await tools
    .get("interactive_terminal_stop")!
    .execute({ id: "tty_tail" }, context);
});

test("terminal observe cursor mode returns lines around cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-observe-"));
  const lines =
    Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n") + "\n";
  const nativeTerminal = new NativeTerminalRegistry({
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
          cursor_x: 0,
          cursor_y: 15,
        },
      ];
    },
    async read() {
      return lines;
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const context = { workspaceRoot: root, terminal: nativeTerminal };
  const tools = terminalRegistry();
  await tools
    .get("interactive_terminal_start")!
    .execute({ command: "cat", id: "tty_cursor" }, context);
  const obs = JSON.parse(
    await tools
      .get("terminal_observe")!
      .execute({ id: "tty_cursor", afterRevision: 0, mode: "cursor" }, context),
  );
  expect(obs.cursorY).toBe(15);
  expect(obs.text).toContain(
    Array.from({ length: 11 }, (_, i) => `line${i + 10}`).join("\n") + "\n",
  );
  expect(obs.text).not.toContain("line0");
  expect(obs.text).not.toContain("line29");
  await tools
    .get("interactive_terminal_stop")!
    .execute({ id: "tty_cursor" }, context);
});

test("terminal observe new_only mode returns only new text since last observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-observe-"));
  let readCall = 0;
  const nativeTerminal = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 73, window_id: 3, tab_id: 5 };
    },
    async list() {
      return [{ pane_id: 73, window_id: 3, tab_id: 5, rows: 24, cols: 80 }];
    },
    async read() {
      readCall += 1;
      if (readCall === 1) return "initial text\n";
      return "initial text\nnew line 1\nnew line 2\n";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const context = { workspaceRoot: root, terminal: nativeTerminal };
  const tools = terminalRegistry();
  await tools
    .get("interactive_terminal_start")!
    .execute({ command: "cat", id: "tty_new_only" }, context);
  const first = JSON.parse(
    await tools
      .get("terminal_observe")!
      .execute(
        { id: "tty_new_only", afterRevision: 0, mode: "new_only" },
        context,
      ),
  );
  expect(first.text).toBe("initial text\n");
  const second = JSON.parse(
    await tools.get("terminal_observe")!.execute(
      {
        id: "tty_new_only",
        afterRevision: first.currentRevision,
        mode: "new_only",
      },
      context,
    ),
  );
  expect(second.text).toBe("new line 1\nnew line 2\n");
  await tools
    .get("interactive_terminal_stop")!
    .execute({ id: "tty_new_only" }, context);
});

test("interactive terminal input paste mode wraps text in bracketed paste escape sequences", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-paste-"));
  const writes: string[] = [];
  const nativeTerminal = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 73, window_id: 3, tab_id: 5 };
    },
    async list() {
      return [{ pane_id: 73, window_id: 3, tab_id: 5, rows: 24, cols: 80 }];
    },
    async read() {
      return "native terminal output";
    },
    async write(_paneID, data) {
      writes.push(data);
    },
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const context = { workspaceRoot: root, terminal: nativeTerminal };
  const tools = terminalRegistry();
  await tools
    .get("interactive_terminal_start")!
    .execute({ command: "cat", id: "tty_paste" }, context);
  await tools
    .get("interactive_terminal_input")!
    .execute({ id: "tty_paste", text: "hello world", paste: true }, context);
  expect(writes.at(-1)).toBe("\x1b[?2004hhello world\x1b[?2004l");
  const result = JSON.parse(
    await tools
      .get("interactive_terminal_input")!
      .execute({ id: "tty_paste", text: "vim", paste: true }, context),
  );
  expect(result.submitted).toBe(false);
  await tools
    .get("interactive_terminal_stop")!
    .execute({ id: "tty_paste" }, context);
});

test("terminal observe afterRevision is optional and defaults to current state", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-observe-"));
  const nativeTerminal = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 73, window_id: 3, tab_id: 5 };
    },
    async list() {
      return [{ pane_id: 73, window_id: 3, tab_id: 5, rows: 24, cols: 80 }];
    },
    async read() {
      return "no afterRevision output";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const context = { workspaceRoot: root, terminal: nativeTerminal };
  const tools = terminalRegistry();
  await tools
    .get("interactive_terminal_start")!
    .execute({ command: "cat", id: "tty_no_ar" }, context);
  const obs = JSON.parse(
    await tools
      .get("terminal_observe")!
      .execute({ id: "tty_no_ar", mode: "latest" }, context),
  );
  expect(obs.text).toBe("no afterRevision output");
  expect(obs.currentRevision).toBe(obs.revision);
  await tools
    .get("interactive_terminal_stop")!
    .execute({ id: "tty_no_ar" }, context);
});

test("native terminal scrollback pages preserve CJK line boundaries and cursors", () => {
  const text = Array.from(
    { length: 4_000 },
    (_, index) => `第${index}行\n`,
  ).join("");
  const first = nativeTerminalReadPage(text, { startLine: 100 });
  expect(first).toMatchObject({
    truncated: true,
    totalBytes: new TextEncoder().encode(text).byteLength,
    endLine: 100 + first.deliveredLines - 1,
    nextStartLine: 100 + first.deliveredLines,
  });
  expect(first.text.endsWith("\n")).toBe(true);
  expect(new TextDecoder().decode(new TextEncoder().encode(first.text))).toBe(
    first.text,
  );
  const final = nativeTerminalReadPage("最后一行", { startLine: 4_100 });
  expect(final).toMatchObject({
    truncated: false,
    deliveredLines: 1,
    endLine: 4_100,
    nextStartLine: undefined,
  });
});

test("native terminal search pages bounded Unicode matches without screen transport", () => {
  const text = Array.from(
    { length: 200 },
    (_, index) => `line ${index}${index % 50 === 0 ? " 命中" : ""}\n`,
  ).join("");
  const result = nativeTerminalSearchPage(text, {
    query: "命中",
    startLine: 500,
    endLine: 900,
    requestedEndLine: 900,
    maxMatches: 2,
  });
  expect(result).toMatchObject({
    searchedRange: { startLine: 500, endLine: 699, scannedLines: 200 },
    matches: [
      { line: 500, text: "line 0 命中" },
      { line: 550, text: "line 50 命中" },
    ],
    truncatedMatches: true,
    nextCursor: { startLine: 700, endLine: 900 },
  });
  const final = nativeTerminalSearchPage("one\n命中\n", {
    query: "命中",
    startLine: 900,
    endLine: 901,
    requestedEndLine: 901,
    maxMatches: 20,
  });
  expect(final).toMatchObject({
    matches: [{ line: 901, text: "命中" }],
    nextCursor: undefined,
  });
});
test("terminal_observe latest reports a point-in-time read, not a wait outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-observe-latest-"));
  const nativeTerminal = new NativeTerminalRegistry({
    kind: "wezterm",
    executable: "wezterm",
    async spawn() {
      return { pane_id: 91, window_id: 1, tab_id: 1 };
    },
    async list() {
      return [{ pane_id: 91, window_id: 1, tab_id: 1, rows: 24, cols: 80 }];
    },
    async read() {
      return "screen contents";
    },
    async write() {},
    async focus() {},
    async resize() {},
    async stop() {},
  });
  const context = { workspaceRoot: root, terminal: nativeTerminal };
  const tools = terminalRegistry();
  await tools
    .get("interactive_terminal_start")!
    .execute({ command: "cat", id: "tty_latest" }, context);

  const latest = JSON.parse(
    String(
      await tools
        .get("terminal_observe")!
        .execute({ id: "tty_latest", mode: "latest" }, context),
    ),
  );
  // Nothing waited, so no deadline can have passed. Reporting "timeout" made a
  // freshly read screen look like a stale frame.
  expect(latest.reason).toBe("latest");
  expect(latest.text).toContain("screen contents");

  // The same call with a revision already seen still reports the current text.
  const repeated = JSON.parse(
    String(
      await tools.get("terminal_observe")!.execute(
        {
          id: "tty_latest",
          mode: "latest",
          afterRevision: latest.currentRevision,
        },
        context,
      ),
    ),
  );
  expect(repeated.reason).toBe("latest");
  expect(repeated.changed).toBe(false);
  expect(repeated.text).toContain("screen contents");
});

test("observe without afterRevision waits for what changed since last look", async () => {
  // The screenshot's lesson: with the old default (0) every observe
  // returned instantly with a full frame, and the model's only strategy
  // was to spin. Omitted afterRevision now means "since I last looked".
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-default-"));
  const { factory, processes } = fakePtyForBehavior();
  const controller = createPtyTerminalController({
    workspaceRoot: root,
    publish: () => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "rt",
    userRuntimeHome: () => undefined,
    windowMode: () => "windowless" as const,
    spawn: factory,
  });
  const context = { workspaceRoot: root, terminal: controller };
  const tools = terminalRegistry();
  await tools
    .get("interactive_terminal_start")!
    .execute({ command: "bash", cwd: root, id: "tty_default" }, context);
  (processes[0] as PtyProcess & { emit(data: string): void }).emit(
    "first screen\r\n",
  );
  // The first observation marks the revision the model last looked at.
  const first = JSON.parse(
    await tools
      .get("terminal_observe")!
      .execute({ id: "tty_default", timeoutMs: 1_000 }, context),
  );
  expect(first.changed).toBe(true);
  // Nothing new since: an omitted afterRevision now WAITS (the timeout
  // result), rather than returning a full frame instantly.
  const started = Date.now();
  const second = JSON.parse(
    await tools
      .get("terminal_observe")!
      .execute({ id: "tty_default", timeoutMs: 400 }, context),
  );
  expect(second.changed).toBe(false);
  expect(second.reason).toBe("timeout");
  expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  // And new output still returns promptly through the same default.
  (processes[0] as PtyProcess & { emit(data: string): void }).emit(
    "second screen\r\n",
  );
  const third = JSON.parse(
    await tools
      .get("terminal_observe")!
      .execute({ id: "tty_default", timeoutMs: 2_000 }, context),
  );
  expect(third.changed).toBe(true);
  expect(third.text).toContain("second screen");
  await tools
    .get("interactive_terminal_stop")!
    .execute({ id: "tty_default" }, context);
});

test("search pages the rendered scrollback, escapes and all gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-search-"));
  const { factory, processes } = fakePtyForBehavior();
  const controller = createPtyTerminalController({
    workspaceRoot: root,
    publish: () => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "rt",
    userRuntimeHome: () => undefined,
    windowMode: () => "windowless" as const,
    spawn: factory,
  });
  const context = { workspaceRoot: root, terminal: controller };
  const tools = terminalRegistry();
  await tools
    .get("interactive_terminal_start")!
    .execute({ command: "bash", cwd: root, id: "tty_search" }, context);
  for (let line = 0; line < 60; line += 1)
    (processes[0] as PtyProcess & { emit(data: string): void }).emit(
      line === 37 ? "NEEDLE appears here\r\n" : `filler line ${line}\r\n`,
    );
  // The needle scrolled off the viewport long ago: the search pages the
  // rendered scrollback, and the hit's line is the document line.
  const hit = JSON.parse(
    await tools
      .get("interactive_terminal_search")!
      .execute(
        { id: "tty_search", query: "NEEDLE", startLine: 0, endLine: 59 },
        context,
      ),
  );
  expect(hit.matches).toEqual(
    expect.arrayContaining([expect.objectContaining({ line: 37 })]),
  );
  // The blank page (no hits) is honest.
  const miss = JSON.parse(
    await tools
      .get("interactive_terminal_search")!
      .execute(
        { id: "tty_search", query: "ABSENT", startLine: 0, endLine: 59 },
        context,
      ),
  );
  expect(miss.matches).toEqual([]);
  await tools
    .get("interactive_terminal_stop")!
    .execute({ id: "tty_search" }, context);
});

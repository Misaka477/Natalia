import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "@anthelia/plugin";
import type { TerminalToolService } from "@anthelia/tools";
import {
  createTerminalPlugin,
  TERMINAL_PLUGIN_ID,
  terminalToolFamily,
  terminalTools,
} from "../src";
import { interactiveTerminalToolAliases } from "@anthelia/tools";
import type { RuntimeTool } from "@anthelia/tools";
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

/**
 * The tools' terminal surface over a fake host.
 *
 * The host answers with text, the cursor and the geometry —and nothing that
 * locates that text in a document —so the extent served here is null, exactly
 * what the mux-facade shape reports. A bare registry used to pass as the tool
 * context by the luck of overlapping shapes; the read contract now states the
 * extent, and this wrapper is where the host's honest "cannot page" enters
 * rather than a cast that hides the difference.
 */
/**
 * The smallest host facade that still answers the tools' questions with the
 * mux-shaped "cannot page" extent. The fork host is gone; the tools' contract
 * is not, so the fake is now written by hand against TerminalToolService
 * rather than against a registry class that no longer exists.
 */
type FakeHost = {
  start(input: { command: string; cwd: string; id?: string }): Promise<{
    id: string;
    host: "pty";
    paneID: number;
    windowID: number;
    muxWindowID: number;
    tabID: number;
    command: string;
    cwd: string;
    status: "running" | "exited";
    startedAt: string;
  }>;
  list(): {
    pane_id: number;
    window_id: number;
    tab_id: number;
    rows: number;
    cols: number;
    cursor_x: number;
    cursor_y: number;
  }[];
  read(): Promise<string>;
  /** The bytes written, in order — the test's assertion surface. */
  writes: string[];
  write(
    id: string,
    value: string,
    options?: { idempotencyKey?: string },
  ): Promise<void>;
  stop(id: string): Promise<void>;
  openHub?(): Promise<void>;
  claimHumanInput(id: string): Promise<void>;
  releaseHumanControl(id: string): Promise<void>;
};

function fakeHostToolContext(workspaceRoot: string, host: FakeHost) {
  const view = (status: "running" | "exited" = "running") => {
    const [pane] = host.list();
    return {
      id: `tty_${pane?.pane_id ?? 0}`,
      host: "pty" as const,
      paneID: pane?.pane_id ?? 0,
      windowID: pane?.window_id ?? 0,
      muxWindowID: pane?.window_id ?? 0,
      tabID: pane?.tab_id ?? 0,
      command: "cat",
      cwd: ".",
      status,
      startedAt: new Date(0).toISOString(),
    };
  };
  const terminal = {
    start: async (input: {
      command: string;
      cwd: string;
      id?: string;
      sessionID?: string;
    }) => {
      const started = await host.start(input);
      return {
        id: started.id,
        host: "pty" as const,
        paneID: started.paneID,
        windowID: started.windowID,
        muxWindowID: started.windowID,
        tabID: started.tabID,
        command: started.command,
        cwd: started.cwd,
        status: started.status,
        startedAt: started.startedAt,
      };
    },
    list: () => [view()],
    reconcile: async () => [view()],
    snapshot: async (id: string) => {
      const [pane] = host.list();
      return {
        ...view(),
        id,
        text: await host.read(),
        cursorX: pane?.cursor_x ?? 0,
        cursorY: pane?.cursor_y ?? 0,
        rows: pane?.rows ?? 24,
        cols: pane?.cols ?? 80,
        revision: 0,
      };
    },
    observe: async (
      id: string,
      afterRevision: number,
      _options?: { maxLines?: number; timeoutMs?: number },
    ) => {
      const snap = await terminal.snapshot(id);
      return {
        id,
        text: snap.text,
        cursorX: snap.cursorX,
        cursorY: snap.cursorY,
        rows: snap.rows,
        cols: snap.cols,
        revision: snap.revision,
        currentRevision: snap.revision,
        afterRevision,
        changed: snap.revision > afterRevision,
        reason: "latest" as const,
        session: { revision: snap.revision },
      };
    },
    read: async () => {
      const [pane] = host.list();
      return {
        text: await host.read(),
        startLine: null,
        endLine: null,
        totalLines: null,
        startByte: null,
        endByte: null,
        totalBytes: null,
        cursorX: pane?.cursor_x ?? 0,
        cursorY: pane?.cursor_y ?? 0,
        rows: pane?.rows ?? 24,
        cols: pane?.cols ?? 80,
      };
    },
    session: (id: string) => ({
      id,
      host: "pty" as const,
      paneID: 73,
      windowID: 3,
      muxWindowID: 3,
      tabID: 5,
      command: "cat",
      cwd: ".",
      status: "running" as const,
      startedAt: new Date(0).toISOString(),
      lastObservedText: "",
      lastObservedRevision: 0,
      inputOwner: "model" as const,
      revision: 0,
    }),
    markObserved: (_id: string, text: string, revision: number) => revision,
    lastObservedRevision: () => 0,
    write: async (
      id: string,
      value: string,
      options?: { idempotencyKey?: string },
    ) => {
      const before = host.writes.length;
      await host.write(id, value, options);
      return {
        writtenBytes: value.length,
        delivery:
          host.writes.length === before
            ? ("duplicate" as const)
            : ("accepted" as const),
      };
    },
    stop: async (id: string) => {
      await host.stop(id);
      return view("exited");
    },
  };
  return {
    workspaceRoot,
    terminal: terminal as unknown as TerminalToolService,
  };
}

/** A ready-made host whose answers each test overrides. */
function fakeHost(
  answers: {
    pane?: number;
    text?: string;
    reads?: string[];
    geometry?: {
      rows?: number;
      cols?: number;
      cursorX?: number;
      cursorY?: number;
    };
  } = {},
): FakeHost & { writes: string[] } {
  const writes: string[] = [];
  const pane = answers.pane ?? 73;
  const geometry = answers.geometry ?? {};
  const reads = answers.reads ? [...answers.reads] : undefined;
  let human = false;
  const seenKeys = new Set<string>();
  return {
    writes,
    async start(input) {
      return {
        id: input.id ?? "tty",
        host: "pty",
        paneID: pane,
        windowID: 3,
        muxWindowID: 3,
        tabID: 5,
        command: input.command,
        cwd: input.cwd,
        status: "running",
        startedAt: new Date().toISOString(),
      };
    },
    list() {
      return [
        {
          pane_id: pane,
          window_id: 3,
          tab_id: 5,
          rows: geometry.rows ?? 24,
          cols: geometry.cols ?? 80,
          cursor_x: geometry.cursorX ?? 0,
          cursor_y: geometry.cursorY ?? 0,
        },
      ];
    },
    async read() {
      if (reads && reads.length > 1) return reads.shift()!;
      return reads ? reads[0]! : (answers.text ?? "native terminal output");
    },
    async write(_id, value, options) {
      if (human) throw new Error("controlled by a human");
      if (options?.idempotencyKey) {
        if (seenKeys.has(options.idempotencyKey)) return;
        seenKeys.add(options.idempotencyKey);
      }
      writes.push(value);
    },
    async stop() {},
    async openHub() {},
    async claimHumanInput() {
      human = true;
    },
    async releaseHumanControl() {
      human = false;
    },
  };
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
  const nativeTerminal = fakeHost({ text: "native terminal output" });
  const writes = nativeTerminal.writes;
  const context = fakeHostToolContext(root, nativeTerminal);
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
  ).toMatchObject({ writtenBytes: 15, delivery: "accepted" });
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
  await nativeTerminal.openHub?.();
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
  const nativeTerminal = fakeHost({ text: "native terminal output" });
  const writes = nativeTerminal.writes;
  const context = fakeHostToolContext(root, nativeTerminal);
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
  const nativeTerminal = fakeHost({ text: "snapshot output" });
  const context = fakeHostToolContext(root, nativeTerminal);
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
    host: "pty",
    text: "snapshot output",
    cursorX: 0,
    cursorY: 0,
    rows: 24,
    cols: 80,
    status: "running",
  });
  expect(typeof snap.revision).toBe("number");
  expect(tools.has("interactive_snapshot")).toBe(true);
  await tools
    .get("interactive_terminal_stop")!
    .execute({ id: "tty_snapshot" }, context);
});

test("terminal observe latest mode returns current state without waiting", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-observe-"));
  const nativeTerminal = fakeHost({ text: "latest output" });
  const context = fakeHostToolContext(root, nativeTerminal);
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
  const nativeTerminal = fakeHost({
    text: "line1\nline2\nline3\nline4\nline5\n",
  });
  const context = fakeHostToolContext(root, nativeTerminal);
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
  const nativeTerminal = fakeHost({ text: lines, geometry: { cursorY: 15 } });
  const context = fakeHostToolContext(root, nativeTerminal);
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
  const nativeTerminal = fakeHost({
    reads: ["initial text\n", "new line 1\nnew line 2\n"],
  });
  const context = fakeHostToolContext(root, nativeTerminal);
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
  const nativeTerminal = fakeHost({ text: "native terminal output" });
  const writes = nativeTerminal.writes;
  const context = fakeHostToolContext(root, nativeTerminal);
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
  const nativeTerminal = fakeHost({ text: "no afterRevision output" });
  const context = fakeHostToolContext(root, nativeTerminal);
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
  const nativeTerminal = fakeHost({ text: "screen contents" });
  const context = fakeHostToolContext(root, nativeTerminal);
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

// --- The command-level read, as a model-facing tool -------------------------
//
// The route a model actually takes: tool -> service -> pane. A pty controller
// built over a stub pty stands in for the shell, and emits the markers the way a
// marked-up shell does.

const ESC = "\u001b";
const BEL = "\u0007";
const cmdPromptStart = `${ESC}]133;A${BEL}`;
const cmdExecuted = `${ESC}]133;C${BEL}`;
const cmdFinished = (code?: number) =>
  `${ESC}]133;D${code === undefined ? "" : `;${code}`}${BEL}`;
const cmdLineMarker = (command: string) =>
  `${ESC}]633;E;${command.replace(/\\/g, "\\\\").replace(/;/g, "\\x3b")}${BEL}`;

function stubPtyForCommands(): {
  factory: PtyFactory;
  emit: (d: string) => void;
} {
  const listeners = new Set<(data: string) => void>();
  const factory: PtyFactory = () =>
    ({
      pid: 7,
      write(data: string) {
        for (const l of listeners) l(data.replace(/\n/g, "\r\n"));
      },
      resize() {},
      kill() {},
      onData(listener: (data: string) => void) {
        listeners.add(listener);
        return {
          dispose() {
            listeners.delete(listener);
          },
        };
      },
      onExit() {
        return { dispose() {} };
      },
    }) as unknown as PtyProcess;
  return {
    factory,
    emit: (data) => {
      for (const l of listeners) l(data);
    },
  };
}

/** The pane and the tools, wired the way the runtime wires them. */
async function commandToolSetup() {
  const root = await mkdtemp(join(tmpdir(), "natalia-command-tool-"));
  const { factory, emit } = stubPtyForCommands();
  const terminal = createPtyTerminalController({
    workspaceRoot: root,
    publish: () => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "runtime-test",
    userRuntimeHome: () => undefined,
    windowMode: () => "windowless" as const,
    spawn: factory,
  });
  const tools = new Map<string, RuntimeTool>();
  for (const tool of terminalTools()) tools.set(tool.name, tool);
  await terminal.start({ command: "bash", cwd: root, id: "tty_cmd" });
  return {
    root,
    terminal: <never>terminal,
    emit,
    call: (id: string) =>
      tools.get(id)!.execute({ id: "tty_cmd" }, <never>{ terminal }),
    dispose: async () => {
      await terminal.close?.();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("the command-level tool reports the command, its exit code and its output", async () => {
  const pane = await commandToolSetup();
  emit_cycle(pane.emit, "echo hi", "hi\r\n", 0);
  const read = JSON.parse(await pane.call("interactive_terminal_last_command"));
  expect(read.commandLine).toBe("echo hi");
  expect(read.exitCode).toBe(0);
  expect(read.output).toContain("hi");
  expect(read.atPrompt).toBe(true);
  await pane.dispose();
});

test("the two read surfaces are both reachable, and the command one names the other", async () => {
  const pane = await commandToolSetup();
  // Same pane, two questions. The command read answers what a command produced;
  // the screen read answers what is on screen now.
  emit_cycle(pane.emit, "echo alpha", "alpha\r\n", 0);
  const byCommand = JSON.parse(
    await pane.call("interactive_terminal_last_command"),
  );
  const byScreen = JSON.parse(await pane.call("interactive_terminal_read"));
  expect(byCommand.output).toContain("alpha");
  expect(byScreen.text).toContain("alpha");
  // The screen read reports the served window and the document's extent, so
  // the model can walk the scrollback instead of guessing where the window it
  // just received sits. A real pane keeps its document in-process, so these
  // are numbers, never nulls.
  expect(byScreen.window?.startLine).toBeGreaterThanOrEqual(0);
  expect(byScreen.window?.lineCount).toBeGreaterThanOrEqual(1);
  expect(byScreen.totalLines).toBeGreaterThanOrEqual(byScreen.window.lineCount);
  // Reachable under the short alias too: a model that learned "interactive_read"
  // reaches for the sibling by the same shape of name.
  const aliases = interactiveTerminalToolAliases;
  expect(aliases.interactive_last_command).toBe(
    "interactive_terminal_last_command",
  );
  await pane.dispose();
});

/** A full command cycle, the way a marked-up shell emits one. */
function emit_cycle(
  emit: (data: string) => void,
  command: string,
  output: string,
  exitCode: number | undefined,
) {
  emit(
    cmdPromptStart +
      cmdLineMarker(command) +
      cmdExecuted +
      output +
      cmdFinished(exitCode),
  );
}

test("the command-level tool names a pane that has run no command yet (T-07)", async () => {
  // A fresh pane has no commandLine: the answer used to be a record whose
  // command field was simply absent — a model cannot tell "no command ran"
  // from "the backend forgot". The honest state names itself and points at
  // the per-moment read.
  const pane = await commandToolSetup();
  const read = JSON.parse(await pane.call("interactive_terminal_last_command"));
  expect(read.commandLine).toBeNull();
  expect(read.note).toContain("no command has run in this pane yet");
  expect(read.note).toContain("interactive_terminal_read");
  // Once a cycle runs, the same read carries the command again.
  emit_cycle(pane.emit, "echo hi", "hi\r\n", 0);
  const after = JSON.parse(
    await pane.call("interactive_terminal_last_command"),
  );
  expect(after.commandLine).toBe("echo hi");
  expect(after.note).toBeUndefined();
  await pane.dispose();
});

test("scrollback search without a starting point fails with guidance (T-08)", async () => {
  // startLine/cursor are optional in the schema but required in fact — the
  // schema vocabulary has no "either". The failure therefore has to teach:
  // what to pass and what the values mean.
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-search-start-"));
  const { factory } = fakePtyForBehavior();
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
    .execute({ command: "bash", cwd: root, id: "tty_nostart" }, context);
  await expect(
    tools
      .get("interactive_terminal_search")!
      .execute({ id: "tty_nostart", query: "anything" }, context),
  ).rejects.toThrow(/starting point/);
  // The guidance names both doors and what the numbers mean.
  await expect(
    tools
      .get("interactive_terminal_search")!
      .execute({ id: "tty_nostart", query: "anything" }, context),
  ).rejects.toThrow(/startLine/);
  await expect(
    tools
      .get("interactive_terminal_search")!
      .execute({ id: "tty_nostart", query: "anything" }, context),
  ).rejects.toThrow(/cursor/);
  await tools
    .get("interactive_terminal_stop")!
    .execute({ id: "tty_nostart" }, context);
});

test("a model write on a human-taken pane is refused naming the current owner (T-06)", async () => {
  // The user's own correction: the takeover is the USER's action, so the
  // refusal must not speculate about a previous owner — it must say what the
  // owner state IS right now. The old message ("terminal input is
  // controlled by a human") never did.
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-owner-"));
  const { factory } = fakePtyForBehavior();
  const controller = createPtyTerminalController({
    workspaceRoot: root,
    publish: () => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "rt",
    userRuntimeHome: () => undefined,
    windowMode: () => "windowless" as const,
    spawn: factory,
  });
  await controller.start({ command: "bash", cwd: root, id: "tty_owner" });
  // The user takes over (the only way the owner flips — the tool's own
  // correction: this is a user action, never automatic).
  await controller.claimHumanInput("tty_owner");
  await expect(
    controller.write("tty_owner", "echo model-write\n", { actor: "model" }),
  ).rejects.toThrow(/inputOwner=human/u);
  await expect(
    controller.write("tty_owner", "echo model-write\n", { actor: "model" }),
  ).rejects.toThrow(/the user took over this pane/u);
  // The guidance says what waits for what.
  await expect(
    controller.write("tty_owner", "echo model-write\n", { actor: "model" }),
  ).rejects.toThrow(/release control/u);
  // After the user releases, the model's write lands again.
  await controller.releaseHumanControl("tty_owner");
  await expect(
    controller.write("tty_owner", "echo model-write\n", { actor: "model" }),
  ).resolves.toBeTruthy();
  await controller.stop("tty_owner", "system");
});

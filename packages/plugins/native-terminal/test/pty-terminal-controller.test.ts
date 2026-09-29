import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPtyTerminalController,
  type PtyFactory,
  type PtyProcess,
} from "../src";

function fakePty(): { factory: PtyFactory; processes: PtyProcess[] } {
  const processes: PtyProcess[] = [];
  let nextPid = 1000;
  const factory: PtyFactory = () => {
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<
      (event: { exitCode: number; signal?: number }) => void
    >();
    const process: PtyProcess & {
      emit(data: string): void;
      exit(code?: number): void;
    } = {
      pid: nextPid++,
      write(data) {
        // A real pty's echo applies ONLCR: the newline reaches the
        // reader as CRLF. The fake mirrors that, so the rendered screen
        // matches a real pane's.
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

function controllerInput(
  root: string,
  spawn: PtyFactory,
  events: unknown[] = [],
  extra: Record<string, unknown> = {},
) {
  return {
    workspaceRoot: root,
    publish: (event: unknown) => {
      events.push(event);
    },
    onPerformance: () => undefined,
    runtimeID: () => "runtime-test",
    userRuntimeHome: () => undefined,
    windowMode: () => "windowless" as const,
    spawn,
    ...extra,
  };
}

test("pty controller start is idempotent per terminal id, not per natalia session", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-idempotent-"));
  const { factory, processes } = fakePty();
  const controller = createPtyTerminalController(
    controllerInput(root, factory),
  );
  await controller.init();
  await controller.init();
  const first = await controller.start({
    command: "bash",
    cwd: root,
    id: "term_a",
    sessionID: "ses_one",
  });
  const same = await controller.start({
    command: "zsh",
    cwd: root,
    id: "term_a",
    sessionID: "ses_one",
  });
  const second = await controller.start({
    command: "zsh",
    cwd: root,
    id: "term_b",
    sessionID: "ses_one",
  });
  expect(same.id).toBe(first.id);
  expect(second.id).not.toBe(first.id);
  expect(first.host).toBe("pty");
  expect(processes).toHaveLength(2);
  expect(await controller.list()).toHaveLength(2);
  await controller.close();
});

test("pty controller start with the same id returns the running session", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-same-id-"));
  const { factory, processes } = fakePty();
  const controller = createPtyTerminalController(
    controllerInput(root, factory),
  );
  const first = await controller.start({
    command: "bash",
    cwd: root,
    id: "term_web",
  });
  const second = await controller.start({
    command: "bash",
    cwd: root,
    id: "term_web",
  });
  expect(second.id).toBe(first.id);
  expect(processes).toHaveLength(1);
  await controller.close();
});

test("pty controller write, read, resize, and observe", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-io-"));
  const { factory } = fakePty();
  const controller = createPtyTerminalController(
    controllerInput(root, factory),
  );
  const started = await controller.start({ command: "cat", cwd: root });
  const written = await controller.write(started.id, "hello\n");
  expect(written).toEqual({ writtenBytes: 6, delivery: "accepted" });
  const duplicate = await controller.write(started.id, "hello\n", {
    idempotencyKey: "k1",
  });
  expect(duplicate.delivery).toBe("accepted");
  const again = await controller.write(started.id, "hello\n", {
    idempotencyKey: "k1",
  });
  expect(again.delivery).toBe("duplicate");
  const snapshot = await controller.snapshot(started.id);
  // The rendered screen: a grid has used rows, not a byte tail — the
  // trailing newline of the raw echo is a cursor move, not a line.
  expect(snapshot.text).toBe("hello\nhello");
  const read = await controller.read(started.id);
  expect(read.text).toBe("hello\nhello");

  const resized = await controller.resize(started.id, 40, 120, "human");
  expect(resized.rows).toBe(40);
  expect(resized.cols).toBe(120);
  const observed = await controller.observe(started.id, 0, { timeoutMs: 50 });
  expect(observed.changed).toBe(true);
  await controller.close();
});

test("pty controller close kills remaining processes and rejects later start", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-close-"));
  const { factory, processes } = fakePty();
  const controller = createPtyTerminalController(
    controllerInput(root, factory),
  );
  await controller.start({ command: "bash", cwd: root, sessionID: "ses_a" });
  await controller.close();
  await controller.close();
  expect(await controller.list()).toEqual([]);
  expect((processes[0] as { pid: number }).pid).toBeGreaterThan(0);
  await expect(
    controller.start({ command: "bash", cwd: root }),
  ).rejects.toThrow("terminal controller is closed");
  await expect(controller.init()).rejects.toThrow(
    "terminal controller is closed",
  );
});

test("pty controller start without an id creates a new terminal each time", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-default-"));
  const { factory, processes } = fakePty();
  const controller = createPtyTerminalController(
    controllerInput(root, factory),
  );
  const first = await controller.start({ command: "bash", cwd: root });
  const second = await controller.start({ command: "bash", cwd: root });
  expect(second.id).not.toBe(first.id);
  expect(processes).toHaveLength(2);
  await controller.close();
});

test("pty controller isolates sessions via setActiveSession", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-isolate-"));
  const { factory, processes } = fakePty();
  const controller = createPtyTerminalController(
    controllerInput(root, factory),
  );
  controller.setActiveSession("ses_a");
  const a = await controller.start({
    command: "bash",
    cwd: root,
    sessionID: "ses_a",
  });
  controller.setActiveSession("ses_b");
  const b = await controller.start({
    command: "bash",
    cwd: root,
    sessionID: "ses_b",
  });
  expect(a.id).not.toBe(b.id);
  expect(processes).toHaveLength(2);
  expect(await controller.list()).toEqual([
    expect.objectContaining({ id: b.id }),
  ]);
  await expect(controller.read(a.id)).rejects.toThrow(/belongs to session/);
  await expect(controller.write(a.id, "from-b\n")).rejects.toThrow(
    /belongs to session/,
  );
  controller.setActiveSession("ses_a");
  expect((await controller.list()).map((session) => session.id)).toEqual([
    a.id,
  ]);
  expect((await controller.read(a.id)).text).toBe("");
  await expect(controller.write(a.id, "from-a\n")).resolves.toMatchObject({
    delivery: "accepted",
  });
  await controller.close();
});

test("pty controller subscribeOutput replays buffer then live chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-subscribe-"));
  const { factory, processes } = fakePty();
  const controller = createPtyTerminalController(
    controllerInput(root, factory),
  );
  const started = await controller.start({ command: "cat", cwd: root });
  await controller.write(started.id, "hello\n");
  const chunks: string[] = [];
  const unsubscribe = controller.subscribeOutput!(started.id, (chunk) => {
    chunks.push(chunk);
  });
  // The echo's CRLF reality (ONLCR): a real pty translates the newline,
  // and the live-chunk listeners see the pane's actual bytes.
  expect(chunks).toEqual(["hello\r\n"]);
  (processes[0] as PtyProcess & { emit(data: string): void }).emit("world\n");
  expect(chunks).toEqual(["hello\r\n", "world\n"]);
  unsubscribe();
  (processes[0] as PtyProcess & { emit(data: string): void }).emit("ignored\n");
  expect(chunks).toEqual(["hello\r\n", "world\n"]);
  await controller.close();
});

test("default python pty spawn runs an interactive shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-python-pty-"));
  const controller = createPtyTerminalController({
    workspaceRoot: root,
    publish: () => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "runtime-test",
    userRuntimeHome: () => undefined,
    windowMode: () => "windowless",
  });
  const started = await controller.start({
    command: "printf '__PTY_READY__\\n'",
    cwd: root,
    sessionID: "ses_python_pty",
  });
  expect(started.host).toBe("pty");
  let text = "";
  const unsubscribe = controller.subscribeOutput!(started.id, (chunk) => {
    text += chunk;
  });
  const deadline = Date.now() + 8_000;
  while (!text.includes("__PTY_READY__") && Date.now() < deadline)
    await Bun.sleep(50);
  unsubscribe();
  expect(text).toContain("__PTY_READY__");
  await controller.close();
}, 15_000);

test("input written the instant a pty starts is not dropped by the bridge", async () => {
  // Regression: the python bridge reads the startup spec with its own line
  // reader. An input message that landed in the same socket read as the spec
  // was left in that reader's buffer while the select loop only watched for
  // NEW bytes, so the first write of a freshly started terminal vanished.
  // Hosts write the moment start() resolves, so the wait is deliberately zero.
  const root = await mkdtemp(join(tmpdir(), "natalia-python-pty-race-"));
  const controller = createPtyTerminalController({
    workspaceRoot: root,
    publish: () => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "runtime-test",
    userRuntimeHome: () => undefined,
    windowMode: () => "windowless",
  });
  const started = await controller.start({
    // The managed pane shell wraps commands in a profile-sourcing `sh -lc`;
    // the bash
    // inside is interactive but must not read the developer's rc files to
    // keep the test deterministic.
    command: "exec bash --norc --noprofile",
    cwd: root,
    sessionID: "ses_python_pty_race",
  });
  expect(started.host).toBe("pty");
  await controller.write(started.id, "printf '__PTY_READY__\\n'\n");
  let text = "";
  const unsubscribe = controller.subscribeOutput!(started.id, (chunk) => {
    text += chunk;
  });
  const deadline = Date.now() + 8_000;
  while (!text.includes("__PTY_READY__") && Date.now() < deadline)
    await Bun.sleep(50);
  unsubscribe();
  expect(text).toContain("__PTY_READY__");
  await controller.close();
}, 15_000);
test("pty controller caps running terminals per natalia session", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-cap-"));
  const { factory, processes } = fakePty();
  const controller = createPtyTerminalController({
    ...controllerInput(root, factory),
    maxPerSession: 2,
  });
  await controller.start({
    command: "bash",
    cwd: root,
    id: "term_1",
    sessionID: "ses_cap",
  });
  await controller.start({
    command: "bash",
    cwd: root,
    id: "term_2",
    sessionID: "ses_cap",
  });
  await expect(
    controller.start({
      command: "bash",
      cwd: root,
      id: "term_3",
      sessionID: "ses_cap",
    }),
  ).rejects.toThrow("session already has 2 running terminals");
  expect(processes).toHaveLength(2);
  await controller.close();
});

test("pty controller recycles the oldest idle terminal when the cap is hit", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-idle-"));
  const { factory, processes } = fakePty();
  const controller = createPtyTerminalController({
    ...controllerInput(root, factory),
    maxPerSession: 2,
    idleMs: 20,
  });
  const first = await controller.start({
    command: "bash",
    cwd: root,
    id: "term_old",
    sessionID: "ses_idle",
  });
  await controller.start({
    command: "bash",
    cwd: root,
    id: "term_new",
    sessionID: "ses_idle",
  });
  await Bun.sleep(30);
  const third = await controller.start({
    command: "bash",
    cwd: root,
    id: "term_third",
    sessionID: "ses_idle",
  });
  expect(third.id).toBe("term_third");
  expect(processes).toHaveLength(3);
  const listed = (await controller.list()).filter(
    (session) => session.status === "running",
  );
  expect(listed.map((session) => session.id).sort()).toEqual([
    "term_new",
    "term_third",
  ]);
  expect(listed.find((session) => session.id === first.id)).toBeUndefined();
  await controller.close();
});

test("pty controller stopForSession kills every pane of that session", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-stop-session-"));
  const { factory } = fakePty();
  const controller = createPtyTerminalController(
    controllerInput(root, factory),
  );
  await controller.start({
    command: "bash",
    cwd: root,
    id: "a1",
    sessionID: "ses_a",
  });
  await controller.start({
    command: "bash",
    cwd: root,
    id: "a2",
    sessionID: "ses_a",
  });
  await controller.start({
    command: "bash",
    cwd: root,
    id: "b1",
    sessionID: "ses_b",
  });
  await controller.stopForSession!("ses_a");
  controller.setActiveSession("ses_a");
  expect(
    (await controller.list()).filter((session) => session.status === "running"),
  ).toEqual([]);
  controller.setActiveSession("ses_b");
  expect(
    (await controller.list())
      .filter((session) => session.status === "running")
      .map((session) => session.id),
  ).toEqual(["b1"]);
  await controller.close();
});

test("pty controller refuses to reuse a terminal id from another session", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-owner-"));
  const { factory } = fakePty();
  const controller = createPtyTerminalController(
    controllerInput(root, factory),
  );
  await controller.start({
    command: "bash",
    cwd: root,
    id: "term_shared",
    sessionID: "ses_a",
  });
  await expect(
    controller.start({
      command: "bash",
      cwd: root,
      id: "term_shared",
      sessionID: "ses_b",
    }),
  ).rejects.toThrow("belongs to session ses_a");
  await controller.close();
});

test("the pane reads as its rendered screen, not its byte stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-render-"));
  const { factory, processes } = fakePty();
  const controller = createPtyTerminalController(
    controllerInput(root, factory),
  );
  await controller.start({
    command: "bash",
    cwd: root,
    id: "term_render",
    sessionID: "ses_render",
  });
  // The app's redraw shape: clear, home, write. The raw capture would
  // carry the escapes; the read returns the rendered text.
  (processes[0] as PtyProcess & { emit(data: string): void }).emit(
    "\x1b[2J\x1b[Hloading...\r\x1b[Kready on 5178",
  );
  const read = await controller.read("term_render");
  expect(read.text).toBe("ready on 5178");
  expect(read.text).not.toContain("\x1b");
  await controller.close();
});

test("a quiet pane emits one settled frame notice and stays quiet", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-frame-"));
  const { factory, processes } = fakePty();
  const notices: Array<{ sessionID: string; notice: Record<string, unknown> }> =
    [];
  const controller = createPtyTerminalController({
    ...controllerInput(root, factory),
    settlement: {
      deliverForSession: (
        sessionID: string,
        notice: Record<string, unknown>,
      ) => {
        notices.push({ sessionID, notice });
        return true;
      },
    },
    frameSettleMs: 20,
  });
  await controller.start({
    command: "bash",
    cwd: root,
    id: "term_frame",
    sessionID: "ses_frame",
  });
  (processes[0] as PtyProcess & { emit(data: string): void }).emit(
    "server up\r\n",
  );
  await Bun.sleep(80);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({
    sessionID: "ses_frame",
    notice: {
      subject: "term_frame",
      reason: "settled",
      sourceKind: "terminal-settled",
    },
  });
  // The same screen after another quiet window: no second notice.
  (processes[0] as PtyProcess & { emit(data: string): void }).emit("");
  await Bun.sleep(80);
  expect(notices).toHaveLength(1);
  await controller.close();
});

test("a frame with new scrollback reports scrolled, not settled", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-scroll-"));
  const { factory, processes } = fakePty();
  const notices: Array<Record<string, unknown>> = [];
  const controller = createPtyTerminalController({
    ...controllerInput(root, factory),
    settlement: {
      deliverForSession: (
        _sessionID: string,
        notice: Record<string, unknown>,
      ) => {
        notices.push(notice);
        return true;
      },
    },
    frameSettleMs: 20,
  });
  await controller.start({
    command: "bash",
    cwd: root,
    id: "term_scroll",
    sessionID: "ses_scroll",
    // A screenful is defined by the grid, so say so: 4 rows by 40 lines is
    // always an overflow, whatever the spawn default happens to be.
    rows: 4,
    cols: 20,
  });
  // A screenful of new lines: the scrollback grows past its last frame.
  for (let line = 0; line < 30; line += 1)
    (processes[0] as PtyProcess & { emit(data: string): void }).emit(
      `line ${line}\r\n`,
    );
  await Bun.sleep(80);
  expect(notices.length).toBeGreaterThanOrEqual(1);
  expect(notices.at(-1)).toMatchObject({
    reason: "scrolled",
    sourceKind: "terminal-settled",
  });
  await controller.close();
});

test("without the spine the pane renders and stays silent", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-bare-"));
  const { factory, processes } = fakePty();
  const controller = createPtyTerminalController(
    controllerInput(root, factory),
  );
  await controller.start({
    command: "bash",
    cwd: root,
    id: "term_bare",
    sessionID: "ses_bare",
  });
  (processes[0] as PtyProcess & { emit(data: string): void }).emit(
    "plain text",
  );
  await Bun.sleep(60);
  expect((await controller.read("term_bare")).text).toBe("plain text");
  await controller.close();
});

test("read pages the scrollback, not just the viewport", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-history-"));
  const { factory, processes } = fakePty();
  const controller = createPtyTerminalController(
    controllerInput(root, factory),
  );
  await controller.start({
    command: "bash",
    cwd: root,
    id: "term_history",
    sessionID: "ses_history",
  });
  // More lines than the viewport: the older ones scroll off into the
  // renderer's scrollback.
  for (let line = 0; line < 40; line += 1)
    (processes[0] as PtyProcess & { emit(data: string): void }).emit(
      `log line ${line}\r\n`,
    );
  // The default range is the document's tail window (the host's
  // `-maxLines`: scrollback plus viewport), here all 40 lines.
  const tail = await controller.read("term_history");
  expect(tail.text.split("\n")).toHaveLength(40);
  expect(tail.text).toContain("log line 39");
  // Line 0 is the OLDEST scrolled-off line — the history is reachable.
  const oldest = await controller.read("term_history", {
    startLine: 0,
    maxLines: 5,
  });
  expect(oldest.text.split("\n")[0]).toBe("log line 0");
  expect(oldest.text).toContain("log line 4");
  // An explicit range pages the middle.
  const middle = await controller.read("term_history", {
    startLine: 10,
    endLine: 12,
  });
  expect(middle.text.split("\n")).toEqual([
    "log line 10",
    "log line 11",
    "log line 12",
  ]);
  // Negative lines count from the end (the host's own convention).
  const fromEnd = await controller.read("term_history", {
    startLine: -3,
  });
  expect(fromEnd.text.split("\n")).toEqual([
    "log line 37",
    "log line 38",
    "log line 39",
  ]);
  // A document longer than the window: the default read is still the
  // bounded tail, not everything.
  for (let line = 40; line < 100; line += 1)
    (processes[0] as PtyProcess & { emit(data: string): void }).emit(
      `log line ${line}\r\n`,
    );
  const bounded = await controller.read("term_history", { maxLines: 60 });
  const boundedLines = bounded.text.split("\n");
  expect(boundedLines).toHaveLength(60);
  expect(boundedLines[0]).toBe("log line 40");
  expect(boundedLines.at(-1)).toBe("log line 99");
  await controller.close();
});

test("resize carries the pane's geometry into the screen the model reads", async () => {
  // The regression: resize() resized the pty and the metadata but never the
  // rendered screen, so the model's window stayed at the spawn-time 24x80
  // forever — a full-screen TUI clipped to 80 columns, and the human's pane
  // resize invisible to every read surface.
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-resize-screen-"));
  const { factory } = fakePty();
  const controller = createPtyTerminalController(
    controllerInput(root, factory),
  );
  const started = await controller.start({ command: "cat", cwd: root });
  // More lines than the grid's rows: the overflow is what makes the scrollback
  // carry content, and the scrollback is the part a resize must never lose.
  const lines = Array.from(
    { length: 60 },
    (_unused, index) => `scroll-${index}`,
  );
  for (const line of lines) await controller.write(started.id, `${line}\r\n`);
  // The echo travels the write's delivery chain, so wait for the screen to
  // carry it before asserting on what a resize keeps.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const before = await controller.read(started.id);
    if (before.text.includes("scroll-9")) break;
    await Bun.sleep(10);
  }

  // The pane's geometry, deliberately different from the spawn default so the
  // resize is a real geometry change rather than a no-op guard.
  await controller.resize(started.id, 60, 240, "human");

  const after = await controller.read(started.id);
  expect(after.rows).toBe(60);
  expect(after.cols).toBe(240);
  // The scrollback is the durable part, and it survives the resize.
  expect(after.text).toContain("scroll-0");
  // The rendered screen — the model's window, the pane's size — is re-blanked
  // (the app redraws for the new geometry), so the window is empty and its size
  // is the pane's, not the spawn-time default.
  const window = await controller.snapshot(started.id);
  expect(window.rows).toBe(60);
  expect(window.cols).toBe(240);
  expect(window.text).toBe("");
  await controller.close();
});

test("a settle notice only fires for the model's own terminal", async () => {
  // The user's report: opening a terminal in the UI woke Natalia. A pane the
  // human drives is the human's business; only the model's own tool-driven
  // terminal settles into a notice, because there the output IS the answer to
  // what it asked.
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-settle-owner-"));
  const { factory } = fakePty();
  const settlements: Array<{ subject: string; summary: string }> = [];
  const controller = createPtyTerminalController(
    controllerInput(root, factory, [], {
      settlement: {
        deliverForSession: (
          _sessionID: string,
          notice: { subject: string; summary: string },
        ) => {
          settlements.push({
            subject: notice.subject,
            summary: notice.summary,
          });
          return true;
        },
      },
      frameSettleMs: 50,
    }),
  );
  // The model's terminal: input owned by the model at spawn.
  const modelOwned = await controller.start({
    command: "cat",
    cwd: root,
    sessionID: "ses_model",
  });
  expect(modelOwned.inputOwner).toBe("model");
  await controller.write(modelOwned.id, "model output\r\n");
  await Bun.sleep(300);
  expect(settlements).toHaveLength(1);

  // A human pane: claimed by the human, so its output is not the model's news.
  // (And the model can no longer write to it at all — the same ownership that
  // gates the settle.)
  await controller.claimHumanInput!(modelOwned.id, "ses_model");
  await expect(
    controller.write(modelOwned.id, "model writes into a human pane\r\n"),
  ).rejects.toThrow("terminal input is controlled by a human");
  await controller.write(modelOwned.id, "human types here\r\n", {
    actor: "human",
  });
  await Bun.sleep(300);
  expect(settlements).toHaveLength(1);

  // A terminal nobody claimed (still model-owned) settles again.
  await controller.releaseHumanControl(modelOwned.id, "ses_model");
  await controller.write(modelOwned.id, "model terminal again\r\n");
  await Bun.sleep(300);
  expect(settlements).toHaveLength(2);

  await controller.close();
});

test("a terminal spawns at a grid a TUI can render, and honours a caller's size", async () => {
  // The old 24x80 default clipped every full-screen TUI this terminal exists to
  // run: vim's split, htop's meters and tmux's status line all ran out of
  // columns, and a 24-row window hid most of a build log. The session, the
  // rendered screen the model reads and the spawned pty must all agree on it.
  const root = await mkdtemp(join(tmpdir(), "natalia-pty-geometry-"));
  const { factory, processes } = fakePty();
  const controller = createPtyTerminalController(
    controllerInput(root, factory),
  );
  const spawned = processes[0];
  const spawnSizes: Array<{ rows: number; cols: number }> = [];
  // Record every spawn's geometry before the fake pty records nothing.
  const instrumented = createPtyTerminalController(
    controllerInput(root, factory),
  );

  const byId = await instrumented.start({
    command: "cat",
    cwd: root,
    id: "t_default",
  });
  expect(byId.rows).toBe(50);
  expect(byId.cols).toBe(200);
  const screenRead = await instrumented.read(byId.id);
  expect(screenRead.rows).toBe(50);
  expect(screenRead.cols).toBe(200);

  const sized = await instrumented.start({
    command: "cat",
    cwd: root,
    id: "t_sized",
    rows: 40,
    cols: 160,
  });
  expect(sized.rows).toBe(40);
  expect(sized.cols).toBe(160);

  const tiny = await instrumented.start({
    command: "cat",
    cwd: root,
    id: "t_tiny",
    rows: 0,
    cols: -3,
  });
  // A nonsensical size falls back to the default, never a zero-column pty.
  expect(tiny.rows).toBe(50);
  expect(tiny.cols).toBe(200);

  const huge = await instrumented.start({
    command: "cat",
    cwd: root,
    id: "t_huge",
    rows: 9000,
    cols: 9000,
  });
  // Upper-bounded so a caller cannot allocate an absurd grid.
  expect(huge.rows).toBe(500);
  expect(huge.cols).toBe(500);
  await instrumented.close();
  await controller.close();
});

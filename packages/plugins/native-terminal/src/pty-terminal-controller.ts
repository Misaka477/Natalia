import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  applyTerminalOutput,
  createTerminalScreen,
  renderScreen,
  renderScreenText,
  resizeTerminalScreen,
  type TerminalScreen,
} from "./terminal-screen";
import {
  initialCommandState,
  parseShellMarkers,
  foldShellMarkers,
  type CommandState,
} from "./shell-integration";
import {
  SETTLEMENT_SOURCE_KINDS,
  type SettlementService,
} from "@natalia/collaboration";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type {
  NativeTerminalOwnershipChange,
  RuntimeEvent,
  RuntimeNativeTerminalSession,
} from "@anthelia/contracts";
import type { TerminalController } from "@anthelia/runtime-services";
import { nativeTerminalPrebuiltDir } from "./prebuilt-dir";
import {
  nativeTerminalPaneCommand,
  nativeTerminalPaneSpawn,
} from "./pane-command";
import { terminalOutputChunk, trimScreenTail } from "./output-chunk";

/**
 * The spawn geometry for a terminal nobody sized yet.
 *
 * A vt100 24x80 was the old default, and it is too small for the full-screen
 * TUIs this terminal exists to run: vim's split, htop's meters and tmux's
 * status line all clip at 80 columns, and a 24-row window hides most of a
 * build log. The pane a human drags open is routinely 40+ rows and 150+ cols,
 * and a headless model terminal has no reason to be smaller: the cost is grid
 * memory (rows * cols cells), not pixels. 50x200 matches the pane and leaves
 * the room a TUI needs; a caller who knows better still passes rows/cols.
 */
const DEFAULT_ROWS = 50;
const DEFAULT_COLS = 200;
const MAX_OUTPUT_BYTES = 256 * 1024;
/** The default byte window when a caller says where to start but not where to stop. */
const MAX_BYTE_WINDOW = 64 * 1024;

/**
 * A caller's geometry, or the default when it is absent or nonsense.
 *
 * A negative or zero grid is not a small terminal, it is an invalid one —and
 * spawning at it produces a pty no program can draw into, so it falls back
 * rather than clamps up to one row. The upper bound stops a caller from
 * allocating an absurd grid for a screen that does not exist.
 */
function clampGeometry(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value < 1)
    return fallback;
  return Math.min(500, value);
}
const DEFAULT_MAX_PER_SESSION = 8;
const DEFAULT_IDLE_MS = 15 * 60 * 1000;

export type PtyProcess = {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
};

export type PtySpawnOptions = {
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  /**
   * The command text as it was requested, before the shell argv was derived.
   * The WezTerm adapter passes it to the host's own start (which applies the
   * same profile-shell wrapping once); the in-process PTYs use file/args.
   */
  command?: string;
};

export type PtyFactory = (options: PtySpawnOptions) => PtyProcess;

type PtySession = {
  id: string;
  sessionID?: string;
  agentID?: string;
  command: string;
  cwd: string;
  startedAt: string;
  status: "running" | "exited";
  inputOwner: "model" | "human";
  geometryOwner: "human";
  secureInput: boolean;
  attached: boolean;
  /** The most recent input-ownership transition, newest last. */
  lastOwnershipChange?: NativeTerminalOwnershipChange;
  /**
   * Whether this pane's shell ever emitted an integration marker (OSC 133).
   *
   * The command-level read (`interactive_terminal_last_command`) is built
   * from those markers, so a pane that runs fine without them has output on
   * screen and no commandLine — and the honest answer names the difference
   * instead of claiming no command ran (the 2026-10-07 smoke run: observe,
   * read and search all saw the command's output while last_command said
   * "no command has run in this pane yet").
   */
  sawShellMarkers: boolean;
  rows: number;
  cols: number;
  revision: number;
  output: string;
  /** The virtual screen the byte stream renders onto (the model's human view). */
  screen: TerminalScreen;
  /**
   * The command-level read: which command the pane is in and what it last
   * returned. Folded from the stream's shell-integration markers as bytes arrive,
   * so it is true at any moment without a second capture of anything.
   */
  commandState: CommandState;
  /**
   * The pane's full text when the current command's output began.
   *
   * The WHOLE text, not a scrollback depth: a pane that has not scrolled yet
   * still shows the previous command's output on its grid, so slicing the
   * scrollback from a depth would hand that output over as this command's.
   */
  outputBaseLines?: readonly string[];
  /** The last finished command's output, as a slice of the screen. */
  lastCommandOutput?: string;
  /** The last emitted frame's text (the diff base for scroll notices). */
  lastFrameText?: string;
  /** The scrollback depth at the last emitted frame. */
  lastFrameScrollback?: number;
  settleTimer?: ReturnType<typeof setTimeout>;
  lastObservedText?: string;
  lastObservedRevision?: number;
  lastModelWriteAt?: number;
  lastOutputAt?: number;
  lastActivityAt: number;
  pty?: PtyProcess;
  disposers: Array<{ dispose(): void }>;
};

export type PtyTerminalControllerInput = {
  workspaceRoot: string;
  publish(event: RuntimeEvent): void;
  onPerformance(name: string, durationMs: number): void;
  runtimeID(): string;
  userRuntimeHome(): string | undefined;
  windowMode(): "auto" | "windowless" | "window";
  spawn?: PtyFactory;
  maxPerSession?: number;
  idleMs?: number;
  /** The settlement bridge (resolved by the plugin's setup). */
  settlement?: SettlementService;
  /** How long the pane stays quiet before a frame is "settled". */
  frameSettleMs?: number;
};

const PYTHON_PTY_BRIDGE = `
import fcntl, json, os, pty, select, signal, struct, sys, termios

stdin = sys.stdin.fileno()
stdout = sys.stdout.fileno()
pending = b""

def read_line():
    global pending
    while True:
        index = pending.find(b"\\n")
        if index >= 0:
            line = pending[:index]
            pending = pending[index + 1:]
            return line.decode("utf-8")
        chunk = os.read(stdin, 4096)
        if not chunk:
            return None
        pending += chunk

spec = json.loads(read_line())
pid, master = pty.fork()
if pid == 0:
    os.chdir(spec["cwd"])
    env = os.environ.copy()
    env.update(spec.get("env") or {})
    os.execvpe(spec["file"], [spec["file"], *spec["args"]], env)
fcntl.ioctl(
    master,
    termios.TIOCSWINSZ,
    struct.pack("HHHH", spec["rows"], spec["cols"], 0, 0),
)
os.write(stdout, (json.dumps({"pid": pid}) + "\\n").encode("ascii"))

def send(kind, payload=b""):
    data = payload if isinstance(payload, bytes) else payload.encode("utf-8")
    os.write(stdout, f"{kind} {len(data)}\\n".encode("ascii"))
    if data:
        os.write(stdout, data)

def handle_line(line):
    message = json.loads(line)
    kind = message.get("type")
    if kind == "input":
        os.write(master, message.get("data", "").encode("utf-8"))
        return True
    if kind == "resize":
        fcntl.ioctl(
            master,
            termios.TIOCSWINSZ,
            struct.pack("HHHH", int(message["rows"]), int(message["cols"]), 0, 0),
        )
        return True
    if kind == "kill":
        os.kill(pid, signal.SIGTERM)
        return False
    return True

# A message can arrive in the same socket read as the startup spec —the host
# writes its first input the instant start() returns, before this interpreter
# has finished booting. read_line leaves such a line in pending, and the
# select loop below only reacts to NEW bytes, so without this drain the first
# input of a freshly started terminal is silently dropped. Process whatever
# the spec read already consumed before blocking in select.
alive = True
while True:
    index = pending.find(b"\\n")
    if index < 0:
        break
    line = pending[:index].decode("utf-8")
    pending = pending[index + 1:]
    if not handle_line(line):
        alive = False
        break

# A shell that runs a full line editor asks the terminal where the cursor is before it
# draws anything: OSC-133-aware PowerShell (through PSReadLine) sends DSR, ESC [ 6 n, on
# start and blocks until a terminal answers ESC [ <row> ; <col> R. This bridge IS that
# terminal -- it owns the pty the child writes into -- and it never answered. The child
# waits forever for a reply, its read-line call returns empty, and the command-level read
# comes back with no command at all. bash and zsh never notice because neither asks.
#
# The reply goes to the pty MASTER, which is the child's input -- where a terminal
# emulator's answer belongs, and why the pane's own output never shows it as such. A test
# therefore asserts on the shell reading its own stdin, not on the rendered screen.
#
# The answer is the window size, not a cursor position, because this bridge does not
# track the cursor: it forwards bytes rather than emulating a screen. An app asking
# "where is the cursor" gets "the extent of the terminal", which is enough for a line
# editor to lay itself out, and is honest about what is actually known here.
DSR_QUERY = b"\x1b[6n"

def answer_cursor_queries(chunk):
    if DSR_QUERY not in chunk:
        return chunk
    rows, cols = 24, 80
    try:
        packed = fcntl.ioctl(master, termios.TIOCGWINSZ, bytes(8))
        rows, cols = struct.unpack("HHHH", packed)[:2]
    except OSError:
        pass
    os.write(master, b"\x1b[%d;%dR" % (rows, cols))
    # Consumed rather than forwarded: the host renders a screen and has no more use for
    # the request than this bridge does.
    return chunk.replace(DSR_QUERY, b"")


while alive:
    readable, _, _ = select.select([stdin, master], [], [])
    if stdin in readable:
        chunk = os.read(stdin, 4096)
        if not chunk:
            alive = False
            break
        pending += chunk
        while True:
            index = pending.find(b"\\n")
            if index < 0:
                break
            line = pending[:index].decode("utf-8")
            pending = pending[index + 1:]
            if not handle_line(line):
                alive = False
                break
    if not alive:
        break
    if master in readable:
        try:
            chunk = os.read(master, 4096)
        except OSError:
            chunk = b""
        if not chunk:
            alive = False
            break
        send("o", answer_cursor_queries(chunk))
try:
    waited, status = os.waitpid(pid, 0)
    code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
except ChildProcessError:
    code = 0
send("x", str(code))
`;

function loadNodePty(): typeof import("node-pty") {
  const candidates = [
    import.meta.url,
    resolve(process.cwd(), "packages/plugins/native-terminal/package.json"),
    resolve(process.cwd(), "package.json"),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const pty = createRequire(candidate)(
        "node-pty",
      ) as typeof import("node-pty");
      if (typeof pty.spawn !== "function")
        throw new Error("node-pty spawn is missing");
      return pty;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("node-pty is not installed");
}

function spawnWithNodePty(options: PtySpawnOptions): PtyProcess {
  const pty = loadNodePty();
  const child = pty.spawn(options.file, options.args, {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
  });
  return {
    pid: child.pid,
    write(data) {
      child.write(data);
    },
    resize(cols, rows) {
      child.resize(cols, rows);
    },
    kill(signal) {
      child.kill(signal);
    },
    onData(listener) {
      return child.onData(listener);
    },
    onExit(listener) {
      return child.onExit(listener);
    },
  };
}

/**
 * The framing both PTY bridges speak: a JSON spec line on stdin; `{kind} {size}`
 * frames and a `{"pid":N}` handshake on stdout; JSON control lines back. The
 * POSIX implementation is the Rust bridge (native/pty-bridge), with the Python
 * one as its fallback; the Windows one is the ConPTY helper. The controller,
 * the panel and the model see the same real byte stream from either, so the
 * bridge in use is a detail of this file —which is what makes them
 * interchangeable, and what the two-bridge suite run proves.
 */
function spawnPtyBridge(
  child: ReturnType<typeof spawn>,
  options: PtySpawnOptions,
): PtyProcess {
  if (!child.stdin || !child.stdout || child.pid == null)
    throw new Error("pty bridge failed to start");
  child.stdin.write(
    `${JSON.stringify({
      file: options.file,
      args: options.args,
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      env: options.env ?? {},
    })}\n`,
  );
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();
  let pid = child.pid;
  let leftover = Buffer.alloc(0);
  let header: { kind: string; size: number } | undefined;
  let exited = false;

  function emitExit(exitCode: number) {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener({ exitCode });
  }

  function consume(chunk: Buffer) {
    leftover = Buffer.concat([leftover, chunk]);
    while (leftover.length) {
      if (!header) {
        const newline = leftover.indexOf(10);
        if (newline < 0) return;
        const line = leftover.subarray(0, newline).toString("utf8");
        leftover = leftover.subarray(newline + 1);
        if (line.startsWith("{")) {
          try {
            const parsed = JSON.parse(line) as { pid?: number };
            if (typeof parsed.pid === "number") pid = parsed.pid;
          } catch {
            // ignore malformed handshake
          }
          continue;
        }
        const match = /^(o|x) (\d+)$/u.exec(line);
        if (!match) continue;
        header = { kind: match[1]!, size: Number(match[2]) };
        continue;
      }
      if (leftover.length < header.size) return;
      const payload = leftover.subarray(0, header.size);
      leftover = leftover.subarray(header.size);
      if (header.kind === "o") {
        const text = payload.toString("utf8");
        for (const listener of dataListeners) listener(text);
      } else {
        emitExit(Number(payload.toString("utf8") || "0"));
      }
      header = undefined;
    }
  }

  const childEvents = child as unknown as NodeJS.EventEmitter & {
    stdout?: {
      on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
    };
  };
  childEvents.stdout?.on("data", (chunk) => {
    consume(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  });
  childEvents.on("exit", (code: number | null) => emitExit(code ?? 0));

  function send(message: Record<string, unknown>) {
    if (!child.stdin?.writable) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  return {
    get pid() {
      return pid;
    },
    write(data) {
      send({ type: "input", data });
    },
    resize(cols, rows) {
      send({ type: "resize", cols, rows });
    },
    kill() {
      send({ type: "kill" });
      child.kill();
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
  };
}

function spawnWithPythonPty(options: PtySpawnOptions): PtyProcess {
  return spawnPtyBridge(
    spawn("python3", ["-u", "-c", PYTHON_PTY_BRIDGE], {
      stdio: ["pipe", "pipe", "inherit"],
    }),
    options,
  );
}

/// The crate's own release build (a developer's answer), mirroring how the
/// fork's build dir is found: source layout has `native/pty-bridge/target`,
/// a store-loaded plugin does not and must use the prebuilt drop.
function rustBridgeBuildDir(): string {
  return import.meta.url.endsWith(".ts")
    ? join(import.meta.dir, "..", "native", "pty-bridge", "target", "release")
    : join(import.meta.dir, "native", "pty-bridge");
}

/**
 * The POSIX PTY, in Rust: packages/plugins/native-terminal/native/pty-bridge.
 *
 * The same wire protocol as the Python bridge —a JSON spec line in, `{kind}
 * {len}` frames and a `{pid}` handshake out, the same control lines, the same
 * DSR answer —so the controller cannot tell them apart. Why it exists: this
 * process touches every byte of every pane, and `cat`-ing a large file was
 * interpreter throughput in Python. The search mirrors the ConPTY helper's:
 * the prebuilt drop first (a downloaded Natalia's answer), then the crate's
 * own release build (a developer's).
 */
function spawnWithRustBridge(options: PtySpawnOptions): PtyProcess {
  const helperName = "natalia-pty-bridge";
  const candidates = [
    join(nativeTerminalPrebuiltDir("linux"), helperName),
    join(rustBridgeBuildDir(), helperName),
  ];
  const helper = candidates.find((candidate) => existsSync(candidate));
  if (!helper)
    throw new Error(
      `the pty bridge is not built: run native-terminal:build-pty-bridge (expected ${candidates[0]})`,
    );
  return spawnPtyBridge(
    spawn(helper, [], { stdio: ["pipe", "pipe", "inherit"] }),
    options,
  );
}

/**
 * The Windows PTY: a ConPTY host compiled from src/win/natalia-conpty-bridge.cc
 * (`npm run native-terminal:build-conpty:windows`), found in the prebuilt drop
 * the release archive makes. It is the platform's own pseudo console speaking
 * the POSIX bridge's protocol, so this path delivers the same real byte stream
 * Linux gets.
 */
function spawnWithConptyBridge(options: PtySpawnOptions): PtyProcess {
  const helperName = "natalia-conpty-bridge.exe";
  const helper = join(nativeTerminalPrebuiltDir("win32"), helperName);
  if (!existsSync(helper))
    throw new Error(
      `the ConPTY bridge is not built: run native-terminal:build-conpty:windows (expected ${helper})`,
    );
  return spawnPtyBridge(
    spawn(helper, [], { stdio: ["pipe", "pipe", "inherit"] }),
    options,
  );
}

function defaultSpawn(): PtyFactory {
  return (options) => {
    if (process.platform === "win32") {
      // The ConPTY bridge is the Windows default. Not an opt-in: the mute pane
      // it once produced (P23) is fixed and verified — the Windows CI's
      // conpty-native drives round-trip the typed line AND the command's
      // answer, the pane paints, and the exit frame reads the child's code —
      // and the two alternatives on this platform are dead weights on any
      // default build: the WezTerm mux adapter needed the fork's three natives
      // (the retirement removed them), and the Python bridge needs the POSIX
      // pty module (a runner pane died on `fcntl` before this flip). A missing
      // bridge binary throws with its build command in the message: loud,
      // never a silent degrade to a pane that cannot start.
      return spawnWithConptyBridge(options);
    }
    // POSIX: the Rust bridge is the default when it is built — the byte path
    // the user's performance decision asked for — with the Python bridge as
    // the fallback, so a missing binary degrades instead of failing. The env
    // var names one explicitly: "rust" THROWS when the binary is absent (a
    // run that asked for the Rust bridge must not silently measure the Python
    // one and call it a comparison), "python" pins the predecessor so both
    // bridges stay measurable side by side.
    const requested = process.env.NATALIA_TERMINAL_BRIDGE;
    if (requested !== "python") {
      try {
        return spawnWithRustBridge(options);
      } catch (error) {
        if (requested === "rust") throw error;
      }
    }
    if (typeof Bun !== "undefined") return spawnWithPythonPty(options);
    try {
      return spawnWithNodePty(options);
    } catch {
      return spawnWithPythonPty(options);
    }
  };
}

function envRecord(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = env.TERM || "xterm-256color";
  env.COLORTERM = env.COLORTERM || "truecolor";
  return env;
}

function trimOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return text.slice(text.length - MAX_OUTPUT_BYTES);
}

function lineWindow(text: string, maxLines?: number): string {
  if (!maxLines || maxLines <= 0) return text;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-maxLines).join("\n");
}

/**
 * In-process PTY TerminalController for the Web interactive terminal.
 * One Natalia session may own several PTYs (capped); start() is idempotent
 * per terminalID; close() kills every remaining process.
 */
export function createPtyTerminalController(
  input: PtyTerminalControllerInput,
): TerminalController {
  const sessions = new Map<string, PtySession>();
  const idempotency = new Map<string, Map<string, string>>();
  const writes = new Map<string, Promise<void>>();
  const revisionWaiters = new Map<string, Set<() => void>>();
  const outputListeners = new Map<string, Set<(chunk: string) => void>>();
  let activeSession: string | undefined;
  let closed = false;
  let initialized = false;
  const spawnPty = input.spawn ?? defaultSpawn();
  const maxPerSession = Math.max(
    1,
    input.maxPerSession ?? DEFAULT_MAX_PER_SESSION,
  );
  const idleMs = Math.max(1, input.idleMs ?? DEFAULT_IDLE_MS);

  function sessionVisible(session: PtySession): boolean {
    return activeSession === undefined || session.sessionID === activeSession;
  }

  function assertSessionOwner(session: PtySession, sessionID?: string) {
    const expected = sessionID ?? activeSession;
    if (expected && session.sessionID && session.sessionID !== expected)
      throw new Error(
        `terminal ${session.id} belongs to session ${session.sessionID}`,
      );
  }

  function get(id: string): PtySession {
    const session = sessions.get(id);
    if (!session) throw new Error(`native terminal session not found: ${id}`);
    return session;
  }

  function notifyRevision(id: string) {
    for (const wake of revisionWaiters.get(id) ?? []) wake();
  }

  function waitForRevision(id: string, timeoutMs: number) {
    return new Promise<void>((resolve) => {
      const waiters = revisionWaiters.get(id) ?? new Set<() => void>();
      const wake = () => {
        clearTimeout(timer);
        waiters.delete(wake);
        if (!waiters.size) revisionWaiters.delete(id);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      waiters.add(wake);
      revisionWaiters.set(id, waiters);
    });
  }

  /**
   * The ONLY place inputOwner changes.
   *
   * Ownership is an explicit state change with a named actor and action —
   * the user's P0: focus is not takeover, activity is not takeover, and a
   * takeover nobody asked for is a defect. Every transition is recorded so
   * a refused model write can name WHO moved the pane and WHEN, and the
   * audit trail shows the trigger source rather than an unexplained flip.
   */
  function setInputOwner(
    session: PtySession,
    to: "model" | "human",
    actor: "model" | "human" | "system",
    action: NativeTerminalOwnershipChange["action"],
  ): void {
    const from = session.inputOwner;
    if (from === to) return;
    session.inputOwner = to;
    session.lastOwnershipChange = {
      from,
      to,
      actor,
      action,
      at: new Date().toISOString(),
    };
    session.revision += 1;
    notifyRevision(session.id);
  }

  function publishAudit(
    session: PtySession,
    action:
      | "started"
      | "write"
      | "resize"
      | "exit"
      | "request_human"
      | "detach"
      | "secure_input",
    actor: "model" | "human" | "system",
    detail?: string,
  ) {
    const sessionID = session.sessionID as
      | RuntimeEvent["sessionID"]
      | undefined;
    input.publish({
      type: "terminal.action",
      id: session.id,
      ...(sessionID ? { sessionID } : {}),
      action,
      redacted: action === "write" ? false : undefined,
      target: { kind: "host", cwd: session.cwd },
    });
    input.publish({
      type: "terminal.timeline",
      id: session.id,
      ...(sessionID ? { sessionID } : {}),
      actor: actor === "human" ? "user" : actor,
      action,
      status: "executed",
      summary:
        action === "request_human"
          ? (detail ?? "pty terminal requests human attention")
          : action === "started"
            ? "pty terminal started"
            : action === "write"
              ? "pty terminal input accepted"
              : `pty terminal ${action} executed`,
      at: new Date().toISOString(),
    });
  }

  function publicSession(session: PtySession): RuntimeNativeTerminalSession {
    return {
      id: session.id,
      host: "pty",
      paneID: session.pty?.pid ?? 0,
      windowID: 0,
      muxWindowID: 0,
      tabID: 0,
      command: session.command,
      cwd: session.cwd,
      status: session.status,
      inputOwner: session.inputOwner,
      geometryOwner: session.geometryOwner,
      secureInput: session.secureInput,
      ...(session.lastOwnershipChange
        ? { lastOwnershipChange: session.lastOwnershipChange }
        : {}),
      rows: session.rows,
      cols: session.cols,
      startedAt: session.startedAt,
      attached: session.attached,
      ...(session.sessionID ? { sessionID: session.sessionID } : {}),
      ...(session.agentID ? { agentID: session.agentID } : {}),
    };
  }

  function touch(session: PtySession) {
    session.lastActivityAt = Date.now();
  }

  /**
   * The command's output, as a projection of the screen.
   *
   * Everything the screen scrolled past since the command started, then what is on
   * screen now. No second buffer, so this cannot drift from what the human sees:
   * it IS what the human sees, bounded by the command's markers.
   */
  /** The pane's whole text: scrollback then the live grid. */
  function paneText(session: PtySession): string[] {
    const grid = renderScreen(session.screen).map((row) => row.trimEnd());
    while (grid.length && grid[grid.length - 1] === "") grid.pop();
    return [...session.screen.scrollback, ...grid];
  }

  function commandOutputText(session: PtySession): string {
    const current = paneText(session);
    const base = session.outputBaseLines;
    // The lines the pane gained since the command started. Append-only is the
    // normal case —a command writes, the terminal scrolls —and the prefix check
    // makes it exact.
    if (
      base &&
      base.length <= current.length &&
      base.every((line, i) => current[i] === line)
    )
      return current.slice(base.length).join("\n").replace(/\s+$/, "");
    // A command that REPAINTED (a progress bar, a full-screen app) breaks the
    // prefix property. Hand over the whole pane rather than a guessed slice: more
    // than asked for is recoverable, a slice that silently omits output is not.
    return current.join("\n").replace(/\s+$/, "");
  }

  /**
   * The command-level read by pane id, carrying the same ownership assertion every
   * other read on a pane does: one agent must not read another's terminal.
   */
  function lastCommand(id: string) {
    const session = get(id);
    assertReadable(session);
    // The screen's last non-empty line: the evidence a marker-less pane's
    // answer carries, so the caller sees WHAT ran, not just that something did.
    const screenTail = (() => {
      const lines = paneText(session).filter((line) => line.trim().length > 0);
      return lines.length > 0 ? lines[lines.length - 1] : undefined;
    })();
    return {
      commandLine: session.commandState.commandLine,
      exitCode: session.commandState.exitCode,
      atPrompt: session.commandState.atPrompt,
      output: session.lastCommandOutput,
      revision: session.revision,
      /**
       * "markers" when this pane's shell emits the integration protocol the
       * command-level read is folded from; "missed" when it never has — a
       * pane started without the Natalia shell integration (a raw
       * `bash --norc`, a shell that does not source the rc file).
       */
      integration: session.sawShellMarkers
        ? ("markers" as const)
        : ("missed" as const),
      ...(screenTail ? { screenTail } : {}),
    };
  }

  function appendOutput(session: PtySession, chunk: string) {
    if (!chunk) return;
    session.output = trimOutput(session.output + chunk);
    //
    // THE BASELINE IS TAKEN BEFORE THE SCREEN, and that order is the whole point.
    //
    // The screen takes this entire chunk, so by the time a marker is walked the
    // bytes that followed it in the same chunk are already on screen: a baseline
    // captured then already contains the command's own output and the slice comes
    // back empty. Reading the markers first, and snapshotting when a chunk carries
    // `C`, fixes it. A fast command whose `C` and `D` arrive together is handled by
    // the same rule —the baseline is the pane as it was BEFORE that chunk, so
    // everything gained since is its output.
    //
    // Walking the markers rather than diffing the state around the fold: a real
    // shell delivers a whole command cycle in one chunk, so `outputFrom` is set
    // and cleared inside a single fold and a before/after comparison sees nothing.
    //
    // One input, two surfaces: the screen is what a terminal shows, the command
    // state is what it means. They cannot disagree because neither re-reads the
    // stream independently.
    const markers = parseShellMarkers(chunk);
    if (markers.length > 0) session.sawShellMarkers = true;
    // OSC 7: the pane's working directory follows the shell. The spawn-time
    // cwd is stale the moment the operator types `cd`, and the model's file
    // tools work relative to the pane —so the pane reports where the shell
    // IS, not where it was started. `publicSession` already carries the field;
    // this is what keeps it alive.
    for (const marker of markers) {
      if (marker.kind === "cwd") session.cwd = marker.cwd;
    }
    if (markers.some((marker) => marker.kind === "command-executed"))
      session.outputBaseLines = paneText(session);
    // The render layer: the same bytes the raw buffer keeps, applied to
    // the virtual screen —the model's view is now the pane's rendered
    // screen, not the stream.
    applyTerminalOutput(session.screen, chunk);
    session.revision += 1;
    for (const marker of markers) {
      if (marker.kind !== "command-finished") continue;
      // `D`: the command finished, and PROMPT_COMMAND runs BEFORE the next prompt
      // is drawn. So the screen right now holds exactly this command's output and
      // nothing that follows it, which is what makes the projection exact rather
      // than approximate.
      session.lastCommandOutput = commandOutputText(session);
      session.outputBaseLines = undefined;
    }
    session.commandState = foldShellMarkers(
      session.commandState,
      markers,
      session.revision,
    );
    session.lastOutputAt = Date.now();
    touch(session);
    notifyRevision(session.id);
    armFrameSettle(session);
    for (const listener of outputListeners.get(session.id) ?? [])
      listener(chunk);
  }

  /**
   * The frame emitter (the settlement plan's block 3): when the pane goes
   * quiet for the settle window and the screen differs from the frame the
   * model last saw, ONE notice is delivered —the model is told the
   * screen settled instead of polling for it. A fast stream resets the
   * window (the timer re-arms on every chunk), so a chatty pane emits at
   * meaningful pauses, not per keystroke.
   */
  function armFrameSettle(session: PtySession) {
    if (!input.settlement || !session.sessionID) return;
    // Ownership decides whether a settle is news: a terminal the human is
    // driving (an interactive pane opened from the UI, or one the model handed
    // over) is the human's business, and waking the model on every prompt it
    // prints is how "I open a terminal and Natalia wakes up" happened. Only the
    // model's own tool-driven terminal settles into a notice, because there the
    // output IS the answer to what it asked.
    if (session.inputOwner !== "model") return;
    if (session.settleTimer) clearTimeout(session.settleTimer);
    session.settleTimer = setTimeout(() => {
      session.settleTimer = undefined;
      if (session.status !== "running") return;
      const text = renderScreenText(session.screen);
      if (text === session.lastFrameText) return;
      const scrolled =
        session.screen.scrollback.length > (session.lastFrameScrollback ?? 0);
      session.lastFrameText = text;
      session.lastFrameScrollback = session.screen.scrollback.length;
      input.settlement?.deliverForSession(session.sessionID!, {
        subject: session.id,
        reason: scrolled ? "scrolled" : "settled",
        summary: scrolled
          ? `terminal ${session.id} scrolled a screen of new output`
          : `terminal ${session.id} settled`,
        sourceKind: SETTLEMENT_SOURCE_KINDS.terminalSettled,
      });
    }, input.frameSettleMs ?? 400);
    session.settleTimer.unref?.();
  }

  function markExited(
    session: PtySession,
    actor: "model" | "human" | "system",
  ) {
    if (session.status === "exited") return;
    session.status = "exited";
    session.attached = false;
    session.revision += 1;
    notifyRevision(session.id);
    idempotency.delete(session.id);
    writes.delete(session.id);
    for (const disposer of session.disposers) disposer.dispose();
    session.disposers = [];
    session.pty = undefined;
    publishAudit(session, "exit", actor);
  }

  function runningForSession(sessionID: string | undefined): PtySession[] {
    const key = sessionID ?? "__default__";
    return [...sessions.values()].filter((session) => {
      const owner = session.sessionID ?? "__default__";
      return owner === key && session.status === "running";
    });
  }

  async function recycleOldestIdle(
    sessionID: string | undefined,
  ): Promise<boolean> {
    const now = Date.now();
    const idle = runningForSession(sessionID)
      .filter((session) => now - session.lastActivityAt >= idleMs)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    const victim = idle[0];
    if (!victim) return false;
    await stop(victim.id, "system");
    return true;
  }

  function assertRunning(session: PtySession) {
    if (session.status !== "running")
      throw new Error("terminal session has exited");
  }

  function assertReadable(session: PtySession) {
    assertRunning(session);
    if (session.secureInput)
      throw new Error("terminal output is hidden during secure human input");
  }

  async function init() {
    if (closed) throw new Error("terminal controller is closed");
    initialized = true;
  }

  async function list(sessionID?: string) {
    return [...sessions.values()]
      .filter((session) =>
        sessionID ? session.sessionID === sessionID : sessionVisible(session),
      )
      .map(publicSession);
  }

  async function reconcile() {
    return await list();
  }

  async function read(
    id: string,
    options?: {
      maxLines?: number;
      startLine?: number;
      endLine?: number;
      /** The byte window: a successor of a byte read starts at its predecessor's
       *  `endByte`. Mutually exclusive with the line window's bounds. */
      startByte?: number;
      endByte?: number;
      sessionID?: string;
    },
  ) {
    const session = get(id);
    assertSessionOwner(session, options?.sessionID);
    assertReadable(session);
    // The pane's virtual document: the scrollback (the history the
    // renderer keeps) followed by the visible screen (the present). Line
    // addressing is the host's own: 0 is the oldest scrollback line and
    // negatives count from the end, so `read` and `search` page the WHOLE
    // pane, not just the viewport. Before this, the rendered read dropped
    // startLine/endLine and the scrollback was unreachable —the history
    // existed and nothing could read it.
    // The pane's virtual document: the archived frame (if a resize just wiped
    // the grid and the applications have not repainted yet), then the scrollback,
    // then the visible screen. The model reads this while the human watches
    // xterm.js, and a resize that leaves a blank grid would hand the model
    // nothing —so the last frame it had is offered instead of nothing.
    const archived = session.screen.previousFrame?.lines;
    const blank = renderScreen(session.screen).every(
      (line) => line.trim().length === 0,
    );
    const document = [
      ...(blank && archived ? archived : []),
      ...session.screen.scrollback,
      ...renderScreen(session.screen),
    ];
    const maxLines = Math.max(1, Math.min(options?.maxLines ?? 60, 200));
    const normalize = (line: number) =>
      line < 0 ? Math.max(0, document.length + line) : line;
    // The same document addressed in BYTES. Two cases a line window cannot
    // serve: a single huge line (a minified bundle `cat`-ed into the pane) has
    // no bound a line window can give it, and exact resume wants the successor
    // window to start where this one ended with no arithmetic in between.
    // Both windows report BOTH extents -- this host can count either, and a
    // caller must not have to guess which family it is holding.
    const full = document.join("\n");
    const buffer = Buffer.from(full, "utf8");
    const totalBytes = buffer.byteLength;
    const byteOffsetOfLine = (line: number) => {
      const clamped = Math.max(0, Math.min(line, document.length));
      if (clamped === 0) return 0;
      // The offset of line `clamped`'s first byte: the joined prefix plus the
      // separator that follows it. (For clamped === document.length this is one
      // past the document's last byte —a virtual position, which is why the
      // END report below does not use it.)
      const joined = document.slice(0, clamped).join("\n");
      return Buffer.byteLength(joined, "utf8") + 1;
    };
    // The last byte the window actually served: the end of its last line,
    // WITHOUT the separator that follows it. A byte window over the reported
    // span then serves exactly the text the line window served —the two
    // families are two addresses for one document, not two documents. (The
    // first version reported the next line's start, so the line window's byte
    // span carried a trailing separator its text did not, and a cross-window
    // comparison came out one byte long.)
    const endByteOfWindow = (endLineExclusive: number) =>
      endLineExclusive >= document.length
        ? totalBytes
        : Math.max(0, byteOffsetOfLine(endLineExclusive) - 1);
    // The exclusive END LINE of a byte window, which is not simply the count of
    // separators before its end: a window whose last byte is a separator ends
    // exactly at a line start and touches none of the next line, while one
    // that ends mid-line carries part of that line and must claim it.
    const endLineOfByte = (byteOffset: number) => {
      const lines =
        buffer.subarray(0, byteOffset).toString("utf8").split("\n").length - 1;
      if (byteOffset > 0 && buffer[byteOffset - 1] === 0x0a) return lines;
      return lines + 1;
    };
    if (options?.startByte !== undefined || options?.endByte !== undefined) {
      const start = Math.max(0, Math.min(options?.startByte ?? 0, totalBytes));
      const end =
        options?.endByte === undefined
          ? Math.min(totalBytes, start + MAX_BYTE_WINDOW)
          : Math.max(start, Math.min(options.endByte, totalBytes));
      return {
        text: buffer.subarray(start, end).toString("utf8"),
        startLine:
          buffer.subarray(0, start).toString("utf8").split("\n").length - 1,
        endLine: endLineOfByte(end),
        totalLines: document.length,
        startByte: start,
        endByte: end,
        totalBytes,
        cursorX: session.screen.cursorX,
        cursorY: session.screen.cursorY,
        rows: session.rows,
        cols: session.cols,
      };
    }
    let start: number;
    let endExclusive: number;
    if (options?.startLine === undefined) {
      // An absent range is the tail window (the host's `-maxLines`).
      start = Math.max(0, document.length - maxLines);
      endExclusive = document.length;
    } else {
      start = normalize(options.startLine);
      const end =
        options?.endLine === undefined
          ? start + maxLines
          : normalize(options.endLine);
      endExclusive = Math.min(document.length, end + 1); // endLine is inclusive
    }
    return {
      text: document.slice(start, endExclusive).join("\n"),
      // The window that was actually served, and how much document there is to page
      // through. Without the extent a caller asking for `startLine: 400` gets an empty
      // string and cannot tell "nothing there" from "there is nothing at all", so it
      // cannot page without guessing -- which is the difference between a window and
      // a guess.
      startLine: start,
      endLine: endExclusive,
      totalLines: document.length,
      startByte: byteOffsetOfLine(start),
      endByte: endByteOfWindow(endExclusive),
      totalBytes,
      // The pane's own cursor (screen-relative), as the host reports it.
      cursorX: session.screen.cursorX,
      cursorY: session.screen.cursorY,
      rows: session.rows,
      cols: session.cols,
    };
  }

  async function openHub() {
    const first = [...sessions.values()].find(
      (session) => session.status === "running" && sessionVisible(session),
    );
    if (!first) throw new Error("no running native terminal session");
    first.attached = true;
    return { muxWindowID: 0 };
  }

  function releaseHumanControl(id: string, sessionID?: string) {
    const session = get(id);
    assertSessionOwner(session, sessionID);
    if (session.secureInput)
      throw new Error(
        "secure input must end before returning control to model",
      );
    setInputOwner(session, "model", "human", "release");
    publishAudit(session, "detach", "human");
    return publicSession(session);
  }

  function beginSecureInput(id: string, sessionID?: string) {
    const session = get(id);
    assertSessionOwner(session, sessionID);
    assertRunning(session);
    if (session.inputOwner !== "human")
      throw new Error("secure input requires human terminal control");
    session.secureInput = true;
    session.revision += 1;
    notifyRevision(session.id);
    publishAudit(session, "secure_input", "human");
    return publicSession(session);
  }

  function endSecureInput(id: string, sessionID?: string) {
    const session = get(id);
    assertSessionOwner(session, sessionID);
    session.secureInput = false;
    session.revision += 1;
    notifyRevision(session.id);
    publishAudit(session, "secure_input", "human");
    return publicSession(session);
  }

  async function claimHumanInput(id: string, sessionID?: string) {
    const session = get(id);
    assertSessionOwner(session, sessionID);
    assertRunning(session);
    if (session.secureInput && session.inputOwner !== "human")
      throw new Error("secure input requires human terminal control");
    if (session.inputOwner === "human") return publicSession(session);
    setInputOwner(session, "human", "human", "claim");
    publishAudit(session, "write", "human");
    return publicSession(session);
  }

  async function stop(
    id: string,
    actor: "model" | "human" | "system",
    sessionID?: string,
  ) {
    const session = get(id);
    assertSessionOwner(session, sessionID);
    if (session.status === "running") {
      try {
        session.pty?.kill();
      } catch {
        // process already gone
      }
    }
    // A stopped pane holds no input, so a human's ownership of it ends with
    // the stop — recorded, like every transition, with the actor who stopped.
    if (session.inputOwner === "human")
      setInputOwner(session, "model", actor, "stop");
    markExited(session, actor);
    return publicSession(session);
  }

  async function start(startInput: {
    command: string;
    cwd: string;
    id?: string;
    sessionID?: string;
    agentID?: string;
    /**
     * The grid to spawn at. Absent means the default; a human pane resizes the
     * running terminal the moment it opens, so this matters for headless
     * (model-only) terminals —which is exactly where "too small to render a
     * TUI" bites.
     */
    rows?: number;
    cols?: number;
  }) {
    if (closed) throw new Error("terminal controller is closed");
    if (!initialized) await init();
    const owningSession = startInput.sessionID ?? activeSession;
    if (startInput.id) {
      const existing = sessions.get(startInput.id);
      if (existing?.status === "running") {
        if (
          existing.sessionID &&
          owningSession &&
          existing.sessionID !== owningSession
        )
          throw new Error(
            `terminal ${existing.id} belongs to session ${existing.sessionID}`,
          );
        touch(existing);
        return publicSession(existing);
      }
    }

    const running = runningForSession(owningSession);
    if (running.length >= maxPerSession) {
      const recycled = await recycleOldestIdle(owningSession);
      if (!recycled || runningForSession(owningSession).length >= maxPerSession)
        throw new Error(
          `session already has ${maxPerSession} running terminals`,
        );
    }

    // argv and env: a zsh pane is integrated through ZDOTDIR, which is not an
    // argument, so taking only the argv would leave it silently unintegrated.
    const spawnSpec = nativeTerminalPaneSpawn(startInput.command);
    const argv = spawnSpec.argv;
    const file = argv[0] ?? "/bin/sh";
    const args = argv.slice(1);
    const shellEnv = spawnSpec.env;
    const id = startInput.id ?? `terminal_${randomUUID()}`;
    // The one geometry the session, its screen and the spawned pty share. A
    // caller's rows/cols win; anything absent or nonsensical falls back to the
    // default rather than spawning a zero-column pty.
    const rows = clampGeometry(startInput.rows, DEFAULT_ROWS);
    const cols = clampGeometry(startInput.cols, DEFAULT_COLS);
    const now = Date.now();
    const session: PtySession = {
      id,
      sessionID: owningSession,
      ...(startInput.agentID ? { agentID: startInput.agentID } : {}),
      command: startInput.command,
      cwd: startInput.cwd,
      startedAt: new Date().toISOString(),
      status: "running",
      inputOwner: "model",
      geometryOwner: "human",
      sawShellMarkers: false,
      secureInput: false,
      attached: true,
      rows,
      cols,
      revision: 0,
      output: "",
      screen: createTerminalScreen({ rows, cols }),
      // A pane starts at a prompt. If the shell inside never emits the markers,
      // this stays atPrompt=true with every other field absent —the
      // command-level read says "unknown", which is honest, rather than
      // inventing a command line out of the screen.
      commandState: initialCommandState(),
      lastActivityAt: now,
      disposers: [],
    };
    const started = performance.now();
    const pty = spawnPty({
      file,
      args,
      cwd: startInput.cwd,
      cols,
      rows,
      // `shellEnv` first: it carries what the pane's shell needs to be integrated
      // (zsh's ZDOTDIR). `envRecord()` then supplies the operator's own
      // environment, so PATH, HOME and locale still reach the child —an
      // integration that replaced them would spawn a shell that cannot find ls.
      env: { ...shellEnv, ...envRecord() },
      command: startInput.command,
    });
    session.pty = pty;
    session.disposers.push(
      pty.onData((chunk) => {
        appendOutput(session, chunk);
      }),
      pty.onExit(() => {
        markExited(session, "system");
      }),
    );
    sessions.set(id, session);
    input.onPerformance("pty.start", performance.now() - started);
    publishAudit(session, "started", "model");
    return publicSession(session);
  }

  async function write(
    id: string,
    value: string,
    options?: {
      idempotencyKey?: string;
      sessionID?: string;
      /**
       * Who is typing. The model's write is refused on a human-owned
       * terminal; the human's write is refused on a secure-input pane. Both
       * flow through this one RPC today, so the caller states which it is —
       * without it a UI pane claimed by its human could not type at all.
       */
      actor?: "model" | "human";
    },
  ) {
    const session = get(id);
    assertSessionOwner(session, options?.sessionID);
    assertRunning(session);
    if (options?.actor === "human") {
      if (session.secureInput)
        throw new Error("terminal is accepting secure human input");
    } else if (session.inputOwner !== "model") {
      // T-06: the refusal names the CURRENT owner state — the model needs
      // to know a human holds the pane right now, not that "a human"
      // exists somewhere in the past. (The user's own correction: the
      // takeover is the user's action; the defect was only that the
      // refusal never said so.)
      //
      // The user's P0 follow-up: the refusal must also name the LAST
      // TRANSITION (who took the pane, when, through what action), so an
      // unexplained flip is diagnosable instead of just refused.
      const change = session.lastOwnershipChange;
      const transition =
        change && change.to === "human"
          ? ` The last transition: a ${change.actor} claimed input at ${change.at} via ${change.action}.`
          : "";
      throw new Error(
        `terminal input is controlled by a human (inputOwner=${session.inputOwner}): ` +
          `the user took over this pane; wait for them to release control ` +
          `(their release sets inputOwner back to model). Reads still work; ` +
          `this write is refused until then.${transition}`,
      );
    }
    if (session.secureInput)
      throw new Error("terminal is accepting secure human input");
    const writtenBytes = new TextEncoder().encode(value).byteLength;
    if (options?.idempotencyKey) {
      const keys = idempotency.get(id) ?? new Map<string, string>();
      const previous = keys.get(options.idempotencyKey);
      if (previous !== undefined) {
        if (previous !== value)
          throw new Error(
            "terminal idempotency key was reused with different input",
          );
        return { writtenBytes, delivery: "duplicate" as const };
      }
      keys.set(options.idempotencyKey, value);
      idempotency.set(id, keys);
      while (keys.size > 256) keys.delete(keys.keys().next().value!);
    }
    const previous = writes.get(id) ?? Promise.resolve();
    let cancelled = false;
    const delivery = previous.then(() => {
      const human = options?.actor === "human";
      if (
        (!human && session.inputOwner !== "model") ||
        session.status !== "running"
      ) {
        cancelled = true;
        return;
      }
      session.pty?.write(value);
    });
    writes.set(
      id,
      delivery.catch(() => undefined),
    );
    try {
      await delivery;
    } catch (error) {
      if (options?.idempotencyKey)
        idempotency.get(id)?.delete(options.idempotencyKey);
      throw error;
    }
    if (cancelled) {
      if (options?.idempotencyKey)
        idempotency.get(id)?.delete(options.idempotencyKey);
      return { writtenBytes, delivery: "cancelled" as const };
    }
    session.revision += 1;
    session.lastModelWriteAt = Date.now();
    touch(session);
    notifyRevision(session.id);
    publishAudit(session, "write", "model");
    return { writtenBytes, delivery: "accepted" as const };
  }

  async function resize(
    id: string,
    rows: number,
    cols: number,
    actor: "model" | "human",
    sessionID?: string,
  ) {
    const session = get(id);
    assertSessionOwner(session, sessionID);
    assertRunning(session);
    if (!Number.isInteger(rows) || rows < 1 || rows > 500)
      throw new Error("terminal rows must be an integer between 1 and 500");
    if (!Number.isInteger(cols) || cols < 1 || cols > 500)
      throw new Error("terminal cols must be an integer between 1 and 500");
    session.pty?.resize(cols, rows);
    session.rows = rows;
    session.cols = cols;
    // The rendered screen the model reads must follow the pane, or the model's
    // window stays at the spawn-time 24x80 forever: a full-screen TUI clipped
    // to 80 columns, and a human's pane resize invisible to it. The pty
    // resizes too, so the applications redraw for the new geometry —the grid
    // is re-blanked (see resizeTerminalScreen) rather than re-flowed.
    resizeTerminalScreen(session.screen, rows, cols);
    session.revision += 1;
    touch(session);
    notifyRevision(session.id);
    publishAudit(session, "resize", actor);
    return publicSession(session);
  }

  /**
   * What a MODEL-facing surface renders.
   *
   * The human's `snapshot` says `renderScreenText` because that is the truth about
   * the human's window. But `read` consults the frame a resize archived, so a
   * model-facing surface that rendered the raw screen would DISAGREE with the
   * model's own read in exactly the window where the grid is blank —observe would
   * report "nothing here" while read reports the frame it just had. Both
   * model-facing surfaces share this helper so that cannot happen.
   */
  function modelFacingText(session: { screen: TerminalScreen }): string {
    const live = renderScreenText(session.screen);
    const blank = session.screen.grid.every((row) =>
      row.every((cell) => cell.char.trim().length === 0),
    );
    const archived = session.screen.previousFrame?.lines;
    return blank && archived?.length ? archived.join("\n") : live;
  }

  async function snapshot(id: string) {
    const session = get(id);
    assertReadable(session);
    return {
      // The pane, as the model sees it —the archived frame while the grid is
      // blank, exactly like read.
      text: modelFacingText(session),
      cursorX: session.screen.cursorX,
      cursorY: session.screen.cursorY,
      rows: session.rows,
      cols: session.cols,
      revision: session.revision,
      status: session.status,
      inputOwner: session.inputOwner,
      highlightRanges: [],
    };
  }

  async function observe(
    id: string,
    afterRevision: number,
    options?: { maxLines?: number; timeoutMs?: number },
  ) {
    const session = get(id);
    const timeoutMs = Math.max(
      1,
      Math.min(options?.timeoutMs ?? 5_000, 30_000),
    );
    const deadline = performance.now() + timeoutMs;
    while (true) {
      if (session.status === "exited")
        return {
          session: { revision: session.revision },
          text: "",
          cursorX: 0,
          cursorY: 0,
          rows: session.rows,
          cols: session.cols,
          afterRevision,
          changed: session.revision > afterRevision,
          reason: "exited" as const,
        };
      const text = modelFacingText(session);
      if (session.revision > afterRevision)
        return {
          session: { revision: session.revision },
          text,
          cursorX: 0,
          cursorY: 0,
          rows: session.rows,
          cols: session.cols,
          afterRevision,
          changed: true,
          reason: "session_activity" as const,
        };
      if (performance.now() >= deadline)
        return {
          session: { revision: session.revision },
          text,
          cursorX: 0,
          cursorY: 0,
          rows: session.rows,
          cols: session.cols,
          afterRevision,
          changed: false,
          reason: "timeout" as const,
        };
      await waitForRevision(
        session.id,
        Math.max(10, Math.min(500, deadline - performance.now())),
      );
    }
  }

  function session(id: string) {
    const current = get(id);
    return { lastObservedText: current.lastObservedText };
  }

  function markObserved(id: string, text: string, revision: number) {
    const current = get(id);
    current.lastObservedText = text;
    current.lastObservedRevision = revision;
  }

  function lastObservedRevision(id: string): number | undefined {
    return get(id).lastObservedRevision;
  }

  async function requestHuman(id: string, reason: string, sessionID?: string) {
    const current = get(id);
    assertSessionOwner(current, sessionID);
    assertRunning(current);
    if (typeof reason !== "string" || reason.length === 0)
      throw new Error("request_human requires a reason");
    if (reason.length > 240)
      throw new Error(
        "request_human reason must be 240 characters or fewer; describe the kind of input needed, never screen content or secrets",
      );
    publishAudit(current, "request_human", "model", reason);
    return publicSession(current);
  }

  async function ttyName(id: string) {
    const current = get(id);
    const pid = current.pty?.pid;
    return pid ? `/proc/${pid}/fd/0` : undefined;
  }

  function subscribeOutput(id: string, listener: (chunk: string) => void) {
    const session = get(id);
    const listeners =
      outputListeners.get(session.id) ?? new Set<(chunk: string) => void>();
    listeners.add(listener);
    outputListeners.set(session.id, listeners);
    if (session.output) listener(session.output);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) outputListeners.delete(session.id);
    };
  }

  function setActiveSession(sessionID: string | undefined) {
    if (sessionID !== undefined)
      for (const session of sessions.values())
        if (session.sessionID === undefined && session.status === "running")
          session.sessionID = sessionID;
    activeSession = sessionID;
  }

  async function stopForSession(sessionID: string) {
    const owned = [...sessions.values()].filter(
      (session) =>
        session.sessionID === sessionID && session.status === "running",
    );
    await Promise.allSettled(
      owned.map(async (session) => {
        await stop(session.id, "system");
      }),
    );
  }

  async function close() {
    if (closed) return;
    closed = true;
    const running = [...sessions.values()].filter(
      (session) => session.status === "running",
    );
    await Promise.allSettled(
      running.map(async (session) => {
        try {
          session.pty?.kill();
        } catch {
          // already gone
        }
        markExited(session, "system");
      }),
    );
    for (const session of sessions.values())
      if (session.settleTimer) clearTimeout(session.settleTimer);
    sessions.clear();
    idempotency.clear();
    writes.clear();
    revisionWaiters.clear();
    outputListeners.clear();
  }

  return {
    init,
    list,
    reconcile,
    read,
    openHub,
    claimHumanInput,
    releaseHumanControl,
    beginSecureInput,
    endSecureInput,
    stop,
    start,
    write,
    resize,
    lastCommand,
    snapshot,
    observe,
    session,
    markObserved,
    lastObservedRevision,
    requestHuman,
    ttyName,
    setActiveSession,
    subscribeOutput,
    stopForSession,
    close,
  };
}

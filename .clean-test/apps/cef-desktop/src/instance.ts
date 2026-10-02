/**
 * The desktop app's single instance.
 *
 * A normal application is launched once: a second click on its icon focuses the
 * window that is already open instead of starting a second copy that fights
 * over the same session store. Natalia's desktop is a CEF window in front of a
 * runtime, and the runtime is stateful — two of them on one profile is worse
 * than two editors: they both write the same SQLite session journals.
 *
 * So the FIRST process owns a lock and stays reachable; every later launch
 * connects, asks it to show its window, and exits with success. That handoff is
 * what makes "close the window, click the icon again, the window comes back"
 * work — the process never went away, only the window did.
 *
 * The lock lives in the user's state root (`~/.natalia`), not the workspace and
 * not a temp directory: a temp lock is lost on reboot and then two instances
 * can run, which is the exact failure this prevents. A stale lock (a process
 * that died without releasing) is detected by its recorded pid and taken over
 * rather than making the app permanently unlaunchable.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** What a second launch asks the running instance to do. */
export type InstanceRequest =
  | { kind: "show" }
  | { kind: "exit" }
  | { kind: "ping" };

export type InstanceHandle = {
  /** The state directory this instance registered in. */
  readonly stateDir: string;
  /** True when another instance already held the lock. */
  readonly wasAlreadyRunning: boolean;
  /** Show this instance's window (called by the owner on a `show` request). */
  onShow?: () => void | Promise<void>;
  /** Quit this instance (called by the owner on an `exit` request). */
  onExit?: () => void | Promise<void>;
  /** Release the lock and stop listening. */
  close(): Promise<void>;
};

export type AcquireOptions = {
  /** The state root; default `~/.natalia`. */
  stateDir?: string;
  /** The socket/pidfile name inside the state dir. */
  appName?: string;
  /** Called on the OWNER when another launch asks for the window. */
  onShow?: () => void | Promise<void>;
  /** Called on the OWNER when another launch asks it to quit. */
  onExit?: () => void | Promise<void>;
  /** Injected for tests: is this pid alive? */
  isProcessAlive?: (pid: number) => boolean;
};

const DEFAULT_STATE_DIR = join(homedir(), ".natalia");

function lockPaths(stateDir: string, appName: string) {
  return {
    dir: stateDir,
    socket: join(stateDir, `${appName}.instance.sock`),
    pid: join(stateDir, `${appName}.instance.pid`),
  };
}

/** A pid is alive when `kill 0` succeeds. */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but belongs to someone else — still alive.
    return code === "EPERM";
  }
}

function pidFromFile(path: string): number | undefined {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Take the single-instance lock, or hand off to whoever holds it.
 *
 * Returns a handle on success; throws only when the state directory cannot be
 * created (in which case the app should still start — a degraded single-instance
 * guarantee is better than no app).
 */
export async function acquireSingleInstance(
  options: AcquireOptions = {},
): Promise<InstanceHandle> {
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const appName = options.appName ?? "natalia";
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const { socket: socketPath, pid: pidPath } = lockPaths(stateDir, appName);

  mkdirSync(stateDir, { recursive: true });

  // A socket that still answers is a live instance: hand off to it.
  if (existsSync(socketPath)) {
    const handed = await handOff(socketPath, { kind: "show" });
    if (handed) {
      return {
        stateDir,
        wasAlreadyRunning: true,
        close: async () => undefined,
      };
    }
    // Nobody answered: the previous process is gone. Its socket and pid file are
    // litter, not a lock.
    rmSync(socketPath, { force: true });
    rmSync(pidPath, { force: true });
  }

  // A pid file without a socket means a crash between the two steps.
  const stalePid = pidFromFile(pidPath);
  if (stalePid !== undefined && !isAlive(stalePid)) {
    rmSync(pidPath, { force: true });
  }

  const connections = new Set<Socket>();
  let server: Server | undefined;
  let closing = false;

  const owner = async (request: InstanceRequest): Promise<void> => {
    if (request.kind === "show") await options.onShow?.();
    if (request.kind === "exit") await options.onExit?.();
  };

  await new Promise<void>((resolveListen, rejectListen) => {
    server = createServer((socket) => {
      connections.add(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let request: InstanceRequest = { kind: "ping" };
          try {
            request = JSON.parse(line) as InstanceRequest;
          } catch {
            socket.write('{"ok":false}\n');
            continue;
          }
          void owner(request).then(
            () => socket.write('{"ok":true}\n'),
            () => socket.write('{"ok":false}\n'),
          );
        }
      });
      socket.on("error", () => undefined);
      socket.on("close", () => connections.delete(socket));
    });
    server.on("error", rejectListen);
    server.listen(socketPath, () => resolveListen());
  });
  server?.on("error", () => undefined);

  writeFileSync(pidPath, `${process.pid}\n`, "utf8");

  return {
    stateDir,
    wasAlreadyRunning: false,
    onShow: options.onShow,
    onExit: options.onExit,
    async close() {
      if (closing) return;
      closing = true;
      for (const socket of connections) socket.destroy();
      await new Promise<void>((done) => {
        if (!server) {
          done();
          return;
        }
        server.close(() => done());
      });
      rmSync(socketPath, { force: true });
      rmSync(pidPath, { force: true });
    },
  };
}

/** Ask the running instance to do something; false when it did not answer. */
async function handOff(
  socketPath: string,
  request: InstanceRequest,
  timeoutMs = 1500,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect(socketPath);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      finish(String(chunk).includes('"ok":true'));
    });
  });
}

/** Ask the running instance to show its window (for a launcher/menu entry). */
export async function requestShow(
  options: { stateDir?: string; appName?: string } = {},
): Promise<boolean> {
  const { socket } = lockPaths(
    options.stateDir ?? DEFAULT_STATE_DIR,
    options.appName ?? "natalia",
  );
  return await handOff(socket, { kind: "show" });
}

/** Ask the running instance to exit. */
export async function requestExit(
  options: { stateDir?: string; appName?: string } = {},
): Promise<boolean> {
  const { socket } = lockPaths(
    options.stateDir ?? DEFAULT_STATE_DIR,
    options.appName ?? "natalia",
  );
  return await handOff(socket, { kind: "exit" });
}

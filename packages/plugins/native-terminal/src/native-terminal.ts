import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  readdir,
  readFile,
  mkdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { executableName, isWindows } from "@anthelia/platform";
import { selectExecutor } from "@anthelia/shell";
import {
  interactiveShellArgv,
  shellEnvFor,
  withShellIntegration,
} from "./shell-integration-argv";

export {
  NATIVE_INPUT_BROKER_VERSION,
  decodeNativeInputClaim,
  decodeNativeInputDecision,
  encodeNativeInputDecision,
  nativeInputBrokerEndpoint,
  nativeInputBrokerDecision,
  type NativeInputClaim,
  type NativeInputDecision,
  type NativeInputKind,
} from "./input-broker";
export {
  startNativeInputBroker,
  type NativeInputBroker,
} from "./input-broker-server";

export type NativeTerminalPane = {
  pane_id: number;
  window_id: number;
  tab_id: number;
  title?: string;
  cwd?: string;
  cursor_x?: number;
  cursor_y?: number;
  is_active?: boolean;
  tty_name?: string;
  rows?: number;
  cols?: number;
};

export type NativeTerminalHost = {
  readonly kind: "wezterm";
  readonly executable: string;
  spawn(input: {
    cwd: string;
    command: string[];
    workspace?: string;
    muxWindowID?: number;
  }): Promise<NativeTerminalPane>;
  list(): Promise<NativeTerminalPane[]>;
  listClients?(): Promise<Array<{ focused_pane_id: number }>>;
  isAlive?(): Promise<boolean>;
  resetMuxReady?(): void;
  read(
    paneID: number,
    options?: {
      maxLines?: number;
      startLine?: number;
      endLine?: number;
      format?: "text" | "selection" | "highlights";
    },
  ): Promise<string>;
  write(paneID: number, data: string): Promise<void>;
  open?(
    paneID: number,
    options?: {
      environment?: Record<string, string | undefined>;
      muxWindowID?: number;
      launch?: boolean;
      discardBootstrapPanes?: boolean;
    },
  ): Promise<NativeTerminalPane>;
  openHub?(options?: {
    environment?: Record<string, string | undefined>;
  }): Promise<void>;
  focus(
    paneID: number,
    options?: { environment?: Record<string, string | undefined> },
  ): Promise<void>;
  resize(paneID: number, rows: number, cols: number): Promise<void>;
  stop(paneID: number): Promise<void>;
  dispose?(): Promise<void>;
  isClientAttached?(paneID: number): Promise<boolean>;
};

type CommandRunner = (
  executable: string,
  args: string[],
  stdin?: string,
  environment?: Record<string, string | undefined>,
  timeoutMs?: number,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

type GuiLauncher = (
  executable: string,
  args: string[],
  environment?: Record<string, string | undefined>,
) => Promise<void>;

export function resolveWezTermExecutable(
  input: {
    configured?: string;
    which?: (name: string) => string | null;
    os?: NodeJS.Platform;
    forkBuildDir?: string;
  } = {},
) {
  if (input.configured) return input.configured;
  const fork = resolveNataliaWezTermForkExecutable({
    os: input.os,
    buildDir: input.forkBuildDir,
  });
  if (fork) return fork;
  return undefined;
}

/**
 * The PREBUILT drop directory: `<this package>/prebuilt/<platform-triple>/`,
 * the one place a downloaded or unpacked Natalia drops the three terminal
 * executables into. It exists because the fork's build directory
 * (`wezterm/target/release`) is a path a fresh unpack does not have —
 * asking a user to create that folder structure by hand is a paper cut the
 * distribution should not ship. Extracting the release archive already
 * makes such a directory, so no `mkdir -p` is needed.
 */
export function nativeTerminalPrebuiltDir(
  os: NodeJS.Platform = platform(),
): string {
  return join(import.meta.dir, "..", "prebuilt", platformTriple(os));
}

/** The platform triple the prebuilt directory is keyed by (windows-x64, linux-x64, …). */
export function platformTriple(os: NodeJS.Platform = platform()): string {
  const arch = process.arch === "x64" ? "x64" : process.arch;
  const system = os === "win32" ? "windows" : os === "darwin" ? "darwin" : os;
  return `${system}-${arch}`;
}

/**
 * The patched current-main source is owned by this package. Its release build
 * is generated locally and intentionally excluded from version control.
 */
export function nativeTerminalForkBuildDir() {
  return import.meta.url.endsWith(".ts")
    ? join(import.meta.dir, "..", "wezterm", "target", "release")
    : join(import.meta.dir, "wezterm");
}

export function resolveNataliaWezTermForkExecutable(
  input: { os?: NodeJS.Platform; buildDir?: string } = {},
) {
  const os = input.os ?? platform();
  // The search order is the ergonomics: an explicit dir, then the
  // PREBUILT drop (a downloaded or unpacked Natalia's answer — the archive
  // made the directory, so no `mkdir -p` by hand), then the fork's own
  // build (a developer's answer). The three executables must sit together
  // (the mux server is resolved beside the main one), which every
  // candidate satisfies.
  const candidates = input.buildDir
    ? [input.buildDir]
    : [nativeTerminalPrebuiltDir(os), nativeTerminalForkBuildDir()];
  for (const dir of candidates) {
    const executable = join(dir, executableName("wezterm", os));
    if (existsSync(executable)) return executable;
  }
  return undefined;
}

/**
 * Readiness budget for a Windows mux server. It is far larger than the POSIX
 * one because the server is not daemonized there, so first-run costs such as
 * Defender inspecting a freshly written executable land inside this window.
 */
const WINDOWS_MUX_READY_TIMEOUT_MS = 120_000;

/**
 * Argument vector for the shell that hosts a managed pane's command. A
 * bash `-lc` shell is used on every platform so that the command text, its
 * quoting, and its profile semantics are identical for the model regardless of
 * host. Windows resolves this to the Git for Windows bash.
 */
// The shell that owns the pane command's spelling. Stateless, so one per module.
const shell = selectExecutor();

export function nativeTerminalPaneCommand(
  command: string,
  os?: NodeJS.Platform,
): string[] {
  // The argv is unchanged — it is the public contract its callers and tests pin —
  // but the spelling now belongs to the shell rather than being built here.
  // `/bin/sh`, not bash: the pane command is derived for the workspace's own
  // shell, and the seam carries that through its `shellExecutable` valve.
  //
  // A pane whose command IS a shell is an interactive shell, and gets that shell
  // directly — not `/bin/sh -lc <shell>`. The `-lc` wrapper was the old contract
  // for every command, and it means a bash pane would be dash running bash,
  // carrying no integration and so no command-level read. Detecting the shell
  // here keeps the wrapper for real commands and drops it for a real shell.
  const integrated = interactiveShellArgv(command, os);
  if (integrated) return integrated;
  const spec = shell.resolve({
    command,
    loginShell: true,
    os,
    shellExecutable: "/bin/sh",
  });
  return withShellIntegration([spec.command, ...spec.args]).argv;
}

/**
 * The pane's spawn spec: argv AND the environment the shell needs.
 *
 * Separate from `nativeTerminalPaneCommand` because that one is a pinned contract
 * — callers and tests assert on its argv — and a zsh pane's integration is not
 * expressible as argv. It arrives as ZDOTDIR, which is environment, so a pane that
 * wants the command-level read needs both halves or it gets neither.
 */
export function nativeTerminalPaneSpawn(
  command: string,
  os?: NodeJS.Platform,
): { argv: string[]; env: Record<string, string> } {
  // The pane argv ALREADY went through the integrator inside
  // `nativeTerminalPaneCommand`, so wrapping it here again would double the
  // `--rcfile` — which is what the first version did, and the argv shows it:
  // `bash --rcfile X --rcfile X`. What this adds is only the environment half,
  // which the argv path cannot carry.
  return {
    argv: nativeTerminalPaneCommand(command, os),
    env: shellEnvFor(command, os),
  };
}

export function createWezTermHost(
  input: {
    os?: NodeJS.Platform;
    executable?: string;
    run?: CommandRunner;
    configFile?: string;
    className?: string;
    environment?: Record<string, string | undefined>;
    muxRuntimeDir?: string;
    nativeDomain?: {
      name: string;
      socketPath: string;
      configFile: string;
    };
    onPerformance?: (name: string, durationMs: number) => void;
    timeoutMs?: number;
    launch?: GuiLauncher;
    muxDomain?: string;
  } = {},
): NativeTerminalHost {
  // A deployment under test may be POSIX-shaped while the host machine is
  // Windows; the host's own os lets fixtures keep exercising the POSIX
  // launcher paths instead of silently falling into the native branch.
  const os = input.os ?? platform();
  // An explicit override is reserved for controlled diagnostics. The managed
  // current-main fork build is the normal host when available.
  const executable =
    input.executable ??
    resolveWezTermExecutable({
      configured: process.env.NATALIA_WEZTERM_EXECUTABLE,
    });
  if (!executable) {
    const suffix = os === "win32" ? ".exe" : "";
    throw new Error(
      `WezTerm Native Terminal Host is unavailable. Drop the three terminal executables ` +
        `(wezterm${suffix}, wezterm-gui${suffix}, wezterm-mux-server${suffix}) into ` +
        `${nativeTerminalPrebuiltDir(os)} — or build the managed Natalia fork, or set ` +
        `NATALIA_WEZTERM_EXECUTABLE for controlled diagnostics.`,
    );
  }
  const run = input.run ?? runWezTermCommand;
  const measure = async <T>(name: string, work: () => Promise<T>) => {
    const startedAt = performance.now();
    try {
      return await work();
    } finally {
      input.onPerformance?.(name, performance.now() - startedAt);
    }
  };
  const timeoutMs = input.timeoutMs ?? 5_000;
  const launch = input.launch ?? launchWezTermGUI;
  const configFile = input.nativeDomain?.configFile ?? input.configFile;
  const global = configFile ? ["--config-file", configFile] : [];
  const muxServer = join(
    dirname(executable),
    executableName("wezterm-mux-server", os),
  );
  const privateEnvironment = {
    ...input.environment,
    ...(input.muxRuntimeDir ? { XDG_RUNTIME_DIR: input.muxRuntimeDir } : {}),
  };
  let muxReady: Promise<void> | undefined;
  let command: (args: string[], stdin?: string) => Promise<string>;
  const ensureMux = async () => {
    if (!input.environment?.WEZTERM_UNIX_SOCKET) return;
    // A resolved promise only proves the server answered once. It can die
    // later, and trusting the cache meant every later spawn talked to a dead
    // socket with no way back: the only code that cleared the cache ran from
    // reconcile, which spawn never reaches.
    if (muxReady && !(await isMuxAlive())) muxReady = undefined;
    muxReady ??= (async () => {
      if (await muxIsReady()) return;
      await measure("native.mux.start", async () => {
        if (isWindows(os)) {
          // `--daemonize` relies on a DETACHED_PROCESS create that can leave the
          // parent waiting on the cross-compiled binary, so the server is
          // spawned directly and its readiness is polled instead. Its streams
          // are discarded because the process outlives this call.
          Bun.spawn([muxServer, ...global], {
            env: { ...process.env, ...privateEnvironment },
            detached: true,
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
          }).unref();
          await waitForMux(WINDOWS_MUX_READY_TIMEOUT_MS, 200);
          return;
        }
        const result = await withTimeout(
          run(
            muxServer,
            [...global, "--daemonize"],
            undefined,
            privateEnvironment,
            timeoutMs,
          ),
          timeoutMs,
          ["wezterm-mux-server", "--daemonize"],
        );
        // A concurrent session may have won the pid lock between the readiness
        // probe and spawn. Reuse that mux only when it serves our private socket.
        if (result.exitCode !== 0 && !(await muxIsReady()))
          throw new Error(`WezTerm mux server failed: ${result.stderr.trim()}`);
        await waitForMux(timeoutMs, 50);
      });
    })().catch((error) => {
      muxReady = undefined;
      throw error;
    });
    await muxReady;
  };
  const waitForMux = async (budgetMs: number, intervalMs: number) => {
    const deadline = performance.now() + budgetMs;
    while (performance.now() < deadline) {
      if (await muxIsReady()) return;
      await Bun.sleep(intervalMs);
    }
    throw new Error(
      `WezTerm mux server did not become ready within ${budgetMs}ms`,
    );
  };
  command = async (args: string[], stdin?: string) => {
    const cliArgs =
      args[0] === "cli" && input.className
        ? [
            "cli",
            "--no-auto-start",
            "--prefer-mux",
            "--class",
            input.className,
            ...args.slice(1),
          ]
        : args[0] === "cli"
          ? ["cli", "--no-auto-start", "--prefer-mux", ...args.slice(1)]
          : args;
    const operation =
      args[0] === "cli" ? (args[1] ?? "unknown") : (args[0] ?? "unknown");
    const result = await measure(`native.cli.${operation}`, () =>
      withTimeout(
        run(
          executable,
          [...global, ...cliArgs],
          stdin,
          privateEnvironment,
          timeoutMs,
        ),
        timeoutMs,
        args,
      ),
    );
    if (result.exitCode !== 0)
      throw new Error(
        `WezTerm command failed (${args.join(" ")}): ${result.stderr.trim()}`,
      );
    return result.stdout;
  };
  const muxIsReady = async () => {
    try {
      await command(["cli", "list", "--format", "json"]);
      return true;
    } catch {
      return false;
    }
  };
  const privateClientPaneIDs = async () => {
    try {
      const output = await command(["cli", "list-clients", "--format", "json"]);
      const clients = JSON.parse(output) as unknown;
      if (!Array.isArray(clients)) return [];
      return clients.flatMap((client) => {
        if (!client || typeof client !== "object") return [];
        const paneID = (client as Record<string, unknown>).focused_pane_id;
        return Number.isSafeInteger(paneID) ? [paneID as number] : [];
      });
    } catch {
      return [];
    }
  };
  const ensureCjkGlyphReadiness = async () => {
    await measure("native.gui.glyph-ready", async () => {
      const output = await command(["ls-fonts", "--text", "你好中文"]);
      if (!output.trim() || /(?:Last Resort|No fonts)/iu.test(output))
        throw new Error(
          "Native GUI CJK glyph fallback is unavailable; refusing to report Terminal Hub open success",
        );
    });
  };
  const isMuxAlive = async (): Promise<boolean> => {
    try {
      // The runner resolves with the exit code instead of throwing on failure,
      // so the code has to be checked here. Without it this probe reported a
      // dead server as alive whenever the binary ran at all, which is why
      // "failed to connect" never triggered recovery.
      const result = await withTimeout(
        run(
          executable,
          [
            "cli",
            "--no-auto-start",
            "--prefer-mux",
            "list",
            "--format",
            "json",
          ],
          undefined,
          privateEnvironment,
          2000,
        ),
        2000,
        ["cli", "list"],
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  };
  return {
    kind: "wezterm",
    executable,
    async spawn(options) {
      return await measure("native.spawn", async () => {
        await ensureMux();
        const args = ["cli", "spawn", "--cwd", options.cwd];
        if (options.muxWindowID === undefined) {
          args.push("--new-window");
          if (options.workspace) args.push("--workspace", options.workspace);
        } else args.push("--window-id", String(options.muxWindowID));
        args.push("--", ...options.command);
        const output = await command(args);
        const paneID = Number.parseInt(output.trim(), 10);
        if (!Number.isSafeInteger(paneID))
          throw new Error(
            `WezTerm returned an invalid pane id: ${output.trim()}`,
          );
        const pane = (await this.list()).find(
          (item) => item.pane_id === paneID,
        );
        if (!pane)
          throw new Error(
            `WezTerm created pane ${paneID} but it was not listed`,
          );
        return pane;
      });
    },
    async list() {
      const output = await command(["cli", "list", "--format", "json"]);
      const parsed = JSON.parse(output) as unknown;
      if (!Array.isArray(parsed))
        throw new Error("WezTerm returned invalid pane list");
      return parsed.map(parsePane);
    },
    async read(paneID, options = {}) {
      if (options.format === "selection") {
        return await command([
          "cli",
          "get-selection",
          "--pane-id",
          String(paneID),
        ]);
      }
      if (options.format === "highlights") {
        return await command([
          "cli",
          "get-highlights",
          "--pane-id",
          String(paneID),
        ]);
      }
      const maxLines = Math.max(1, Math.min(options.maxLines ?? 200, 2000));
      const args = ["cli", "get-text", "--pane-id", String(paneID)];
      if (options.startLine !== undefined) {
        // The CLI is handed whatever range it is given, so a reversed pair is
        // normalized here rather than asking the terminal to interpret it. This
        // is input hygiene: no crash has been traced to a reversed range, and it
        // should not be presented as a fix for one.
        const startLine = Math.trunc(options.startLine);
        const endLine =
          options.endLine === undefined
            ? undefined
            : Math.trunc(options.endLine);
        const lowerLine =
          endLine === undefined ? startLine : Math.min(startLine, endLine);
        args.push("--start-line", String(lowerLine));
        if (endLine !== undefined)
          args.push("--end-line", String(Math.max(startLine, endLine)));
      } else args.push("--start-line", String(-maxLines));
      return await command(args);
    },
    async write(paneID, data) {
      await command(
        ["cli", "send-text", "--pane-id", String(paneID), "--no-paste"],
        data,
      );
    },
    async open(paneID, options = {}) {
      const openedAt = performance.now();
      const before = (await this.list()).find(
        (item) => item.pane_id === paneID,
      );
      if (!before) throw new Error(`WezTerm pane ${paneID} is unavailable`);
      // A fresh wezterm-mux-server creates a default shell pane before Natalia
      // spawns the first TerminalSession. It is private to this UUID-scoped
      // mux, but must not become a stray empty tab in the first Hub window.
      if (options.discardBootstrapPanes)
        for (const pane of await this.list())
          if (pane.pane_id !== paneID)
            await command([
              "cli",
              "kill-pane",
              "--pane-id",
              String(pane.pane_id),
            ]);
      await command([
        "cli",
        "move-pane-to-new-tab",
        "--pane-id",
        String(paneID),
        ...(options.muxWindowID === undefined
          ? ["--new-window", "--workspace", "natalia"]
          : ["--window-id", String(options.muxWindowID)]),
      ]);
      if (options.launch !== false) {
        await this.openHub?.({ environment: options.environment });
        input.onPerformance?.(
          "native.gui.launch",
          performance.now() - openedAt,
        );
      }
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        await command(["cli", "activate-pane", "--pane-id", String(paneID)]);
        const pane = (await this.list()).find(
          (item) => item.pane_id === paneID,
        );
        if (!pane)
          throw new Error(`WezTerm pane ${paneID} disappeared while opening`);
        // A server-side move changes window identity before any GUI client
        // exists. Only the private mux client's focused pane proves the GUI
        // attached to this exact Natalia pane rather than a local shell.
        if ((await privateClientPaneIDs()).includes(paneID)) {
          input.onPerformance?.(
            "native.gui.attach",
            performance.now() - openedAt,
          );
          return pane;
        }
        await Bun.sleep(100);
      }
      throw new Error(
        `WezTerm GUI did not attach to the native terminal window within ${timeoutMs}ms`,
      );
    },
    async openHub(options = {}) {
      if ((await privateClientPaneIDs()).length) return;
      await ensureCjkGlyphReadiness();
      await launch(
        executable,
        [
          ...global,
          "connect",
          input.nativeDomain?.name ?? input.muxDomain ?? "local",
          "--workspace",
          "natalia",
        ],
        options.environment
          ? { ...privateEnvironment, ...options.environment }
          : privateEnvironment,
      );
    },
    async focus(paneID) {
      await command(["cli", "activate-pane", "--pane-id", String(paneID)]);
    },
    async resize(paneID, rows, cols) {
      const pane = (await this.list()).find((item) => item.pane_id === paneID);
      if (!pane || pane.rows === undefined || pane.cols === undefined)
        throw new Error("WezTerm pane geometry is unavailable");
      const rowDelta = rows - pane.rows;
      const colDelta = cols - pane.cols;
      if (rowDelta)
        await command([
          "cli",
          "adjust-pane-size",
          "--pane-id",
          String(paneID),
          "--amount",
          String(Math.abs(rowDelta)),
          rowDelta > 0 ? "Down" : "Up",
        ]);
      if (colDelta)
        await command([
          "cli",
          "adjust-pane-size",
          "--pane-id",
          String(paneID),
          "--amount",
          String(Math.abs(colDelta)),
          colDelta > 0 ? "Right" : "Left",
        ]);
    },
    async stop(paneID) {
      await command(["cli", "kill-pane", "--pane-id", String(paneID)]);
    },
    async dispose() {
      if (!input.muxRuntimeDir) return;
      const pidFile = join(input.muxRuntimeDir, "wezterm", "pid");
      try {
        const pid = Number.parseInt(
          (await readFile(pidFile, "utf8")).trim(),
          10,
        );
        if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
      } catch (error) {
        // Dispose wants the mux server gone. A missing pid file (ENOENT) and a
        // pid that no longer exists (ESRCH) both mean it already is, which is
        // success, not failure. Treating ESRCH as an error meant that disposing
        // after the mux had crashed threw from the shutdown path.
        const code =
          error instanceof Error && "code" in error
            ? (error as NodeJS.ErrnoException).code
            : undefined;
        if (code !== "ENOENT" && code !== "ESRCH") throw error;
      } finally {
        // The mux server still holds its socket, pid, and log files for a
        // moment after termination. POSIX unlinks them regardless; Windows
        // refuses while any handle is open, so retry briefly instead of
        // leaving a runtime directory behind on every dispose.
        for (let attempt = 0; ; attempt += 1) {
          try {
            await rm(input.muxRuntimeDir, { recursive: true, force: true });
            break;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if ((code !== "EBUSY" && code !== "EPERM") || attempt >= 10) break;
            await Bun.sleep(100);
          }
        }
      }
    },
    async isClientAttached(paneID) {
      try {
        const output = await command([
          "cli",
          "list-clients",
          "--format",
          "json",
        ]);
        const clients = JSON.parse(output) as unknown;
        if (!Array.isArray(clients)) return false;
        return clients.some(
          (client: Record<string, unknown>) =>
            client &&
            typeof client.focused_pane_id === "number" &&
            client.focused_pane_id === paneID,
        );
      } catch {
        return false;
      }
    },
    async isAlive() {
      return await isMuxAlive();
    },
    resetMuxReady() {
      muxReady = undefined;
    },
    async listClients() {
      try {
        const output = await command([
          "cli",
          "list-clients",
          "--format",
          "json",
        ]);
        const clients = JSON.parse(output) as unknown;
        if (!Array.isArray(clients)) return [];
        return clients
          .filter(
            (client: unknown): client is Record<string, unknown> =>
              !!client && typeof client === "object",
          )
          .map((client) => ({
            focused_pane_id: client.focused_pane_id as number,
          }));
      } catch {
        return [];
      }
    },
  };
}

/**
 * Removes mux runtime directories left behind by runtimes that exited without
 * disposing. Each runtime creates one directory, so a process that is killed or
 * crashes leaks it, and they accumulate for as long as the host stays up.
 *
 * A directory is only reclaimed when nothing is using it: either no mux server
 * ever wrote a pid there, or the recorded pid is gone. The age check keeps this
 * away from a sibling runtime that has just created its directory and has not
 * started its server yet.
 */
export async function reclaimStaleMuxRuntimeDirs(input: {
  root: string;
  keep?: string;
  olderThanMs?: number;
}) {
  const olderThanMs = input.olderThanMs ?? 600_000;
  const entries = await readdir(input.root, { withFileTypes: true }).catch(
    () => [],
  );
  let reclaimed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === input.keep) continue;
    const directory = join(input.root, entry.name);
    try {
      const info = await stat(directory);
      if (Date.now() - info.mtimeMs < olderThanMs) continue;
      if (await muxRuntimeDirInUse(directory)) continue;
      await rm(directory, { recursive: true, force: true });
      reclaimed += 1;
    } catch {
      // A directory that cannot be inspected or removed is left alone; another
      // runtime may own it, and reclamation must never break startup.
    }
  }
  return reclaimed;
}

async function muxRuntimeDirInUse(directory: string) {
  const raw = await readFile(join(directory, "wezterm", "pid"), "utf8").catch(
    () => undefined,
  );
  if (raw === undefined) return false;
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else, so it is in
    // use. ESRCH means it is gone and the directory can go with it.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function writeWezTermNativeDomainConfig(input: {
  directory: string;
  socketPath: string;
  name?: string;
  os?: NodeJS.Platform;
}) {
  const name = input.name ?? "natalia";
  const configFile = join(input.directory, "wezterm-native-domain.lua");
  const fonts = monospaceFontFallback(input.os)
    .map((font) => `    ${JSON.stringify(font)},`)
    .join("\n");
  await writeFile(
    configFile,
    `local wezterm = require 'wezterm'

return {
  unix_domains = {
    {
      name = ${JSON.stringify(name)},
      socket_path = [[${input.socketPath}]],
      no_serve_automatically = true,
    },
  },
  -- Avoid the asynchronous system fallback path for CJK text. The latter can
  -- briefly render Last Resort/tofu glyphs while fontconfig resolves fonts.
  font = wezterm.font_with_fallback {
${fonts}
  },
}
`,
    { mode: 0o600 },
  );
  return { name, socketPath: input.socketPath, configFile };
}

/**
 * Explicit monospace fallback chain per platform. The CJK families differ
 * between distributions and Windows, and an absent family would otherwise be
 * resolved as tofu rather than falling through to the next candidate.
 */
export function monospaceFontFallback(os?: NodeJS.Platform): string[] {
  if (isWindows(os))
    return [
      "JetBrains Mono",
      "Cascadia Mono",
      "Consolas",
      "Microsoft YaHei Mono",
      "Microsoft YaHei",
      "Segoe UI Emoji",
    ];
  return [
    "JetBrains Mono",
    "Noto Sans Mono CJK SC",
    "Noto Sans CJK SC",
    "Noto Color Emoji",
  ];
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  args: string[],
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `WezTerm command timed out after ${timeoutMs}ms: ${args.join(" ")}`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type NativeTerminalSession = {
  id: string;
  /** The session that started this pane; absent for pre-I3 recovered panes. */
  sessionID?: string;
  /** The subagent that started this pane, when a subagent created it. */
  agentID?: string;
  host: "wezterm";
  paneID: number;
  windowID: number;
  muxWindowID: number;
  tabID: number;
  command: string;
  cwd: string;
  startedAt: string;
  revision: number;
  lastText?: string;
  lastObservedText?: string;
  lastObservedRevision?: number;
  inputOwner: "model" | "human";
  geometryOwner: "human";
  secureInput: boolean;
  status: "running" | "exited";
  attached: boolean;
  cursor_x?: number;
  cursor_y?: number;
  rows?: number;
  cols?: number;
  /** When the model last wrote input, for the TERM-M.3 route-3 weak fact. */
  lastModelWriteAt?: number;
  /** When the pane last produced output, for the same weak fact. */
  lastOutputAt?: number;
  /** Re-derived on reconcile; never inspects content. */
  mayWaitForHuman?: boolean;
};

export type NativeTerminalHub = {
  workspace: "natalia";
  muxWindowID: number;
};

export type NativeTerminalWriteResult = {
  writtenBytes: number;
  delivery: "accepted" | "duplicate" | "cancelled";
};

export type NativeTerminalAuditEvent = {
  id: string;
  sessionID?: string;
  cwd: string;
  action:
    | "write"
    | "attach"
    | "detach"
    | "resize"
    | "secure_input"
    | "exit"
    | "request_human"
    | "started";
  actor: "model" | "human" | "system";
  at: string;
  redacted?: boolean;
  /** Carried only by request_human: the model's reason, bounded and content-free. */
  detail?: string;
};

/**
 * Control plane for panes rendered by WezTerm itself. It intentionally has no
 * framebuffer, polling loop, or ANSI renderer: the native pane is the only
 * human-facing terminal authority.
 */
export class NativeTerminalRegistry {
  private readonly sessions = new Map<string, NativeTerminalSession>();
  private readonly idempotency = new Map<string, Map<string, string>>();
  private readonly modelWrites = new Map<string, Promise<void>>();
  private readonly revisionWaiters = new Map<string, Set<() => void>>();
  private hub?: NativeTerminalHub;
  private humanInputBridge?: { endpoint: string; token: string };
  private lastReconcileAt = -Infinity;
  private reconcileInFlight?: Promise<NativeTerminalSession[]>;
  /**
   * I3: the session whose panes the model-visible surface (list and every
   * id-addressed entry) may see. Unset keeps the legacy behaviour — every
   * pane is visible — which is what an externally provided registry (host
   * owns it, no sessions) expects.
   */
  private activeSession: string | undefined;

  constructor(
    private readonly host: NativeTerminalHost,
    private readonly options: {
      onAudit?: (event: NativeTerminalAuditEvent) => void;
      /**
       * How a foreground terminal start relates to the human window.
       * - `window`: always open/attach the hub window; an attach failure is a
       *   start failure (the session is removed, not left half-started).
       * - `windowless`: never open a window; the pane runs real and the model
       *   reads and writes it, the human opens it later with Open terminal.
       * - `auto` (default): attempt the window; on attach failure degrade to
       *   windowless instead of rolling the started terminal back.
       */
      windowMode?: "auto" | "windowless" | "window";
      persistPath?: string;
      /**
       * TERM-M.3 route 3: how long a pane must be silent (after model-write
       * followed by output) before the weak "may wait for human" fact reads
       * true. Content is never inspected; a long computation also reads true.
       */
      mayWaitGraceMs?: number;
    } = {},
  ) {
    this.loadPersistedSessions();
  }

  setHumanInputBridge(bridge: { endpoint: string; token: string }) {
    this.humanInputBridge = bridge;
  }

  /**
   * I3: switch whose panes the model-visible surface addresses. Pane records
   * without an owning session (a host-injected registry that started panes
   * before the runtime had a session) are claimed by the new active session;
   * explicitly owned panes never move.
   */
  setActiveSession(sessionID: string | undefined) {
    if (sessionID !== undefined)
      for (const session of this.sessions.values())
        if (session.sessionID === undefined && session.status === "running")
          session.sessionID = sessionID;
    this.activeSession = sessionID;
  }

  private assertSessionOwner(
    session: NativeTerminalSession,
    sessionID?: string,
  ) {
    const expected = sessionID ?? this.activeSession;
    if (expected && session.sessionID && session.sessionID !== expected)
      throw new Error(
        `terminal ${session.id} belongs to session ${session.sessionID}`,
      );
  }

  async start(input: {
    command: string;
    cwd: string;
    id?: string;
    sessionID?: string;
    agentID?: string;
    /**
     * A pane started for an embedded surface (the web panel's PTY backend on
     * Windows, which has no in-process PTY): real in the mux, never attached
     * to a window. The same shape the background-session derivation produces.
     */
    background?: boolean;
  }) {
    // Creating a pane is only ever requested by the model, and it lands in the
    // window the human is attached to.
    this.assertNoHumanSecureInput("starting a terminal", "model");
    // I1: a start from a session that is not the one the UI is attached to is
    // background work. It must neither open the hub nor steal focus — the
    // human's Open terminal is the only way a background pane gets a window —
    // and a timeline fact says the pane exists, waiting for that action.
    const owningSession = input.sessionID ?? this.activeSession;
    const background =
      input.background === true ||
      (this.activeSession !== undefined &&
        owningSession !== this.activeSession);
    // A restarted mux server numbers panes from scratch, so stale session
    // records can collide with the pane about to be created. Recovery marks
    // them exited first, which also clears the host readiness cache.
    if ((await this.host.isAlive?.()) === false)
      await this.reconcile({ force: true });
    let pane;
    try {
      pane = await this.host.spawn({
        cwd: input.cwd,
        command: nativeTerminalPaneCommand(input.command),
        workspace: "natalia",
        muxWindowID: this.hub?.muxWindowID,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (this.hub && /window.*(?:not found|doesn.t exist)/i.test(msg)) {
        this.hub = undefined;
        pane = await this.host.spawn({
          cwd: input.cwd,
          command: nativeTerminalPaneCommand(input.command),
          workspace: "natalia",
          muxWindowID: undefined,
        });
      } else {
        throw error;
      }
    }
    const session: NativeTerminalSession = {
      id: input.id ?? `terminal_${randomUUID()}`,
      // Model-side starts (tools and remote callers) belong to the active
      // session; an explicit id wins once parallel sessions can start panes
      // for a background session.
      sessionID: input.sessionID ?? this.activeSession,
      ...(input.agentID ? { agentID: input.agentID } : {}),
      host: "wezterm",
      paneID: pane.pane_id,
      windowID: pane.window_id,
      muxWindowID: pane.window_id,
      tabID: pane.tab_id,
      command: input.command,
      cwd: input.cwd,
      startedAt: new Date().toISOString(),
      revision: 0,
      inputOwner: "model",
      geometryOwner: "human",
      secureInput: false,
      status: "running",
      attached: true,
      rows: pane.rows,
      cols: pane.cols,
    };
    this.sessions.set(session.id, session);
    try {
      await this.persistSessions();
    } catch (error) {
      // persistSessions failed: never leave a pane registered without a
      // durable record.
      this.sessions.delete(session.id);
      await this.host.stop(session.paneID).catch(() => undefined);
      await this.persistSessions().catch(() => undefined);
      throw error;
    }
    const windowMode = this.options.windowMode ?? "auto";
    if (windowMode !== "windowless" && !background) {
      try {
        if (!this.hub) await this.attachToHub(session, true, true);
        else {
          session.windowID = this.hub.muxWindowID;
          session.muxWindowID = this.hub.muxWindowID;
          // Kill stray panes (e.g. mux default pane) in the hub window that
          // are not managed by any session. The new session is already in
          // this.sessions so its paneID is in the known set and won't be killed.
          const known = new Set(this.sessions.values().map((s) => s.paneID));
          for (const p of await this.host.list())
            if (!known.has(p.pane_id) && p.window_id === this.hub.muxWindowID)
              await this.host.stop(p.pane_id).catch(() => {});
          await this.host.focus(session.paneID);
        }
      } catch (error) {
        if (windowMode === "auto") {
          // No display, a stale DISPLAY, or a transient first-run attach
          // failure: the pane is real and the model can keep using it, so
          // degrade to windowless instead of rolling the start back. The
          // timeline fact is the trace until Open terminal attaches a window.
          this.audit(session, "started", "model");
        } else {
          // Explicit `window`: the attach was required. A half-started
          // session must not linger as "running": remove it and kill the
          // pane so the next list/observe is consistent and a retry starts
          // clean.
          this.sessions.delete(session.id);
          await this.host.stop(session.paneID).catch(() => undefined);
          await this.persistSessions().catch(() => undefined);
          throw error;
        }
      }
    } else {
      // Windowless mode, or a start from a background session: the pane is
      // real but windowless; the human opens it with Open terminal. The
      // timeline fact is the only trace until then.
      this.audit(session, "started", "model");
    }
    return session;
  }

  /** I3: only the active session's panes are visible to the model surface. */
  private sessionVisible(session: NativeTerminalSession): boolean {
    return (
      this.activeSession === undefined ||
      session.sessionID === this.activeSession
    );
  }

  list() {
    return [...this.sessions.values()].filter((session) =>
      this.sessionVisible(session),
    );
  }

  private loadPersistedSessions() {
    if (!this.options.persistPath) return;
    try {
      if (!existsSync(this.options.persistPath)) return;
      const data = JSON.parse(
        readFileSync(this.options.persistPath, "utf8"),
      ) as unknown;
      if (!data || typeof data !== "object") return;
      const manifest = data as Record<string, unknown>;
      const sessions = manifest.sessions;
      if (!Array.isArray(sessions)) return;
      for (const raw of sessions) {
        if (!raw || typeof raw !== "object") continue;
        const paneID = (raw as Record<string, unknown>).paneID;
        const session: NativeTerminalSession = {
          id: (raw as Record<string, unknown>).id as string,
          sessionID: (raw as Record<string, unknown>).sessionID as
            | string
            | undefined,
          ...(((raw as Record<string, unknown>).agentID as string | undefined)
            ? { agentID: (raw as Record<string, unknown>).agentID as string }
            : {}),
          host: "wezterm",
          paneID: typeof paneID === "number" ? paneID : 0,
          windowID: (raw as Record<string, unknown>).windowID as number,
          muxWindowID: (raw as Record<string, unknown>).muxWindowID as number,
          tabID: (raw as Record<string, unknown>).tabID as number,
          command: ((raw as Record<string, unknown>).command as string) ?? "",
          cwd: ((raw as Record<string, unknown>).cwd as string) ?? "",
          startedAt:
            ((raw as Record<string, unknown>).startedAt as string) ??
            new Date().toISOString(),
          revision: 0,
          inputOwner:
            ((raw as Record<string, unknown>)
              .inputOwner as NativeTerminalSession["inputOwner"]) ?? "model",
          geometryOwner: "human",
          secureInput: Boolean((raw as Record<string, unknown>).secureInput),
          status:
            ((raw as Record<string, unknown>)
              .status as NativeTerminalSession["status"]) ?? "exited",
          attached: Boolean((raw as Record<string, unknown>).attached),
          cursor_x: (raw as Record<string, unknown>).cursor_x as
            | number
            | undefined,
          cursor_y: (raw as Record<string, unknown>).cursor_y as
            | number
            | undefined,
          rows: (raw as Record<string, unknown>).rows as number | undefined,
          cols: (raw as Record<string, unknown>).cols as number | undefined,
        };
        this.sessions.set(session.id, session);
      }
    } catch {
      // ignore corrupt manifest; empty sessions will be rebuilt on start
    }
  }

  private async persistSessions() {
    if (!this.options.persistPath) return;
    try {
      await mkdir(dirname(this.options.persistPath), { recursive: true });
      const data = JSON.stringify({
        sessions: Array.from(this.sessions.values()).map((s) => ({
          id: s.id,
          sessionID: s.sessionID,
          ...(s.agentID ? { agentID: s.agentID } : {}),
          paneID: s.paneID,
          windowID: s.windowID,
          muxWindowID: s.muxWindowID,
          tabID: s.tabID,
          command: s.command,
          cwd: s.cwd,
          startedAt: s.startedAt,
          status: s.status,
          inputOwner: s.inputOwner,
          secureInput: s.secureInput,
          rows: s.rows,
          cols: s.cols,
          attached: s.attached,
          cursor_x: s.cursor_x,
          cursor_y: s.cursor_y,
        })),
        hub: this.hub,
      });
      await writeFile(this.options.persistPath, data, { mode: 0o600 });
    } catch {
      // persistence is best-effort; runtime continues without durable manifest
    }
  }

  isHumanInputOwner(id: string) {
    return this.get(id).inputOwner === "human";
  }

  async reconcile(options: { force?: boolean } = {}) {
    if (!options.force && performance.now() - this.lastReconcileAt < 2_000)
      return this.list();
    this.reconcileInFlight ??= this.reconcileNow().finally(() => {
      this.reconcileInFlight = undefined;
    });
    return await this.reconcileInFlight;
  }

  private async reconcileNow() {
    let panes: NativeTerminalPane[];
    try {
      panes = await this.host.list();
    } catch (error) {
      let muxAlive: boolean | undefined = true;
      try {
        muxAlive = await this.host.isAlive?.();
      } catch {
        // isAlive probe itself failed; keep muxAlive=true and re-throw original
      }
      if (muxAlive === false) {
        await this.host.resetMuxReady?.();
        for (const session of this.sessions.values()) {
          if (session.status !== "exited") {
            session.status = "exited";
            session.attached = false;
            session.revision += 1;
            this.notifyRevision(session.id);
            this.audit(session, "exit", "system");
          }
        }
        await this.persistSessions();
        return this.list();
      }
      throw error;
    }
    const paneMap = new Map(panes.map((pane) => [pane.pane_id, pane]));
    const attached = new Set(
      (await this.host.listClients?.())?.map(
        (client) => client.focused_pane_id,
      ) ?? [],
    );
    this.lastReconcileAt = performance.now();
    for (const session of this.sessions.values()) {
      const pane = paneMap.get(session.paneID);
      if (!pane) {
        if (session.status !== "exited") {
          session.revision += 1;
          this.notifyRevision(session.id);
          this.audit(session, "exit", "system");
        }
        session.status = "exited";
        session.attached = false;
        session.mayWaitForHuman = false;
        continue;
      }
      session.rows = pane.rows;
      session.cols = pane.cols;
      session.cursor_x = pane.cursor_x;
      session.cursor_y = pane.cursor_y;
      session.attached = attached.has(session.paneID);
      session.mayWaitForHuman = this.deriveMayWaitForHuman(session);
    }
    await this.persistSessions();
    return this.list();
  }

  /**
   * TERM-M.3 route 3: the conservative weak fact. The model wrote, the pane
   * produced output after that write, that output was the last activity, and
   * the pane has been silent for the grace period. Deliberately no content
   * inspection: a long-running computation also reads true, which is why the
   * fact says "may".
   */
  private deriveMayWaitForHuman(session: NativeTerminalSession): boolean {
    if (session.status !== "running") return false;
    if (session.inputOwner !== "model") return false;
    const lastModelWriteAt = session.lastModelWriteAt;
    const lastOutputAt = session.lastOutputAt;
    if (!lastModelWriteAt || !lastOutputAt) return false;
    // Output found at or after the model's write counts; a strict `<=` would
    // make the fact depend on millisecond ordering between the write and the
    // read that discovers the output.
    if (lastOutputAt < lastModelWriteAt) return false;
    const graceMs = this.options.mayWaitGraceMs ?? 15_000;
    return Date.now() - lastOutputAt >= graceMs;
  }

  async read(
    id: string,
    options?: {
      maxLines?: number;
      startLine?: number;
      endLine?: number;
      sessionID?: string;
    },
  ) {
    const session = this.get(id);
    this.assertSessionOwner(session, options?.sessionID);
    await this.reconcile();
    this.assertReadable(session);
    return await this.readSession(session, options);
  }

  async snapshot(id: string) {
    const session = this.get(id);
    await this.reconcile();
    this.assertReadable(session);
    const { text, highlightRanges } = await this.readSession(session);
    return {
      text,
      cursorX: session.cursor_x ?? 0,
      cursorY: session.cursor_y ?? 0,
      rows: session.rows ?? 0,
      cols: session.cols ?? 0,
      revision: session.revision,
      status: session.status,
      inputOwner: session.inputOwner,
      highlightRanges,
    };
  }

  async write(
    id: string,
    data: string,
    options: {
      idempotencyKey?: string;
      sessionID?: string;
      /**
       * Who is typing. The PTY controller's shape: the model's write is
       * refused on a human-owned pane; the human's write is refused on a
       * secure-input pane. Without the actor a web panel claimed by its
       * human could not type at all — the pane would refuse every keystroke
       * with "input is controlled by a human" while the human holds it.
       */
      actor?: "model" | "human";
    } = {},
  ): Promise<NativeTerminalWriteResult> {
    const session = this.get(id);
    this.assertSessionOwner(session, options.sessionID);
    await this.reconcile();
    this.assertRunning(session);
    const human = options.actor === "human";
    if (!human && session.inputOwner !== "model")
      throw new Error("terminal input is controlled by a human");
    if (session.secureInput)
      throw new Error("terminal is accepting secure human input");
    const writtenBytes = new TextEncoder().encode(data).byteLength;
    if (options.idempotencyKey) {
      const keys = this.idempotency.get(id) ?? new Map<string, string>();
      const previous = keys.get(options.idempotencyKey);
      if (previous !== undefined) {
        if (previous !== data)
          throw new Error(
            "terminal idempotency key was reused with different input",
          );
        return { writtenBytes, delivery: "duplicate" };
      }
      keys.set(options.idempotencyKey, data);
      this.idempotency.set(id, keys);
      while (keys.size > 256) keys.delete(keys.keys().next().value!);
    }
    const previous = this.modelWrites.get(id) ?? Promise.resolve();
    let cancelled = false;
    const delivery = previous.then(async () => {
      if (human) {
        // Keystrokes go to the pane verbatim: the pane's tty is in raw mode
        // while it runs, and the wezterm host's send-text is the byte path.
        // No modelInputChunks guard — that is the model's bracketed-paste
        // discipline, not a human's typing.
        await this.host.write(session.paneID, data);
        return;
      }
      for (const chunk of modelInputChunks(data)) {
        if (session.inputOwner !== "model") {
          cancelled = true;
          return;
        }
        await this.host.write(session.paneID, chunk);
      }
    });
    this.modelWrites.set(
      id,
      delivery.catch(() => undefined),
    );
    try {
      await delivery;
    } catch (error) {
      if (options.idempotencyKey)
        this.idempotency.get(id)?.delete(options.idempotencyKey);
      throw error;
    }
    if (cancelled) {
      if (options.idempotencyKey)
        this.idempotency.get(id)?.delete(options.idempotencyKey);
      return { writtenBytes, delivery: "cancelled" };
    }
    session.revision += 1;
    if (human) session.lastOutputAt = Date.now();
    else session.lastModelWriteAt = Date.now();
    this.audit(session, "write", human ? "human" : "model");
    this.notifyRevision(session.id);
    return { writtenBytes, delivery: "accepted" };
  }

  async openHub() {
    if (!this.hub) {
      const firstSession = this.list().find(
        (session) => session.status === "running",
      );
      if (!firstSession) throw new Error("no running native terminal session");
      await this.attachToHub(firstSession, true, false);
      return this.hub!;
    }
    await this.host.openHub?.();
    return this.hub;
  }

  private async cleanupStalePanes() {
    if (!this.host.list || !this.host.stop) return;
    const known = new Set(
      this.sessions.values().map((session) => session.paneID),
    );
    const hubWindowID = this.hub?.muxWindowID;
    for (const pane of await this.host.list()) {
      if (!known.has(pane.pane_id) && pane.window_id !== hubWindowID) {
        await this.host.stop(pane.pane_id);
      }
    }
  }

  private async attachToHub(
    session: NativeTerminalSession,
    launch: boolean,
    selectTarget = false,
  ) {
    if (!this.host.open) return undefined;
    await this.cleanupStalePanes();
    const environment = this.humanInputBridge
      ? {
          NATALIA_NATIVE_INPUT_ENDPOINT: this.humanInputBridge.endpoint,
          NATALIA_NATIVE_INPUT_TOKEN: this.humanInputBridge.token,
        }
      : undefined;
    let pane;
    try {
      pane = await this.host.open(session.paneID, {
        environment,
        muxWindowID: this.hub?.muxWindowID,
        launch,
        discardBootstrapPanes: this.hub === undefined,
      });
    } catch (error) {
      if (
        this.hub &&
        error instanceof Error &&
        /window.*not found|not found.*window|not found on this server/i.test(
          error.message,
        )
      ) {
        this.hub = undefined;
        pane = await this.host.open(session.paneID, {
          environment,
          muxWindowID: undefined,
          launch,
          discardBootstrapPanes: true,
        });
      } else {
        throw error;
      }
    }
    if (!this.hub)
      this.hub = { workspace: "natalia", muxWindowID: pane.window_id };
    session.windowID = pane.window_id;
    session.muxWindowID = pane.window_id;
    session.tabID = pane.tab_id;
    session.rows = pane.rows;
    session.cols = pane.cols;
    if (selectTarget && this.hub) await this.host.focus(session.paneID);
    return pane;
  }

  /**
   * Refuses an action that would disturb a human who is entering a secret.
   *
   * `secureInput` already guarantees the bytes are never seen by us — the native
   * host writes them through its own path. It did not guarantee the *surroundings*:
   * a pane appearing, a pane dying or a resize all re-lay out the multiplexer window
   * the human is typing into, which can move the prompt, redraw over it, or steal
   * the focus mid-password.
   *
   * Writing to another pane is deliberately still allowed: it changes no layout, and
   * refusing all model output during a password prompt would stall unrelated work.
   */
  private assertNoHumanSecureInput(action: string, actor: "model" | "human") {
    if (actor !== "model") return;
    const holder = this.list().find(
      (session) => session.secureInput && session.inputOwner === "human",
    );
    if (holder)
      throw new Error(
        `${action} refused while a human is entering secure input on terminal ${holder.id}`,
      );
  }

  async claimHumanInput(id: string, sessionID?: string) {
    const session = this.get(id);
    this.assertSessionOwner(session, sessionID);
    this.assertRunning(session);
    if (session.secureInput && session.inputOwner !== "human")
      throw new Error("secure input requires human terminal control");
    // The host claims before every native pane write. Only the first accepted
    // claim is an ownership transition; subsequent human keystrokes must not
    // churn revisions, audit events, or the TUI timeline.
    if (session.inputOwner === "human") return session;
    // A native host retains and writes the bytes through its original pane path
    // after this synchronous ownership transition. Natalia never sees them.
    session.inputOwner = "human";
    session.revision += 1;
    this.notifyRevision(session.id);
    await this.reconcile();
    this.assertRunning(session);
    this.audit(session, "write", "human", session.secureInput);
    return session;
  }

  async attach(id: string) {
    const session = this.get(id);
    this.assertRunning(session);
    await this.openHub();
    this.audit(session, "attach", "human");
    return session;
  }

  detach(id: string) {
    const session = this.get(id);
    if (session.secureInput)
      throw new Error("secure input must end before detaching");
    session.inputOwner = "model";
    session.revision += 1;
    this.notifyRevision(session.id);
    this.audit(session, "detach", "human");
    return session;
  }

  releaseHumanControl(id: string, sessionID?: string) {
    const session = this.get(id);
    this.assertSessionOwner(session, sessionID);
    if (session.secureInput)
      throw new Error(
        "secure input must end before returning control to model",
      );
    session.inputOwner = "model";
    session.revision += 1;
    this.notifyRevision(session.id);
    this.audit(session, "detach", "human");
    return session;
  }

  beginSecureInput(id: string, sessionID?: string) {
    const session = this.get(id);
    this.assertSessionOwner(session, sessionID);
    this.assertRunning(session);
    if (session.inputOwner !== "human")
      throw new Error("secure input requires human terminal control");
    session.secureInput = true;
    session.revision += 1;
    this.notifyRevision(session.id);
    this.audit(session, "secure_input", "human");
    return session;
  }

  endSecureInput(id: string, sessionID?: string) {
    const session = this.get(id);
    this.assertSessionOwner(session, sessionID);
    session.secureInput = false;
    session.revision += 1;
    this.notifyRevision(session.id);
    this.audit(session, "secure_input", "human");
    return session;
  }

  async observe(
    id: string,
    afterRevision: number,
    options: { maxLines?: number; timeoutMs?: number } = {},
  ) {
    const session = this.get(id);
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 5_000, 30_000));
    const deadline = performance.now() + timeoutMs;
    while (true) {
      await this.reconcile();
      if (session.status === "exited")
        return {
          session,
          text: "",
          cursorX: session.cursor_x ?? 0,
          cursorY: session.cursor_y ?? 0,
          rows: session.rows ?? 0,
          cols: session.cols ?? 0,
          highlightRanges: [],
          afterRevision,
          changed: session.revision > afterRevision,
          reason: "exited" as const,
          exited: true,
        };
      const revisionBeforeRead = session.revision;
      const { text, cursorX, cursorY, rows, cols, highlightRanges } =
        await this.readSession(session, { maxLines: options.maxLines });
      if (session.revision > afterRevision)
        return {
          session,
          text,
          cursorX,
          cursorY,
          rows,
          cols,
          highlightRanges,
          afterRevision,
          changed: true,
          reason:
            session.revision > revisionBeforeRead
              ? ("screen_changed" as const)
              : ("session_activity" as const),
        };
      if (performance.now() >= deadline)
        return {
          session,
          text,
          cursorX,
          cursorY,
          rows,
          cols,
          highlightRanges,
          afterRevision,
          changed: false,
          reason: "timeout" as const,
        };
      await this.waitForRevision(
        session.id,
        Math.max(10, Math.min(500, deadline - performance.now())),
      );
    }
  }

  /**
   * Resizes a pane on behalf of `actor`.
   *
   * The actor is passed in rather than assumed. It used to be recorded as `human`
   * unconditionally while the only caller was the model's resize tool, so every
   * model-driven resize appeared in the audit trail as something a person did —
   * an audit that answers "who did this" wrongly is worse than one that says
   * nothing.
   *
   * The check this replaces (`geometryOwner !== "human"`) could never fire:
   * `geometryOwner` is typed as the literal `"human"` and only ever assigned it. A
   * guard that cannot run reads like protection while providing none. If geometry
   * ownership should actually restrict the model, that is a product decision and
   * has to be modelled as a transition like `inputOwner` is, not as a constant.
   */
  async resize(
    id: string,
    rows: number,
    cols: number,
    actor: "model" | "human" = "model",
    sessionID?: string,
  ) {
    const session = this.get(id);
    this.assertSessionOwner(session, sessionID);
    await this.reconcile();
    this.assertRunning(session);
    this.assertNoHumanSecureInput("resizing a terminal", actor);
    if (!Number.isInteger(rows) || rows < 1 || rows > 500)
      throw new Error("terminal rows must be an integer between 1 and 500");
    if (!Number.isInteger(cols) || cols < 1 || cols > 500)
      throw new Error("terminal cols must be an integer between 1 and 500");
    await this.host.resize(session.paneID, rows, cols);
    session.rows = rows;
    session.cols = cols;
    session.revision += 1;
    this.notifyRevision(session.id);
    this.audit(session, "resize", actor);
    return session;
  }

  async stop(
    id: string,
    actor: "model" | "human" | "system" = "system",
    sessionID?: string,
  ) {
    const session = this.get(id);
    this.assertSessionOwner(session, sessionID);
    this.assertNoHumanSecureInput(
      "stopping a terminal",
      actor === "system" ? "human" : actor,
    );
    if (session.status === "running")
      try {
        await this.host.stop(session.paneID);
      } catch {
        // pane already gone; proceed with local cleanup
      }
    session.status = "exited";
    session.revision += 1;
    session.attached = false;
    this.notifyRevision(session.id);
    this.idempotency.delete(id);
    this.modelWrites.delete(id);
    this.audit(session, "exit", actor);
    await this.persistSessions();
    return session;
  }

  async stopForSession(sessionID: string) {
    const owned = [...this.sessions.values()].filter(
      (session) =>
        session.sessionID === sessionID && session.status === "running",
    );
    await Promise.allSettled(
      owned.map(async (session) => {
        await this.stop(session.id, "system");
      }),
    );
  }

  /**
   * TERM-M.3 route 2: the model explicitly declares that a pane needs a
   * human. Publishes the request as an audit fact and returns immediately —
   * the model is expected to go do something else and observe later (the (b)
   * semantics). `reason` is a fact that may reach the journal, so it is
   * bounded and must describe the kind of input needed, never screen content,
   * file content, or anything that looks like a secret.
   */
  async requestHuman(id: string, reason: string, sessionID?: string) {
    const session = this.get(id);
    this.assertSessionOwner(session, sessionID);
    this.assertRunning(session);
    if (typeof reason !== "string" || reason.length === 0)
      throw new Error("request_human requires a reason");
    if (reason.length > 240)
      throw new Error(
        "request_human reason must be 240 characters or fewer; describe the kind of input needed, never screen content or secrets",
      );
    this.audit(session, "request_human", "model", undefined, reason);
    return session;
  }

  async dispose() {
    // I3: teardown is registry lifecycle, not a session-scoped view — every
    // pane must stop, including panes of sessions that are not active now.
    const running = [...this.sessions.values()].filter(
      (session) => session.status === "running",
    );
    await Promise.allSettled(running.map((session) => this.stop(session.id)));
    await this.persistSessions();
    await this.host.dispose?.();
    this.sessions.clear();
    this.modelWrites.clear();
    this.idempotency.clear();
    this.revisionWaiters.clear();
    this.hub = undefined;
  }

  session(id: string): NativeTerminalSession {
    return this.get(id);
  }

  /**
   * Terminal device backing a pane. The runtime uses it to confirm which program
   * is actually in the foreground, instead of inferring that from the screen.
   */
  async ttyName(id: string): Promise<string | undefined> {
    const session = this.get(id);
    const panes = await this.host.list();
    return panes.find((pane) => pane.pane_id === session.paneID)?.tty_name;
  }

  markObserved(id: string, text: string, revision: number) {
    const session = this.get(id);
    session.lastObservedText = text;
    session.lastObservedRevision = revision;
  }

  lastObservedRevision(id: string): number | undefined {
    return this.get(id).lastObservedRevision;
  }

  private get(id: string): NativeTerminalSession {
    const session = this.sessions.get(id);
    // I3: a pane that exists but belongs to another session is indistinguishable
    // from an unknown id, so cross-session probing cannot even learn existence.
    if (!session || !this.sessionVisible(session))
      throw new Error(`native terminal session not found: ${id}`);
    return session;
  }

  private async readSession(
    session: NativeTerminalSession,
    options?: { maxLines?: number; startLine?: number; endLine?: number },
  ) {
    const paneID = session.paneID;
    let text: string;
    let selectionJson: string;
    let highlightsJson: string;
    try {
      [text, selectionJson, highlightsJson] = await Promise.all([
        this.host.read(paneID, options),
        this.host.read(paneID, { format: "selection" }),
        this.host.read(paneID, { format: "highlights" }),
      ]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (
        /pane.*(?:not found|doesn.t exist|unavailable)|window.*(?:not found|doesn.t exist)/i.test(
          msg,
        )
      ) {
        session.status = "exited";
        session.attached = false;
        session.revision += 1;
        this.notifyRevision(session.id);
        return {
          text: "",
          cursorX: 0,
          cursorY: 0,
          rows: 1,
          cols: 80,
          highlightRanges: [],
        };
      }
      throw error;
    }
    if (text !== session.lastText) {
      session.lastText = text;
      session.revision += 1;
      // The pane produced output after the model's last write: this is the
      // timestamp the TERM-M.3 route-3 weak fact keys on.
      session.lastOutputAt = Date.now();
      this.notifyRevision(session.id);
    }
    const highlightRanges: Array<{
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
    }> = [];
    try {
      const parsedSelection = JSON.parse(selectionJson) as Record<
        string,
        unknown
      >;
      const selection = parsedSelection.selection as Record<
        string,
        unknown
      > | null;
      if (selection && Array.isArray(selection.ranges)) {
        for (const r of selection.ranges as Array<Record<string, unknown>>) {
          highlightRanges.push({
            startRow: Number(r.startRow) ?? 0,
            startCol: Number(r.startCol) ?? 0,
            endRow: Number(r.endRow) ?? 0,
            endCol: Number(r.endCol) ?? 0,
          });
        }
      }
    } catch {
      // ignore parse errors
    }
    try {
      const parsedHighlights = JSON.parse(highlightsJson) as Record<
        string,
        unknown
      >;
      const highlights = parsedHighlights.highlights as Record<
        string,
        unknown
      > | null;
      if (highlights && Array.isArray(highlights.ranges)) {
        for (const r of highlights.ranges as Array<Record<string, unknown>>) {
          highlightRanges.push({
            startRow: Number(r.startRow) ?? 0,
            startCol: Number(r.startCol) ?? 0,
            endRow: Number(r.endRow) ?? 0,
            endCol: Number(r.endCol) ?? 0,
          });
        }
      }
    } catch {
      // ignore parse errors
    }
    return {
      text,
      cursorX: session.cursor_x ?? 0,
      cursorY: session.cursor_y ?? 0,
      rows: session.rows ?? 0,
      cols: session.cols ?? 0,
      highlightRanges,
    };
  }

  private assertRunning(session: NativeTerminalSession) {
    if (session.status !== "running")
      throw new Error("terminal session has exited");
  }

  private async waitForRevision(id: string, timeoutMs: number) {
    await new Promise<void>((resolve) => {
      const waiters = this.revisionWaiters.get(id) ?? new Set<() => void>();
      const wake = () => {
        clearTimeout(timer);
        waiters.delete(wake);
        if (!waiters.size) this.revisionWaiters.delete(id);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      waiters.add(wake);
      this.revisionWaiters.set(id, waiters);
    });
  }

  private notifyRevision(id: string) {
    for (const wake of this.revisionWaiters.get(id) ?? []) wake();
  }

  private assertReadable(session: NativeTerminalSession) {
    this.assertRunning(session);
    if (session.secureInput)
      throw new Error("terminal output is hidden during secure human input");
  }

  private audit(
    session: NativeTerminalSession,
    action: NativeTerminalAuditEvent["action"],
    actor: NativeTerminalAuditEvent["actor"],
    redacted = false,
    detail?: string,
  ) {
    this.options.onAudit?.({
      id: session.id,
      sessionID: session.sessionID,
      cwd: session.cwd,
      action,
      actor,
      at: new Date().toISOString(),
      redacted: action === "write" ? redacted : undefined,
      detail,
    });
  }
}

function modelInputChunks(data: string) {
  // Each chunk starts a `wezterm cli send-text` process. Avoid a process spawn
  // per handful of characters while still bounding a single command payload.
  const characters = [...data];
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += 1024)
    chunks.push(characters.slice(index, index + 1024).join(""));
  return chunks;
}

function parsePane(value: unknown): NativeTerminalPane {
  if (!value || typeof value !== "object")
    throw new Error("WezTerm returned an invalid pane entry");
  const pane = value as Record<string, unknown>;
  for (const field of ["pane_id", "window_id", "tab_id"] as const)
    if (!Number.isSafeInteger(pane[field]))
      throw new Error(`WezTerm pane is missing numeric ${field}`);
  return {
    pane_id: pane.pane_id as number,
    window_id: pane.window_id as number,
    tab_id: pane.tab_id as number,
    title: typeof pane.title === "string" ? pane.title : undefined,
    cwd: typeof pane.cwd === "string" ? pane.cwd : undefined,
    cursor_x: typeof pane.cursor_x === "number" ? pane.cursor_x : undefined,
    cursor_y: typeof pane.cursor_y === "number" ? pane.cursor_y : undefined,
    is_active: typeof pane.is_active === "boolean" ? pane.is_active : undefined,
    tty_name: typeof pane.tty_name === "string" ? pane.tty_name : undefined,
    rows:
      typeof pane.size === "object" &&
      pane.size !== null &&
      typeof (pane.size as Record<string, unknown>).rows === "number"
        ? ((pane.size as Record<string, unknown>).rows as number)
        : undefined,
    cols:
      typeof pane.size === "object" &&
      pane.size !== null &&
      typeof (pane.size as Record<string, unknown>).cols === "number"
        ? ((pane.size as Record<string, unknown>).cols as number)
        : undefined,
  };
}

async function runWezTermCommand(
  executable: string,
  args: string[],
  stdin?: string,
  environment?: Record<string, string | undefined>,
  timeoutMs = 5_000,
) {
  // A hung `wezterm cli` must not be allowed to block or retain memory inside
  // the runtime Worker. This nested worker owns the subprocess streams and is
  // terminated from its parent on deadline, independent of Bun stream state.
  const worker = new Worker(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./wezterm-command-worker.ts"
        : "./wezterm-command-worker.js",
      import.meta.url,
    ),
    {
      workerData: { executable, args, stdin, environment },
    },
  );
  return await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>((resolve, reject) => {
    let settled = false;
    const finish = (result: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      result();
    };
    const timeout = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `WezTerm command timed out after ${timeoutMs}ms: ${args.join(" ")}`,
          ),
        ),
      );
    }, timeoutMs);
    const workerEvents = worker as unknown as NodeJS.EventEmitter;
    workerEvents.once("message", (message: unknown) => {
      const result = message as {
        stdout?: unknown;
        stderr?: unknown;
        exitCode?: unknown;
        error?: unknown;
      };
      if (typeof result.error === "string") {
        const errorMessage = result.error;
        return finish(() => reject(new Error(errorMessage)));
      }
      if (
        typeof result.stdout !== "string" ||
        typeof result.stderr !== "string" ||
        typeof result.exitCode !== "number"
      )
        return finish(() =>
          reject(new Error("invalid WezTerm command response")),
        );
      const stdout = result.stdout;
      const stderr = result.stderr;
      const exitCode = result.exitCode;
      finish(() =>
        resolve({
          stdout,
          stderr,
          exitCode,
        }),
      );
    });
    workerEvents.once("error", (error: Error) => finish(() => reject(error)));
    workerEvents.once("exit", (code: number | null) => {
      if (code !== 0)
        finish(() =>
          reject(new Error(`WezTerm command worker exited: ${code}`)),
        );
    });
  });
}

async function launchWezTermGUI(
  executable: string,
  args: string[],
  environment?: Record<string, string | undefined>,
) {
  const env = { ...process.env } as Record<string, string>;
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const child = Bun.spawn({
    cmd: [executable, ...args],
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
}

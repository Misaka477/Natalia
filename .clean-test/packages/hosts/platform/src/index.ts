export * from "./hash-tree";
export * from "./store-paths";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32, join } from "node:path";

export {
  DEFAULT_NATALIA_IGNORE_CONTENT,
  DEFAULT_NATALIA_IGNORE_PATTERNS,
  ensureNataliaIgnoreFile,
  isSnapshotIgnored,
  loadNataliaIgnore,
  NATALIA_IGNORE_FILE,
  parseSnapshotIgnore,
  parseSnapshotIgnoreLine,
  type SnapshotIgnoreRule,
} from "./natalia-ignore";
export {
  createWorkspaceFile,
  deleteWorkspaceFile,
  findWorkspaceFiles,
  globWorkspaceFiles,
  globWorkspaceFilesBounded,
  grepWorkspaceFilesBounded,
  invalidateWorkspaceFiles,
  listWorkspaceFiles,
  readWorkspaceFile,
  renameWorkspaceFile,
  searchWorkspaceFiles,
  watchWorkspaceFiles,
  writeWorkspaceFile,
  type WorkspaceGlobInput,
  type WorkspaceGlobResult,
  type WorkspaceGrepInput,
  type WorkspaceGrepMatch,
  type WorkspaceGrepResult,
} from "./workspace-files";

/**
 * Host platform abstraction.
 *
 * Every function accepts an explicit `os`/`env`/`exists` injection point and
 * defaults to the real host. This keeps POSIX behaviour byte-identical to the
 * pre-abstraction call sites while making both branches testable from either
 * platform, following the convention already established by
 * `nativeInputBrokerEndpoint`.
 */

export type HostEnvironment = Record<string, string | undefined>;

export type PlatformInput = {
  os?: NodeJS.Platform;
  env?: HostEnvironment;
};

export type ShellCommand = {
  executable: string;
  args: string[];
};

export function currentPlatform(): NodeJS.Platform {
  return process.platform;
}

export function isWindows(os?: NodeJS.Platform): boolean {
  return (os ?? currentPlatform()) === "win32";
}

/**
 * Joins path segments with the separator of the *target* platform rather than
 * the host. Windows paths therefore stay well-formed when they are constructed
 * or asserted from a POSIX host, which keeps both branches deterministic.
 */
export function platformJoin(
  os: NodeJS.Platform | undefined,
  ...segments: string[]
): string {
  return isWindows(os) ? win32.join(...segments) : posix.join(...segments);
}

/**
 * Appends the Windows executable suffix to a bare binary name. Sibling binaries
 * of a resolved executable are located by name, so the suffix must be applied
 * consistently rather than only at the entry point.
 */
export function executableName(base: string, os?: NodeJS.Platform): string {
  if (!isWindows(os)) return base;
  return base.toLowerCase().endsWith(".exe") ? base : `${base}.exe`;
}

const WINDOWS_BASH_RELATIVE_PATHS = [
  win32.join("Git", "bin", "bash.exe"),
  win32.join("Git", "usr", "bin", "bash.exe"),
];

/**
 * A bash path SET BY THE USER (the settings UI's Git Bash row, persisted in
 * the config). The seam is module-level for the same reason the object
 * store's backend seam is: the shell call sites are primitives that must
 * not each learn to read the config, and one boot-time wiring is the
 * honest place. `undefined` restores discovery.
 *
 * WINDOWS ONLY, deliberately: on POSIX the shell is `bash` (or a call
 * site's own `posixShell`) and no setting is needed — a configuration row
 * that does nothing on two of three platforms is noise, so the platform
 * guard is the resolver's, not merely the UI's.
 */
let configuredBashExecutable: string | undefined;

export function configureBashExecutable(path: string | undefined): void {
  configuredBashExecutable = path && path.trim() ? path.trim() : undefined;
}

/** The configured path (the doctor's report reads it). */
export function configuredBashPath(): string | undefined {
  return configuredBashExecutable;
}

/**
 * Locates a bash-compatible shell on Windows. Natalia's shell call sites pass
 * `bash -lc` with POSIX quoting, so the Git for Windows bash is used rather
 * than `cmd.exe`: it preserves argument, redirection, and quoting semantics
 * exactly, which keeps a single shell contract across platforms.
 *
 * The order is the ergonomics the distribution asked for: the USER's
 * configured path first (a Git installed outside the four default roots —
 * D:\tools\Git, a portable install — is the case the default search
 * cannot see), then the environment variable (controlled diagnostics),
 * then discovery: the default roots, then the PATH. The registry remains
 * the one authoritative source not read yet (HKLM\SOFTWARE\GitForWindows
 * → InstallPath) — recorded, not shelled out to yet.
 */
export function resolveBashExecutable(
  input: PlatformInput & { exists?: (path: string) => boolean } = {},
): string | undefined {
  const env = input.env ?? process.env;
  if (!isWindows(input.os)) {
    // POSIX: the shell is `bash` (or a call site's own `posixShell`), so
    // the user's configured path never applies — but the ENV's explicit
    // override keeps its any-platform semantics (controlled diagnostics,
    // a contract the platform tests pin).
    return env.NATALIA_BASH_EXECUTABLE;
  }
  // Windows: the user's configuration first (a Git installed outside the
  // default roots), then the env, then discovery.
  if (configuredBashExecutable) return configuredBashExecutable;
  const fromEnv = env.NATALIA_BASH_EXECUTABLE;
  if (fromEnv) return fromEnv;
  const exists = input.exists ?? defaultExists;
  const roots = [
    env.ProgramFiles,
    env.ProgramW6432,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "Programs") : undefined,
  ];
  for (const root of roots) {
    if (!root) continue;
    for (const relative of WINDOWS_BASH_RELATIVE_PATHS) {
      const candidate = win32.join(root, relative);
      if (exists(candidate)) return candidate;
    }
  }
  // The PATH's own bash.exe: an install that put itself on the PATH is
  // discoverable without knowing where it lives.
  for (const dir of (env.PATH ?? "").split(";")) {
    if (!dir) continue;
    const candidate = win32.join(dir, "bash.exe");
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Builds the `-lc` profile-reading shell invocation used by every Natalia call
 * site. `posixShell` carries the resolution each call site already performed so
 * that POSIX behaviour is unchanged.
 */
export function profileShellCommand(
  script: string,
  input: PlatformInput & {
    posixShell?: string;
    exists?: (path: string) => boolean;
  } = {},
): ShellCommand {
  return {
    executable: shellExecutable(input),
    args: ["-lc", script],
  };
}

/**
 * Builds the `--noprofile --norc -c` invocation used where profile
 * side effects must not leak into a managed session.
 */
export function isolatedShellCommand(
  script: string,
  input: PlatformInput & {
    posixShell?: string;
    exists?: (path: string) => boolean;
  } = {},
): ShellCommand {
  return {
    executable: shellExecutable(input),
    args: ["--noprofile", "--norc", "-c", script],
  };
}

function shellExecutable(
  input: PlatformInput & {
    posixShell?: string;
    exists?: (path: string) => boolean;
  },
): string {
  if (!isWindows(input.os)) return input.posixShell ?? "bash";
  const resolved = resolveBashExecutable(input);
  if (resolved) return resolved;
  throw new Error(
    "A bash-compatible shell is unavailable on this Windows host. Install Git for Windows or set NATALIA_BASH_EXECUTABLE to a bash executable.",
  );
}

/**
 * Quotes a value for safe interpolation into a shell script.
 *
 * A single-quoted POSIX string is used, and an embedded quote is closed,
 * escaped, and reopened as `'\''`. This is valid on every platform Natalia
 * supports because a bash-compatible shell is always used, including on
 * Windows. A shorter-looking `'''` is *not* equivalent: it terminates the
 * string and silently drops or truncates the surrounding text.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Prefix that detaches a background command from the launching shell's job
 * control. `setsid` creates the owned process group that negative-PID signals
 * later address; Windows has no process-group equivalent, so the prefix is
 * empty there and process trees are terminated through `taskkill /T`.
 */
export function detachedShellPrefix(os?: NodeJS.Platform): string {
  return isWindows(os) ? "" : "setsid ";
}

/**
 * Starts a detached background process and reports a PID that the operating
 * system can later signal.
 *
 * POSIX keeps the caller's own script verbatim, so its quoting, redirection and
 * `setsid` process-group semantics are unchanged. Windows cannot reuse that
 * script: a bash-compatible shell there reports an MSYS process id from `$!`,
 * which lives in a separate namespace from the Windows process ids used by
 * `process.kill` and `taskkill`. Redirection and detachment are therefore
 * performed natively so that the returned PID is the real Windows one.
 */
export async function startDetachedProcess(input: {
  command: string;
  posixScript: string;
  cwd: string;
  outputPath: string;
  env?: Record<string, string | undefined>;
  hostEnv?: HostEnvironment;
  posixShell?: string;
  os?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}): Promise<{ pid: number }> {
  // The child environment is deliberately allowlisted and secret-scrubbed, so
  // the shell itself must be located through the host environment instead.
  const resolution = {
    os: input.os,
    env: input.hostEnv,
    posixShell: input.posixShell,
    exists: input.exists,
  };
  if (isWindows(input.os)) {
    // The shell performs the redirection, exactly as the POSIX launcher script
    // does. A detached Windows child does not inherit a descriptor opened
    // here, so `stdio: [..., log.fd, log.fd]` left every background log empty
    // and made process output invisible. The command is grouped first because
    // a bare `cmd > log` would only redirect the final stage of a `;` or `&&`
    // sequence. The native spawn is still required so the returned PID is a
    // real Windows one rather than an MSYS id.
    const shell = profileShellCommand(
      `( ${input.command} ) > ${shellQuote(input.outputPath)} 2>&1`,
      resolution,
    );
    const child = spawn(shell.executable, shell.args, {
      cwd: input.cwd,
      env: input.env as NodeJS.ProcessEnv | undefined,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const pid = await new Promise<number | undefined>(
      (resolvePromise, reject) => {
        const childEvents = child as unknown as NodeJS.EventEmitter;
        childEvents.once("spawn", () => resolvePromise(child.pid));
        childEvents.once("error", reject);
      },
    );
    if (pid === undefined)
      throw new Error("the detached process did not report a process id");
    child.unref();
    return { pid };
  }
  const launcherShell = profileShellCommand(input.posixScript, resolution);
  const launcher = spawn(launcherShell.executable, launcherShell.args, {
    cwd: input.cwd,
    env: input.env as NodeJS.ProcessEnv | undefined,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const launcherEvents = launcher as unknown as NodeJS.EventEmitter & {
    stdout?: NodeJS.ReadableStream & {
      on(event: "data", listener: (chunk: Buffer) => void): unknown;
    };
    stderr?: NodeJS.ReadableStream & {
      on(event: "data", listener: (chunk: Buffer) => void): unknown;
    };
  };
  launcherEvents.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  launcherEvents.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    launcherEvents.on("error", reject);
    launcherEvents.on("close", (code: number | null) =>
      resolvePromise(code ?? -1),
    );
  });
  const pid = Number(Buffer.concat(stdout).toString("utf8").trim());
  if (exitCode !== 0 || !Number.isFinite(pid))
    throw new Error(
      Buffer.concat(stderr).toString("utf8") ||
        `the detached launcher exited with ${exitCode}`,
    );
  return { pid };
}

/**
 * Windows process-tree termination command. POSIX callers keep using a negative
 * PID signal, so `undefined` is returned there.
 */
export function processTreeKillCommand(
  pid: number,
  os?: NodeJS.Platform,
): ShellCommand | undefined {
  if (!isWindows(os)) return undefined;
  return {
    executable: "taskkill",
    args: ["/PID", String(Math.trunc(pid)), "/T", "/F"],
  };
}

/**
 * Root of the per-user global configuration tree. The POSIX branch reproduces
 * the previous `$HOME/.config` resolution exactly.
 */
export function globalConfigHome(input: PlatformInput = {}): string {
  const env = input.env ?? process.env;
  if (isWindows(input.os))
    return usableDirectory([env.APPDATA], () =>
      win32.join(userHome(input), "AppData", "Roaming"),
    );
  return posix.join(env.HOME ?? "", ".config");
}

/**
 * The per-user state directory's name — the product name, not the repository
 * name. It used to be `natalia-cli` (named after the repo), and the rename
 * is NOT a string change: the directory is a published interface that holds
 * a user's config, workspace registry, skills and UI state. Renaming it
 * silently would strand every existing install, so:
 *
 *   - WRITES go to the new name;
 *   - READS prefer the new name and fall back to the legacy one, so an
 *     existing install keeps working with nothing to migrate;
 *   - the fallback is visible (the config resolution reports the legacy
 *     location as its source) rather than silent.
 *
 * The legacy name stays recognized indefinitely: a stale directory nobody
 * reads is not a bug, and a config file the user can no longer find is.
 */
export const STATE_DIR_NAME = "natalia";
export const LEGACY_STATE_DIR_NAMES = ["natalia-cli"] as const;

/**
 * The LIVE state path (writes go here). Under a root, so the caller joins
 * its own home/state root: `statePath(globalConfigHome(), "config.json")`.
 */
export function statePath(root: string, ...segments: string[]): string {
  return join(root, STATE_DIR_NAME, ...segments);
}

/** The legacy paths, oldest first — the read fallback's candidates. */
export function legacyStatePaths(
  root: string,
  ...segments: string[]
): Array<{ path: string; legacy: string }> {
  return LEGACY_STATE_DIR_NAMES.map((name) => ({
    path: join(root, name, ...segments),
    legacy: name,
  }));
}

/**
 * A reader's answer: the live path if it exists, else the first legacy path
 * that does, else the live path (so a write still lands on the live name).
 * The existence check is injected — the resolver style this package already
 * uses, so the fallback is testable without touching a real home.
 */
export function resolveStatePath(
  root: string,
  exists: (path: string) => boolean,
  ...segments: string[]
): { path: string; legacy: boolean } {
  const live = statePath(root, ...segments);
  if (exists(live)) return { path: live, legacy: false };
  for (const candidate of legacyStatePaths(root, ...segments))
    if (exists(candidate.path)) return { path: candidate.path, legacy: true };
  return { path: live, legacy: false };
}

/**
 * Root of the per-user durable state tree, preserving the previous
 * `XDG_STATE_HOME ?? $HOME/.local/state` resolution on POSIX.
 */
export function userStateHome(input: PlatformInput = {}): string {
  const env = input.env ?? process.env;
  if (isWindows(input.os))
    return usableDirectory([env.LOCALAPPDATA], () =>
      win32.join(userHome(input), "AppData", "Local"),
    );
  return env.XDG_STATE_HOME ?? posix.join(env.HOME ?? ".", ".local", "state");
}

/**
 * Root of the per-user ephemeral runtime tree. Windows has no XDG runtime
 * directory, so callers fall back to their existing workspace-local path.
 */
export function userRuntimeHome(input: PlatformInput = {}): string | undefined {
  const env = input.env ?? process.env;
  if (isWindows(input.os))
    return usableDirectory([env.LOCALAPPDATA, env.TEMP], safeHomedir);
  return env.XDG_RUNTIME_DIR;
}

function userHome(input: PlatformInput): string {
  const env = input.env ?? process.env;
  return usableDirectory([env.USERPROFILE, env.HOME], safeHomedir);
}

/**
 * Picks the first usable directory from the candidates. A bare drive letter
 * ("D:") from a misconfigured env var (LOCALAPPDATA/TEMP/APPDATA/HOME set to
 * just the drive) is not a usable directory: creating a directory at the
 * drive root fails with EPERM on Windows, which surfaced as a hard startup
 * crash. Such values are skipped in favour of the real user home.
 */
function usableDirectory(
  candidates: Array<string | undefined>,
  fallback: () => string,
): string {
  for (const candidate of candidates) {
    if (candidate && !/^[A-Za-z]:$/u.test(candidate)) return candidate;
  }
  return fallback();
}

/**
 * Strips the Windows extended-length (`\\?\`) prefix and normalises separators
 * so a link target can be resolved and containment-checked.
 *
 * `readlink` on a Windows directory junction returns an absolute
 * `\\?\C:\...` path. Resolving that verbatim produces a path no containment
 * check can match, which silently marks a workspace manifest incomplete. POSIX
 * targets are returned untouched.
 */
export function normalizeLinkTarget(
  target: string,
  os?: NodeJS.Platform,
): string {
  if (!isWindows(os)) return target;
  const unprefixed = target.startsWith("\\\\?\\") ? target.slice(4) : target;
  return unprefixed.replaceAll("\\", "/");
}

/**
 * Creates a symbolic link, choosing the Windows link type that does not
 * require elevation where possible.
 *
 * An unprivileged Windows process cannot create a symlink, but it *can* create
 * a directory junction. Node also defaults to a `file` link on Windows, which
 * would turn a restored directory link into a broken one. POSIX takes the
 * original single-argument call so its behaviour is unchanged.
 */
export async function createSymlink(
  target: string,
  path: string,
  input: PlatformInput & {
    targetIsDirectory?: boolean;
    symlink?: (
      target: string,
      path: string,
      type?: "dir" | "file" | "junction",
    ) => Promise<void>;
  } = {},
): Promise<void> {
  const link = input.symlink ?? nodeSymlink;
  if (!isWindows(input.os)) return await link(target, path);
  return await link(
    target,
    path,
    input.targetIsDirectory ? "junction" : "file",
  );
}

/**
 * Removes a path, clearing the Windows read-only attribute first.
 *
 * `fs.rm({ force: true })` does not clear `FILE_ATTRIBUTE_READONLY`, so a file
 * restored from a manifest that recorded a read-only POSIX mode cannot be
 * deleted afterwards. On POSIX this is exactly the previous `rm` call.
 */
export async function forceRemove(
  path: string,
  input: PlatformInput & {
    recursive?: boolean;
    rm?: (
      path: string,
      options: { force: boolean; recursive: boolean },
    ) => Promise<void>;
    chmod?: (path: string, mode: number) => Promise<void>;
  } = {},
): Promise<void> {
  const remove = input.rm ?? nodeRm;
  const options = { force: true, recursive: input.recursive ?? false };
  if (!isWindows(input.os)) return await remove(path, options);
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await remove(path, options);
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")
        throw error;
      // Read-only attribute: clear it, then retry. EBUSY is a transient lock
      // (a just-exited child still releasing its working-directory handle);
      // the backoff spans several seconds so a slow child exit clears it.
      await (input.chmod ?? nodeChmod)(path, 0o666).catch(() => undefined);
      await Bun.sleep(100 * (attempt + 1));
    }
  }
  throw lastError;
}

async function nodeSymlink(
  target: string,
  path: string,
  type?: "dir" | "file" | "junction",
) {
  const { symlink } = await import("node:fs/promises");
  await symlink(target, path, type);
}

async function nodeRm(
  path: string,
  options: { force: boolean; recursive: boolean },
) {
  const { rm } = await import("node:fs/promises");
  await rm(path, options);
}

async function nodeChmod(path: string, mode: number) {
  const { chmod } = await import("node:fs/promises");
  await chmod(path, mode);
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}

function defaultExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Foreground program of a terminal device.
 *
 * This exists so the runtime can confirm that an authorized interactive program
 * is still the one receiving pane input, instead of guessing from the screen,
 * the prompt or a model claim. It is deliberately OS truth or nothing: when the
 * platform cannot answer, the caller must fail closed.
 */
export type ForegroundProcessProbe =
  | { supported: false; reason: string }
  | { supported: true; process: { pid: number; name: string } | undefined };

export type ForegroundProcessIO = {
  os?: NodeJS.Platform;
  /** Device number of the tty, as reported by `stat`. */
  deviceNumber?(ttyName: string): number | undefined;
  processIDs?(): number[];
  processStat?(pid: number): string | undefined;
};

export function foregroundProcessForTTY(
  ttyName: string,
  io: ForegroundProcessIO = {},
): ForegroundProcessProbe {
  const os = io.os ?? currentPlatform();
  if (os !== "linux")
    return {
      supported: false,
      reason: `foreground process confirmation is unavailable on ${os}`,
    };
  if (!ttyName)
    return { supported: false, reason: "pane has no tty to inspect" };
  const deviceNumber = (io.deviceNumber ?? defaultDeviceNumber)(ttyName);
  if (deviceNumber === undefined)
    return { supported: false, reason: `tty is not inspectable: ${ttyName}` };
  const readStat = io.processStat ?? defaultProcessStat;
  const pids = (io.processIDs ?? defaultProcessIDs)();
  let foregroundGroup: number | undefined;
  const names = new Map<number, string>();
  for (const pid of pids) {
    const stat = readStat(pid);
    if (!stat) continue;
    const parsed = parseProcessStat(stat);
    if (!parsed) continue;
    names.set(parsed.pid, parsed.name);
    if (parsed.tty === deviceNumber && parsed.foregroundGroup > 0)
      foregroundGroup = parsed.foregroundGroup;
  }
  if (foregroundGroup === undefined)
    return { supported: true, process: undefined };
  const name = names.get(foregroundGroup);
  if (name === undefined) {
    // The group leader is gone or unreadable, so nothing can be confirmed.
    return {
      supported: false,
      reason: `foreground process group ${foregroundGroup} is not inspectable`,
    };
  }
  return { supported: true, process: { pid: foregroundGroup, name } };
}

/**
 * Parses `/proc/<pid>/stat`. The command name is brace-delimited and may itself
 * contain spaces and parentheses, so the numeric fields are read relative to the
 * final `)`.
 */
export function parseProcessStat(stat: string):
  | {
      pid: number;
      name: string;
      tty: number;
      foregroundGroup: number;
    }
  | undefined {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const pid = Number.parseInt(stat.slice(0, open).trim(), 10);
  const name = stat.slice(open + 1, close);
  const rest = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  // rest[0] is state (field 3), so tty_nr (field 7) and tpgid (field 8) are at
  // offsets 4 and 5.
  const tty = Number.parseInt(rest[4] ?? "", 10);
  const foregroundGroup = Number.parseInt(rest[5] ?? "", 10);
  if (
    !Number.isSafeInteger(pid) ||
    !Number.isSafeInteger(tty) ||
    !Number.isSafeInteger(foregroundGroup)
  )
    return undefined;
  return { pid, name, tty, foregroundGroup };
}

function defaultDeviceNumber(ttyName: string): number | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { statSync } = require("node:fs") as typeof import("node:fs");
    return statSync(ttyName).rdev;
  } catch {
    return undefined;
  }
}

function defaultProcessIDs(): number[] {
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    return readdirSync("/proc")
      .map((entry) => Number.parseInt(entry, 10))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function defaultProcessStat(pid: number): string | undefined {
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
}

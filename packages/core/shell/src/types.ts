/**
 * The request shape: one command string in, one argv out.
 *
 * See shell.ts for the design and why `command` is a STRING rather than a
 * pre-split argv.
 */

/** What a caller asks for. */
export type ShellExecRequest = {
  /** The command text, interpreted by the executor's own shell. */
  command: string;
  /** Working directory override; the executor's own default when absent. */
  workdir?: string | undefined;
  /** Timeout override in milliseconds; implementations cap it. */
  timeoutMs?: number | undefined;
  /**
   * The confinement mode to run under. Absent means unconfined — the same
   * default the shell tool has always had, so this is not a behaviour change.
   */
  confinement?: import("@anthelia/confinement").ConfinementMode | undefined;
  /** The workspace root the confinement policy scopes its writable paths to. */
  workspaceRoot?: string | undefined;
  /** Kill the command when this fires. */
  signal?: AbortSignal | undefined;
  /** Bytes to write to stdin before closing it. */
  stdin?: string | undefined;
  /**
   * The environment the child runs with, already sanitised by the caller.
   *
   * A caller's ALLOWLIST is policy and stays above the seam; this carries its
   * result. Absent means inherit, which is what a caller that has already
   * narrowed things wants and what the seam must not second-guess.
   */
  env?: Record<string, string | undefined> | undefined;
  /**
   * The PROFILE-READING invocation (`bash -lc`) rather than the isolated one
   * (`--noprofile --norc -c`). Two call sites deliberately want the user's
   * profile; the shell tool deliberately does not. It is a request field so the
   * choice is data, not a second executor class.
   */
  loginShell?: boolean | undefined;
  /**
   * The platform to resolve against, overriding the host's own.
   *
   * Testability, not a second shell: two call sites inject a platform so they can
   * assert both branches without running on both. `shellExecutable` decides which
   * shell, `os` decides how the platform layers behave around it.
   */
  os?: NodeJS.Platform | undefined;
  /**
   * A caller-named shell executable, honoured when present.
   *
   * A valve, and a temporary one: two call sites currently choose their own
   * (`$SHELL`, `/bin/sh`). Keeping it here preserves their behaviour exactly
   * while the shell choice moves above the seam; it disappears when those sites
   * name an executor instead.
   */
  shellExecutable?: string | undefined;
  /**
   * The confinement backend binary this run should use, overriding discovery.
   *
   * A valve, the same shape as {@link shellExecutable}: absent means the wrap layer
   * discovers the backend beside this package (and in the workspace's own native
   * build), which is what every production caller wants. A caller that ships its own
   * backend — or a test that needs the fail-closed branch without unsetting
   * anything on the machine it runs on — names it here. It is a PATH, not a mode:
   * whether confinement runs at all is {@link confinement}'s decision.
   */
  confinementBinaryPath?: string | undefined;
  /**
   * The harness-owned `NATALIA_*` facts for this execution.
   *
   * Merged by the executor AFTER {@link env} and after every ambient `NATALIA_*`
   * entry has been dropped, so a managed fact always wins: a caller cannot displace
   * `NATALIA_HOME` by naming it, and the harness process's own stale value cannot
   * leak in. See `applyShellEnv`.
   */
  shellEnv?: import("./shell-env").ShellEnv | undefined;
};

/** A resolved request: everything needed to spawn, and nothing shell-shaped. */
export type ShellExecSpec = {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  stdin?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  /** The managed snapshot, carried through from the request. */
  shellEnv?: import("./shell-env").ShellEnv | undefined;
};

/**
 * What the sandbox actually did, reported independently of the exit status.
 *
 * Present only when confinement was requested. The three things a caller must be
 * able to tell apart are "the command failed", "the policy refused the command",
 * and "the sandbox could not run at all" — and only the first is visible in an
 * exit code.
 *
 * `denied` is NOT here yet: the confinement wrapper's stderr dialect does not
 * separate a policy refusal from a runner failure, so a `denied: true` would be a
 * guess dressed as a fact. Its refusal arrives as `runnerFailed` with the wrapper's
 * own text in `confinementRefusal`, and separating the two is deferred work on the
 * wrapper rather than something to invent here.
 */
export interface ShellSandboxInfo {
  /** The mode that was requested for this execution. */
  mode: import("@anthelia/confinement").ConfinementMode;
  /** The sandbox runner declined before the command could run. */
  runnerFailed: boolean;
}

/** A finished foreground run. Nonzero exits and timeouts RESOLVE, not reject. */
export type ShellRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Why the run stopped when it did not exit on its own. */
  outcome: "exited" | "timeout" | "aborted" | "spawn-failed";
  /** The wrapper's own refusal, when confinement declined before exec. */
  confinementRefusal?: string | undefined;
  /** What the sandbox did, when confinement was requested. */
  sandbox?: ShellSandboxInfo | undefined;
};

/** A live background process. */
export type ShellProcess = {
  pid: number | undefined;
  write(data: string): void;
  kill(): void;
  onOutput(listener: (chunk: string, stream: "stdout" | "stderr") => void): {
    dispose(): void;
  };
  onExit(
    listener: (event: { exitCode: number | null; signal?: number }) => void,
  ): { dispose(): void };
};

/**
 * The confinement wrapper's refusal prefix (its own stderr dialect). The shell
 * tool has always carried this; it stays here so every shell inherits it.
 */
export const WRAPPER_FAILURE_SIGNATURE = "confinement-exec:";

/**
 * The exit code the wrapper uses for EVERY refusal.
 *
 * Read from `native/src/main.rs`: `fail()` prints the signature and exits 2, and so
 * does `usage()`. The comment there says the code exists precisely so a
 * classification layer can tell "the runner refused" from "the command ran" — which
 * is what it is used for here, instead of trusting the stderr text alone. A command
 * is free to print anything it likes to stderr, so the code and the signature are
 * required TOGETHER: the code without the signature is an ordinary exit 2.
 */
export const WRAPPER_REFUSAL_EXIT = 2;

/**
 * What a run whose sandbox could not start says.
 *
 * The OTHER kind of runner failure, and the one that used to say nothing at all:
 * the wrapper is missing, so there is no exit code, no stderr and no signature to
 * classify — only the fail-closed result. `spawnSpec` fills `confinementRefusal`
 * with this so the refusal a caller reads is a sentence rather than the bare
 * "the command could not be started" the seam used to substitute. That bare string
 * cost a debugging session: it names no mode, no reason and no way out, so the
 * shell-choice was suspected and re-fixed while the real cause sat one layer down.
 */
export function missingConfinementRefusal(
  mode: import("@anthelia/confinement").ConfinementMode,
): string {
  return (
    `the ${mode} sandbox could not start this command: no usable ` +
    `confinement-exec backend was found on this host, and the sandbox refuses ` +
    `to run a command unconfined. Build the backend (bun run native:confinement) ` +
    `or run this call under sandbox_permissions=danger-full-access.`
  );
}

/** Default and maximum timeouts, matching the shell tool's existing caps. */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;

/** Cap a requested timeout rather than trusting it. */
export function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS);
}

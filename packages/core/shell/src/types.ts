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
   * The PROFILE-READING invocation (`bash -lc`) rather than the isolated one
   * (`--noprofile --norc -c`). Two call sites deliberately want the user's
   * profile; the shell tool deliberately does not. It is a request field so the
   * choice is data, not a second executor class.
   */
  loginShell?: boolean | undefined;
  /**
   * A caller-named shell executable, honoured when present.
   *
   * A valve, and a temporary one: two call sites currently choose their own
   * (`$SHELL`, `/bin/sh`). Keeping it here preserves their behaviour exactly
   * while the shell choice moves above the seam; it disappears when those sites
   * name an executor instead.
   */
  shellExecutable?: string | undefined;
};

/** A resolved request: everything needed to spawn, and nothing shell-shaped. */
export type ShellExecSpec = {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  stdin?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
};

/** A finished foreground run. Nonzero exits and timeouts RESOLVE, not reject. */
export type ShellRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Why the run stopped when it did not exit on its own. */
  outcome: "exited" | "timeout" | "aborted" | "spawn-failed";
  /** The wrapper's own refusal, when confinement declined before exec. */
  confinementRefusal?: string | undefined;
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

/** Default and maximum timeouts, matching the shell tool's existing caps. */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;

/** Cap a requested timeout rather than trusting it. */
export function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS);
}

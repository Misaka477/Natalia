/**
 * The command substrate's seam.
 *
 * One abstract method ({@link ShellExecutor.resolve}) plus shared execution
 * ({@link ShellExecutor.run}/{@link ShellExecutor.start}). Everything above the
 * seam — the tools that run commands, the confinement policy, the timeout and
 * abort handling, the output the model reads — is shell-agnostic and lives here.
 * Everything shell-specific collapses into `resolve`.
 *
 * Before this seam, the substrate was bash-shaped end to end: `shellQuote`
 * (POSIX single-quote rules), `detachedShellPrefix` (`setsid`, degrading to
 * `taskkill /T` on Windows), and `shellExecutable` throwing when no bash exists
 * on a Windows host. Six call sites imported those directly, so the shell was a
 * compile-time decision rather than a runtime one.
 *
 * Modelling the request as a command STRING dissolves the quoting problem instead
 * of solving it: PowerShell takes the command as one argv element of `-Command`,
 * so no intermediate shell exists and there is no second quoting layer, whereas
 * `bash -c` puts the command inside a string domain that must be escaped. The
 * difference lands in exactly one method.
 *
 * `run` and `start` are CONCRETE, not abstract: spawning is shell-agnostic, and
 * duplicating timeout, abort, confinement and failure-classification per shell
 * would mean two copies of policy that drift.
 */
import { spawn } from "node:child_process";
import { wrapConfinedCommand } from "@anthelia/confinement";
import type { ConfinementMode } from "@anthelia/confinement";
import { terminateChildProcessTree } from "@anthelia/platform";

import {
  WRAPPER_FAILURE_SIGNATURE,
  WRAPPER_REFUSAL_EXIT,
  missingConfinementRefusal,
  type ShellExecRequest,
  type ShellExecSpec,
  type ShellProcess,
  type ShellRunResult,
  type ShellSandboxInfo,
} from "./types";
import { applyShellEnv } from "./shell-env";

/** Where the policy lives: everything here is shell-independent. */
export abstract class ShellExecutor {
  /**
   * Map the caller's command text onto an argv. This is the ONLY method a shell
   * implements; everything else is shared.
   */
  abstract resolve(request: ShellExecRequest): ShellExecSpec;

  /**
   * The POSIX launcher script for a detached, output-redirected process.
   *
   * Shell-specific by definition — `setsid` and `$!` are bash's, and a pwsh twin
   * would have neither — so it is the executor's business rather than shared.
   * Callers used to hand-build this string, which hardcoded bash quoting at the
   * call site; the platform layer already owns the Windows branch (it detaches
   * natively and returns a real Windows pid, because an MSYS `$!` is in a
   * different namespace), so only the POSIX half is moving.
   */
  detachedPosixScript(input: { command: string; outputPath: string }): string {
    // A shell that cannot express this refuses rather than guessing: silently
    // producing a script that does not detach is worse than a caller-visible
    // failure.
    throw new Error(
      `${this.constructor.name} cannot build a detached POSIX launcher script`,
    );
  }

  /**
   * Run to completion with the timeout, abort and confinement applied.
   *
   * Nonzero exits and timeouts RESOLVE with a descriptive result rather than
   * rejecting: the caller reads `outcome` to tell "the command failed" from "the
   * command could not be run", which is a distinction the shell tool has always
   * made and which rejecting on nonzero would destroy.
   */
  async run(
    spec: ShellExecSpec,
    request?: ShellExecRequest,
  ): Promise<ShellRunResult> {
    const spawned = this.spawnSpec(spec, request);
    if ("error" in spawned) return spawned.error;
    const child = spawned.child;

    let stdout = "";
    let stderr = "";
    return await new Promise<ShellRunResult>((resolveRun) => {
      let settled = false;
      const finish = (result: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request?.signal?.removeEventListener("abort", abort);
        result();
      };

      const abort = () => {
        terminateChildProcessTree(child.pid);
        finish(() =>
          resolveRun({ exitCode: null, stdout, stderr, outcome: "aborted" }),
        );
      };
      const timer = setTimeout(() => {
        terminateChildProcessTree(child.pid);
        finish(() =>
          resolveRun({ exitCode: null, stdout, stderr, outcome: "timeout" }),
        );
      }, spec.timeoutMs);
      request?.signal?.addEventListener("abort", abort, { once: true });

      childEvents(child).stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      childEvents(child).stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      childEvents(child).on("error", (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveRun({
          exitCode: null,
          stdout,
          stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
          outcome: "spawn-failed",
        });
      });
      childEvents(child).on("close", (code: number | null) => {
        // The wrapper prints its own refusal when IT declines (missing landlock
        // backend, an unappliable rule): that is a sandbox failure, not the
        // command's exit, and it must read as one.
        //
        // What the sandbox did is stamped on every path, so a caller reads the fact
        // rather than inferring it from the exit code.
        const sandbox: ShellSandboxInfo | undefined =
          request?.confinement && request.confinement !== "danger-full-access"
            ? {
                mode: request.confinement as ConfinementMode,
                runnerFailed: false,
              }
            : undefined;
        // The wrapper's exit code AND its signature. Either alone would
        // misclassify: the code alone would take an ordinary exit 2 away from a
        // command that happens to use it, and the signature alone would believe a
        // command that printed a convincing line of its own.
        if (
          code === WRAPPER_REFUSAL_EXIT &&
          stderr.startsWith(WRAPPER_FAILURE_SIGNATURE)
        )
          finish(() =>
            resolveRun({
              exitCode: null,
              stdout,
              stderr,
              outcome: "spawn-failed",
              confinementRefusal: stderr.trim(),
              sandbox: sandbox && { ...sandbox, runnerFailed: true },
            }),
          );
        else
          finish(() =>
            resolveRun({
              exitCode: code,
              stdout,
              stderr,
              outcome: "exited",
              sandbox,
            }),
          );
      });
    });
  }

  /**
   * Start a background process. Separate from {@link run} because a caller that
   * streams output cannot also be the one blocking on a promise.
   */
  async start(
    spec: ShellExecSpec,
    request?: ShellExecRequest,
  ): Promise<ShellProcess> {
    const spawned = this.spawnSpec(spec, request);
    if ("error" in spawned)
      throw new Error(
        spawned.error.confinementRefusal ?? "the command could not be started",
      );
    const child = spawned.child;

    const outputListeners = new Set<
      (chunk: string, stream: "stdout" | "stderr") => void
    >();
    const exitListeners = new Set<
      (event: { exitCode: number | null; signal?: number }) => void
    >();

    childEvents(child).stdout?.on("data", (chunk) => {
      for (const listener of outputListeners) listener(String(chunk), "stdout");
    });
    childEvents(child).stderr?.on("data", (chunk) => {
      for (const listener of outputListeners) listener(String(chunk), "stderr");
    });
    childEvents(child).on("exit", (code: number | null, signal?: number) => {
      for (const listener of exitListeners)
        listener({ exitCode: code, signal });
    });

    return {
      pid: child.pid ?? undefined,
      write(data) {
        child.stdin?.write(data);
      },
      kill() {
        terminateChildProcessTree(child.pid);
      },
      onOutput(listener) {
        outputListeners.add(listener);
        return { dispose: () => outputListeners.delete(listener) };
      },
      onExit(listener) {
        exitListeners.add(listener);
        return { dispose: () => exitListeners.delete(listener) };
      },
    };
  }

  /**
   * Spawn the resolved spec, applying confinement first.
   *
   * Confinement is a POLICY and it is shell-agnostic by shape — it wraps an
   * executable and an argv — so it belongs here rather than in each shell. That
   * is what keeps "which shell" from leaking into "whether we are confined".
   */
  protected spawnSpec(
    spec: ShellExecSpec,
    request?: ShellExecRequest,
  ): { child: ReturnType<typeof spawn> } | { error: ShellRunResult } {
    let command = spec.command;
    let args: readonly string[] = spec.args;
    const mode = request?.confinement;
    if (mode && mode !== "danger-full-access") {
      const wrapped = wrapConfinedCommand({
        mode: mode as ConfinementMode,
        workspaceRoot: request?.workspaceRoot,
        command,
        args: [...args],
        // Absent in production: the wrap layer then discovers the backend beside
        // this package. Named, it is the caller's own backend — and it is how a
        // test reaches the fail-closed branch below, which overriding the resolved
        // argv cannot do (that only fails the wrapper's own exec, which is a
        // refusal with text and not the silent one this branch produces).
        binaryPath: request?.confinementBinaryPath,
      });
      // Fail-closed: a missing backend must not silently degrade to running the
      // command unconstrained. `runnerFailed` says the sandbox could not run rather
      // than that the command failed — the distinction an exit code cannot carry.
      //
      // The refusal TEXT rides with it. The wrapper never ran, so there is no
      // signature and no stderr to classify, and a refusal with no words is what
      // made "the command could not be started" the only thing a caller ever saw.
      if (!wrapped)
        return {
          error: {
            exitCode: null,
            stdout: "",
            stderr: "",
            outcome: "spawn-failed",
            confinementRefusal: missingConfinementRefusal(
              mode as ConfinementMode,
            ),
            sandbox: { mode: mode as ConfinementMode, runnerFailed: true },
          },
        };
      command = wrapped.command;
      args = wrapped.args;
    }
    return {
      child: spawn(command, [...args], {
        cwd: spec.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        // The SPEC, not the request: `resolve` is where an executor applies its
        // defaults (pwsh's NO_COLOR and PAGER) ON TOP of the caller's
        // environment, so a caller's value still wins per-key. Reading
        // `request.env` here instead discarded every executor default whenever a
        // caller passed anything — the pwsh overrides would never have applied.
        //
        // `applyShellEnv` then drops any ambient `NATALIA_*` entry and merges the
        // managed snapshot last, so a harness-owned fact cannot be displaced by a
        // caller's `env` entry nor inherited from whenever this process started.
        env: applyShellEnv(spec.env, spec.shellEnv) as
          | Record<string, string>
          | undefined,
      }),
    };
  }
}

type ChildEventSource = ReturnType<typeof spawn> &
  NodeJS.EventEmitter & {
    stdout?: {
      on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
    };
    stderr?: {
      on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
    };
  };

function childEvents(child: ReturnType<typeof spawn>) {
  return child as unknown as ChildEventSource;
}

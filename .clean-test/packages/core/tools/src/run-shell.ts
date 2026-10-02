import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { profileShellCommand } from "@anthelia/platform";
import { wrapConfinedCommand } from "@anthelia/confinement";
import type { ToolExecutionContext } from "./types";
import { safeToolEnv, terminateChildProcessTree } from "./child-process";

/** The confinement wrapper's refusal prefix (its own stderr dialect). */
const WRAPPER_FAILURE_SIGNATURE = "confinement-exec:";

/**
 * Runs one shell command inside the workspace with output capture.
 *
 * Lives here rather than in `@natalia/plugin-tool-shell` because it is a shared
 * execution primitive, not shell-plugin-specific: `@natalia/plugin-tool-web` runs the
 * headless browser through it. A tool plugin may use it without statically
 * depending on another tool plugin's package.
 */
export async function runShell(
  command: string,
  context: ToolExecutionContext,
  timeoutSec: number,
) {
  await stat(context.workspaceRoot);
  const shell = profileShellCommand(command);
  // The confinement policy rides this call (sandbox study §3 item 4). No
  // policy — or explicit danger-full-access — runs the raw command; a
  // confined mode wraps the spawn and refuses when no backend exists,
  // instead of silently degrading (fail-closed).
  let executable = shell.executable;
  let args = shell.args;
  if (context.confinement && context.confinement !== "danger-full-access") {
    const wrapped = wrapConfinedCommand({
      mode: context.confinement,
      workspaceRoot: context.workspaceRoot,
      command: shell.executable,
      args: shell.args,
    });
    if (!wrapped)
      throw new Error(
        "sandbox unavailable: the confinement backend is missing; refusing to run the command unconstrained (fail-closed)",
      );
    executable = wrapped.command;
    args = wrapped.args;
  }
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: context.workspaceRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: safeToolEnv(context.settings?.envAllowlist),
    });
    let settled = false;
    const finish = (result: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      result();
    };
    const abort = () => {
      terminateChildProcessTree(child.pid);
      finish(() =>
        reject(context.signal?.reason ?? new Error("command cancelled")),
      );
    };
    const timer = setTimeout(() => {
      terminateChildProcessTree(child.pid);
      finish(() => reject(new Error(`command timed out after ${timeoutSec}s`)));
    }, timeoutSec * 1000);
    context.signal?.addEventListener("abort", abort, { once: true });
    let stdout = "";
    let stderr = "";
    const childEvents = child as unknown as NodeJS.EventEmitter & {
      stdout?: {
        on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
      };
      stderr?: {
        on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
      };
    };
    childEvents.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    childEvents.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    childEvents.on("error", (error: Error) => {
      finish(() => reject(error));
    });
    childEvents.on("close", (code: number | null) => {
      // The wrapper prints `confinement-exec: ...` when IT refuses (missing
      // landlock, an unappliable rule): that is a sandbox failure, not the
      // command's own exit, and must read as one (dsh's runner-failure
      // signature classification).
      if (code !== 0 && stderr.startsWith(WRAPPER_FAILURE_SIGNATURE)) {
        finish(() =>
          reject(
            new Error(
              `sandbox refused the command before exec (fail-closed): ${stderr.trim()}`,
            ),
          ),
        );
        return;
      }
      const output = [
        `exit=${code}`,
        stdout && `stdout:\n${stdout}`,
        stderr && `stderr:\n${stderr}`,
      ]
        .filter(Boolean)
        .join("\n");
      if (code === 0) finish(() => resolvePromise(output));
      else finish(() => reject(new Error(output)));
    });
  });
}

/**
 * Starting, inspecting and stopping OS child processes.
 *
 * The primitives every tool that spawns something needs, kept apart from the
 * durable registry that tracks long-lived ones: this layer knows about PIDs,
 * signals and process groups, and nothing about what a managed process is or
 * where its state is stored.
 *
 * Two things here are load-bearing for safety rather than convenience. A tool
 * inherits a deliberately small environment, because handing a model's shell the
 * whole environment hands it every credential in it. And stopping is done to a
 * process *group* with an identity check, because a PID can be reused between the
 * moment it was recorded and the moment a signal is sent.
 */
import { isWindows, processTreeKillCommand } from "@anthelia/platform";
import { readFile } from "node:fs/promises";

/**
 * Reads a file that may not exist yet, which is the normal state of a process log
 * asked about before the process has written anything.
 */
export async function readOptionalFile(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function safeToolEnv(allowlist?: string[]) {
  const defaults = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"];
  const allowed = new Set([...defaults, ...(allowlist ?? [])]);
  return Object.fromEntries(
    [...allowed]
      .map((key) => [key, process.env[key]] as const)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
  );
}

// Moved to @anthelia/platform: it depends only on that package, and the command
// seam sits above this one. Re-exported so existing imports keep working.
export { terminateChildProcessTree } from "@anthelia/platform";

export function sendProcessSignal(pid: number, signal: NodeJS.Signals) {
  try {
    // Managed processes start through setsid, so the negative PID addresses
    // their owned process group and includes background children. Windows has
    // no equivalent, so the tree is terminated through the OS utility instead.
    if (isWindows()) {
      const treeKill = processTreeKillCommand(pid);
      if (treeKill && signal === "SIGKILL") {
        Bun.spawnSync([treeKill.executable, ...treeKill.args], {
          stdout: "ignore",
          stderr: "ignore",
        });
        return;
      }
      process.kill(pid, signal);
    } else process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    try {
      process.kill(pid, signal);
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code !== "ESRCH")
        throw fallbackError;
    }
  }
}

export function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads field 22 (starttime) from a `/proc/<pid>/stat` line. Field 2 (`comm`) is
 * parenthesized and may itself contain spaces or parentheses, so the line must
 * be split AFTER the last `)` — splitting the whole line on whitespace shifts
 * every later field whenever `comm` has a space, silently reading the wrong
 * value (itrealvalue instead of starttime) and weakening the pid-reuse check.
 * Post-`)` fields are 0-indexed from `state`, so starttime is index 19.
 */
export function parseProcStatStartTicks(statLine: string): string | undefined {
  const afterComm = statLine.slice(statLine.lastIndexOf(")") + 1);
  return afterComm.trim().split(/\s+/u)[19];
}

export async function processFingerprint(pid: number) {
  if (process.platform !== "linux") return {};
  try {
    const [statLine, commandLine] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/cmdline`, "utf8"),
    ]);
    return {
      pidStartTicks: parseProcStatStartTicks(statLine),
      commandLine: commandLine.replace(/\0/gu, " ").trim(),
    };
  } catch {
    return {};
  }
}

export async function ownsProcess(pid: number, pidStartTicks?: string) {
  if (!pidStartTicks) return isProcessRunning(pid);
  return (await processFingerprint(pid)).pidStartTicks === pidStartTicks;
}

export async function stopProcessTree(
  pid: number,
  timeoutMs: number,
  pidStartTicks?: string,
) {
  if (!(await ownsProcess(pid, pidStartTicks))) return;
  sendProcessSignal(pid, "SIGTERM");
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!(await ownsProcess(pid, pidStartTicks))) return;
    await Bun.sleep(25);
  }
  if (await ownsProcess(pid, pidStartTicks)) sendProcessSignal(pid, "SIGKILL");
}

export function truncateProcessOutput(output: string, maxBytes = 20000) {
  const bytes = Buffer.from(output);
  if (bytes.byteLength <= maxBytes) return output;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

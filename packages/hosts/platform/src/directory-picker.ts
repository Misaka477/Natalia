/**
 * The native directory chooser: one pure decision plus three platform
 * spellings, behind an injectable command runner.
 *
 * The shape follows the reference harness's `directory-picker-native`: the
 * sequencing is pure and testable, the platform verbs are the only thing that
 * touches the host, and a caller that cannot show a dialog says so instead of
 * guessing. What it deliberately does NOT do is fall back to a text box — a
 * path a human must type is the thing being replaced.
 *
 * The dialog runs in the RUNTIME process, which is on the user's machine. A
 * browser page cannot open one (it has no host channel), so the web layer asks
 * over RPC and the runtime answers with a path or null.
 */

import { spawn } from "node:child_process";
import { isWindows, locateRuntimeWorker } from "./index";

/** One command the host can run, and its captured result. */
export type NativeCommandResult = { stdout: string; stderr: string };

/** The runner seam: production spawns, tests inject. */
export type NativeCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<NativeCommandResult>;

/** Why no chooser could be shown, in the words a reader needs. */
export class DirectoryPickerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectoryPickerUnavailableError";
  }
}

/** What a chooser selects. A directory, or one file. */
export type PickerKind = "directory" | "file";

/** The dialog's title, in the platform's own language where it has one. */
export const DIRECTORY_PICKER_TITLE = "Select Directory";

/** The file chooser's title. Separate because the two ask different things. */
export const FILE_PICKER_TITLE = "Select File";

/**
 * The trailing newline a chooser's stdout carries is not part of the path, and
 * an empty answer means "the human dismissed it" rather than "the root".
 */
function outputPath(stdout: string): string | null {
  const trimmed = stdout.replace(/[\r\n]+$/u, "");
  return trimmed === "" ? null : trimmed;
}

/** The process-level failure code, when the error carries one. */
function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number"
    ? code
    : undefined;
}

function errorStderr(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error))
    return "";
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" ? stderr : "";
}

/** A dismissed dialog exits non-zero with a message that says so. */
function looksCancelled(error: unknown): boolean {
  if (errorCode(error) === 1) return true;
  return /(?:canceled|cancelled|-128|user canceled)/iu.test(errorStderr(error));
}

/** The command is not installed at all — a different answer from "it failed". */
function isMissingCommand(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/**
 * The macOS spelling: AppleScript's `choose folder` or `choose file`, whose
 * POSIX path is the second line. A dismissal is exit 1 with "User canceled",
 * which is a result rather than a failure.
 */
async function pickDarwin(
  run: NativeCommandRunner,
  kind: PickerKind,
): Promise<string | null> {
  try {
    const result = await run("osascript", [
      "-e",
      kind === "directory"
        ? `set chosen to choose folder with prompt "${DIRECTORY_PICKER_TITLE}"`
        : `set chosen to choose file with prompt "${FILE_PICKER_TITLE}"`,
      "-e",
      "POSIX path of chosen",
    ]);
    return outputPath(result.stdout);
  } catch (error: unknown) {
    if (looksCancelled(error)) return null;
    throw error;
  }
}

/**
 * The Linux spelling: zenity, then kdialog. Either missing is a host fact, and
 * neither present is a sentence rather than a silent null.
 */
async function pickLinux(
  run: NativeCommandRunner,
  kind: PickerKind,
): Promise<string | null> {
  try {
    const result = await run("zenity", [
      "--file-selection",
      // `--directory` is the whole difference: with it zenity browses
      // directories, without it the human chooses a file.
      ...(kind === "directory" ? ["--directory"] : []),
      `--title=${kind === "directory" ? DIRECTORY_PICKER_TITLE : FILE_PICKER_TITLE}`,
    ]);
    return outputPath(result.stdout);
  } catch (error: unknown) {
    if (looksCancelled(error)) return null;
    if (!isMissingCommand(error)) throw error;
  }
  try {
    const result = await run("kdialog", [
      kind === "directory" ? "--getexistingdirectory" : "--getopenfilename",
      ".",
      "--title",
      kind === "directory" ? DIRECTORY_PICKER_TITLE : FILE_PICKER_TITLE,
    ]);
    return outputPath(result.stdout);
  } catch (error: unknown) {
    if (looksCancelled(error)) return null;
    if (isMissingCommand(error))
      throw new DirectoryPickerUnavailableError(
        "no native directory chooser on this host: install zenity or kdialog",
      );
    throw error;
  }
}

/**
 * The Windows spelling: the shell's own folder browser, driven from a
 * PowerShell child.
 *
 * `Shell.Application`'s `BrowseForFolder` is the Explorer dialog the platform
 * already ships — the same window a user gets from a "Browse…" button — so
 * there is no second look to maintain and no native dependency.
 *
 * It runs as its OWN process rather than inline because a modal dialog blocks
 * the thread that shows it, and the runtime's thread is the one serving every
 * other request.
 *
 * This replaced a koffi-backed `IFileOpenDialog`. koffi carries its own native
 * binary as a separate optional package, which `bun install` skipped and `bun
 * build --compile` would not have embedded either — so a packaged runtime died
 * with `Cannot find the native Koffi module; did you bundle it correctly?`,
 * measured against a real release. The shell dialog needs nothing the platform
 * does not already have.
 */
async function pickWindows(
  run: NativeCommandRunner,
  kind: PickerKind,
): Promise<string | null> {
  const title =
    kind === "directory" ? DIRECTORY_PICKER_TITLE : FILE_PICKER_TITLE;
  const script =
    kind === "directory"
      ? [
          "$s = New-Object -ComObject Shell.Application",
          `$f = $s.BrowseForFolder(0, '${title}', 0)`,
          "if ($f -ne $null) { Write-Output $f.Self.Path }",
        ].join("; ")
      : [
          "Add-Type -AssemblyName System.Windows.Forms",
          "$d = New-Object System.Windows.Forms.OpenFileDialog",
          `$d.Title = '${title}'`,
          "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }",
        ].join("; ");
  try {
    const result = await run("powershell", [
      "-NoProfile",
      // NOT `-NonInteractive`: that flag tells PowerShell to refuse any UI, so
      // `Shell.Application.BrowseForFolder` never opens and the call answers
      // nothing — measured as a 浏览 click that produced no dialog at all. The
      // whole point of this child is to show a modal dialog, so it must be
      // allowed to.
      "-Command",
      script,
    ]);
    return outputPath(result.stdout);
  } catch (error: unknown) {
    if (looksCancelled(error)) return null;
    throw error;
  }
}

/**
 * Open the platform's chooser and wait for the human.
 * @param run - the command runner (production spawns a real process).
 * @param platform - the host platform; defaults to this process's own.
 * @param kind - a directory or a file; defaults to a directory.
 * @returns the chosen absolute path, or null when the human dismissed it.
 */
export async function pickNativeDirectory(
  run: NativeCommandRunner,
  platform: NodeJS.Platform = process.platform,
  kind: PickerKind = "directory",
): Promise<string | null> {
  if (platform === "darwin") return await pickDarwin(run, kind);
  if (platform === "win32") return await pickWindows(run, kind);
  if (platform === "linux") return await pickLinux(run, kind);
  throw new DirectoryPickerUnavailableError(
    `no native directory chooser on ${platform}`,
  );
}

/**
 * The production runner: spawn the chooser's own process and collect what it
 * prints. The dialog is modal to ITS process, so the runtime's thread is never
 * the one that blocks.
 */
export const spawnNativeCommand: NativeCommandRunner = async (
  command,
  args,
) => {
  const child = spawn(command, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) {
    const error = new Error(
      `${command} exited ${code}: ${stderr.trim() || stdout.trim()}`,
    ) as Error & { code?: number; stderr?: string };
    error.code = code ?? undefined;
    error.stderr = stderr;
    throw error;
  }
  return { stdout, stderr };
};

/**
 * Open the platform chooser with the production runner.
 *
 * On Windows the dialog is modal to the thread that shows it, so it runs on a
 * dedicated worker rather than the runtime's own thread — the runtime keeps
 * serving every other request while a human browses. Without the worker the
 * `await` on the child process never settles, because the child is blocked in
 * `ShowDialog` waiting for a click that has not happened yet.
 *
 * The worker module is a REAL FILE staged beside the executable by
 * `scripts/ts-build.ts`; `locateRuntimeWorker` finds it and falls back to the
 * TypeScript source a checkout has.
 * @param kind - a directory or a file; defaults to a directory.
 * @returns the chosen absolute path, or null when the human dismissed it.
 */
export async function pickPath(
  kind: PickerKind = "directory",
): Promise<string | null> {
  if (isWindows()) {
    const { Worker } = await import("node:worker_threads");
    const worker = new Worker(
      locateRuntimeWorker(
        new URL("./win32-dialog.worker.ts", import.meta.url),
      ).url,
      { workerData: { kind } },
    );
    try {
      return await new Promise<string | null>((resolve, reject) => {
        worker.once("message", (value: unknown) => {
          if (value !== null && typeof value === "object" && "error" in value)
            reject(new Error(String((value as { error: unknown }).error)));
          else resolve(value as string | null);
        });
        worker.once("error", reject);
      });
    } finally {
      await worker.terminate();
    }
  }
  return await pickNativeDirectory(spawnNativeCommand, process.platform, kind);
}

/**
 * Open the platform's directory chooser.
 * @returns the chosen absolute directory, or null when the human dismissed it.
 */
export async function pickDirectory(): Promise<string | null> {
  return await pickPath("directory");
}

/**
 * Open the platform's file chooser.
 * @returns the chosen absolute file path, or null when the human dismissed it.
 */
export async function pickFile(): Promise<string | null> {
  return await pickPath("file");
}

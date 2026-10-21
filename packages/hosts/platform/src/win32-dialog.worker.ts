/**
 * The Win32 dialog's own thread.
 *
 * `Shell.Application.BrowseForFolder` is modal to the thread that calls it, so
 * the runtime cannot be that thread: it would stop serving every other request
 * for as long as a human browses. This worker owns the dialog's thread and
 * posts the chosen path back, so the runtime's event loop is never blocked by a
 * modal window.
 *
 * The kind (directory or file) arrives as worker data rather than through a
 * second entry point: one worker serves both.
 */

import { parentPort, workerData } from "node:worker_threads";
import { spawn } from "node:child_process";

const DIRECTORY_TITLE = "Select Directory";
const FILE_TITLE = "Select File";

/** Spelled here rather than imported: the worker must not reach back into the
 *  module that spawns it. */
type PickerKind = "directory" | "file";

function scriptFor(kind: PickerKind): string {
  if (kind === "directory")
    return [
      "$s = New-Object -ComObject Shell.Application",
      `$f = $s.BrowseForFolder(0, '${DIRECTORY_TITLE}', 0)`,
      "if ($f -ne $null) { Write-Output $f.Self.Path }",
    ].join("; ");
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$d = New-Object System.Windows.Forms.OpenFileDialog",
    `$d.Title = '${FILE_TITLE}'`,
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }",
  ].join("; ");
}

async function main(): Promise<void> {
  if (!parentPort) return;
  const kind: PickerKind = workerData?.kind === "file" ? "file" : "directory";
  const child = spawn("powershell", [
    "-NoProfile",
    // NOT `-NonInteractive`: that flag makes PowerShell refuse any UI, so the
    // folder browser never opens and the call answers nothing.
    "-Command",
    scriptFor(kind),
  ]);
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) {
    parentPort.postMessage({
      error: `powershell exited ${code}`,
    });
    return;
  }
  const trimmed = stdout.replace(/[\r\n]+$/u, "");
  parentPort.postMessage(trimmed === "" ? null : trimmed);
}

await main();

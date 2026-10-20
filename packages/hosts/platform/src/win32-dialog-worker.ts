/**
 * The Win32 dialog's own thread.
 *
 * `IFileOpenDialog::Show` is modal to the thread that calls it, so the runtime
 * cannot be that thread: it would stop serving every other request for as long
 * as a human browses. This worker owns the dialog's thread and posts the chosen
 * path back, so the runtime's event loop is never blocked by a modal window.
 *
 * The kind (directory or file) arrives as worker data rather than through a
 * second entry point: one worker serves both, and `FOS_PICKFOLDERS` is the only
 * difference the sequencing makes of it.
 */

import { parentPort, workerData } from "node:worker_threads";
import { loadWin32DialogBindings } from "./win32-dialog-bindings";
import { runFolderDialog, type Win32DialogKind } from "./win32-dialog-logic";

async function main(): Promise<void> {
  if (!parentPort) return;
  const kind: Win32DialogKind =
    workerData?.kind === "file" ? "file" : "directory";
  try {
    const bindings = await loadWin32DialogBindings();
    const chosen = runFolderDialog(
      bindings,
      kind === "file" ? "Select File" : "Select Directory",
      () => undefined,
      kind,
    );
    parentPort.postMessage(chosen);
  } catch (error: unknown) {
    parentPort.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

await main();

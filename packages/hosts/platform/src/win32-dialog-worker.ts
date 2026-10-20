/**
 * The Win32 dialog's own thread.
 *
 * `IFileOpenDialog::Show` is modal to the thread that calls it, so the runtime
 * cannot be that thread: it would stop serving every other request for as long
 * as a human browses. This worker owns the dialog's thread and posts the chosen
 * path back, so the runtime's event loop is never blocked by a modal window.
 */

import { parentPort } from "node:worker_threads";
import { loadWin32DialogBindings } from "./win32-dialog-bindings";
import { runFolderDialog } from "./win32-dialog-logic";

async function main(): Promise<void> {
  if (!parentPort) return;
  try {
    const bindings = await loadWin32DialogBindings();
    const chosen = runFolderDialog(
      bindings,
      "Select Directory",
      () => undefined,
    );
    parentPort.postMessage(chosen);
  } catch (error: unknown) {
    parentPort.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

await main();

export function waitForToolExecution<T>(
  execution: Promise<T>,
  signal?: AbortSignal,
) {
  if (!signal) return execution;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("tool cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    execution.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * The tool calls after which the runtime status snapshot must be refreshed.
 *
 * A managed RESOURCE is anything the status panel lists — a process, a sandbox
 * resource, a terminal pane — so the refresh triggers are every call that starts
 * or ends one, not the three process names this used to carry: a sandbox
 * resource that started or a pane that closed left the panel showing the state
 * from before it.
 */
export function isManagedResourceTool(toolName: string) {
  return [
    "process_start",
    "process_stop",
    "process_restart",
    "sandbox_resource_start",
    "sandbox_resource_stop",
    "sandbox_create",
    "sandbox_delete",
    "interactive_terminal_start",
    "interactive_terminal_stop",
    "interactive_terminal_cleanup",
    "interactive_start",
    "interactive_stop",
    "interactive_cleanup",
    "record_validation",
  ].includes(toolName);
}

export function lineCount(text: string) {
  return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length;
}

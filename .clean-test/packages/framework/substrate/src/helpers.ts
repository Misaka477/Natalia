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

export function isManagedResourceTool(toolName: string) {
  return [
    "process_start",
    "process_stop",
    "process_restart",
    "background_start",
    "background_stop",
    "background_restart",
  ].includes(toolName);
}

export function lineCount(text: string) {
  return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length;
}

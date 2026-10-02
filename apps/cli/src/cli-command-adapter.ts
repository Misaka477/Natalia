import type { PluginAdapterInstance } from "@anthelia/plugin";

type CliCommandAdapterInstance = PluginAdapterInstance & {
  done: Promise<void>;
};

type StartCliCommandAdapter = () => CliCommandAdapterInstance;

export async function createCliCommandAdapterHost(
  start: StartCliCommandAdapter = startCliCommandAdapter,
) {
  const adapter = start();
  let closed = false;
  /**
   * The runtime's exit path, reachable over RPC.
   *
   * A window that hides on close leaves this process alive, so the app needs a
   * way to end it that is not a signal or a task manager. `session.shutdown`
   * lands here, and it reuses the same idempotent close the host already does —
   * one shutdown implementation, called from two directions (RPC and the
   * process's own lifecycle).
   */
  async function shutdown(): Promise<void> {
    if (closed) return;
    closed = true;
    await adapter.dispose();
  }
  return {
    done: adapter.done,
    async close() {
      await shutdown();
    },
    shutdown,
  };
}

function startCliCommandAdapter(): CliCommandAdapterInstance {
  return {
    done: import("./command-dispatcher").then(() => undefined),
    dispose() {},
  };
}

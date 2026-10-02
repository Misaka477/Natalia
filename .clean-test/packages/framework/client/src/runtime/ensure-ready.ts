/**
 * Lazy initialization gate — runtime/ensure-ready.ts.
 *
 * `ensureReady` runs the composition root once and caches the promise: a
 * second subscriber must not re-run initialize (it would open a second sqlite
 * connection and a second workspace watcher). A failed initialization keeps
 * its original cause and is re-thrown on every later access.
 */
import type { RuntimeContext } from "@anthelia/substrate";

export function createEnsureReady(ctx: RuntimeContext) {
  return {
    ensureReady,
  };

  function ensureReady() {
    const { getReady, setReady, initialize, publish } = ctx.ports;
    let ready = getReady();
    if (!ready) {
      const initialization = initialize().catch((error) => {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        publish({
          type: "diagnostic",
          level: "error",
          message: failure.message,
        });
        throw failure;
      });
      ready = initialization;
      setReady(initialization);
      void ready.catch(() => undefined);
    }
    return ready;
  }
}

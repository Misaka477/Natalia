import { resolve } from "node:path";
import { userStateHome } from "@anthelia/platform";

export function valueAfter(argv: string[], flag: string, offset = 0) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1 + offset] : undefined;
}

export function withoutOption(argv: string[], flag: string) {
  const index = argv.indexOf(flag);
  return index < 0 ? argv : [...argv.slice(0, index), ...argv.slice(index + 2)];
}

export function daemonDir() {
  // Derived state (sockets and pid files), not user data: renaming it
  // strands at most a stale directory from a previous install, which the
  // daemon's own stale-socket handling already copes with. No migration
  // is owed here.
  return resolve(userStateHome(), "natalia", "daemon");
}

function positiveEnvNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? "");
  return Number.isFinite(raw) && raw >= 250 ? raw : fallback;
}

/** How long one shutdown step may take before we log it and move on. */
export function shutdownStepTimeoutMs() {
  return positiveEnvNumber("NATALIA_SHUTDOWN_STEP_TIMEOUT_MS", 8_000);
}

/** Hard bound for the whole post-signal shutdown, after which we force exit. */
function shutdownHardTimeoutMs() {
  return positiveEnvNumber("NATALIA_SHUTDOWN_HARD_TIMEOUT_MS", 20_000);
}

/**
 * Waits for the first SIGINT/SIGTERM, then keeps absorbing repeats.
 *
 * A `process.once` listener is removed when it fires, so a second Ctrl+C hits
 * the OS default and kills the process while durable writes are still being
 * flushed. Keeping a persistent listener lets the graceful path finish, and a
 * hard watchdog bounds it so a hung dispose cannot leave a zombie process.
 */
export function waitSignal() {
  return new Promise<void>((resolve) => {
    let shuttingDown = false;
    const onSignal = (signal: NodeJS.Signals) => {
      if (shuttingDown) {
        console.warn(
          `[shutdown] ignoring repeated ${signal}; graceful shutdown already in progress`,
        );
        return;
      }
      shuttingDown = true;
      const hardTimeoutMs = shutdownHardTimeoutMs();
      const watchdog = setTimeout(() => {
        console.error(
          `[shutdown] graceful shutdown did not finish within ${hardTimeoutMs}ms; forcing exit`,
        );
        process.exit(1);
      }, hardTimeoutMs);
      // A clean shutdown that releases every handle should still exit at once.
      watchdog.unref?.();
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

/**
 * Runs one shutdown step under a timeout so a stuck close/dispose cannot hang
 * the whole exit. Logs the failure/slowness instead of throwing, because the
 * remaining steps (and the process) must still get a chance to run.
 */
export async function settleShutdown(
  label: string,
  work: () => Promise<unknown> | unknown,
): Promise<void> {
  const timeoutMs = shutdownStepTimeoutMs();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  console.warn(`[shutdown] ${label} start`);
  try {
    await Promise.race([
      Promise.resolve().then(work),
      new Promise<void>((done) => {
        timer = setTimeout(() => {
          console.error(
            `[shutdown] ${label} did not finish within ${timeoutMs}ms; continuing`,
          );
          done();
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    console.error(
      `[shutdown] ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
    console.warn(`[shutdown] ${label} done +${Date.now() - started}ms`);
  }
}

/**
 * Diagnostic: names what still keeps the event loop alive after the graceful
 * sequence. A completed dispose that never lets the process exit is invisible
 * otherwise, and the hard watchdog then looks like a hang.
 */
export function logActiveHandles(label = "post-shutdown"): void {
  try {
    const resources =
      (
        process as { getActiveResourcesInfo?: () => string[] }
      ).getActiveResourcesInfo?.() ?? [];
    const handles =
      (
        process as { _getActiveHandles?: () => unknown[] }
      )._getActiveHandles?.() ?? [];
    const names = handles.map(
      (handle) =>
        (handle as { constructor?: { name?: string } })?.constructor?.name ??
        typeof handle,
    );
    console.warn(
      `[shutdown] ${label} resources=${JSON.stringify(resources)} handles=${JSON.stringify(names)}`,
    );
  } catch (error) {
    console.warn(
      `[shutdown] ${label} handle probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

import { nataliaHomePath } from "@anthelia/platform";

export function valueAfter(argv: string[], flag: string, offset = 0) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1 + offset] : undefined;
}

export function withoutOption(argv: string[], flag: string) {
  const index = argv.indexOf(flag);
  return index < 0 ? argv : [...argv.slice(0, index), ...argv.slice(index + 2)];
}

export function daemonDir() {
  return nataliaHomePath("run");
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

/**
 * Ends the process, or explains why it cannot.
 *
 * The graceful sequence has run and every step has reported its own result, so
 * the only thing left is to actually go. A process that stays alive after a
 * clean dispose is indistinguishable from a hang to the person at the
 * terminal, and the only signal they get is the hard watchdog firing 20
 * seconds later with no reason — which is exactly what the reported behaviour
 * was: one Ctrl+C, a long silence, then an exit nobody could attribute.
 *
 * So this does the thing the sequence was for, says it, and if the exit does
 * not take effect says THAT with what is still alive. The exit itself is
 * last: a printed line that reaches the user before the process goes is the
 * whole point.
 *
 * @param code - the exit code the sequence earned.
 * @param io - the write and the exit, injectable so a test can observe the
 * ordering without ending the test process. Production passes neither.
 */
export function exitAfterShutdown(
  code = 0,
  io: {
    write?: (line: string, done: () => void) => void;
    exit?: (code: number) => void;
  } = {},
): void {
  logActiveHandles();
  const line =
    `[shutdown] everything disposed; exiting with code ${code}` +
    (code === 0 ? "" : " (an earlier step failed)");
  // The exit waits for the WRITE, not for a guessed delay. A fixed sleep is
  // wrong in both directions: too short and the last line is lost — a
  // redirected console buffers it, which is how "the last thing it printed"
  // becomes nothing — and longer than needed is time the user spends watching
  // a process that has already finished. The write callback is the
  // deterministic answer, and the timer is the backstop for a stream that
  // never calls back (a closed pipe). The backstop is deliberately NOT
  // unref'd: a guaranteed exit is this function's entire purpose.
  const exit = io.exit ?? ((value: number) => process.exit(value));
  const write =
    io.write ??
    ((text: string, done: () => void) => {
      process.stderr.write(text, done);
    });
  const backstop = setTimeout(() => exit(code), 1_000);
  write(`${line}\n`, () => {
    clearTimeout(backstop);
    exit(code);
  });
}

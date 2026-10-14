// What `natalia` with NO arguments does: start the app.
//
// This is the entry point a user finds by double-clicking, so it has to open the
// program. It used to print a status blob instead, which meant the largest and
// most obvious exe in the install folder — the one you are supposed to run —
// flashed a window of JSON and exited, and a user reported exactly that: "I
// double-click natalia.exe and nothing starts". The status is still available,
// as `natalia status`.
//
// The stack, in the order it has to come up:
//   1. the runtime     `natalia serve --port 8790`   the API the web shell calls
//   2. the web server  `natalia serve-web ...`       the shell itself, on 8791
//   3. the window host `natalia-cef-desktop.exe`     the native window
//   4. the browser                                   the same URL, if 3 dies
//
// Ports are not free choices: the web shell's runtime client is compiled with
// `VITE_NATALIA_RUNTIME_URL || "http://127.0.0.1:8790"`, so a runtime on any
// other port loads the app and 404s every API call — it opens and cannot
// configure a model. The shell takes 8791 and calls 8790 cross-origin, which the
// transport already allows (it sends access-control-allow-origin: * with POST).
//
// THE SERVERS RUN IN THIS PROCESS. They were spawned as children of this same
// executable first, and that cannot work: `natalia.exe` is a Bun single-file
// shell, and uv_spawn refuses it with ENOENT no matter which path you hand it
// (`process.execPath`, `process.argv[0]` — both name a file that exists, both
// were refused). Spawning is also the wrong shape on its own, because a child
// sharing this console dies with it and the browser tab then finds its API
// refusing every connection (net::ERR_CONNECTION_REFUSED :8790/rpc). Only the
// window host is spawned, because that really is a different executable.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join, dirname, resolve } from "node:path";
import { handleRuntimeCommand } from "./runtime-commands";

const RUNTIME_PORT = 8790;
const WEB_PORT = 8791;

/**
 * CEF's "I handed this launch to a de-elevated copy of myself" exit code.
 *
 * `CEF_RESULT_CODE_NORMAL_EXIT_AUTO_DE_ELEVATED = 38` in
 * include/internal/cef_types.h, whose own comment reads "The browser process
 * exited because it was re-launched without elevation". Treating it as a failure
 * opened a browser tab on top of a window that had already come up.
 */
const CEF_EXIT_HANDED_OFF_TO_DE_ELEVATED = 38;

/**
 * CEF's "I handed this launch to the instance that was already running"
 * exit code.
 *
 * ProcessSingleton found a live instance, forwarded the launch to it and
 * exited early. The app IS open — in that other process, which (see
 * SimpleApp::OnAlreadyRunningAppRelaunch) opens a further window for this
 * launch. Treating 24 as a failure opens a browser tab on top of a window
 * that has already come up.
 */
const CEF_EXIT_HANDED_OFF_TO_EXISTING = 24;

/**
 * The install directory: every shipped executable, library and the web shell sit
 * side by side in it.
 *
 * Every obvious candidate is WRONG in at least one launch mode, which is why
 * this tries several and picks by evidence (does `web/index.html` live there)
 * instead of trusting one:
 *   `import.meta.dir`  -> `B:\~BUN\` — Bun's embedded filesystem, never the
 *                         install folder. "no web shell at B:\~BUN\web" is
 *                         exactly what that produced.
 *   `process.execPath` -> correct when started by the shell
 *                         (`E:\Natalia-verify\natalia.exe`), but `B:\~BUN\...`
 *                         when started with redirected stdio. Same binary, same
 *                         machine, different answer, so it cannot be the only
 *                         source.
 *   `process.argv[0]`  -> what the shell actually used, the other mode's answer.
 * The first candidate that actually contains the web shell wins; if none does,
 * the first non-empty one is returned so the caller can name it in its error.
 */
function appDir(): string {
  const candidates = [
    dirname(process.argv[0] ?? ""),
    dirname(process.execPath),
    dirname(import.meta.dir),
  ].filter((dir) => dir.length > 0);
  for (const dir of candidates) {
    if (existsSync(join(dir, "web", "index.html"))) return dir;
  }
  return candidates[0] ?? ".";
}

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(250);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Whether the port is held by a Natalia runtime of OURS.
 *
 * A second launch must not conclude "something else has my port" when the
 * something is the app's own already-running runtime: one runtime with
 * several front ends is the correct form — each window does its own thing
 * against the same sessions. The alternative this replaces was a second
 * `serve` hitting EADDRINUSE, the failure being swallowed by the
 * fire-and-forget start, and the window connecting to whichever instance
 * answered — a second launch that looked like a mystery.
 *
 * The signature is the event stream: only our transport answers
 * text/event-stream on /events. The probe reads the headers and closes at
 * once, so it never lingers as a subscriber in the running runtime.
 */
async function isOurRuntime(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    const response = await fetch(`http://127.0.0.1:${port}/events`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const ours =
      response.ok &&
      (response.headers.get("content-type") ?? "").includes(
        "text/event-stream",
      );
    // Close the probe connection immediately.
    controller.abort();
    return ours;
  } catch {
    return false;
  }
}

/**
 * Whether the port is already serving OUR web shell.
 *
 * The title is the signature: a static server that happens to hold 8791
 * is not the app. Read from the body, so a redirect or an error page
 * cannot pass for it.
 */
async function isOurWebShell(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = response.ok ? await response.text() : "";
    controller.abort();
    return body.includes("<title>Natalia</title>");
  } catch {
    return false;
  }
}

async function waitForPort(port: number, attempts: number): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (await portIsOpen(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Start the app and return its exit code.
 *
 * Never throws for a missing piece: a user who double-clicked an exe gets a
 * message and a browser, not a stack trace in a window that vanishes.
 */
export async function startApp(): Promise<number> {
  const dir = appDir();
  const webUrl = `http://127.0.0.1:${WEB_PORT}/`;
  const webRoot = join(dir, "web");

  if (!existsSync(join(webRoot, "index.html"))) {
    console.error(`[natalia] no web shell at ${webRoot}`);
    return 1;
  }

  // In-process, and NOT awaited: `serve` holds the runtime for as long as the
  // app runs, so awaiting it would mean never reaching the window below.
  // A failure is reported, not swallowed, and it does not take the app down —
  // the browser fallback still opens, and the reason is on stderr.
  const startServer = (args: string[], what: string): void => {
    void handleRuntimeCommand(args).catch((error: unknown) => {
      console.error(
        `[natalia] could not start the ${what}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  };

  // Whose port is it? If ours, this launch JOINS the running runtime
  // instead of fighting it for the port — see isOurRuntime. A runtime
  // started by an earlier launch serves this one exactly as it serves the
  // window that is already open.
  if (await isOurRuntime(RUNTIME_PORT)) {
    console.error(
      `[natalia] a Natalia runtime is already serving ${RUNTIME_PORT}; ` +
        `this launch uses it — one runtime, several front ends`,
    );
  } else {
    console.error(`[natalia] starting the runtime on ${RUNTIME_PORT}`);
    startServer(["serve", "--port", String(RUNTIME_PORT)], "runtime");
  }

  // The web server is per-launch state, not runtime state: a runtime
  // started on its own (`natalia serve`) has no shell beside it, so the
  // shell is started whenever it is not already being served.
  if (await isOurWebShell(WEB_PORT)) {
    console.error(
      `[natalia] the web shell is already served on ${WEB_PORT}; ` +
        `this launch uses it`,
    );
  } else {
    console.error(`[natalia] starting the web server on ${WEB_PORT}`);
    startServer(
      ["serve-web", "--root", webRoot, "--port", String(WEB_PORT)],
      "web server",
    );
  }

  // BOTH ports, and the runtime FIRST, because that order is the user-visible
  // symptom: the shell (8791) comes up faster than the runtime (8790), so
  // waiting only for the shell handed the window a page whose API was not
  // listening yet. The window then showed "cannot reach the backend", retried,
  // and connected a few seconds later — which reads as a slow first launch
  // rather than as a startup-order bug.
  //
  // The shell's runtime client is built against 8790 (see the header), so a
  // window opened before 8790 answers has no API to talk to, and the page does
  // not retry on its own.
  if (await waitForPort(RUNTIME_PORT, 40)) {
    console.error(`[natalia] the runtime is ready on ${RUNTIME_PORT}`);
  } else {
    console.error(
      `[natalia] the runtime never came up on ${RUNTIME_PORT}; the window ` +
        `will open without a working API`,
    );
  }
  if (await waitForPort(WEB_PORT, 40)) {
    console.error(`[natalia] the web server is ready on ${WEB_PORT}`);
  } else {
    console.error(`[natalia] the web server never came up on ${WEB_PORT}`);
  }

  const host = join(dir, "natalia-cef-desktop.exe");
  let hostExit = 0;
  if (existsSync(host)) {
    console.error("[natalia] starting the window host");
    try {
      const window = spawn(host, [`--url=${webUrl}`], {
        cwd: dir,
        stdio: "inherit",
      });
      hostExit = await new Promise<number>((resolve) => {
        window.once("error", () => resolve(1));
        window.once("close", (code) => resolve(code ?? 1));
      });
      console.error(`[natalia] the window host exited with ${hostExit}`);
    } catch {
      hostExit = 1;
    }
  } else {
    console.error(
      "[natalia] no window host in this install; using the browser",
    );
    hostExit = 1;
  }

  if (hostExit === 0) return 0;

  // Exit 38 is NOT a failure. It is
  //   CEF_RESULT_CODE_NORMAL_EXIT_AUTO_DE_ELEVATED
  // — "the browser process exited because it was re-launched without elevation"
  // (include/internal/cef_types.h). When the launcher runs elevated, Chromium's
  // ProcessSingleton hands the launch to a DE-ELEVATED copy of this same
  // process, and the copy we started exits 38 while that other one puts the real
  // window on screen.
  //
  // So on 38 the app IS open — in the de-elevated child. Falling back to the
  // browser here would open a SECOND window on top of a working one, and log a
  // failure that did not happen. Measured: the CEF log of an elevated launch
  // carries `RunDeElevated: Started process, PID: <n>` and
  // `AddKeepAlive(kBrowserWindow)` under that OTHER pid, while the process we
  // spawned returns 38.
  //
  // The rest of the codes are real failures and still fall through.
  // Exit 24 is NOT a failure either. It is the ProcessSingleton hand-off:
  // a live instance was found, the launch was forwarded to it, and the
  // process we spawned exited early — while that instance opens a further
  // window for this launch (SimpleApp::OnAlreadyRunningAppRelaunch).
  // Falling back to the browser here would open a SECOND window on top of
  // the one that just came up.
  if (hostExit === CEF_EXIT_HANDED_OFF_TO_EXISTING) {
    console.error(
      "[natalia] the window host handed its launch to the " +
        "already-running instance (CEF exit 24); that instance owns the " +
        "window, so no browser fallback is opened",
    );
    return 0;
  }

  if (hostExit === CEF_EXIT_HANDED_OFF_TO_DE_ELEVATED) {
    console.error(
      "[natalia] the window host handed its launch to a de-elevated " +
        "instance (CEF exit 38); that instance owns the window, so no " +
        "browser fallback is opened",
    );
    return 0;
  }

  // The window is what the user is owed; WHICH window is a preference, and a
  // crashed host must not take the app down. The servers are detached, so they
  // are still up for the tab this opens.
  console.error("[natalia] opening the app in the default browser");
  const opener = process.platform === "win32" ? "explorer.exe" : "xdg-open";
  try {
    spawn(opener, [webUrl], { detached: true, stdio: "ignore" }).unref();
  } catch {
    console.error(`[natalia] open ${webUrl} by hand`);
  }
  return 0;
}

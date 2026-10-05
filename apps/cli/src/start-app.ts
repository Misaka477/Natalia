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

  console.error(`[natalia] starting the runtime on ${RUNTIME_PORT}`);
  startServer(["serve", "--port", String(RUNTIME_PORT)], "runtime");
  console.error(`[natalia] starting the web server on ${WEB_PORT}`);
  startServer(
    ["serve-web", "--root", webRoot, "--port", String(WEB_PORT)],
    "web server",
  );

  // A window that loads before its listener exists never retries, so wait.
  if (await waitForPort(WEB_PORT, 40)) {
    console.error("[natalia] the web server is ready");
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

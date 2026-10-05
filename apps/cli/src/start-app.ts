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
//   2. the web server  `natalia serve-web ... `      the shell itself, on 8791
//   3. the window host `natalia-cef-desktop.exe`     the native window
//   4. the browser                                   the same URL, if 3 dies
//
// Ports are not free choices: the web shell's runtime client is compiled with
// `VITE_NATALIA_RUNTIME_URL || "http://127.0.0.1:8790"`, so a runtime on any
// other port loads the app and 404s every API call — it opens and cannot
// configure a model. The shell takes 8791 and calls 8790 cross-origin, which the
// transport already allows (it sends access-control-allow-origin: * with POST).
//
// The children are detached so they outlive this process: a child sharing this
// console dies with it, and the browser tab just opened would then find its API
// refusing every connection (net::ERR_CONNECTION_REFUSED :8790/rpc).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

const RUNTIME_PORT = 8790;
const WEB_PORT = 8791;

/** Own directory: the release tree puts every executable side by side. */
function appDir(): string {
  return join(import.meta.dir, "..");
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
  const self = process.execPath;
  const webUrl = `http://127.0.0.1:${WEB_PORT}/`;

  const startChild = (args: string[]): void => {
    try {
      const child = spawn(self, args, {
        cwd: dir,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      // Detached: nothing waits on it here, and it must not die with this
      // process (see the header).
      child.unref();
    } catch {
      console.error(`[natalia] could not start: ${self} ${args.join(" ")}`);
    }
  };

  console.error(`[natalia] starting the runtime on ${RUNTIME_PORT}`);
  startChild(["serve", "--port", String(RUNTIME_PORT)]);
  console.error(`[natalia] starting the web server on ${WEB_PORT}`);
  startChild([
    "serve-web",
    "--root",
    join(dir, "web"),
    "--port",
    String(WEB_PORT),
  ]);

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

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const runtimeConfigPath = resolve(root, ".natalia", "global-config.json");
const defaultRuntimeConfigPath = resolve(
  homedir(),
  ".config",
  "natalia-cli",
  "config.json",
);
const runtimeWorkspacesPath = resolve(root, ".natalia", "workspaces.json");
const defaultRuntimeWorkspacesPath = resolve(
  homedir(),
  ".config",
  "natalia-cli",
  "workspaces.json",
);
mkdirSync(resolve(root, ".natalia"), { recursive: true });
if (!existsSync(runtimeConfigPath) && existsSync(defaultRuntimeConfigPath)) {
  try {
    copyFileSync(defaultRuntimeConfigPath, runtimeConfigPath);
  } catch {
    // A missing or unreadable default config should not block the dev server.
  }
}
if (
  !existsSync(runtimeWorkspacesPath) &&
  existsSync(defaultRuntimeWorkspacesPath)
) {
  try {
    copyFileSync(defaultRuntimeWorkspacesPath, runtimeWorkspacesPath);
  } catch {
    // A missing or unreadable default registry should not block the dev server.
  }
}
let serve: ChildProcess | undefined;

/**
 * Spawn a command the way this host can actually spawn it.
 *
 * Two Windows traps this used to fall into:
 *
 *  1. `npm` is `npm.cmd` on Windows, and Node refuses to spawn a `.cmd`
 *     without `shell: true` (ENOENT since the 18.20/20.12/21.7 security
 *     fixups). Passing the shell through is the documented escape hatch, and
 *     it is applied per platform so POSIX keeps its argument-vector
 *     semantics (no shell quoting surprises on a path with a space in it).
 *  2. a hard-coded `/tmp/...` for the npm cache resolves to the current
 *     drive's root on Windows (`C:\tmp`), which is not writable for an
 *     unprivileged user — so the spawn failed with EPERM on a cache nobody
 *     needed. The cache now goes under the OS temp dir on every platform.
 */
const isWindows = process.platform === "win32";
const npmCacheDir = join(tmpdir(), "natalia-npm-cache");
function spawnCommand(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2] = {},
): ChildProcess {
  return spawn(isWindows ? `${command}.cmd` : command, args, {
    ...options,
    ...(isWindows ? { shell: true } : {}),
  });
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolvePromise(true));
    });
  });
}

async function findFreePort(start = 8790): Promise<number> {
  for (let port = start; port < start + 100; port++) {
    if (await portFree(port)) return port;
  }
  throw new Error("no free runtime port found");
}

async function waitForServer(port: number, tries = 20): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`runtime server did not start on ${port}`);
}

const port = await findFreePort();
console.log(`[dev-web-ui] starting runtime serve on ${port}`);
serve = spawnCommand("bun", ["apps/cli/src/main.ts", "serve", String(port)], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    NATALIA_CONFIG: runtimeConfigPath,
    NATALIA_WORKSPACES_FILE: runtimeWorkspacesPath,
    npm_config_cache: npmCacheDir,
    NPM_CONFIG_CACHE: npmCacheDir,
  },
});
serve.on("exit", (code) => {
  if (code && code !== 0) console.error(`[dev-web-ui] serve exited ${code}`);
});

await waitForServer(port);

const vite = spawnCommand(
  "npm",
  ["--workspace", "@natalia/web-shell", "run", "dev"],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_NATALIA_RUNTIME_URL: `http://127.0.0.1:${port}`,
    },
  },
);

async function shutdown(signal: string) {
  console.log(`[dev-web-ui] received ${signal}, shutting down`);
  vite.kill(signal as NodeJS.Signals);
  serve?.kill(signal as NodeJS.Signals);
  await once(vite, "exit").catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
await once(vite, "exit").catch(() => undefined);
serve?.kill();
process.exit(0);

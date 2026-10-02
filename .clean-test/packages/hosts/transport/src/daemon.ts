import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

export type RuntimeDaemonRegistration = {
  version: string;
  url: string;
  pid: number;
  tokenFile: string;
  transport: "http" | "unix" | "tls";
  createdAt: string;
};

export type RuntimeDaemonStore = {
  dir: string;
  registrationPath: string;
  tokenPath: string;
  version: string;
};

export function createRuntimeDaemonStore(input: {
  dir: string;
  version?: string;
}): RuntimeDaemonStore {
  const dir = resolve(input.dir);
  return {
    dir,
    registrationPath: resolve(dir, "daemon.json"),
    tokenPath: resolve(dir, "token"),
    version: input.version ?? "0.0.0-ts7",
  };
}

export async function daemonToken(store: RuntimeDaemonStore) {
  try {
    return (await readFile(store.tokenPath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("base64url");
  await mkdir(dirname(store.tokenPath), { recursive: true, mode: 0o700 });
  await writeFile(store.tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

export async function registerRuntimeDaemon(
  store: RuntimeDaemonStore,
  input: Omit<RuntimeDaemonRegistration, "version" | "tokenFile" | "createdAt">,
) {
  const registration: RuntimeDaemonRegistration = {
    ...input,
    version: store.version,
    tokenFile: store.tokenPath,
    createdAt: new Date().toISOString(),
  };
  await mkdir(dirname(store.registrationPath), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    store.registrationPath,
    `${JSON.stringify(registration, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  return registration;
}

export async function readRuntimeDaemonRegistration(store: RuntimeDaemonStore) {
  try {
    return JSON.parse(
      await readFile(store.registrationPath, "utf8"),
    ) as RuntimeDaemonRegistration;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function runtimeDaemonStatus(store: RuntimeDaemonStore) {
  const registration = await readRuntimeDaemonRegistration(store);
  if (!registration) return { state: "missing" as const };
  if (registration.version !== store.version)
    return { state: "incompatible" as const, registration };
  if (!isProcessRunning(registration.pid)) {
    // Best-effort cleanup, same discipline as the update receipts: a
    // READ-ONLY state home (a real deployment — and this repo's own
    // sandbox) must never turn a status READ into a crash. The record
    // stays on disk then, still honestly reported as stale.
    await rm(store.registrationPath, { force: true }).catch(() => undefined);
    return { state: "stale" as const, registration };
  }
  return { state: "running" as const, registration };
}

export async function stopRuntimeDaemon(store: RuntimeDaemonStore) {
  const registration = await readRuntimeDaemonRegistration(store);
  if (!registration) return { stopped: false, reason: "missing" as const };
  if (isProcessRunning(registration.pid))
    process.kill(registration.pid, "SIGTERM");
  await rm(store.registrationPath, { force: true });
  return { stopped: true, pid: registration.pid };
}

export function spawnRuntimeDaemon(input: {
  command: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}) {
  if (input.command.length === 0) throw new Error("daemon command is empty");
  const child = spawn(input.command[0]!, input.command.slice(1), {
    cwd: input.cwd,
    detached: true,
    stdio: "ignore",
    env: cleanEnv(input.env ?? process.env),
  });
  child.unref();
  if (!child.pid) throw new Error("daemon process did not expose a pid");
  return child.pid;
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanEnv(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

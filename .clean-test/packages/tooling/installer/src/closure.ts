import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { nataliaLockSchema, type NataliaLock } from "@anthelia/contracts";

export function pluginClosurePaths(pluginStoreRoot: string) {
  const storeRoot = resolve(pluginStoreRoot);
  return {
    storeRoot,
    pluginsDir: storeRoot,
    lockPath: join(storeRoot, "natalia.lock"),
  };
}

export type FileSnapshot = { path: string; contents?: Buffer };

export async function snapshotFile(path: string): Promise<FileSnapshot> {
  try {
    return { path, contents: await readFile(path) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path };
    throw error;
  }
}

export async function restoreFile(snapshot: FileSnapshot) {
  if (!snapshot.contents) {
    await rm(snapshot.path, { force: true });
    return;
  }
  await mkdir(dirname(snapshot.path), { recursive: true, mode: 0o700 });
  await writeFile(snapshot.path, snapshot.contents, { mode: 0o600 });
}

export async function rollbackWith(
  originalError: unknown,
  restorations: Array<() => Promise<void>>,
): Promise<never> {
  const errors = [originalError];
  for (const restore of restorations)
    try {
      await restore();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length > 1)
    throw new AggregateError(errors, "plugin transaction rollback failed");
  throw originalError;
}

export async function loadNataliaLock(
  pluginStoreRoot: string,
): Promise<NataliaLock> {
  try {
    return nataliaLockSchema.parse(
      JSON.parse(
        await readFile(pluginClosurePaths(pluginStoreRoot).lockPath, "utf8"),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, plugins: {} };
    throw error;
  }
}

export async function saveNataliaLock(
  pluginStoreRoot: string,
  lock: NataliaLock,
) {
  const parsed = nataliaLockSchema.parse(lock);
  const { lockPath } = pluginClosurePaths(pluginStoreRoot);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const temporary = `${lockPath}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, lockPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export type PackageManagerRun = (input: {
  args: string[];
  cwd: string;
}) => Promise<void>;

export async function withStoreLock<T>(
  pluginStoreRoot: string,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockDirectory = join(resolve(pluginStoreRoot), `.${name}.lock`);
  await mkdir(resolve(pluginStoreRoot), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      await writeFile(
        join(lockDirectory, "owner.json"),
        JSON.stringify({ pid: process.pid }),
        { mode: 0o600 },
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await lockOwnerIsDead(lockDirectory)) {
        await rm(lockDirectory, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockDirectory, { recursive: true, force: true });
  }
}

async function lockOwnerIsDead(lockDirectory: string) {
  try {
    const owner = JSON.parse(
      await readFile(join(lockDirectory, "owner.json"), "utf8"),
    ) as { pid?: number };
    if (!Number.isInteger(owner.pid) || owner.pid! <= 0)
      return await invalidLockIsStale(lockDirectory);
    try {
      process.kill(owner.pid!, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return await invalidLockIsStale(lockDirectory);
  }
}

async function invalidLockIsStale(lockDirectory: string) {
  return Date.now() - (await stat(lockDirectory)).mtimeMs > 30_000;
}

export const runNpm: PackageManagerRun = async ({ args, cwd }) => {
  const child = Bun.spawn(["npm", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(
      `npm ${args.join(" ")} failed: ${(stderr || stdout).trim()}`,
    );
};

export function npmInstallArgs(prefix: string, spec: string) {
  return [
    "install",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    "--install-links",
    "--save-exact",
    "--prefix",
    prefix,
    spec,
  ];
}

export function npmUninstallArgs(prefix: string, packageName: string) {
  return [
    "uninstall",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    "--prefix",
    prefix,
    packageName,
  ];
}

export async function closureDependencies(prefix: string) {
  try {
    const value = JSON.parse(
      await readFile(join(prefix, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    return value.dependencies ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function packageDirectory(prefix: string, packageName: string) {
  return join(prefix, "node_modules", ...packageName.split("/"));
}

export async function readPackageRecord(prefix: string, packageName: string) {
  const lock = JSON.parse(
    await readFile(join(prefix, "package-lock.json"), "utf8"),
  ) as { packages?: Record<string, unknown> };
  return lock.packages?.[`node_modules/${packageName}`] as
    | { version?: string; integrity?: string }
    | undefined;
}

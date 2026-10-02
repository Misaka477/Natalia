/**
 * The exit-phase data plane (install study §5, phase D4): program removal,
 * the one true data deletion, and the store export that precedes it.
 *
 * The iron law this module exists to keep: **uninstall ≠ data deletion**.
 * The life-preserving store (`~/.natalia/stores/`) is the user's rescue
 * ring — uninstall removes the program and nothing else; `purge` is the
 * only command that deletes data, behind a double confirmation, and the
 * format question is settled here: an export is a directory archive of
 * stores/ plus a SHA256 manifest (the store's own manifests already make
 * it self-describing; the manifest adds tamper-evidence, the same
 * discipline build-standalone uses for release artifacts).
 */
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hashTreeFiles } from "@anthelia/platform";

/** The install root: `NATALIA_HOME` overrides (D2 unattended + tests). */
/**
 * The install layout the installer writes: `<home>/bin/natalia` is a
 * relative symlink to `<home>/versions/<version>/natalia`. An INSTALLED
 * binary derives its home from that layout — otherwise `uninstall` (and
 * every other store-touching command) operates on whatever `~/.natalia`
 * happens to be, leaving the real install untouched (the bug this
 * closes: installing to /tmp/x then running uninstall reported "no
 * program files under ~/.natalia"). The env still wins: it is the
 * documented override, and a dev run (bun) has no install layout.
 */
export function nataliaHomeForExecutable(execPath: string): string | undefined {
  const parts = execPath.split("/");
  const last = parts.at(-1);
  if (last !== "natalia" && last !== "natalia.ts") return undefined;
  const parent = parts.at(-2);
  const grandparent = parts.at(-3);
  // <home>/bin/natalia (the installer's symlink)
  if (parent === "bin") return parts.slice(0, -2).join("/") || "/";
  // <home>/versions/<version>/natalia (what process.execPath usually is:
  // the grandparent is "versions", the parent is the version dir)
  if (grandparent === "versions") return parts.slice(0, -3).join("/") || "/";
  return undefined;
}

export function nataliaHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NATALIA_HOME) return resolve(env.NATALIA_HOME);
  const derived = nataliaHomeForExecutable(process.execPath);
  if (derived) return derived;
  return join(homedir(), ".natalia");
}

export type StoreSummary = {
  workspaceID: string;
  bytes: number;
  sessions: number;
};

export type PurgeTargets = {
  stores: StoreSummary[];
  storesBytes: number;
  logsBytes: number;
  hasConfig: boolean;
  configBytes: number;
};

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function treeFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await treeFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  for (const file of await treeFiles(dir)) total += (await statSize(file)) ?? 0;
  return total;
}

async function statSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

/** What purge would delete — listed BEFORE any confirmation (火化要明确). */
export async function listPurgeTargets(home: string): Promise<PurgeTargets> {
  const storesDir = join(home, "stores");
  const stores: StoreSummary[] = [];
  let storesBytes = 0;
  for (const entry of await entries(storesDir)) {
    const dir = join(storesDir, entry);
    if (!entry.startsWith(".")) {
      const bytes = await treeBytes(dir);
      const sessionsDir = join(dir, "sessions");
      const sessions = (await entries(sessionsDir)).length;
      stores.push({ workspaceID: entry, bytes, sessions });
      storesBytes += bytes;
    }
  }
  const logsBytes = await treeBytes(join(home, "logs"));
  const configPath = join(home, "config.json");
  const configBytes = (await statSize(configPath)) ?? 0;
  return {
    stores,
    storesBytes,
    logsBytes,
    hasConfig: configBytes > 0,
    configBytes,
  };
}

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export type UninstallReport = {
  home: string;
  programPresent: boolean;
  removed: string[];
  preserved: { stores: string; workspaces: number; bytes: number };
  /** The study's verbatim promise, ready to print. */
  message: string;
};

/**
 * Remove the PROGRAM (bin/ and versions/) and prove nothing else moved:
 * stores/, logs/ and config.json are never opened for deletion here — the
 * message carries the rescue ring's location and the reinstall promise.
 */
export async function uninstallProgram(home: string): Promise<UninstallReport> {
  const removed: string[] = [];
  for (const entry of ["bin", "versions"]) {
    const path = join(home, entry);
    if (await isDirectory(path)) {
      await rm(path, { recursive: true, force: true });
      removed.push(entry);
    }
  }
  const storesDir = join(home, "stores");
  const targets = await listPurgeTargets(home);
  const message =
    targets.stores.length > 0
      ? `your checkpoints and journal are preserved at ${storesDir} ` +
        `(${targets.stores.length} workspace store(s), ${targets.storesBytes} bytes) — reinstall to recover them`
      : `no store data at ${storesDir} to preserve (nothing to recover, nothing lost)`;
  return {
    home,
    programPresent: removed.length > 0,
    removed,
    preserved: {
      stores: storesDir,
      workspaces: targets.stores.length,
      bytes: targets.storesBytes,
    },
    message,
  };
}

/** The double confirmation's phrase (unit-tested; CLI prompts for it). */
export function purgeConfirmation(answer: string): boolean {
  return answer.trim().toLowerCase() === "purge";
}

/**
 * The confirmation gate: `--yes` proceeds on automation; a TTY asks; a
 * non-TTY without `--yes` REFUSES (fail-closed: nobody "confirmed" a
 * nuclear deletion by being a pipe).
 */
export function resolvePurgeGate(input: { yes: boolean; isTTY: boolean }): {
  proceed: boolean;
  ask: boolean;
  reason?: string;
} {
  if (input.yes) return { proceed: true, ask: false };
  if (input.isTTY) return { proceed: false, ask: true };
  return {
    proceed: false,
    ask: false,
    reason:
      "purge needs an interactive confirmation — re-run on a TTY or pass --yes (consider: natalia store export <dest>)",
  };
}

/**
 * The ONLY data deletion: stores/, logs/ and config.json. The program
 * (bin/, versions/) is deliberately NOT this command's business — that is
 * uninstall's, and mixing them would put data deletion behind the wrong
 * door.
 */
export async function purgeData(home: string): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  for (const entry of ["stores", "logs", "config.json"]) {
    const path = join(home, entry);
    if (await exists(path)) {
      await rm(path, { recursive: true, force: true });
      removed.push(entry);
    }
  }
  return { removed };
}

export type ExportReport = {
  dest: string;
  files: number;
  bytes: number;
  manifest: string;
};

/**
 * `natalia store export <dest>` — the format the study left open (未决 #4),
 * decided as: a directory archive of stores/ plus a SHA256 manifest over
 * every archived file. No new serialization: the store's own manifests make
 * the archive self-describing, the file manifest makes it tamper-evident.
 * The original store is only read.
 */
export async function exportStores(
  home: string,
  dest: string,
): Promise<ExportReport> {
  const storesDir = join(home, "stores");
  if (!(await isDirectory(storesDir)))
    throw new Error(`no stores to export at ${storesDir}`);
  const target = resolve(dest);
  const archive = join(target, "stores");
  await mkdir(target, { recursive: true });
  await cp(storesDir, archive, { recursive: true });
  // The shared checksum walk — the same inventory the release build and
  // the debug bundle produce (one walk, three manifests, one meaning of
  // "verified").
  const { files: hashed, bytes } = await hashTreeFiles(archive, target);
  const manifestFiles = hashed;
  const manifestPath = join(target, "manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        name: "natalia-stores",
        exportedAt: new Date().toISOString(),
        files: manifestFiles,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return {
    dest: target,
    files: manifestFiles.length,
    bytes,
    manifest: manifestPath,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

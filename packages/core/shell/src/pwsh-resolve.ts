/**
 * PowerShell executable resolution.
 *
 * Parameterised by env and platform so resolution is a pure function of its
 * inputs on every host, and by `exists` so the order can be tested without a
 * real Windows filesystem — the same injection `@anthelia/platform`'s
 * `resolveBashExecutable` takes.
 *
 * The order is PowerShell 7 first, then PATH, then Windows PowerShell 5.1 as the
 * legacy last resort: a host that has 7 and 5.1 should use 7, and one that has
 * only 5.1 should still work rather than fail for a version it cannot fix.
 */
import { lstatSync } from "node:fs";

/**
 * Well-known PowerShell locations plus PATH entries, in resolution order.
 *
 * PATH entries may carry surrounding quotes left by `setx`-style definitions, so
 * they are trimmed and unquoted; a quoted entry that is not stripped is a path
 * that never exists.
 */
export function candidatePwshPaths(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  const candidates = [`${programFiles}\\PowerShell\\7\\pwsh.exe`];
  for (const entry of (env.PATH ?? "").split(";")) {
    const trimmed = entry.trim().replace(/^"|"$/gu, "");
    if (trimmed.length === 0) continue;
    candidates.push(`${trimmed}\\pwsh.exe`);
  }
  candidates.push(
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
  );
  return candidates;
}

/**
 * Whether a candidate can be spawned.
 *
 * A SYMLINK counts. The Microsoft Store install is an app execution alias, which
 * the filesystem reports as a reparse point: `stat` follows it and meets the
 * target's ACL (EACCES), while opening the entry itself succeeds. So the check
 * accepts a symlink where a `stat`-based one would reject the only PowerShell a
 * Store-installed host has. A directory never matches.
 */
function defaultExists(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() || info.isSymbolicLink();
  } catch {
    // The candidate vanished between listing and probing, or is unspawnable for
    // some other reason; either way it is not a usable executable.
    return false;
  }
}

/**
 * Resolve the PowerShell executable to spawn.
 *
 * `configured` is trusted as-is, so a caller who knows better wins. On win32 the
 * candidates are probed in order; everywhere else the answer is `pwsh` and PATH
 * resolution does the rest.
 */
export function resolvePwshPath(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = defaultExists,
): string {
  if (configured !== undefined && configured.length > 0) return configured;
  if (platform === "win32") {
    for (const candidate of candidatePwshPaths(env))
      if (exists(candidate)) return candidate;
  }
  return "pwsh";
}

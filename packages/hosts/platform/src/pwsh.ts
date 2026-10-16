/**
 * The PowerShell spelling, owned by the platform layer.
 *
 * This lived one layer up in the shell package until the platform layer
 * itself needed it: `startDetachedProcess`'s Windows branch used to launch
 * its redirecting launcher through a BASH (`bash -lc "( cmd ) > log 2>&1"`),
 * which on Windows means Git bash or WSL — neither of which can see the
 * Windows paths Natalia hands its processes, and WSL cannot see the
 * Windows-installed node/bun either. The detached branch now speaks the
 * platform's own shell, exactly like the foreground path, and the knowledge
 * lives at the layer both can import.
 */

/**
 * Pinned before every command.
 *
 * Windows PowerShell 5.1 — the last-resort executable — writes the console's OEM
 * code page by default, which garbles any non-ASCII output; pwsh 7 defaults to
 * UTF-8 and is unaffected. The statements ride on line 1 separated by `; ` rather
 * than on their own line so PowerShell's error LINE NUMBERS stay accurate, which
 * is the reason this is a prefix and not a preamble block.
 */
export const ENCODING_PREAMBLE =
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ";

import { lstatSync } from "node:fs";

/**
 * Well-known PowerShell locations plus PATH entries, in resolution order.
 *
 * The reference implementation's order, kept verbatim — a machine-wide
 * `%ProgramFiles%\PowerShell\7`, then PATH entries, then the OS's own Windows
 * PowerShell 5.1 — plus the PER-USER install root, which that list cannot see:
 * the MSI's default scope puts pwsh 7 under `%LOCALAPPDATA%\Programs\PowerShell\7`,
 * and a host installed that way has no ProgramFiles copy and no PATH entry once
 * the process inherits an environment that dropped it. Measured on this machine:
 * with only that candidate missing, a pane resolved to Windows PowerShell 5.1,
 * which then rejected the pwsh-7 `-Interactive` switch, and the terminal opened
 * unusable. Derived from the environment like `ProgramFiles` above, never a
 * literal machine path.
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
  const localAppData = env.LOCALAPPDATA;
  if (localAppData)
    candidates.push(`${localAppData}\\Programs\\PowerShell\\7\\pwsh.exe`);
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
export function pwshExecutableExists(path: string): boolean {
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
  exists: (path: string) => boolean = pwshExecutableExists,
): string {
  if (configured !== undefined && configured.length > 0) return configured;
  if (platform === "win32") {
    for (const candidate of candidatePwshPaths(env))
      if (exists(candidate)) return candidate;
  }
  return "pwsh";
}

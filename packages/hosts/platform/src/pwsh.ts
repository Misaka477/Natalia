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
import { basename } from "node:path";

/**
 * A pwsh path SET BY THE USER (the settings panel's PowerShell row, persisted in
 * the config). The seam is module-level for the same reason the bash path's is:
 * the shell call sites are primitives that must not each learn to read the
 * config, and one boot-time wiring is the honest place. `undefined` restores
 * discovery.
 *
 * WINDOWS ONLY, deliberately, exactly like the bash path: on POSIX the answer is
 * `pwsh` and no setting is needed, so the platform guard is the resolver's, not
 * merely the UI's. Matches the reference implementation's `pwshPath` plugin
 * config, which is likewise an explicit executable overriding discovery.
 */
let configuredPwshExecutable: string | undefined;

export function configurePwshExecutable(path: string | undefined): void {
  configuredPwshExecutable = path && path.trim() ? path.trim() : undefined;
}

/** The configured path (the doctor's report reads it). */
export function configuredPwshPath(): string | undefined {
  return configuredPwshExecutable;
}

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
 * `configured` is trusted as-is, so a caller who knows better wins; the
 * boot-time configuration (the settings panel's row) is the next answer on
 * Windows, and discovery follows. On win32 the candidates are probed in order;
 * everywhere else the answer is `pwsh` and PATH resolution does the rest.
 */
export function resolvePwshPath(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = pwshExecutableExists,
): string {
  if (configured !== undefined && configured.length > 0) return configured;
  if (platform === "win32") {
    if (configuredPwshExecutable) return configuredPwshExecutable;
    for (const candidate of candidatePwshPaths(env))
      if (exists(candidate)) return candidate;
  }
  return "pwsh";
}

/**
 * Whether a resolved PowerShell is the OS's own Windows PowerShell 5.1.
 *
 * 5.1 is the resolver's documented last resort and a materially different
 * shell: it is not the product's target (it has no PSReadLine by default, it
 * rejects the pwsh-7 `-Interactive` switch, and it writes the OEM code page), so
 * a caller that ended up there says so instead of leaving the operator to guess.
 * Only that executable is named `powershell.exe`; every PowerShell 7 build is
 * `pwsh.exe`.
 */
export function isWindowsPowerShell51(path: string): boolean {
  return basename(path).toLowerCase() === "powershell.exe";
}

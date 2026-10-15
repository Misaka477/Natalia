/**
 * The shell a pane's command line names, as the panel spells it.
 *
 * The runtime reports a pane's `command` as whatever it spawned — a full
 * Windows path with spaces (`C:\Program Files\PowerShell\7\pwsh.exe`), a
 * POSIX absolute path (`/bin/zsh`), or a bare name. The select lists the
 * shell's NAME, so the two have to be reconciled without guessing: the
 * answer is the file name without its executable suffix, lowercased, which
 * is the name the platform's own resolvers already answer to
 * (`resolveShellPath("pwsh")` → PowerShell 7, `powershell` → the OS's 5.1).
 *
 * This runs where the pane does, not in a renderer: it is the panel's way of
 * showing what the RUNTIME says is running, and a renderer-side guess (a
 * `navigator.platform` read) would be a second source of truth for the same
 * fact.
 */
export function shortShellName(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  // A Windows path is whole until its last separator; splitting on whitespace
  // first would cut `C:\Program Files\PowerShell\7\pwsh.exe` at the space.
  const lastSegment = trimmed.split(/[\\/]/u).pop() ?? trimmed;
  const firstWord = lastSegment.split(/\s+/u)[0] ?? lastSegment;
  return firstWord.replace(/\.(exe|cmd|bat)$/iu, "").toLowerCase();
}

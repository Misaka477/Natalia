/**
 * Which shell gets which integration script.
 *
 * A pane spawns the operator's shell, and the command-level read exists only if
 * that shell emits the OSC 133 markers we parse. This is the map from a resolved
 * shell to an injectable script, and from a script to the argv that loads it.
 *
 * ONE ENTRIES, AND IT IS THE ONE VERIFIED. `bash` was driven end to end — a real
 * bash through a pty, emitting the markers in the order the parser expects, with
 * `false` reaching `133;D;1`. The rest of this file is therefore written and
 * UNVERIFIED: the shells that have no script here produce no markers, which the
 * reader already reports as "this pane cannot tell you" rather than a wrong
 * answer. An entry is added when its shell has been run, not when it has been
 * written.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The integration script bundled with this package, by shell basename.
 *
 * The NAME is the map's value; the PATH is derived, because a pane's `--rcfile`
 * must be absolute. A pane spawns in the operator's workspace, and a relative
 * script name would resolve there — not next to the plugin that ships it — so the
 * integration would silently not load and the pane would just have no markers.
 */
const SCRIPTS: Record<string, string> = {
  bash: "shell-integration-bash.sh",
  zsh: "shell-integration-zsh.sh",
};

/** The directory this module lives in: where the bundled scripts are. */
const BUNDLED = import.meta.dir;

/**
 * The argv that starts a shell with its integration script loaded.
 *
 * bash takes `--rcfile`, which REPLACES the user's rc — so the script sources the
 * real one itself, under a variable that says "I gave you this instead of
 * ~/.bashrc". A caller that already passes `-l` keeps it.
 */
export function integratedShellArgv(shellPath: string): string[] | undefined {
  const name = basename(shellPath).replace(/\.(exe|cmd|bat)$/i, "");
  const script = SCRIPTS[name];
  if (!script) return undefined;
  // No `-i`: bash rejects the combination outright (`--: invalid option`), which
  // is the loud kind of failure — measured directly. A pane's stdin is a pty, and
  // bash reads `--rcfile` for that case.
  // bash reads `--rcfile`; zsh has no such flag and takes a replacement rc
  // through ZDOTDIR, so the argv cannot carry it — the caller has to set it.
  // `shell` here is only what gets exec'd; the rc is reached by env, not argv,
  // and that difference is why zsh is not just another map entry.
  if (name === "zsh") return [shellPath];
  return [shellPath, "--rcfile", join(BUNDLED, script)];
}

/**
 * Rewrite a pane's argv to carry the integration, if the pane is a shell we
 * support.
 *
 * It only does this for a pane that IS an interactive shell. A pane running a
 * command (`/bin/sh -lc 'mkfs.ext4 ...'`) gets no markers, which is correct: that
 * command's output is the answer to what was asked, and the pane's own read still
 * carries it.
 */
export function withShellIntegration(argv: readonly string[]): string[] {
  if (argv.length === 0) return [...argv];
  const [file] = argv;
  if (typeof file !== "string") return [...argv];
  const integrated = integratedShellArgv(file);
  if (!integrated) return [...argv];
  // Keep any arguments the caller already gave: `-l`, `-i`, a command. The rcfile
  // is appended rather than replacing the argv, so `bash -l` stays a shell that reads its profile.
  return [...integrated, ...argv.slice(1)];
}

/**
 * The argv for a pane whose command IS a supported interactive shell.
 *
 * `command` here is the pane's command string. When it names a shell we can
 * integrate — `bash`, `/usr/bin/bash`, `bash -l` — the pane becomes that shell
 * with its integration loaded, rather than `/bin/sh -lc bash`, which would be a
 * different shell running a shell and carrying no markers at all.
 *
 * Returns undefined for anything that is not such a command, which is every
 * command a pane ever runs that is not a shell.
 */
export function interactiveShellArgv(
  command: string,
  os?: NodeJS.Platform,
): string[] | undefined {
  if (os !== undefined && os !== "linux" && os !== "darwin") return undefined;
  const trimmed = command.trim();
  if (trimmed.length === 0) return undefined;
  const [word, ...rest] = trimmed.split(/\s+/);
  if (word === undefined) return undefined;
  const integrated = integratedShellArgv(word);
  if (!integrated) return undefined;
  // The path first, then the script flags that came with it, then whatever the
  // pane's own command line carried (`-l`, `-i`).
  return [...resolveShellPath(integrated[0]!), ...integrated.slice(1), ...rest];
}

/**
 * An absolute path for a shell name, or the name itself when none is found.
 *
 * The pane's contract hands its spawn an absolute file, and a pty bridge given a
 * bare name depends on PATH — which works, but only if the child inherits one. An
 * absolute path is checked in the ordinary places and falls back to the bare name
 * rather than inventing one.
 */
function resolveShellPath(word: string): string[] {
  if (word.includes("/")) return [word];
  for (const dir of ["/bin", "/usr/bin", "/usr/local/bin"]) {
    const candidate = join(dir, word);
    if (existsSync(candidate)) return [candidate];
  }
  return [word];
}

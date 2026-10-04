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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  pwsh: "shell-integration-pwsh.ps1",
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
/**
 * What a shell needs to start with its integration: the argv, and the environment
 * it needs on top of the pane's own.
 *
 * Both, because the two shells are injected by different means. bash takes a
 * `--rcfile` flag and nothing else. zsh has no such flag — it reads
 * `$ZDOTDIR/.zshrc`, so the rc has to be reached by putting a directory holding our
 * script on ZDOTDIR, and that is environment, not argv. Returning only the argv
 * would leave zsh silently unintegrated, which is what the first version did: the
 * map gained a zsh entry and the argv gained nothing, so a zsh pane looked
 * configured and was not.
 */
export function integratedShellArgv(
  shellPath: string,
): { argv: string[]; env: Record<string, string> } | undefined {
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
  if (name === "zsh")
    return {
      argv: [shellPath],
      // The rc directory holds a generated .zshrc whose only job is to source this
      // package's zsh script. It is written here rather than shipped, because the
      // path has to be absolute: zsh sources `$ZDOTDIR/.zshrc` with `$0` set to the
      // shell's own name and `$PWD` left wherever the pane started, so neither
      // locates a sibling file (both tried, both silently loaded nothing).
      env: { ZDOTDIR: ensureZshRcDir() },
    };
  // PowerShell has no --rcfile and reads no rc file of its own. It takes a command to
  // dot-source, and it must be INTERACTIVE for the read-line override to be the one
  // that reads input -- measured: without `-Interactive` the startup and prompt markers
  // appear and the command line arrives empty, and nothing in the argv looks wrong.
  if (name === "pwsh")
    return {
      argv: [
        shellPath,
        "-NoLogo",
        "-NoExit",
        "-Interactive",
        "-Command",
        `. '${join(BUNDLED, script)}'`,
      ],
      env: {},
    };
  return { argv: [shellPath, "--rcfile", join(BUNDLED, script)], env: {} };
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
export function withShellIntegration(argv: readonly string[]): {
  argv: string[];
  env: Record<string, string>;
} {
  if (argv.length === 0) return { argv: [...argv], env: {} };
  const [file] = argv;
  if (typeof file !== "string") return { argv: [...argv], env: {} };
  const integrated = integratedShellArgv(file);
  if (!integrated) return { argv: [...argv], env: {} };
  // Keep any arguments the caller already gave: `-l`, `-i`, a command. The rcfile
  // is appended rather than replacing the argv, so `bash -l` stays a shell that reads its profile.
  return { argv: [...integrated.argv, ...argv.slice(1)], env: integrated.env };
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
/**
 * Writes `zsh-rc/.zshrc` (if absent) and returns the directory.
 *
 * The loader is generated rather than checked in so the script path is absolute
 * and correct for THIS checkout: a checked-in copy would carry whatever path it
 * was written at, and a pane on a different machine would source nothing. Written
 * once and then left alone, so concurrent panes do not race on it.
 */
function ensureZshRcDir(): string {
  // Under the OS temp dir, not beside the package: this file's content is a path,
  // and a path baked beside a source checkout is wrong the moment the package is
  // installed somewhere else — which is what the first version did (it wrote the
  // source tree's absolute path, so an installed pane sourced nothing at all).
  // Generated fresh here, it always names wherever THIS module was loaded from.
  const dir = join(tmpdir(), `natalia-zsh-rc-${process.pid}`);
  const loader = join(dir, ".zshrc");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    loader,
    [
      "# Generated by @natalia/native-terminal — do not edit.",
      "# Sources this package's zsh shell integration. Generated because zsh has no",
      "# --rcfile: it reads $ZDOTDIR/.zshrc, and neither $0 (the shell's own name)",
      "# nor $PWD (wherever the pane started) locates a sibling file.",
      `builtin . ${JSON.stringify(join(BUNDLED, "shell-integration-zsh.sh"))}`,
      "",
    ].join("\n"),
  );
  return dir;
}

/**
 * The environment a pane's shell needs to be integrated, by shell name.
 *
 * Split out from `withShellIntegration` because the argv path has already been
 * integrated by the time a caller wants the environment: asking for both from one
 * function is what produced `bash --rcfile X --rcfile X`.
 */
export function shellEnvFor(
  command: string,
  os?: NodeJS.Platform,
): Record<string, string> {
  const word = command.trim().split(/\s+/)[0] ?? "";
  const name = basename(word).replace(/\.(exe|cmd|bat)$/i, "");
  if (!SCRIPTS[name]) return {};
  if (name !== "zsh") return {};
  return { ZDOTDIR: ensureZshRcDir() };
}

export function interactiveShellArgv(
  command: string,
  os?: NodeJS.Platform,
): string[] | undefined {
  if (os !== undefined && os !== "linux" && os !== "darwin" && os !== "win32")
    return undefined;
  const trimmed = command.trim();
  if (trimmed.length === 0) return undefined;
  const [word, ...rest] = trimmed.split(/\s+/);
  if (word === undefined) return undefined;
  const integrated = integratedShellArgv(word);
  if (!integrated) return undefined;
  // The path first, then the script flags that came with it, then whatever the
  // pane's own command line carried (`-l`, `-i`). On win32 the path is already
  // absolute in the only case that reaches here in anger (the pane's command IS
  // a full pwsh.exe path), and resolveShellPath falls through unchanged for it.
  return [
    ...resolveShellPath(integrated.argv[0]!),
    ...integrated.argv.slice(1),
    ...rest,
  ];
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

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
import { join, posix, win32 } from "node:path";
import { resolveBashExecutable, resolvePwshPath } from "@anthelia/platform";

/**
 * The executable's own name, read in the flavour that PATH is written in.
 *
 * `basename` alone is the HOST's flavour, and this module is handed paths
 * derived FOR a target platform: `nativeTerminalPaneCommand("pwsh", "win32")`
 * runs on a POSIX CI runner, and there a Windows path has no separator
 * `basename` recognises — it came back WHOLE, the `SCRIPTS` lookup missed, and
 * the pane silently lost its integration on every non-Windows host that derived
 * a Windows pane. The check is the path's own spelling (a separator, or a drive
 * letter), never the host's.
 */
function shellName(file: string): string {
  const flavour =
    /[\\/]/u.test(file) || /^[A-Za-z]:/u.test(file) ? win32 : posix;
  return flavour.basename(file).replace(/\.(exe|cmd|bat)$/iu, "");
}

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
  // Windows PowerShell 5.1 is the SAME integration script and a different argv:
  // the resolver's documented last resort is `powershell.exe`, so a pane can
  // legitimately be 5.1 and must still be integrated (see `integratedShellArgv`).
  powershell: "shell-integration-pwsh.ps1",
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
  const name = shellName(shellPath);
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
  // dot-source.
  //
  // THE FLAGS FOLLOW THE SHELL THAT WAS RESOLVED, not the name the caller asked
  // for. `-Interactive` is pwsh-7-only: Windows PowerShell 5.1 — the resolver's
  // documented last resort — answers it with "-Interactive : The term
  // '-Interactive' is not recognized … CommandNotFoundException" and the pane
  // opens unusable (measured on this host; the same flags without it run 5.1
  // fine). This is the bug the user hit: the panel asked for `pwsh`, the
  // resolver answered 5.1 (a per-user pwsh 7 install was not on the runtime's
  // PATH), and this argv handed 5.1 a switch only 7 has. The reference
  // implementation never assumes 7 anywhere — its PowerShell argv is
  // `pwsh -NoLogo -NoProfile -NonInteractive -Command …`, every switch of which
  // 5.1 accepts — so the spelling here is chosen per resolved product.
  if (name === "pwsh" || name === "powershell") {
    const argv = [shellPath, "-NoLogo", "-NoExit"];
    // pwsh 7 keeps the switch its read-line override needs: without it the
    // startup and prompt markers still appear but the command line arrives empty
    // (measured).
    if (name === "pwsh") argv.push("-Interactive");
    argv.push("-Command", `. '${join(BUNDLED, script)}'`);
    return { argv, env: {} };
  }
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
  const name = shellName(word);
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
  // The whole string first, THEN the whitespace words. A Windows pane's
  // command is a full path with spaces in it — `C:\Program
  // Files\PowerShell\7\pwsh.exe` — and splitting on whitespace first cuts it
  // at "C:\Program", so the pwsh row never matched and the pane fell to the
  // POSIX login-shell wrapper (measured on the Windows runner: the pane ran
  // `bash.exe --rcfile ... -lc "<the pwsh path>"` and died 1.7s in). Existing
  // file first, words second: the POSIX `bash -l` spelling still splits as
  // before, and the Windows path survives whole.
  const words = trimmed.split(/\s+/);
  // The whole string first (a Windows path with spaces in it, which splitting
  // would cut in half), and otherwise THE FIRST WORD ONLY. A pane whose command
  // IS a shell is `bash` or `bash -l`; a command that merely CONTAINS a shell's
  // name later on is a command, not a shell pane — `exec bash --norc
  // --noprofile` runs under the managed `sh -lc` wrapper and must stay there.
  // Trying every word is what turned that into `bash --rcfile <script> bash
  // --norc --noprofile`: the outer shell integrated, then ran the inner bash as
  // a command, and the pane exited before its first read (the CLI dev smoke
  // failed exactly there, "terminal session has exited").
  const candidates = existsSync(trimmed) ? [trimmed] : [words[0]];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    // RESOLVE FIRST, then integrate: which PowerShell this host has is the
    // resolver's answer, and the flags must match what it found — deciding them
    // from the requested name is exactly how a 5.1 pane was handed the pwsh-7
    // `-Interactive` switch.
    const resolved = resolveShellPath(candidate, os);
    const file = resolved[0];
    if (file === undefined) continue;
    const integrated = integratedShellArgv(file);
    if (!integrated) continue;
    // The path first, then the script flags that came with it, then whatever the
    // pane's own command line carried (`-l`, `-i`) — the remainder only applies
    // to the word-shaped candidate; a whole-path candidate already carries all.
    const rest = candidate === trimmed ? [] : words.slice(1);
    // A PowerShell pane is integrated only when the pane IS the shell. Given
    // extra words it is a COMMAND (`pwsh -Command 'x'`), and the integration's own
    // `-Command` would then be followed by a second one — PowerShell takes the
    // last, so the pane ran the command line with the integration's flags in
    // front of it and the text arrived mangled (measured: `[Console]::` reached
    // the shell as `[Console`). bash and zsh compose with extra arguments
    // (`--rcfile` is additive), which is why the rule is PowerShell's.
    const name = shellName(file);
    if ((name === "pwsh" || name === "powershell") && rest.length > 0) {
      // FLAGS are not a command. `powershell -NoLogo -NoProfile` is a person
      // (or a model) naming the shell they want and its switches — the same
      // shape VS Code's own profile has — and treating it as a command spawned
      // `pwsh -NonInteractive -Command "…; powershell -NoLogo -NoProfile"`,
      // where the inner shell has nothing to read and exits at once: the pane
      // died 731ms after start (measured: `terminal.timeline exit actor:system`
      // right after a `status:"running"` start, then every later send_line said
      // "terminal session has exited"). The integration's flags stay in front of
      // `-Command`; the caller's duplicates are dropped so `-NoLogo` appears once.
      if (!rest.every(isShellFlagWord)) continue;
      return mergeShellFlags(integrated.argv, rest);
    }
    return [...integrated.argv, ...rest];
  }
  // A shell we have NO integration script for is still an interactive pane.
  // `cmd.exe` is the case that matters on Windows: with no script its argv fell
  // through to the executor, which wrapped it as `pwsh -NonInteractive -Command
  // "…; cmd.exe"` — the same immediate death as above. No markers is the honest
  // outcome for a shell we do not integrate; a pane that exits is not.
  //
  // Only a KNOWN shell name qualifies. `echo -n` also ends in flags, and
  // spawning it as a pane would be a pane that runs once and dies — the same
  // bug wearing the opposite mask.
  const bare = words[0];
  if (bare !== undefined && words.slice(1).every(isShellFlagWord)) {
    const resolved = resolveShellPath(bare, os);
    const file = resolved[0];
    if (file !== undefined && KNOWN_SHELLS.has(shellName(file)))
      return [...resolved, ...words.slice(1)];
  }
  return undefined;
}

/** Shell executables whose name alone means "this pane is a shell". */
const KNOWN_SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "pwsh",
  "powershell",
  "cmd",
  "nu",
  "elvish",
  "xonsh",
]);

/** A word that is a switch rather than a command to run (`-NoLogo`, `/k`, `--norc`). */
function isShellFlagWord(word: string): boolean {
  return /^[-/][A-Za-z]/u.test(word);
}

/**
 * The integration argv with the caller's own switches folded in.
 *
 * Everything before `-Command` is flags; everything from `-Command` on is the
 * script. A caller's flag that is already present is dropped (the integration's
 * copy is the one that matters), and the rest go immediately before `-Command`
 * so PowerShell still takes the integration's script as its command.
 */
function mergeShellFlags(
  argv: readonly string[],
  flags: readonly string[],
): string[] {
  const commandAt = argv.indexOf("-Command");
  if (commandAt < 0) return [...argv, ...flags];
  const head = argv.slice(0, commandAt);
  const tail = argv.slice(commandAt);
  const merged = [...head];
  for (const flag of flags) {
    const name = flag.split(/[=:]/u)[0]!;
    if (head.some((existing) => existing.split(/[=:]/u)[0] === name)) continue;
    merged.push(flag);
  }
  return [...merged, ...tail];
}

/**
 * An absolute path for a shell name, or the name itself when none is found.
 *
 * The pane's contract hands its spawn an absolute file, and a pty bridge given a
 * bare name depends on PATH — which works, but only if the child inherits one. An
 * absolute path is checked in the ordinary places and falls back to the bare name
 * rather than inventing one.
 *
 * On Windows the ordinary places are the ones the PLATFORM layer already
 * knows: Git for Windows' bash is not on PATH by default (it is a deliberate
 * opt-in during its install), and pwsh 7 lives under Program Files. Resolving
 * through the platform's own finders is what keeps a Windows pane from dying
 * on its first command with a bare name CreateProcess cannot place.
 */
function resolveShellPath(word: string, os?: NodeJS.Platform): string[] {
  if (word.includes("/") || word.includes("\\")) return [word];
  if (os === "win32") {
    const name = shellName(word);
    if (name === "bash") {
      const found = resolveBashExecutable({ os: "win32" });
      if (found) return [found];
    }
    if (name === "pwsh" || name === "powershell") {
      const found = resolvePwshPath(undefined, undefined, "win32");
      if (found) return [found];
    }
    return [word];
  }
  for (const dir of ["/bin", "/usr/bin", "/usr/local/bin"]) {
    const candidate = join(dir, word);
    if (existsSync(candidate)) return [candidate];
  }
  return [word];
}

import { parseBashSimpleCommand } from "@anthelia/tools";

/**
 * A collaborator (Nia, or Navi in her advisor hat) may run inspection and
 * verification commands, but must not mutate the workspace, repository,
 * dependencies or service state. This policy is intentionally
 * deny-by-default: a command must match a safe shape before the existing
 * shell tool is allowed to execute it.
 *
 * The guard is the mechanism; the prompt is the discipline. The same
 * deny-by-default policy serves both agents, voice-parameterized, because
 * "Navi runs tests to check the situation" is the same need as Nia's.
 */
const SAFE_EXECUTABLES = new Set([
  "basename",
  "cat",
  // Process and JSON inspection: both read-only by nature.
  "jq",
  "ps",
  "cmp",
  "cut",
  "df",
  "diff",
  "dirname",
  "du",
  "echo",
  "false",
  "file",
  "grep",
  "head",
  "id",
  "ls",
  "md5sum",
  "printf",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "sha1sum",
  "sha256sum",
  "sort",
  "stat",
  "tail",
  "test",
  "tr",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
  "whereis",
  "whoami",
]);

const SAFE_TEST_EXECUTABLES = new Set(["jest", "pytest", "vitest"]);
const SAFE_PACKAGE_SCRIPTS = new Set(["format", "test", "typecheck"]);

function executableName(token: string | undefined) {
  return token?.split(/[\\/]/u).pop() ?? "";
}

/** The flags a read-only curl may carry: everything else (a body, an
 * upload, a method override, an output file) is denied by default. */
const CURL_SAFE_FLAGS = new Set([
  "-s",
  "--silent",
  "-S",
  "--show-error",
  "-i",
  "--include",
  "-I",
  "--head",
  "-m",
  "--max-time",
  "-v",
  "--verbose",
]);

function curlReadOnly(tokens: string[]) {
  for (const token of tokens.slice(1)) {
    if (!token.startsWith("-")) continue;
    // `--max-time=5` carries its value; the bare form takes the next
    // token, which the allowlist check still governs.
    if (CURL_SAFE_FLAGS.has(token)) continue;
    if (CURL_SAFE_FLAGS.has(token.split("=")[0] ?? "")) continue;
    return false;
  }
  return true;
}

function unsafeShellSyntax(command: string) {
  return /[|&;<>$`\n\r(){}!\\]/u.test(command);
}

function shellTokens(command: string) {
  return (command.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*')+/gu) ?? []).map(
    (token) =>
      token.length >= 2 &&
      ((token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'")))
        ? token.slice(1, -1)
        : token,
  );
}

function hasFlag(tokens: string[], ...flags: string[]) {
  return tokens.some((token) => flags.includes(token));
}

function hasFlagPrefix(tokens: string[], ...prefixes: string[]) {
  return tokens.some((token) =>
    prefixes.some((prefix) => token.startsWith(prefix)),
  );
}

function gitReadOnly(tokens: string[]) {
  const subcommand = tokens[1];
  if (subcommand === undefined) return false;
  if (subcommand.startsWith("-")) return subcommand === "--version";
  switch (subcommand) {
    case "blame":
    case "cat-file":
    case "describe":
    case "diff":
    case "grep":
    case "log":
    case "ls-files":
    case "name-rev":
    case "reflog":
    case "rev-parse":
    case "shortlog":
    case "show":
    case "status":
    case "whatchanged":
      return true;
    // Inherently read-only ref/history walks an audit reads:
    case "diff-tree":
    case "for-each-ref":
    case "ls-remote":
    case "merge-base":
    case "rev-list":
    case "symbolic-ref":
      return true;
    // `list`-only subcommands of stateful features: the mutating
    // siblings (pop/drop/apply, add/prune/remove) are denied by shape.
    case "worktree":
      return tokens[2] === "list";
    // `stash list` / `stash show` read the stash without touching it.
    case "stash":
      return tokens[2] === "list" || tokens[2] === "show";
    case "branch": {
      const args = tokens.slice(2);
      if (args.some((arg) => !arg.startsWith("-"))) return false;
      return args.every((arg) =>
        [
          "-a",
          "--all",
          "-l",
          "--list",
          "-r",
          "--remotes",
          "-v",
          "-vv",
          "--verbose",
        ].includes(arg),
      );
    }
    case "tag":
      return hasFlag(tokens.slice(2), "-l", "--list");
    case "remote":
      return hasFlag(tokens.slice(2), "-v", "--verbose");
    case "config": {
      const args = tokens.slice(2);
      if (hasFlag(args, "-l", "--list", "--get", "--get-all", "--get-regexp"))
        return true;
      // The positional read (`git config user.name`) carries no flag; a
      // write needs a value, so exactly one non-flag arg is a read.
      return args.filter((arg) => !arg.startsWith("-")).length === 1;
    }
    default:
      return false;
  }
}

/** Read-only dependency-state subcommands (installed tree, staleness,
 * advisories, why-a-package-is-here). The install family is denied by
 * default: anything not in this set falls through to the run-script
 * gate. */
const READ_ONLY_PACKAGE_COMMANDS = new Set([
  "audit",
  "list",
  "ls",
  "outdated",
  "why",
]);

function packageManagerReadOnly(tokens: string[]) {
  const first = tokens[1];
  if (first === "test") return true;
  if (first === "--version" || first === "-v") return true;
  if (READ_ONLY_PACKAGE_COMMANDS.has(first ?? "")) return true;
  if (first !== "run") return false;
  let index = 2;
  while (tokens[index]?.startsWith("-")) index += 1;
  return SAFE_PACKAGE_SCRIPTS.has(tokens[index] ?? "");
}

function bunReadOnly(tokens: string[]) {
  const first = tokens[1];
  if (first === "test") return true;
  if (first === "--version" || first === "-v") return true;
  if (first === "outdated") return true;
  // `bun pm ls` / `bun pm outdated` are the read-only dependency state.
  if (first === "pm") return READ_ONLY_PACKAGE_COMMANDS.has(tokens[2] ?? "");
  if (first !== "run") return false;
  let index = 2;
  while (tokens[index]?.startsWith("-")) index += 1;
  return SAFE_PACKAGE_SCRIPTS.has(tokens[index] ?? "");
}

function findReadOnly(tokens: string[]) {
  return !hasFlag(
    tokens,
    "-delete",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-fls",
    "-fprint",
    "-fprint0",
    "-fprintf",
  );
}

function formatterReadOnly(tokens: string[]) {
  return !hasFlag(tokens, "--write", "-w", "--fix", "--fix-only");
}

function tscReadOnly(tokens: string[]) {
  return hasFlag(tokens, "--noEmit");
}

function goReadOnly(tokens: string[]) {
  return ["env", "list", "test", "vet"].includes(tokens[1] ?? "");
}

function cargoReadOnly(tokens: string[]) {
  return ["check", "clippy", "metadata", "test"].includes(tokens[1] ?? "");
}

function denoReadOnly(tokens: string[]) {
  return ["check", "lint", "test"].includes(tokens[1] ?? "");
}

function pythonReadOnly(tokens: string[]) {
  if (tokens[1] !== "-m") return false;
  return ["mypy", "pytest", "ruff", "unittest"].includes(tokens[2] ?? "");
}

export async function niaShellPolicyDenial(
  command: string,
  who: "Nia" | "Navi" = "Nia",
): Promise<string | undefined> {
  // The monorepo's per-package shape (`cd packages/x && bun test`) is a
  // compound command, and a compound is otherwise refused wholesale —
  // which would block the ONE verification style this workspace lives
  // on. Strip a leading `cd <path> &&` and validate the REST with this
  // same policy: the second command is the actor, so it must pass
  // everything below (`cd packages/x && rm -rf y` still dies on the rm).
  const cdPrefix = /^\s*cd\s+("?[^\s&;|<>$`]+"?)\s*&&\s*/u.exec(command);
  if (cdPrefix)
    return niaShellPolicyDenial(command.slice(cdPrefix[0].length), who);
  const parsed = await parseBashSimpleCommand(command);
  let tokens: string[];
  if (parsed.ok) {
    tokens = parsed.command.tokens;
  } else {
    // Tree-sitter rejects some harmless numeric flag values (`git log -5`,
    // `find . -maxdepth 2`). Fall back to a conservative tokenizer only when
    // the command contains none of the shell metacharacters that make a
    // compound or redirecting command possible.
    if (unsafeShellSyntax(command))
      return `${who} shell is read-only and only supports one simple command: ${parsed.reason}`;
    tokens = shellTokens(command);
    if (!tokens.length)
      return `${who} shell is read-only and only supports one simple command: ${parsed.reason}`;
  }
  const executable = executableName(tokens[0]);
  if (!executable) return `${who} shell command is empty`;

  if (executable === "git") {
    return gitReadOnly(tokens)
      ? undefined
      : `${who} shell is read-only and cannot change git state`;
  }
  if (executable === "find")
    return findReadOnly(tokens)
      ? undefined
      : `${who} shell is read-only and find cannot execute or delete files`;
  if (executable === "rg" && hasFlagPrefix(tokens, "--pre"))
    return `${who} shell is read-only and rg cannot execute a preprocessor`;
  if (
    executable === "prettier" ||
    executable === "eslint" ||
    executable === "ruff"
  )
    return formatterReadOnly(tokens)
      ? undefined
      : `${who} shell is read-only and formatters may only check`;
  if (executable === "tsc")
    return tscReadOnly(tokens)
      ? undefined
      : `${who} shell is read-only; tsc must run with --noEmit`;
  if (executable === "bun") {
    return bunReadOnly(tokens)
      ? undefined
      : `${who} shell is read-only and only bun test/run typecheck|test|format is allowed`;
  }
  if (executable === "npm" || executable === "pnpm" || executable === "yarn") {
    return packageManagerReadOnly(tokens)
      ? undefined
      : `${who} shell is read-only and only test/typecheck/format scripts are allowed`;
  }
  if (executable === "go") {
    return goReadOnly(tokens)
      ? undefined
      : `${who} shell is read-only and only go test/vet/list/env are allowed`;
  }
  if (executable === "cargo") {
    return cargoReadOnly(tokens)
      ? undefined
      : `${who} shell is read-only and only cargo check/test/clippy/metadata are allowed`;
  }
  if (executable === "deno") {
    return denoReadOnly(tokens)
      ? undefined
      : `${who} shell is read-only and only deno check/lint/test are allowed`;
  }
  if (
    executable === "python" ||
    executable === "python3" ||
    executable === "pypy" ||
    executable === "pypy3"
  ) {
    return pythonReadOnly(tokens)
      ? undefined
      : `${who} shell is read-only; Python may only run mypy/pytest/ruff/unittest`;
  }
  if (executable === "curl") {
    return curlReadOnly(tokens)
      ? undefined
      : `${who} shell is read-only and curl may only issue GET/HEAD requests`;
  }
  if (SAFE_TEST_EXECUTABLES.has(executable)) return undefined;
  if (SAFE_EXECUTABLES.has(executable)) return undefined;
  return `${who} shell is read-only; command not allowed: ${executable}`;
}

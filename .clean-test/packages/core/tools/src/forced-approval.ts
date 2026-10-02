/**
 * Forced command approval policy.
 *
 * Some commands are always human-gated even when the session permission mode
 * is `auto`. The first policy of this kind is git write operations: they are
 * never granted for a session, and read-only mode still refuses them.
 */

import { visitBashCommands } from "./bash-command-policy";

const FORCED_GIT_SUBCOMMANDS = new Set([
  "commit",
  "push",
  "merge",
  "rebase",
  "reset",
  "cherry-pick",
  "revert",
  "clean",
]);

export type ForcedApproval = {
  ruleID: "C-REL-001";
  subcommand: string;
  reason: string;
};

function stripShellQuotes(value: string): string {
  // Wrapper commands often leave a quote attached to only one side of a word
  // (`bash -lc 'git commit'` makes the subcommand token `commit'`). Trim any
  // leading/trailing shell quote characters rather than requiring a balanced
  // pair so conservative detection still sees the subcommand.
  return value.replace(/^["'`]+|["'`]+$/gu, "");
}

function shellTokens(value: string): string[] {
  return value.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*')+/gu) ?? [];
}

function gitSubcommand(tokens: string[]): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = stripShellQuotes(tokens[index]!);
    if (
      token === "-C" ||
      token === "-c" ||
      token === "--git-dir" ||
      token === "--work-tree" ||
      token === "--namespace" ||
      token === "--exec-path"
    ) {
      index += 1;
      continue;
    }
    if (token.startsWith("--") && token.includes("=")) continue;
    if (token.startsWith("-")) continue;
    return token;
  }
  return undefined;
}

function isForcedGitSubcommand(
  subcommand: string | undefined,
  tokens: string[],
): boolean {
  if (!subcommand) return false;
  if (FORCED_GIT_SUBCOMMANDS.has(subcommand)) return true;
  if (subcommand === "branch") {
    const flags = tokens
      .slice(tokens.indexOf(subcommand) + 1)
      .map(stripShellQuotes);
    return (
      flags.includes("-D") ||
      (flags.includes("--delete") && flags.includes("--force"))
    );
  }
  if (subcommand === "tag") {
    const flags = tokens
      .slice(tokens.indexOf(subcommand) + 1)
      .map(stripShellQuotes);
    return !flags.includes("-l") && !flags.includes("--list");
  }
  return false;
}

/**
 * Detects git write operations that must always enter interactive approval.
 *
 * The detector is intentionally conservative: command obfuscation or a missed
 * compound form can only cause a false approval prompt, not an unapproved git
 * write, because the runtime also applies this to terminal input paths.
 */
export function requiresForcedGitApproval(
  commandText: string | undefined,
): ForcedApproval | undefined {
  if (!commandText) return undefined;
  const matcher = /\bgit(?:\.exe)?\b/giu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(commandText))) {
    const rest = commandText.slice(match.index + match[0].length);
    const tokens = shellTokens(rest);
    const subcommand = gitSubcommand(tokens);
    if (isForcedGitSubcommand(subcommand, tokens))
      return {
        ruleID: "C-REL-001",
        subcommand: subcommand!,
        reason: `git ${subcommand}`,
      };
  }
  return undefined;
}

/**
 * AST-level detector.
 *
 * The regex detector still handles the common cases cheaply. This pass walks
 * every Bash command node and also resolves simple aliases / variable
 * assignments, so forms such as:
 *
 *   alias g=git; g commit
 *   g=git; $g commit
 *   foo() { git commit; }
 *
 * cannot hide a git write behind a command name that never contains "git".
 */
export async function requiresForcedGitApprovalAst(
  commandText: string | undefined,
): Promise<ForcedApproval | undefined> {
  if (!commandText) return undefined;
  const direct = requiresForcedGitApproval(commandText);
  if (direct) return direct;

  const aliases = new Map<string, string>();
  const variables = new Map<string, string>();
  let result: ForcedApproval | undefined;

  await visitBashCommands(commandText, async (nodeText, nodeType) => {
    if (result) return;
    const nodeApproval = requiresForcedGitApproval(nodeText);
    if (nodeApproval) {
      result = nodeApproval;
      return;
    }
    const tokens = shellTokens(nodeText);
    if (!tokens.length) return;

    if (nodeType === "variable_assignment" && tokens.length === 1) {
      const [name, value] = splitAssignment(tokens[0]!);
      if (name && value) variables.set(name, value);
      return;
    }

    const first = stripShellQuotes(tokens[0]!);
    if (
      ["bash", "dash", "ksh", "sh", "zsh"].includes(first) &&
      tokens[1]?.startsWith("-") &&
      tokens[1].includes("c") &&
      tokens[2]
    ) {
      const approval = await requiresForcedGitApprovalAst(
        stripShellQuotes(tokens[2]),
      );
      if (approval) result = approval;
      return;
    }
    if (first === "eval" && tokens[1]) {
      const approval = await requiresForcedGitApprovalAst(
        tokens.slice(1).map(stripShellQuotes).join(" "),
      );
      if (approval) result = approval;
      return;
    }
    if (
      ["declare", "export", "local", "readonly", "typeset"].includes(first) &&
      tokens[1]
    ) {
      const [name, value] = splitAssignment(stripShellQuotes(tokens[1]));
      if (name && value) variables.set(name, value);
      return;
    }
    if (first === "alias") {
      for (const token of tokens.slice(1)) {
        const [name, value] = splitAssignment(token);
        if (!name || !value) continue;
        aliases.set(name, value);
        const approval = requiresForcedGitApproval(value);
        if (approval) {
          result = approval;
          return;
        }
      }
      return;
    }

    let commandIndex = 0;
    if (first === "command" || first === "builtin") commandIndex = 1;
    const target = stripShellQuotes(tokens[commandIndex] ?? "");
    const targetName = target.startsWith("$") ? target.slice(1) : target;
    const replacement = aliases.get(targetName) ?? variables.get(targetName);
    if (!replacement) return;
    const rest = tokens
      .slice(commandIndex + 1)
      .map(stripShellQuotes)
      .join(" ");
    const approval = requiresForcedGitApproval(
      rest ? `${replacement} ${rest}` : replacement,
    );
    if (approval) result = approval;
  });

  return result;
}

function splitAssignment(
  token: string,
): [string, string] | [undefined, undefined] {
  const equals = token.indexOf("=");
  if (equals <= 0) return [undefined, undefined];
  const name = stripShellQuotes(token.slice(0, equals));
  const value = stripShellQuotes(token.slice(equals + 1));
  if (!name || !value || name.startsWith("-")) return [undefined, undefined];
  return [name, value];
}

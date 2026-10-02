import { fileURLToPath } from "node:url";
import { Language, Parser, type Node } from "web-tree-sitter";

export type BashCommandRule = {
  command: string;
  reason?: string;
};

export type ParsedBashCommand = {
  tokens: string[];
};

export type BashCommandParseResult =
  | { ok: true; command: ParsedBashCommand }
  | { ok: false; reason: string };

let parserReady: Promise<Parser> | undefined;

export async function ensureBashCommandParser(): Promise<void> {
  await getParser();
}

export async function parseBashSimpleCommand(
  source: string,
): Promise<BashCommandParseResult> {
  const parser = await getParser();
  const tree = parser.parse(source);
  if (!tree) return { ok: false, reason: "Bash parser did not produce an AST" };
  try {
    const root = tree.rootNode;
    if (root.hasError)
      return {
        ok: false,
        reason: "Bash command contains incomplete or invalid syntax",
      };
    const statements = root.namedChildren.filter(isNode);
    if (statements.length !== 1 || statements[0]?.type !== "command")
      return {
        ok: false,
        reason: "only one simple Bash command is allowed",
      };
    const command = statements[0];
    if (!command) return { ok: false, reason: "Bash command is empty" };
    const parts = command.namedChildren.filter(isNode);
    const name = command.childForFieldName("name");
    if (!name || parts[0]?.type !== "command_name")
      return {
        ok: false,
        reason: "Bash command must start with a program name",
      };
    if (name.namedChildren.filter(isNode).length !== 1)
      return {
        ok: false,
        reason: "Bash command name contains unsupported syntax",
      };
    if (parts.some((part) => part !== parts[0] && part.type !== "word"))
      return {
        ok: false,
        reason: "Bash command contains unsupported syntax",
      };
    if (
      parts
        .slice(1)
        .some((part) => part.namedChildren.filter(isNode).length > 0)
    )
      return {
        ok: false,
        reason: "Bash command contains unsupported syntax",
      };
    const tokens = parts.map((part) => part.text);
    if (tokens.some((token) => token.length === 0))
      return { ok: false, reason: "Bash command contains an empty token" };
    return { ok: true, command: { tokens } };
  } finally {
    tree.delete();
  }
}

export async function parseBashCommandRule(
  rule: BashCommandRule,
): Promise<BashCommandParseResult> {
  return parseBashSimpleCommand(rule.command);
}

/**
 * Visits every command / variable-assignment node in a Bash script, including
 * nodes nested inside compound commands, functions, subshells, pipelines and
 * command substitutions. The callback receives the raw node text; callers can
 * tokenize it for policy checks without needing the tree to outlive the walk.
 */
export async function visitBashCommands(
  source: string,
  visit: (nodeText: string, nodeType: string) => void | Promise<void>,
): Promise<{ ok: boolean; reason?: string }> {
  const parser = await getParser();
  const tree = parser.parse(source);
  if (!tree) return { ok: false, reason: "Bash parser did not produce an AST" };
  try {
    const root = tree.rootNode;
    const walk = async (node: Node): Promise<void> => {
      if (node.type === "command" || node.type === "variable_assignment")
        await visit(node.text, node.type);
      for (const child of node.namedChildren.filter(isNode)) await walk(child);
    };
    await walk(root);
    return root.hasError
      ? { ok: false, reason: "Bash command contains invalid syntax" }
      : { ok: true };
  } finally {
    tree.delete();
  }
}

export function commandHasPrefix(
  command: ParsedBashCommand,
  prefix: ParsedBashCommand,
): boolean {
  return (
    prefix.tokens.length <= command.tokens.length &&
    prefix.tokens.every((token, index) => command.tokens[index] === token)
  );
}

async function getParser(): Promise<Parser> {
  parserReady ??= createParser();
  return parserReady;
}

async function createParser(): Promise<Parser> {
  await Parser.init();
  const grammar = await Language.load(
    fileURLToPath(
      import.meta.resolve(
        "@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm",
      ),
    ),
  );
  const parser = new Parser();
  parser.setLanguage(grammar);
  const selfCheck = parser.parse("command true");
  if (!selfCheck || selfCheck.rootNode.hasError) {
    selfCheck?.delete();
    parser.delete();
    throw new Error("Bash Tree-sitter grammar self-check failed");
  }
  selfCheck.delete();
  return parser;
}

function isNode(node: Node | null): node is Node {
  return node !== null;
}

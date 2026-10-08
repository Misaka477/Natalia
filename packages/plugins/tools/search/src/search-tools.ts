/**
 * The search tool family, as a separately packaged family.
 *
 * Depends on the framework only for the tool-authoring surface (`RuntimeTool`,
 * `ToolFamily`, the argument helpers) and knows nothing about the runtime, the
 * capability kernel or the host that loads it.
 */
import {
  globWorkspaceFilesBounded,
  grepWorkspaceFilesBounded,
  numberOr,
  optionalString,
  requireObject,
  requireString,
  type RuntimeTool,
  type ToolCard,
  type ToolFamily,
  type ToolOutputDefinition,
} from "@anthelia/tools";
import type { Plugin, PluginManifest } from "@anthelia/plugin";

export const SEARCH_PLUGIN_ID = "natalia-tool-search";

/**
 * The budget note, in words, when a scan spent its time budget. Pure and
 * exported so a test can drive it with a synthetic result — the tool-level
 * path cannot force the deadline (it is the scan's internal budget), and a
 * test that waits for a real one measures the machine, not the code.
 */
export function searchBudgetNote(input: {
  tool: "glob" | "grep";
  scannedFiles: number;
}): string {
  const remedy =
    input.tool === "glob"
      ? "narrow path/pattern"
      : "narrow path/include/pattern";
  return `the scan spent its time budget after ${input.scannedFiles} files; this page is complete and continuable — call again with nextCursor, or ${remedy}`;
}

type GlobFacts = {
  paths: string[];
  nextCursor?: string;
};

/** The glob envelope's facts, or an empty listing when it is not one. */
function globFacts(value: string): GlobFacts {
  try {
    const parsed = JSON.parse(value) as {
      paths?: unknown;
      nextCursor?: unknown;
    };
    const paths = Array.isArray(parsed.paths)
      ? parsed.paths.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    const nextCursor = optionalString(parsed.nextCursor);
    return nextCursor === undefined ? { paths } : { paths, nextCursor };
  } catch {
    return { paths: [] };
  }
}

/** The same facts back off the `meta` slot. */
function readGlobFacts(meta: Record<string, unknown>): GlobFacts {
  const paths = Array.isArray(meta.paths)
    ? meta.paths.filter((entry): entry is string => typeof entry === "string")
    : [];
  const nextCursor = optionalString(meta.nextCursor);
  return nextCursor === undefined ? { paths } : { paths, nextCursor };
}

type GrepFacts = {
  matches: Array<{ path: string; line: number; text: string }>;
  nextCursor?: string;
};

/** The grep envelope's facts, or an empty match list when it is not one. */
function grepFacts(value: string): GrepFacts {
  try {
    const parsed = JSON.parse(value) as {
      matches?: unknown;
      nextCursor?: unknown;
    };
    const matches = Array.isArray(parsed.matches)
      ? parsed.matches.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const record = entry as Record<string, unknown>;
          if (typeof record.path !== "string") return [];
          return [
            {
              path: record.path,
              line: typeof record.line === "number" ? record.line : 0,
              text: typeof record.text === "string" ? record.text : "",
            },
          ];
        })
      : [];
    const nextCursor = optionalString(parsed.nextCursor);
    return nextCursor === undefined ? { matches } : { matches, nextCursor };
  } catch {
    return { matches: [] };
  }
}

/** The same facts back off the `meta` slot. */
function readGrepFacts(meta: Record<string, unknown>): GrepFacts {
  const matches = Array.isArray(meta.matches)
    ? (meta.matches as unknown[]).flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as Record<string, unknown>;
        if (typeof record.path !== "string") return [];
        return [
          {
            path: record.path,
            line: typeof record.line === "number" ? record.line : 0,
            text: typeof record.text === "string" ? record.text : "",
          },
        ];
      })
    : [];
  const nextCursor = optionalString(meta.nextCursor);
  return nextCursor === undefined ? { matches } : { matches, nextCursor };
}

function globTool(): RuntimeTool {
  return {
    name: "glob",
    description:
      "List workspace files matching a Bun glob pattern. " +
      "First call: pass ONLY `pattern` (and optionally `path`/`limit`) — do NOT pass `cursor`. " +
      "The RESULT is JSON with `paths` (the matches), `truncated`, and possibly `nextCursor`. " +
      "`timedOut` means the scan spent its time budget before covering the tree (a very large workspace): the page is still complete and continuable — keep calling with `nextCursor`, or narrow `path`/`pattern`. " +
      "`nextCursor` is an OPAQUE token: if the result has one, call glob AGAIN with the SAME `pattern`/`path`/`limit` plus `cursor` set to that string VERBATIM, and repeat until the result has no `nextCursor`. " +
      "Never invent, truncate, or reconstruct a cursor, and never send result fields (`paths`, `truncated`) as arguments — they are outputs, not inputs.",
    requiresApproval: false,
    timeoutSec: 20,
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Bun glob pattern, e.g. '**/*.ts' or 'src/**/*.test.ts'. Required on every call, including continuation calls.",
        },
        path: {
          type: "string",
          description:
            "Optional workspace-relative directory to scope the search to. Omit to search the whole workspace.",
        },
        limit: {
          type: "number",
          description:
            "Optional page size (default 200). Keep it the same across continuation calls.",
        },
        cursor: {
          type: "string",
          description:
            "Opaque continuation token. OMIT on the first call. On later calls, copy the `nextCursor` string from the previous result VERBATIM — never construct, shorten, or guess one.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" } },
          truncated: { type: "boolean" },
          nextCursor: { type: "string" },
        },
        required: ["paths"],
        additionalProperties: false,
      },
      presentCall(args) {
        // dsh's spelling: the verb and the scope in the title, so the row
        // reads "Glob *.ts in src" rather than a bare pattern.
        const parsed = requireObject(args);
        const pattern = String(parsed.pattern ?? "");
        const where = optionalString(parsed.path);
        return {
          kind: "search",
          title: `Glob ${pattern}${where ? ` in ${where}` : ""}`,
          summary: "glob",
        };
      },
      presentationMeta(_args, value) {
        return globFacts(value) as Record<string, unknown>;
      },
      presentResult(args, value, meta) {
        // ONE parse (in presentationMeta): the paths and the cap travel as
        // the event's facts, and the card is composed from them. dsh's
        // SearchPathsResultView carries the PATHS THEMSELVES, not just a
        // count — a bare "3 matches" made the reader parse the result JSON
        // to learn WHICH three.
        const facts =
          meta === undefined ? globFacts(value) : readGlobFacts(meta);
        const count = facts.paths.length;
        const card: ToolCard = {
          kind: "search",
          title: requireObject(args).pattern as string,
          summary: count === 0 ? "no matches" : `${count} matches`,
          paths: facts.paths,
        };
        // A capped result must never read as a complete one: dsh's
        // SearchResultView carries `truncated` and `total` as separate
        // facts, so a UI can show "3 of 200" instead of a bare "3".
        if (facts.nextCursor !== undefined) {
          card.summary += " · more";
          card.truncated = true;
          card.nextCursor = facts.nextCursor;
          card.meta = [
            ["returned", String(count)],
            ["truncated", "true"],
          ];
        }
        if (count === 0) card.body = value;
        return card;
      },
    },
    async execute(input, context) {
      const args = requireObject(input);
      const pattern = requireString(args.pattern, "pattern");
      const result = await globWorkspaceFilesBounded({
        workspaceRoot: context.workspaceRoot,
        pattern,
        path: optionalString(args.path),
        limit: numberOr(args.limit, 200),
        cursor: optionalString(args.cursor),
        authorize: context.workspaceReadAuthorize
          ? (authorization) => context.workspaceReadAuthorize!(authorization)
          : undefined,
      });
      return JSON.stringify({
        paths: result.paths,
        truncated: result.truncated,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        scannedFiles: result.scannedFiles,
        scannedBytes: result.scannedBytes,
        // The budget that fired, in words. A bare `timedOut: true` told the
        // model a boolean and nothing else — and the model that cannot act on
        // a fact reports the same dead end the operator saw: "glob timed out",
        // over and over, when the result was a page like any other.
        ...(result.timedOut
          ? {
              timedOut: true,
              note: searchBudgetNote({
                tool: "glob",
                scannedFiles: result.scannedFiles,
              }),
            }
          : {}),
      });
    },
  };
}

function grepTool(): RuntimeTool {
  return {
    name: "grep",
    description:
      "Search UTF-8 workspace files with a regular expression. " +
      "First call: pass ONLY `pattern` (and optionally `path`/`include`/`limit`) — do NOT pass `cursor`. " +
      "The RESULT is JSON with `matches` (each with path/line/text) and possibly `nextCursor`. " +
      "`timedOut` means the scan spent its time budget before covering the tree (a very large workspace): the page is still complete and continuable — keep calling with `nextCursor`, or narrow `path`/`include`/`pattern`. " +
      "`nextCursor` is an OPAQUE token: if the result has one, call grep AGAIN with the SAME arguments plus `cursor` set to that string VERBATIM, and repeat until the result has no `nextCursor`. " +
      "Never invent, truncate, or reconstruct a cursor, and never send result fields (`matches`) as arguments — they are outputs, not inputs.",
    requiresApproval: false,
    timeoutSec: 20,
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Regular expression to search for. Required on every call, including continuation calls.",
        },
        path: {
          type: "string",
          description:
            "Optional workspace-relative directory to scope the search to. Omit to search the whole workspace.",
        },
        include: {
          type: "string",
          description:
            "Optional glob restricting which files are searched, e.g. '*.ts'. Keep it the same across continuation calls.",
        },
        limit: {
          type: "number",
          description:
            "Optional page size (default 200). Keep it the same across continuation calls.",
        },
        cursor: {
          type: "string",
          description:
            "Opaque continuation token. OMIT on the first call. On later calls, copy the `nextCursor` string from the previous result VERBATIM — never construct, shorten, or guess one.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          matches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                line: { type: "number" },
                text: { type: "string" },
              },
              required: ["path", "line", "text"],
              additionalProperties: false,
            },
          },
        },
        required: ["matches"],
        additionalProperties: false,
      },
      presentCall(args) {
        const parsed = requireObject(args);
        const pattern = String(parsed.pattern ?? "");
        const where = optionalString(parsed.path);
        const include = optionalString(parsed.include);
        return {
          kind: "search",
          title: `Grep ${pattern}${where ? ` in ${where}` : ""}${include ? ` (${include})` : ""}`,
          summary: "grep",
        };
      },
      presentationMeta(_args, value) {
        return grepFacts(value) as Record<string, unknown>;
      },
      presentResult(args, value, meta) {
        // ONE parse (in presentationMeta): the hits travel as the event's
        // facts — each with its path, line and text — and the card is
        // composed from them. A client groups them by file (the search
        // kind's own drawing, the way a diff kind colors its marks); the
        // model-facing JSON is never parsed a second time here.
        const facts =
          meta === undefined ? grepFacts(value) : readGrepFacts(meta);
        const count = facts.matches.length;
        const card: ToolCard = {
          kind: "search",
          title: requireObject(args).pattern as string,
          summary: count === 0 ? "no matches" : `${count} matches`,
          matches: facts.matches,
        };
        if (facts.nextCursor !== undefined) {
          card.summary += " · more";
          card.truncated = true;
          card.nextCursor = facts.nextCursor;
          // The same two facts as glob: the kept count and whether the cap
          // cut the rest.
          card.meta = [
            ["returned", String(count)],
            ["truncated", "true"],
          ];
        }
        if (count === 0) card.body = value;
        return card;
      },
    },
    async execute(input, context) {
      const args = requireObject(input);
      const pattern = requireString(args.pattern, "pattern");
      const result = await grepWorkspaceFilesBounded({
        workspaceRoot: context.workspaceRoot,
        pattern,
        ...(optionalString(args.path)
          ? { path: optionalString(args.path) }
          : {}),
        ...(optionalString(args.include)
          ? { include: optionalString(args.include) }
          : {}),
        ...(args.limit !== undefined
          ? { limit: numberOr(args.limit, 200) }
          : {}),
        ...(typeof args.cursor === "string" && args.cursor
          ? { cursor: args.cursor }
          : {}),
        signal: context.signal,
        authorize: async (authorizeInput) =>
          await context.workspaceReadAuthorize?.(authorizeInput),
      });
      // The same words for grep's budget as glob's: the two tools are one
      // family to the model, and a budget that fires on one and not the other
      // is a difference it has to learn twice.
      return JSON.stringify(
        result.timedOut
          ? {
              ...result,
              note: searchBudgetNote({
                tool: "grep",
                scannedFiles: result.scannedFiles,
              }),
            }
          : result,
      );
    },
  };
}

export const searchTools: RuntimeTool[] = [globTool(), grepTool()];

/**
 * Workspace scope: these tools only mean something inside the workspace they are
 * pointed at, and they read through the same workspace authorization the host
 * applies to file reads.
 */
export function searchToolFamily(): ToolFamily {
  return {
    id: "search",
    name: "Search Tools",
    version: "1.0.0",
    description: "Finding files by name and content in the workspace.",
    scope: "workspace",
    tools: searchTools,
  };
}

export const SEARCH_PLUGIN_MANIFEST: PluginManifest = {
  apiVersion: 2,
  id: SEARCH_PLUGIN_ID,
  version: "1.0.0",
  name: "Search Tools",
  description: "Finding files by name and content in the workspace.",
  entry: "index.js",
  scope: "workspace",
  provides: [],
  requires: [],
  optionalRequires: [],
  conflicts: [],
  dependencies: [],
  hooks: {},
  integrationPoints: ["tools"],
};

export function createSearchPlugin(): Plugin {
  return {
    manifest: SEARCH_PLUGIN_MANIFEST,
    setup(api) {
      for (const tool of searchTools) api.tools.register(tool);
    },
  };
}

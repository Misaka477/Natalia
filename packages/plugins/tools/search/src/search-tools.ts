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
  type ToolFamily,
} from "@anthelia/tools";
import type { Plugin, PluginManifest } from "@anthelia/plugin";

export const SEARCH_PLUGIN_ID = "natalia-tool-search";

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
        return {
          kind: "search",
          title: requireObject(args).pattern as string,
          summary: "glob",
        };
      },
      presentResult(args, value) {
        let summary = "glob";
        try {
          const parsed = JSON.parse(value) as {
            paths?: unknown[];
            nextCursor?: string;
          };
          const count = parsed.paths?.length ?? 0;
          summary = count === 0 ? "no matches" : `${count} matches`;
          if (parsed.nextCursor) summary += " · more";
        } catch {
          summary = "glob";
        }
        return {
          kind: "search",
          title: requireObject(args).pattern as string,
          summary,
          body: value,
        };
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
              note: `the scan spent its time budget after ${result.scannedFiles} files; this page is complete and continuable — call again with nextCursor, or narrow path/pattern`,
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
        return {
          kind: "search",
          title: requireObject(args).pattern as string,
          summary: "grep",
        };
      },
      presentResult(args, value) {
        let summary = "grep";
        try {
          const parsed = JSON.parse(value) as {
            matches?: unknown[];
            nextCursor?: string;
          };
          const count = parsed.matches?.length ?? 0;
          summary = count === 0 ? "no matches" : `${count} matches`;
          if (parsed.nextCursor) summary += " · more";
        } catch {
          summary = value === "no matches" ? "no matches" : "matches";
        }
        return {
          kind: "search",
          title: requireObject(args).pattern as string,
          summary,
          body: value,
        };
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
              note: `the scan spent its time budget after ${result.scannedFiles} files; this page is complete and continuable — call again with nextCursor, or narrow path/include/pattern`,
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

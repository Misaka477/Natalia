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
      "List workspace files matching a Bun glob pattern. Optionally scope the search to a workspace-relative directory with path. Results are paginated; if the response contains nextCursor, call glob again with the same pattern/path and that cursor until no nextCursor is returned.",
    requiresApproval: false,
    timeoutSec: 20,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        limit: { type: "number" },
        cursor: { type: "string" },
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
        ...(result.timedOut ? { timedOut: true } : {}),
      });
    },
  };
}

function grepTool(): RuntimeTool {
  return {
    name: "grep",
    description:
      "Search UTF-8 workspace files with a regular expression. Optionally scope the search to a workspace-relative directory with path. Results are paginated; if the response contains nextCursor, call grep again with the same pattern/path/include and that cursor until no nextCursor is returned.",
    requiresApproval: false,
    timeoutSec: 20,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        include: { type: "string" },
        limit: { type: "number" },
        cursor: { type: "string" },
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
      return JSON.stringify(result);
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

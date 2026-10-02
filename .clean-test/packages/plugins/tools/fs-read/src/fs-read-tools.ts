/**
 * The read-only filesystem tool family, split out of `tool-fs` by read/write
 * boundary (2026-08-21): these tools never write the workspace, need no write
 * lock and are `requiresApproval: false`. The write half lives in
 * `@natalia/plugin-tool-fs-write`.
 *
 * Depends on the framework only for the tool-authoring surface and knows
 * nothing about the runtime or the capability kernel.
 */
import {
  optionalInteger,
  requireObject,
  requireString,
  workspacePath,
  type RuntimeTool,
  type ToolFamily,
} from "@anthelia/tools";
import type { Plugin, PluginManifest } from "@anthelia/plugin";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";

export const FS_READ_PLUGIN_ID = "natalia-tool-fs-read";

function readFileTool(): RuntimeTool {
  return {
    name: "read_file",
    description:
      "Read a UTF-8 text file inside the workspace. Use offset (one-based line number) and length (line count) to read part of a file.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 1 },
        length: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    // The output definition: the tool declares what its call and result mean so
    // a client can draw a file card instead of guessing from the string.
    output: {
      schema: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
        additionalProperties: false,
      },
      presentCall(args) {
        const path = requireObject(args).path as string | undefined;
        return {
          kind: "read",
          title: typeof path === "string" ? path : "file",
          summary: "read",
        };
      },
      presentResult(args, value) {
        const path = requireObject(args).path as string | undefined;
        return {
          kind: "read",
          title: typeof path === "string" ? path : "file",
          summary: `${value.length.toLocaleString()} chars`,
          body: value,
        };
      },
    },
    async execute(input, context) {
      const args = requireObject(input);
      const path = workspacePath(
        context.workspaceRoot,
        requireString(args.path, "path"),
      );
      let content: string;
      try {
        content = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error(
            `read_file: file does not exist: ${relative(context.workspaceRoot, path)}`,
          );
        throw error;
      }
      if (args.offset === undefined && args.length === undefined)
        return content;

      const offset = optionalInteger(args.offset, "offset") ?? 1;
      const length = optionalInteger(args.length, "length");
      if (offset < 1) throw new Error("offset must be a positive integer");
      if (length !== undefined && length < 1)
        throw new Error("length must be a positive integer");

      const lines = content.endsWith("\n")
        ? content.slice(0, -1).replace(/\r$/u, "").split(/\r?\n/u)
        : content.split(/\r?\n/u);
      if (offset > lines.length)
        throw new Error(`read_file offset is out of range: ${offset}`);
      const end = Math.min(lines.length, offset - 1 + (length ?? lines.length));
      const page = lines.slice(offset - 1, end).join("\n");
      if (end === lines.length) return page;

      const remaining = lines.length - end;
      const next = end + 1;
      return `${page}\n\n... ${remaining} more line${remaining === 1 ? "" : "s"}; use offset=${next}${length === undefined ? "" : ` length=${length}`} ...`;
    },
  };
}

function readMediaFileTool(): RuntimeTool {
  return {
    name: "read_media_file",
    description:
      "Read binary/media file metadata inside the workspace without injecting raw bytes into context.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const path = workspacePath(
        context.workspaceRoot,
        requireString(requireObject(input).path, "path"),
      );
      let info: Awaited<ReturnType<typeof stat>>;
      let data: Buffer;
      try {
        info = await stat(path);
        data = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error(
            `read_media_file: file does not exist: ${relative(context.workspaceRoot, path)}`,
          );
        throw error;
      }
      return JSON.stringify(
        {
          path: relative(context.workspaceRoot, path),
          size: info.size,
          mode: info.mode.toString(8),
          sha256: createHash("sha256").update(data).digest("hex"),
          kind: mediaKind(data),
        },
        null,
        2,
      );
    },
  };
}

function mediaKind(data: Uint8Array) {
  const hex = [...data.slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (hex.startsWith("89504e47")) return "png";
  if (hex.startsWith("ffd8ff")) return "jpeg";
  if (hex.startsWith("47494638")) return "gif";
  return "binary";
}

export function imageReadTool(): RuntimeTool {
  return {
    name: "image_read",
    description:
      "Attach an image file inside the workspace to the conversation so the model can see it — e.g. a screenshot of a rendered page. The selected model must support image input.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(input, context) {
      if (!context.attachImage)
        throw new Error(
          "image attachment is unavailable in this context; the selected provider or host does not support image input",
        );
      const args = requireObject(input);
      const path = workspacePath(
        context.workspaceRoot,
        requireString(args.path, "path"),
      );
      try {
        await context.attachImage(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error(
            `image_read: file does not exist: ${relative(context.workspaceRoot, path)}`,
          );
        throw error;
      }
      return `image attached: ${path}`;
    },
  };
}

export const readFileTools: RuntimeTool[] = [
  readFileTool(),
  readMediaFileTool(),
  imageReadTool(),
];

/**
 * Workspace scope: these tools only mean something inside the workspace they are
 * pointed at, and they read through the host's workspace read authorization.
 */
export function fsReadToolFamily(): ToolFamily {
  return {
    id: "fs-read",
    name: "Filesystem Read Tools",
    version: "1.0.0",
    description: "Reading workspace files and media metadata.",
    scope: "workspace",
    tools: readFileTools,
  };
}

export const FS_READ_PLUGIN_MANIFEST: PluginManifest = {
  apiVersion: 2,
  id: FS_READ_PLUGIN_ID,
  version: "1.0.0",
  name: "Filesystem Read Tools",
  description: "Reading workspace files and media metadata.",
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

export function createFsReadPlugin(): Plugin {
  return {
    manifest: FS_READ_PLUGIN_MANIFEST,
    setup(api) {
      for (const tool of readFileTools) api.tools.register(tool);
    },
  };
}

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

/**
 * Default and maximum number of lines one `read_file` call returns. The
 * reference is dsh's `read` (`devref/deepseek-harness/packages/fs/tool-fs/
 * src/read.ts`, `READ_LIMIT = 2000`): a read without a window is still a
 * window, because the alternative is a 500MB file entering the context as
 * one result and the model never asking for a second page.
 */
export const READ_LINE_LIMIT = 2000;

function readFileTool(): RuntimeTool {
  return {
    name: "read_file",
    description: `Read a UTF-8 text file inside the workspace. Returns at most ${READ_LINE_LIMIT} lines per call; the result says how many lines exist and, when it stopped early, the offset to continue from.`,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path of an existing regular file, relative to the workspace or absolute inside it.",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description:
            "1-based first line to return. Defaults to 1; the result names the next offset when the window stops early.",
        },
        length: {
          type: "integer",
          minimum: 1,
          description: `Page size in lines (default ${READ_LINE_LIMIT}, the maximum). A smaller page reads a slice; the result says how many lines exist in total.`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    // The output definition: the tool declares what its call and result mean so
    // a client can draw a file card instead of guessing from the string.
    output: {
      schema: {
        type: "object",
        properties: {
          content: { type: "string" },
          totalLines: { type: "integer" },
          truncated: { type: "boolean" },
        },
        required: ["content", "totalLines", "truncated"],
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
        // `value` is the tool's raw result — JSON text, the shape the kernel's
        // string-returning contract carries (glob and grep do the same). The
        // parse is DEFENSIVE: a rendering path must never be the reason a
        // call fails. Measured on CI: a caller handed this a value that was
        // not the envelope (an error string), JSON.parse threw, and the tool
        // reported "JSON Parse error: Unterminated string" as its RESULT —
        // the card's problem became the read's failure.
        let parsed: {
          content?: string;
          totalLines?: number;
          truncated?: boolean;
        } | null = null;
        try {
          parsed = JSON.parse(value) as {
            content?: string;
            totalLines?: number;
            truncated?: boolean;
          } | null;
        } catch {
          parsed = null;
        }
        const content =
          typeof parsed?.content === "string" ? parsed.content : value;
        const totalLines =
          typeof parsed?.totalLines === "number" ? parsed.totalLines : null;
        const truncated = parsed?.truncated === true;
        // The window, named from the SAME numbers the footer uses, so the
        // card and the text can never disagree: `offset` is where this page
        // starts (arguments, available while the call runs) and the page's
        // own line count closes the range. A reader sees "lines 2-3 of 5" —
        // the window read, not a char count that presents a capped page as
        // the whole file.
        const offset = optionalInteger(
          (requireObject(args) as { offset?: unknown }).offset,
          "offset",
        );
        const pageLines = content.split("\n").length;
        const window =
          offset !== undefined && totalLines !== null
            ? `lines ${offset}-${offset + pageLines - 1} of ${totalLines}`
            : totalLines === null
              ? "read"
              : `${totalLines} lines`;
        return {
          kind: "read",
          title: typeof path === "string" ? path : "file",
          summary: window,
          // The window facts ride as card facets too, so a UI without a
          // read-specific card still shows them.
          meta: [
            ...(totalLines === null
              ? []
              : ([["totalLines", String(totalLines)]] as Array<
                  [string, string]
                >)),
            ...(truncated
              ? ([["truncated", "true"]] as Array<[string, string]>)
              : []),
          ],
          body: content,
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
      const lines = content.endsWith("\n")
        ? content.slice(0, -1).replace(/\r$/u, "").split(/\r?\n/u)
        : content.split(/\r?\n/u);
      const totalLines = lines.length;

      // NO WINDOW IS A WINDOW. Before this, `read_file` with no arguments
      // returned the whole file: the only tool in the registry that could put
      // an unbounded number of bytes into the context in one call, in a repo
      // whose other readers (terminal, glob, grep, mailbox) all page. The
      // default is the same window an explicit read gets.
      const offset = optionalInteger(args.offset, "offset") ?? 1;
      const length = Math.min(
        optionalInteger(args.length, "length") ?? READ_LINE_LIMIT,
        READ_LINE_LIMIT,
      );
      if (offset < 1) throw new Error("offset must be a positive integer");
      if (length < 1) throw new Error("length must be a positive integer");
      if (offset > totalLines)
        throw new Error(`read_file offset is out of range: ${offset}`);

      const end = Math.min(totalLines, offset - 1 + length);
      const page = lines.slice(offset - 1, end).join("\n");
      // The kernel's tool contract returns the model-facing STRING; the
      // window facts ride as JSON text, the shape glob and grep already use
      // (`search-tools.ts`). The model reads `content` (with its footer);
      // a client reads the rest.
      //
      // The footer is the three-state form dsh's read uses, because a MODEL
      // reads it and a page it cannot resume is a page it must guess at:
      //   capped by this call's window  -> "Showing lines A-B of N", with the
      //     next offset named, so the next call needs no arithmetic;
      //   the window reached the end     -> "End of file - total N lines", so
      //     the model knows NOT to ask again;
      //   the window is empty (a byte or line cap below the first selected
      //     line) -> the start line is still named, so a continuation knows
      //     where to resume from.
      // The card's `totalLines`/`truncated` come from the same two numbers, so
      // the text and the UI can never disagree about the window.
      if (end === totalLines)
        return JSON.stringify({
          content: `${page}\n\n(End of file - total ${totalLines} lines)`,
          totalLines,
          truncated: false,
        });

      const next = end + 1;
      return JSON.stringify({
        content: `${page}\n\n(Showing lines ${offset}-${end} of ${totalLines}. Use offset=${next} to continue.)`,
        totalLines,
        truncated: true,
      });
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
    output: {
      schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          size: { type: "integer" },
          sha256: { type: "string" },
        },
        required: ["path", "size", "sha256"],
        additionalProperties: false,
      },
      presentCall(args) {
        return {
          kind: "read",
          title: requireObject(args).path as string,
          summary: "read media metadata",
        };
      },
      presentResult(args, value) {
        // The metadata IS the read: a card that shows the raw JSON text makes a
        // reader parse five quoted keys to learn the size and the digest. The
        // same envelope the model reads is decoded here into facets.
        let parsed: {
          path?: string;
          size?: number;
          mode?: string;
          sha256?: string;
          kind?: string;
        } | null = null;
        try {
          parsed = JSON.parse(value) as typeof parsed;
        } catch {
          parsed = null;
        }
        if (!parsed) {
          return {
            kind: "read",
            title: requireObject(args).path as string,
            summary: "read media metadata",
            body: value,
          };
        }
        return {
          kind: "read",
          title: parsed.path ?? (requireObject(args).path as string),
          summary: parsed.kind
            ? `${parsed.kind} · ${parsed.size} bytes`
            : "media",
          body: [
            `path:   ${parsed.path ?? ""}`,
            `size:   ${parsed.size ?? ""} bytes`,
            `mode:   ${parsed.mode ?? ""}`,
            `sha256: ${parsed.sha256 ?? ""}`,
          ].join("\n"),
          meta: [
            ["size", String(parsed.size ?? "")],
            ["kind", parsed.kind ?? ""],
          ],
        };
      },
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
    output: {
      schema: {
        type: "object",
        properties: { attached: { type: "string" } },
        required: ["attached"],
        additionalProperties: false,
      },
      presentCall(args) {
        return {
          kind: "read",
          title: requireObject(args).path as string,
          summary: "attach image",
        };
      },
      presentResult(args, value) {
        // "What the model read" for this tool is WHICH image entered its
        // context. The card says the file; the result sentence rides as a facet
        // so a reader does not have to decode `image attached: <path>`.
        return {
          kind: "read",
          title: requireObject(args).path as string,
          summary: "image attached",
          meta: [["result", value]],
        };
      },
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

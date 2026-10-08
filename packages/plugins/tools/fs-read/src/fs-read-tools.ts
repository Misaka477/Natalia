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
  optionalString,
  requireObject,
  requireString,
  workspacePath,
  type RuntimeTool,
  type ToolCard,
  type ToolFamily,
  type ToolOutputDefinition,
} from "@anthelia/tools";
import type { Plugin, PluginManifest } from "@anthelia/plugin";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";

export const FS_READ_PLUGIN_ID = "natalia-tool-fs-read";

/**
 * Default and maximum number of lines one `read_file` call returns. The
 * reference is the `read` tool (the reference checkout's fs/tool-fs/
 * src/read.ts`, `READ_LIMIT = 2000`): a read without a window is still a
 * window, because the alternative is a 500MB file entering the context as
 * one result and the model never asking for a second page.
 */
export const READ_LINE_LIMIT = 2000;

/**
 * The `read_media_file` result envelope: the four facets the model-facing
 * JSON carries, plus the detected media kind.
 */
type MediaFacts = {
  path?: string;
  size?: number;
  mode?: string;
  sha256?: string;
  kind?: string;
};

/** The envelope's facts, or `{}` when the value is not one (defensive). */
function mediaFacts(value: string): MediaFacts {
  try {
    const decoded = JSON.parse(value) as MediaFacts | null;
    return decoded && typeof decoded === "object" ? decoded : {};
  } catch {
    return {};
  }
}

/** The same facts back off the `meta` slot. */
function readMediaFacts(meta: Record<string, unknown>): MediaFacts {
  const facts: MediaFacts = {};
  const path = optionalString(meta.path);
  if (path !== undefined) facts.path = path;
  if (typeof meta.size === "number") facts.size = meta.size;
  const mode = optionalString(meta.mode);
  if (mode !== undefined) facts.mode = mode;
  const sha256 = optionalString(meta.sha256);
  if (sha256 !== undefined) facts.sha256 = sha256;
  const kind = optionalString(meta.kind);
  if (kind !== undefined) facts.kind = kind;
  return facts;
}

/** The arguments as a record — a presenter must never throw. */
function argsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

/** The language hint a path implies, for a content renderer. */
function langOf(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ext.length > 0 && ext.length <= 12 ? ext : undefined;
}

/**
 * `read_file`'s output definition (R2): the read card, fully structured.
 *
 * ONE parse, in `presentationMeta`: the window facts the result envelope
 * carries are decoded once and travel the event's `meta` slot; the card is
 * composed from them — the page itself rides as the card's `content` field,
 * the file's own lines, which a client renders without flattening them (the
 * 2026-10-07 verdict: a JSON file read as `key: value` lines was the
 * flatten's doing, and it is exactly what this card ends).
 */
type ReadWindowFacts = {
  path: string;
  offset?: number;
  totalLines?: number;
  truncated?: boolean;
  /** The window's own lines, each keeping the file's line number. */
  lines?: Array<{ number: number; text: string }>;
};

/** The window's numbered lines, from the page text and the read's offset. */
function numberedLines(
  content: string,
  offset: number | undefined,
): Array<{ number: number; text: string }> {
  const start = offset ?? 1;
  return content.split("\n").map((text, index) => ({
    number: start + index,
    text,
  }));
}

/** The window facts, from the arguments and the result envelope. */
function readWindowFacts(args: unknown, value: string): ReadWindowFacts {
  const record = argsRecord(args);
  const facts: ReadWindowFacts = {
    path: optionalString(record.path) ?? "file",
  };
  const offset = optionalInteger(record.offset, "offset");
  if (offset !== undefined) facts.offset = offset;
  const parsed = parseReadEnvelope(value);
  if (typeof parsed?.totalLines === "number")
    facts.totalLines = parsed.totalLines;
  if (parsed?.truncated === true) facts.truncated = true;
  if (typeof parsed?.content === "string")
    facts.lines = numberedLines(parsed.content, offset);
  return facts;
}

/** The same facts back off the `meta` slot. */
function readWindowFromMeta(meta: Record<string, unknown>): ReadWindowFacts {
  const facts: ReadWindowFacts = {
    path: optionalString(meta.path) ?? "file",
  };
  if (typeof meta.offset === "number") facts.offset = meta.offset;
  if (typeof meta.totalLines === "number") facts.totalLines = meta.totalLines;
  if (meta.truncated === true) facts.truncated = true;
  if (Array.isArray(meta.lines))
    facts.lines = meta.lines as ReadWindowFacts["lines"];
  return facts;
}

/** The result envelope, or null when the value is not one (defensive). */
function parseReadEnvelope(
  value: string,
): { content?: unknown; totalLines?: unknown; truncated?: unknown } | null {
  try {
    const decoded = JSON.parse(value) as {
      content?: unknown;
      totalLines?: unknown;
      truncated?: unknown;
    } | null;
    return decoded && typeof decoded === "object" ? decoded : null;
  } catch {
    return null;
  }
}

function readFileOutput(): ToolOutputDefinition {
  return {
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
      const path = optionalString(argsRecord(args).path);
      return {
        kind: "read",
        title: path ?? "file",
        summary: "read",
      };
    },
    presentationMeta(args, value) {
      return readWindowFacts(args, value) as Record<string, unknown>;
    },
    presentResult(args, value, meta) {
      // The window facts come from the `meta` slot the runtime just filled
      // — one decode, not a second parse. The PAGE is the one thing that
      // reads `value`: it IS the text, and a read's content rides on the
      // card rather than duplicating it into meta.
      const facts =
        meta === undefined
          ? readWindowFacts(args, value)
          : readWindowFromMeta(meta);
      const parsed = parseReadEnvelope(value);
      const content =
        typeof parsed?.content === "string" ? parsed.content : value;
      const { path, offset, totalLines, truncated } = facts;
      const numbered = facts.lines ?? numberedLines(content, offset);
      const pageLines = numbered.length;
      // The window, named from the SAME numbers the footer uses, so the card
      // and the text can never disagree: `offset` is where this page starts
      // (an argument, available while the call runs) and the page's own line
      // count closes the range. A reader sees "lines 2-3 of 5" — the window
      // read, not a char count that presents a capped page as the whole
      // file.
      const window =
        offset !== undefined && totalLines !== undefined
          ? `lines ${offset}-${offset + pageLines - 1} of ${totalLines}`
          : totalLines === undefined
            ? "read"
            : `${totalLines} lines`;
      return {
        kind: "read",
        title: path,
        summary: window,
        // The page is the file's own text; the window facts are the
        // structured fields a renderer reads. The facets stay for a UI
        // without a read-specific card.
        content,
        ...(offset === undefined ? {} : { offset }),
        ...(totalLines === undefined ? {} : { totalLines }),
        // The window's own lines, numbered by the file — the shape a client
        // renders a gutter from (the reference implementation's read card).
        lines: numbered,
        ...(truncated ? { truncated } : {}),
        lang: langOf(path),
        meta: [
          ...(totalLines === undefined
            ? []
            : ([["totalLines", String(totalLines)]] as Array<
                [string, string]
              >)),
          ...(truncated
            ? ([["truncated", "true"]] as Array<[string, string]>)
            : []),
        ],
      };
    },
  };
}

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
    // The output definition: the tool declares what its call and result mean
    // so a client can draw a file card instead of guessing from the string.
    output: readFileOutput(),
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
      // The footer is the three-state form the read uses, because a MODEL
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
      presentationMeta(_args, value) {
        return mediaFacts(value) as Record<string, unknown>;
      },
      presentResult(args, value, meta) {
        // The metadata IS the read: a card that shows the raw JSON text makes a
        // reader parse five quoted keys to learn the size and the digest. The
        // same envelope the model reads is decoded ONCE (in presentationMeta)
        // into the facts the card is composed from.
        const parsed = mediaFacts(value);
        const facts = meta === undefined ? parsed : readMediaFacts(meta);
        if (Object.keys(facts).length === 0) {
          return {
            kind: "read",
            title: optionalString(argsRecord(args).path) ?? "file",
            summary: "read media metadata",
            body: value,
          };
        }
        return {
          kind: "read",
          title: facts.path ?? optionalString(argsRecord(args).path) ?? "file",
          summary: facts.kind ? `${facts.kind} · ${facts.size} bytes` : "media",
          body: [
            `path:   ${facts.path ?? ""}`,
            `size:   ${facts.size ?? ""} bytes`,
            `mode:   ${facts.mode ?? ""}`,
            `sha256: ${facts.sha256 ?? ""}`,
          ].join("\n"),
          meta: [
            ["size", String(facts.size ?? "")],
            ["kind", facts.kind ?? ""],
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

/**
 * What the file's bytes are, for the metadata read.
 *
 * The user's 2026-10-07 correction: a plain `.txt` answered `binary`, which
 * reads as a MIME claim ("this file is binary data") when the truth is only
 * "this read did not inject the bytes". A file that decodes as text is TEXT —
 * the name must say what the bytes are, so:
 *   - the three image magics name themselves;
 *   - a NUL-free UTF-8-decodable file is "text" (what a .txt/.json/.md is);
 *   - everything else is "binary", and only that means binary.
 */
function mediaKind(data: Uint8Array) {
  const hex = [...data.slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (hex.startsWith("89504e47")) return "png";
  if (hex.startsWith("ffd8ff")) return "jpeg";
  if (hex.startsWith("47494638")) return "gif";
  const head = data.slice(0, 4096);
  if (head.length > 0 && !head.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(head);
      return "text";
    } catch {
      // Not valid UTF-8: fall through to binary.
    }
  }
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

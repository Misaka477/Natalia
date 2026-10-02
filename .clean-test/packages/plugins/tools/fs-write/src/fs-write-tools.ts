/**
 * The write filesystem tool family, split out of `tool-fs` by read/write
 * boundary (2026-08-21): these tools write the workspace, take the write lock,
 * are `requiresApproval: true` and carry the write-path permission rules. The
 * read half lives in `@natalia/plugin-tool-fs-read`.
 *
 * Depends on the framework only for the tool-authoring surface and knows
 * nothing about the runtime or the capability kernel.
 */
import {
  requireObject,
  requireString,
  workspacePath,
  type RuntimeTool,
  type ToolFamily,
} from "@anthelia/tools";
import type { Plugin, PluginManifest } from "@anthelia/plugin";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";

export const FS_WRITE_PLUGIN_ID = "natalia-tool-fs-write";
export const APPLY_EDIT_OPERATIONS = ["replace", "create", "delete"] as const;

function writeFileTool(): RuntimeTool {
  return {
    name: "write_file",
    description:
      "Write UTF-8 text inside the workspace. Creates parent directories as needed and overwrites existing content; use edit_file or apply_edits for surgical changes.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        mode: { type: "number" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      presentCall(args) {
        return {
          kind: "generic",
          title: requireObject(args).path as string,
          summary: "write",
        };
      },
      presentResult(args, value) {
        return {
          kind: "generic",
          title: requireObject(args).path as string,
          summary: value,
        };
      },
    },
    async execute(input, context) {
      const args = requireObject(input);
      const path = workspacePath(
        context.workspaceRoot,
        requireString(args.path, "path"),
      );
      await context.workspaceWriteAuthorize?.({
        toolName: "write_file",
        path,
      });
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, requireString(args.content, "content"));
      if (typeof args.mode === "number") await chmod(path, args.mode);
      return `wrote ${relative(context.workspaceRoot, path)}`;
    },
  };
}

function editFileTool(): RuntimeTool {
  return {
    name: "edit_file",
    description:
      "Replace exact text inside a UTF-8 workspace file. oldText must occur exactly once; if it appears multiple times, include more surrounding context or use write_file/apply_edits.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      presentCall(args) {
        return {
          kind: "diff",
          title: requireObject(args).path as string,
          summary: "edit",
        };
      },
      presentResult(args, value) {
        return {
          kind: "diff",
          title: requireObject(args).path as string,
          summary: value,
        };
      },
    },
    async execute(input, context) {
      const args = requireObject(input);
      const path = workspacePath(
        context.workspaceRoot,
        requireString(args.path, "path"),
      );
      await context.workspaceWriteAuthorize?.({
        toolName: "edit_file",
        path,
      });
      const oldText = requireString(args.oldText, "oldText");
      let current: string;
      try {
        current = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error(`edit_file: file does not exist: ${args.path}`);
        throw error;
      }
      const count = countOccurrences(current, oldText);
      if (count === 0)
        throw new Error(`edit_file: oldText not found in ${args.path}`);
      if (count > 1)
        throw new Error(
          `edit_file: oldText is ambiguous (${count} occurrences) in ${args.path}; include more context or use write_file`,
        );
      const next = current.replace(
        oldText,
        requireString(args.newText, "newText"),
      );
      await writeFile(path, next);
      return `edited ${relative(context.workspaceRoot, path)}`;
    },
  };
}

function applyEditsTool(): RuntimeTool {
  return {
    name: "apply_edits",
    description:
      "Apply a batch of precise text replacements across workspace files atomically. " +
      "Use it to make several coordinated edits in one call instead of many separate " +
      "edit_file calls. Every match is verified before anything is written, so a bad " +
      "edit changes nothing.\n\n" +
      "Example:\n\n" +
      "{\n" +
      '  "edits": [\n' +
      '    { "path": "src/main.rs", "operation": "replace", "oldText": "let y = 2;", "newText": "let y = 3;" },\n' +
      '    { "path": "src/new.ts", "operation": "create", "newText": "export const x = 1;\\n" },\n' +
      '    { "path": "src/old.ts", "operation": "delete" }\n' +
      "  ]\n" +
      "}\n\n" +
      "Operations:\n" +
      "1. replace: oldText must occur exactly once in the target file.\n" +
      "2. create: the file must not already exist.\n" +
      "3. delete: the file must already exist.\n\n" +
      "Do not use unified diff or Markdown code fences. This is the model-facing batch editor.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              operation: {
                type: "string",
                enum: [...APPLY_EDIT_OPERATIONS],
              },
              oldText: { type: "string" },
              newText: { type: "string" },
            },
            required: ["path", "operation"],
            additionalProperties: false,
          },
        },
      },
      required: ["edits"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { files: { type: "array", items: { type: "string" } } },
        required: ["files"],
        additionalProperties: false,
      },
      presentCall() {
        return { kind: "diff", title: "workspace", summary: "apply edits" };
      },
      presentResult(_args, value) {
        return { kind: "diff", title: "workspace", summary: value };
      },
    },
    async execute(input, context) {
      const args = requireObject(input);
      if (!Array.isArray(args.edits) || args.edits.length === 0)
        throw new Error("apply_edits requires a non-empty edits array");
      const edits = args.edits.map((entry, index) => {
        const edit = requireObject(entry);
        const path = requireString(edit.path, `edits[${index}].path`);
        const operation = requireString(
          edit.operation,
          `edits[${index}].operation`,
        );
        if (
          operation !== "replace" &&
          operation !== "create" &&
          operation !== "delete"
        )
          throw new Error(
            `apply_edits: edits[${index}].operation must be replace, create, or delete`,
          );
        return {
          path,
          operation,
          oldText:
            edit.oldText === undefined
              ? undefined
              : requireString(edit.oldText, `edits[${index}].oldText`),
          newText:
            edit.newText === undefined
              ? undefined
              : requireString(edit.newText, `edits[${index}].newText`),
        } as {
          path: string;
          operation: "replace" | "create" | "delete";
          oldText?: string;
          newText?: string;
        };
      });

      // Phase 1: authorize every touched path and compute every final file
      // content in memory. A mismatch anywhere aborts here, before any file is
      // written.
      const order: string[] = [];
      const editCounts = new Map<string, number>();
      const states = new Map<
        string,
        {
          original: string | undefined;
          content: string | undefined;
          deleted: boolean;
        }
      >();
      for (const edit of edits) {
        const abs = workspacePath(context.workspaceRoot, edit.path);
        editCounts.set(abs, (editCounts.get(abs) ?? 0) + 1);
        await context.workspaceWriteAuthorize?.({
          toolName: "apply_edits",
          path: abs,
        });
        if (!states.has(abs)) {
          let original: string | undefined;
          try {
            original = await readFile(abs, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          states.set(abs, {
            original,
            content: original,
            deleted: false,
          });
          order.push(abs);
        }
        const state = states.get(abs)!;
        if (edit.operation === "replace") {
          if (state.deleted || state.content === undefined)
            throw new Error(`apply_edits: file does not exist: ${edit.path}`);
          const oldText = edit.oldText;
          if (!oldText)
            throw new Error(
              `apply_edits: replace requires non-empty oldText for ${edit.path}`,
            );
          const count = countOccurrences(state.content, oldText);
          if (count === 0)
            throw new Error(`apply_edits: oldText not found in ${edit.path}`);
          if (count > 1)
            throw new Error(
              `apply_edits: oldText is ambiguous (${count} occurrences) in ${edit.path}; include more context or use write_file`,
            );
          state.content = state.content.replace(oldText, edit.newText ?? "");
        } else if (edit.operation === "create") {
          if (state.content !== undefined || state.deleted)
            throw new Error(`apply_edits: file already exists: ${edit.path}`);
          state.content = edit.newText ?? "";
        } else {
          if (state.content === undefined || state.deleted)
            throw new Error(`apply_edits: file does not exist: ${edit.path}`);
          state.content = undefined;
          state.deleted = true;
        }
      }

      type PreparedEdit = {
        path: string;
        abs: string;
        kind: "write" | "delete";
        next?: string;
        original?: string | undefined;
      };
      const prepared: PreparedEdit[] = order.flatMap<PreparedEdit>((abs) => {
        const state = states.get(abs)!;
        if (state.deleted)
          return [
            {
              path: relative(context.workspaceRoot, abs),
              abs,
              kind: "delete" as const,
              original: state.original,
            },
          ];
        if (state.content === undefined) return [];
        return [
          {
            path: relative(context.workspaceRoot, abs),
            abs,
            kind: "write" as const,
            next: state.content,
            original: state.original,
          },
        ];
      });

      // Phase 2: write/delete the changed paths. On a mid-write failure,
      // restore the files already changed so a batch is all-or-nothing on disk.
      const written: PreparedEdit[] = [];
      try {
        for (const entry of prepared) {
          if (entry.kind === "write") {
            if (entry.original === entry.next) continue;
            await mkdir(dirname(entry.abs), { recursive: true });
            await writeFile(entry.abs, entry.next!);
            written.push(entry);
          } else {
            await rm(entry.abs, { force: false });
            written.push(entry);
          }
        }
      } catch (error) {
        for (const entry of [...prepared].reverse()) {
          try {
            if (entry.kind === "delete") {
              if (entry.original !== undefined)
                await writeFile(entry.abs, entry.original);
            } else if (entry.original === undefined) {
              await rm(entry.abs, { force: true });
            } else {
              await writeFile(entry.abs, entry.original);
            }
          } catch {
            // Best-effort rollback; report the original failure below.
          }
        }
        throw error;
      }

      const requested = edits.length;
      const requestedLabel = requested === 1 ? "edit" : "edits";
      if (!written.length)
        return `apply_edits: all ${requested} ${requestedLabel} applied; no file content changed.`;
      const changedLabel = written.length === 1 ? "file" : "files";
      const details = written
        .map((entry) => {
          const count = editCounts.get(entry.abs) ?? 0;
          return `- ${entry.path} (${count} ${count === 1 ? "edit" : "edits"})`;
        })
        .join("\n");
      return `apply_edits: all ${requested} ${requestedLabel} applied; ${written.length} ${changedLabel} changed.\n${details}`;
    },
  };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

export const writeFileTools: RuntimeTool[] = [
  writeFileTool(),
  editFileTool(),
  applyEditsTool(),
];

/**
 * Workspace scope: these tools only mean something inside the workspace they are
 * pointed at, and the host's write lock serialises their writes per workspace.
 */
export function fsWriteToolFamily(): ToolFamily {
  return {
    id: "fs-write",
    name: "Filesystem Write Tools",
    version: "1.0.0",
    description: "Writing and editing workspace files.",
    scope: "workspace",
    tools: writeFileTools,
  };
}

export const FS_WRITE_PLUGIN_MANIFEST: PluginManifest = {
  apiVersion: 2,
  id: FS_WRITE_PLUGIN_ID,
  version: "1.0.0",
  name: "Filesystem Write Tools",
  description: "Writing and editing workspace files.",
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

export function createFsWritePlugin(): Plugin {
  return {
    manifest: FS_WRITE_PLUGIN_MANIFEST,
    setup(api) {
      for (const tool of writeFileTools) api.tools.register(tool);
    },
  };
}

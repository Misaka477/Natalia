/**
 * The todo tool family, as a separately packaged family.
 *
 * This is the first built-in family to live outside `@anthelia/tools`, and it is
 * the proof of the shape the rest follow: it depends on the framework only for
 * the tool-authoring surface (`RuntimeTool`, `ToolFamily`, the argument helpers)
 * and knows nothing about the runtime, the capability kernel or the host that
 * loads it. The host composes families; the framework ships none.
 */
import {
  optionalInteger,
  requireObject,
  requireString,
  type RuntimeTool,
  type ToolFamily,
} from "@anthelia/tools";
import type { Plugin, PluginManifest } from "@anthelia/plugin";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  TODO_RESOURCE_NAME,
  TODO_STATUSES,
  TODO_UI_PLUGIN_ID,
  todoRelativePath,
  type TodoItem,
} from "./todo-item";

export const TODO_PLUGIN_ID = "natalia-tool-todo";

function todoReadTool(): RuntimeTool {
  return {
    name: "todo_read",
    description:
      "Read this session's durable todo items. Optionally bound the result with `limit`; the result reports how many items exist in total. " +
      "The answer is the todo envelope: an object {items, total, truncated} — `items` is the page, `total` is how many exist, `truncated` says whether the page was cut. It is NOT a bare array; todo_write takes the `items` array, not this envelope.",
    requiresApproval: false,
    parameters: {
      type: "object",
      // A bound like the other list-shaped readers carry (mailbox_status,
      // glob, grep): the whole list used to arrive in one result, and the
      // result says how many exist so a caller can ask for more.
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          description:
            "How many items to return in this page. The result says how many exist in total, so a caller can ask for the rest.",
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: [...TODO_STATUSES] },
              },
              required: ["content", "status"],
              additionalProperties: false,
            },
          },
          total: { type: "integer" },
          truncated: { type: "boolean" },
        },
        required: ["items", "total", "truncated"],
        additionalProperties: false,
      },
      presentCall() {
        return { kind: "generic", title: "todos", summary: "read" };
      },
      presentResult(_args, value) {
        const parsed = JSON.parse(value) as {
          items?: Array<{ status?: string; content?: string }>;
          total?: number;
          truncated?: boolean;
        };
        const items = parsed.items ?? [];
        const done = items.filter((item) => item.status === "completed").length;
        const summary = parsed.truncated
          ? `${items.length} of ${parsed.total} items · ${done} done`
          : `${items.length} items · ${done} done`;
        return {
          kind: "generic",
          title: "todos",
          summary,
          body: value,
        };
      },
    },
    async execute(input, context) {
      const limit = optionalInteger(requireObject(input).limit, "limit");
      const items = await readTodos(
        context.workspaceRoot,
        requireSessionID(context.sessionID),
      );
      // A cap like the other list readers, and the facts with it: the whole
      // list used to arrive in one result with nothing saying how long it was.
      const page = limit === undefined ? items : items.slice(0, limit);
      return JSON.stringify(
        {
          items: page,
          total: items.length,
          truncated: page.length < items.length,
        },
        null,
        2,
      );
    },
  };
}

function todoWriteTool(): RuntimeTool {
  return {
    name: "todo_write",
    description:
      "Replace this session's durable todo items. Takes an object {items} whose array is the complete replacement list (pass [] to clear); each item is {content,status}. " +
      "The answer is the same envelope todo_read returns — {items,total,truncated} — NOT {saved}: a read's envelope must never be passed back in; take its `items` array. Example: " +
      '{"items":[{"content":"Write the parser","status":"in_progress"},' +
      '{"content":"Add tests","status":"pending"}]}',
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description:
            "The complete replacement list. Pass [] to clear the list.",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "What the item is.",
              },
              status: {
                type: "string",
                enum: [...TODO_STATUSES],
                description: "pending, in_progress, or completed.",
              },
            },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      if (!Array.isArray(args.items)) throw new Error("items must be an array");
      const items = args.items.map((item) => {
        const value = requireObject(item);
        const status = requireString(value.status, "items.status");
        if (!(TODO_STATUSES as readonly string[]).includes(status))
          throw new Error("items.status is invalid");
        return {
          content: requireString(value.content, "items.content"),
          status: status as TodoItem["status"],
        };
      });
      const path = todoPath(
        context.workspaceRoot,
        requireSessionID(context.sessionID),
      );
      await mkdir(resolve(context.workspaceRoot, ".natalia", "todos"), {
        recursive: true,
      });
      await writeFile(path, `${JSON.stringify(items, null, 2)}\n`, {
        mode: 0o600,
      });
      // The same envelope todo_read answers with (T-01): the two tools used
      // to speak different shapes — read returned {items,total,truncated}
      // while write answered {saved,items} — so a model that read and
      // echoed the result back into write sent the envelope itself.
      return JSON.stringify({
        items,
        total: items.length,
        truncated: false,
      });
    },
  };
}

async function readTodos(
  workspaceRoot: string,
  sessionID: string,
): Promise<TodoItem[]> {
  try {
    const parsed = JSON.parse(
      await readFile(todoPath(workspaceRoot, sessionID), "utf8"),
    ) as TodoItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function requireSessionID(sessionID: string | undefined) {
  if (!sessionID) throw new Error("todo tools require a session ID");
  return sessionID;
}

function todoPath(workspaceRoot: string, sessionID: string) {
  return resolve(workspaceRoot, todoRelativePath(sessionID));
}

export const todoTools: RuntimeTool[] = [todoReadTool(), todoWriteTool()];

/**
 * Session scope: each session owns a separate durable list inside the workspace.
 */
export function todoToolFamily(): ToolFamily {
  return {
    id: "todo",
    name: "Todo Tools",
    version: "1.0.0",
    description: "The session's task list.",
    scope: "session",
    tools: todoTools,
  };
}

export const TODO_PLUGIN_MANIFEST: PluginManifest = {
  apiVersion: 2,
  id: TODO_PLUGIN_ID,
  version: "1.0.0",
  name: "Todo Tools",
  description: "The session's task list.",
  entry: "index.js",
  scope: "session",
  provides: [],
  requires: [],
  optionalRequires: [],
  conflicts: [],
  dependencies: [],
  hooks: {},
  integrationPoints: ["tools", "resources"],
  ui: {
    entry: "ui/plugin.js",
    panels: [
      {
        id: "todo",
        title: "待办",
        region: "side",
      },
    ],
  },
};

export function createTodoPlugin(): Plugin {
  return {
    manifest: TODO_PLUGIN_MANIFEST,
    setup(api) {
      for (const tool of todoTools) api.tools.register(tool);
      api.resources.register({
        name: TODO_RESOURCE_NAME,
        kind: "workspace-file",
        access: "read",
        scope: "session",
        path: ".natalia/todos/{sessionID}.json",
        readers: [TODO_UI_PLUGIN_ID],
        audit: true,
        description: "Durable todo list for the current session",
      });
    },
  };
}

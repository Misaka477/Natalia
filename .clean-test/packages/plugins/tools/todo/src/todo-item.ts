export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export type TodoItem = {
  content: string;
  status: TodoStatus;
};

/**
 * Parses one durable todo item from either tool arguments or a tool result.
 *
 * The todo plugin owns this schema. Nothing in the framework projection needs
 * to know that `content` or `status` exist.
 */
export function parseTodoItem(value: unknown): TodoItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.content !== "string" || typeof item.status !== "string")
    return undefined;
  if (!TODO_STATUSES.includes(item.status as TodoStatus)) return undefined;
  return { content: item.content, status: item.status as TodoStatus };
}

/**
 * Parses a complete todo list. `undefined` means the value was not a todo list
 * at all; an empty array is a valid, explicit cleared list.
 */
export function parseTodoItems(value: unknown): TodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: TodoItem[] = [];
  for (const candidate of value) {
    const item = parseTodoItem(candidate);
    if (!item) return undefined;
    items.push(item);
  }
  return items;
}

/** Stable resource contribution name for the plugin's session todo file. */
export const TODO_RESOURCE_NAME = "session-todo-store";

/** UI plugin id allowed to read the named todo resource. */
export const TODO_UI_PLUGIN_ID = "natalia.ui.todo";

/** Workspace-relative path the todo tool and todo UI both use. */
export function todoRelativePath(sessionID: string): string {
  return `.natalia/todos/${encodeURIComponent(sessionID)}.json`;
}

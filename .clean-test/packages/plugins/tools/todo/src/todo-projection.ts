import type { AppState, ToolBlock } from "@natalia/view-store";
import { parseTodoItems, type TodoItem } from "./todo-item";

/**
 * Reads the latest todo list from the framework's generic tool projection.
 *
 * `state.messages` is the framework's durable, tool-agnostic transcript. The
 * todo plugin interprets its own tool names and result payloads here; the
 * framework never has to project a `state.todos` field.
 *
 * The scan runs newest to oldest so a later failed write is ignored and the
 * last successful write/read wins. `undefined` means no todo payload was found,
 * while `[]` is a successful explicit clear.
 */
export function todoItemsFromProjection(
  state: Pick<AppState, "messages">,
): TodoItem[] | undefined {
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const tool = state.messages[index]?.tool;
    if (!tool || tool.status !== "succeeded") continue;

    if (tool.name === "todo_write") {
      const fromResult = parseTodoWriteResult(tool);
      if (fromResult) return fromResult;
      const fromArguments = parseTodoWriteArguments(tool);
      if (fromArguments) return fromArguments;
    }

    if (tool.name === "todo_read") {
      const fromResult = parseTodoReadResult(tool.result);
      if (fromResult) return fromResult;
    }
  }

  return undefined;
}

function parseTodoWriteResult(tool: ToolBlock): TodoItem[] | undefined {
  if (!tool.result) return undefined;
  try {
    const result = JSON.parse(tool.result) as unknown;
    if (Array.isArray(result)) return parseTodoItems(result);
    if (!result || typeof result !== "object") return undefined;
    const record = result as Record<string, unknown>;
    return parseTodoItems(record.items ?? record.todos);
  } catch {
    return undefined;
  }
}

function parseTodoWriteArguments(tool: ToolBlock): TodoItem[] | undefined {
  if (!tool.argumentsRaw) return undefined;
  try {
    const parsed = JSON.parse(tool.argumentsRaw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    const record = parsed as Record<string, unknown>;
    return parseTodoItems(record.items ?? record.todos);
  } catch {
    return undefined;
  }
}

function parseTodoReadResult(
  result: string | undefined,
): TodoItem[] | undefined {
  if (!result) return undefined;
  try {
    return parseTodoItems(JSON.parse(result) as unknown);
  } catch {
    return undefined;
  }
}

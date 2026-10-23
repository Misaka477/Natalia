import { For, Show, createMemo, createSignal } from "solid-js";
import type { TodoItem } from "../todo-item";

/**
 * The live todo list, as a full-width dock entry above the composer.
 *
 * Collapsed it is one line — how many are pending and what is running —
 * because a reader who is mid-turn needs the count, not the list.
 * Expanded it is the list, done items at the bottom where they stop
 * competing for attention.
 *
 * It is only there when there is something to say: an empty dock entry
 * is furniture, and furniture above the composer is in the way.
 */
export function TodoDock(props: {
  todos?: TodoItem[];
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  const t = props.t;
  const [expanded, setExpanded] = createSignal(false);
  const todos = createMemo(() => props.todos ?? []);
  const pending = createMemo(() =>
    todos().filter((todo) => todo.status !== "completed"),
  );
  const inProgress = createMemo(() =>
    pending().filter((todo) => todo.status === "in_progress"),
  );
  const completed = createMemo(() =>
    todos().filter((todo) => todo.status === "completed"),
  );
  const done = () => completed().length;
  const total = () => todos().length;

  return (
    <Show when={total() > 0}>
      <div class="neu-todo-dock" data-expanded={expanded()}>
        <button
          type="button"
          class="neu-todo-dock-head"
          aria-expanded={expanded()}
          onClick={() => setExpanded((value) => !value)}
        >
          <span class="neu-todo-dock-chevron" data-open={expanded()}>
            ▸
          </span>
          <span class="neu-todo-dock-count">
            {t("todo.pending", { count: pending().length })}
          </span>
          <Show when={inProgress().length}>
            <span class="neu-todo-dock-active">{inProgress()[0]!.content}</span>
          </Show>
          <span class="neu-todo-dock-done">
            {t("todo.done", { done: done(), total: total() })}
          </span>
        </button>
        <Show when={expanded()}>
          <div class="neu-todo-dock-body">
            <For each={pending()}>
              {(todo) => (
                <div class="neu-todo-row" data-status={todo.status}>
                  <span class="neu-todo-dot" data-status={todo.status} />
                  <span class="neu-todo-text">{todo.content}</span>
                  <span class="neu-todo-status">
                    {todo.status === "in_progress"
                      ? t("todo.inProgress")
                      : t("todo.pendingStatus")}
                  </span>
                </div>
              )}
            </For>
            <Show when={completed().length}>
              <div class="neu-todo-completed-header">
                {t("todo.completedHeader", { count: completed().length })}
              </div>
              <For each={completed()}>
                {(todo) => (
                  <div class="neu-todo-row" data-status="completed">
                    <span class="neu-todo-dot" data-status="completed" />
                    <span class="neu-todo-text neu-todo-completed-text">
                      {todo.content}
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}

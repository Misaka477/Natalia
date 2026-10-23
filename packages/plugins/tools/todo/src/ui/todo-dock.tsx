import { For, Show, createMemo, createSignal } from "solid-js";
import type { TodoItem } from "../todo-item";

function progressSummary(
  todos: readonly TodoItem[],
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const done = todos.filter((item) => item.status === "completed").length;
  const active = todos.filter((item) => item.status === "in_progress").length;
  const pending = todos.length - done - active;
  return [
    ...(done > 0 ? [t("todo.progress.done", { done })] : []),
    ...(active > 0 ? [t("todo.progress.active", { active })] : []),
    ...(pending > 0 ? [t("todo.progress.pending", { pending })] : []),
  ].join("\u2002·\u2002");
}

/**
 * The live todo list, as a full-width dock entry above the composer.
 *
 * Matches the task dock layout: header with checklist icon, "任务 / Tasks"
 * title, status progress counts ("5 已完成 · 1 进行中"), and expand/collapse
 * chevron over the list of items with status glyphs.
 */
export function TodoDock(props: {
  todos?: TodoItem[];
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  const t = props.t;
  const [expanded, setExpanded] = createSignal(true);
  const todos = createMemo(() => props.todos ?? []);
  const total = () => todos().length;

  return (
    <Show when={total() > 0}>
      <section
        class="neu-todo-dock"
        data-expanded={expanded()}
        aria-label={t("todo.title")}
      >
        <button
          type="button"
          class="neu-todo-dock-head"
          aria-expanded={expanded()}
          onClick={() => setExpanded((value) => !value)}
        >
          <span class="neu-todo-dock-lead" aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            >
              <circle cx="3.5" cy="4.5" r="1.5" />
              <path d="M7 4.5H13.5" stroke-linecap="round" />
              <circle cx="3.5" cy="11.5" r="1.5" />
              <path d="M7 11.5H13.5" stroke-linecap="round" />
            </svg>
          </span>
          <span class="neu-todo-dock-title">{t("todo.title")}</span>
          <span class="neu-todo-dock-progress">
            {progressSummary(todos(), t)}
          </span>
          <span
            class="neu-todo-dock-chevron"
            data-open={expanded()}
            aria-hidden="true"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
            >
              <path d="M4 6L8 10L12 6" stroke-linecap="round" />
            </svg>
          </span>
        </button>
        <Show when={expanded()}>
          <ul class="neu-todo-dock-body">
            <For each={todos()}>
              {(todo) => (
                <li class="neu-todo-row" data-status={todo.status}>
                  <span class="neu-todo-glyph" data-status={todo.status}>
                    <Show
                      when={todo.status === "completed"}
                      fallback={
                        <span class="neu-todo-dot" data-status={todo.status} />
                      }
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="none"
                      >
                        <circle
                          cx="8"
                          cy="8"
                          r="6.25"
                          stroke="currentColor"
                          stroke-width="1.2"
                        />
                        <path
                          d="M5.2 8.1L7.1 10L10.8 6.2"
                          stroke="currentColor"
                          stroke-width="1.3"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        />
                      </svg>
                    </Show>
                  </span>
                  <span class="neu-todo-text">{todo.content}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </Show>
  );
}

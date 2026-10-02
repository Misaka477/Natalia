import { For, Show, createMemo } from "solid-js";
import type { TodoItem } from "../todo-item";

export function TodoPanel(props: { todos?: TodoItem[] }) {
  const todos = createMemo(() => props.todos ?? []);
  const visible = createMemo(() =>
    todos()
      .filter((todo) => todo.status !== "completed")
      .sort((a, b) =>
        a.status === "in_progress" ? -1 : b.status === "in_progress" ? 1 : 0,
      ),
  );
  const completed = createMemo(() =>
    todos().filter((todo) => todo.status === "completed"),
  );

  return (
    <div class="review-pane">
      <div class="review-header">
        <div class="review-title">
          <span>待办</span>
        </div>
        <div class="review-meta">
          <span class="review-count">{todos().length} tasks</span>
        </div>
      </div>
      <Show
        when={visible().length || completed().length}
        fallback={
          <div class="agent-empty-full">
            <div class="review-empty-icon">
              <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                <rect
                  x="6"
                  y="6"
                  width="24"
                  height="24"
                  rx="4"
                  stroke="currentColor"
                  stroke-width="1.6"
                />
                <path
                  d="M12 18L16 22L24 14"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </div>
            <div class="review-empty-title">暂无待办</div>
            <div class="review-empty-desc">
              模型使用 todo 工具后，待办会显示在这里。
            </div>
          </div>
        }
      >
        <div class="review-body">
          <div class="review-diff">
            <div class="review-diff-header">
              <span class="review-diff-path">进行中</span>
            </div>
            <div class="review-diff-content">
              <For each={visible()}>
                {(todo) => (
                  <div class="todo-row" data-status={todo.status}>
                    <span class="todo-dot" data-status={todo.status} />
                    <span class="todo-text">{todo.content}</span>
                    <span class="todo-status">
                      {todo.status === "in_progress" ? "进行中" : "待处理"}
                    </span>
                  </div>
                )}
              </For>
              <Show when={!visible().length}>
                <div class="review-empty">
                  <div class="review-empty-title">没有进行中的待办</div>
                </div>
              </Show>
              <Show when={completed().length}>
                <div class="todo-completed-header">
                  已完成（{completed().length}）
                </div>
                <For each={completed()}>
                  {(todo) => (
                    <div class="todo-row" data-status="completed">
                      <span class="todo-dot" data-status="completed" />
                      <span class="todo-text todo-completed-text">
                        {todo.content}
                      </span>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}

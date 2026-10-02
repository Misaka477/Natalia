import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import {
  defineUiPlugin,
  type UiPlugin,
  type UiPluginContext,
} from "@natalia/ui-host";
import type { AppState } from "@natalia/view-store";
import {
  parseTodoItems,
  TODO_RESOURCE_NAME,
  type TodoItem,
} from "../todo-item";
import { todoItemsFromProjection } from "../todo-projection";
import { TodoPanel } from "./todo-panel";

function TodoPanelHost(props: { ctx: UiPluginContext }) {
  const [state, setState] = createSignal<AppState>(
    props.ctx.projection.getState(),
  );
  // The framework projects only generic tool blocks. The todo plugin derives
  // its state from those blocks first, and uses its own durable file snapshot
  // only when an older session has no parseable todo tool payload.
  const projectedTodos = createMemo(() => todoItemsFromProjection(state()));
  const [fileTodos, setFileTodos] = createSignal<TodoItem[] | undefined>(
    undefined,
  );
  const todos = createMemo(() => projectedTodos() ?? fileTodos());
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let loadToken = 0;

  async function loadTodos() {
    const sessionID = props.ctx.projection.getState().sessionID;
    const token = ++loadToken;
    setFileTodos(undefined);
    if (!sessionID) return;
    try {
      const result = await props.ctx.resources.read({
        resource: TODO_RESOURCE_NAME,
        params: { sessionID },
      });
      if (token !== loadToken) return;
      const parsed = parseTodoItems(
        JSON.parse(result?.content ?? "[]") as unknown,
      );
      if (parsed) setFileTodos(parsed);
    } catch {
      // No durable todo file yet, or the framework path policy refuses
      // `.natalia/*`. The generic projection above remains the source of truth.
    }
  }

  onMount(() => {
    void loadTodos();
    const off = props.ctx.projection.subscribe(() => {
      const next = props.ctx.projection.getState();
      const sessionChanged = next.sessionID !== state().sessionID;
      setState(next);
      if (refreshTimer) clearTimeout(refreshTimer);
      if (sessionChanged) {
        void loadTodos();
      } else {
        refreshTimer = setTimeout(() => void loadTodos(), 200);
      }
    });
    onCleanup(() => {
      off();
      if (refreshTimer) clearTimeout(refreshTimer);
    });
  });

  return <TodoPanel todos={todos()} />;
}

export function createTodoUiPlugin(): UiPlugin {
  return defineUiPlugin({
    id: "natalia.ui.todo",
    name: "Todo UI",
    version: "1.0.0",
    description: "Todo panel.",
    panels: [
      {
        id: "todo",
        title: "待办",
        region: "side",
        mount(ctx, container) {
          container.replaceChildren();
          const dispose = render(() => <TodoPanelHost ctx={ctx} />, container);
          return () => dispose();
        },
      },
    ],
    mount() {
      return undefined;
    },
  });
}

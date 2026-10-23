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
import { TodoDock } from "./todo-dock";
import { bindTodoLocale } from "./locales";

/**
 * The one shape this plugin needs from the shell's slot registry.
 *
 * Written structurally rather than imported: the todo plugin has no
 * dependency on the shell package, and a deep import into another
 * package's source is how a plugin starts breaking on a refactor it
 * has nothing to do with.
 */
type SlotRegistryLike = {
  register: (
    name: string,
    component: (props: {
      t: (key: string, params?: Record<string, unknown>) => string;
    }) => unknown,
  ) => () => void;
};

/**
 * The todo list is not a panel.
 *
 * It used to register `region: "side"`, which made it a tab in the right
 * rail — one more click away from the run it describes. The list is the
 * run's own state: what is being done right now, and what is left. So it
 * rides the shell's `input.dock` slot, a full-width entry directly above
 * the composer, and it is there whichever agent the pane is talking to.
 *
 * The `todo_write` tool card is the second registration point and stays
 * where it is: the card is the tool call's own record in the
 * transcript, the dock entry is the live list. Two places, two jobs.
 */
function TodoDockHost(props: {
  ctx: UiPluginContext;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  const t = bindTodoLocale(props.ctx.extra);
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

  return <TodoDock todos={todos()} t={t} />;
}

export function createTodoUiPlugin(): UiPlugin {
  return defineUiPlugin({
    id: "natalia.ui.todo",
    name: "Todo UI",
    version: "1.0.0",
    description: "The todo list as a dock entry above the composer.",
    // No panels: the right rail keeps the shell's review surfaces and
    // whatever a plugin genuinely needs a whole tab for. The list is
    // neither.
    panels: [],
    mount(ctx) {
      // The shell publishes its slot registry on the context's extra
      // seat; the same place it publishes the locale and the tool-card
      // registries. A plugin fills a slot; it never reaches into the
      // shell's markup.
      const slots = (ctx.extra as { slots?: SlotRegistryLike }).slots;
      if (!slots) return undefined;
      const dispose = slots.register("input.dock", (props) => (
        <TodoDockHost ctx={ctx} t={props.t} />
      ));
      return { dispose };
    },
  });
}

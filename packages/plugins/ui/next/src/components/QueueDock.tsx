import styles from "../styles/queue-dock.module.css";
import { For, Show, createSignal } from "solid-js";

export interface QueueDockItem {
  id: string;
  text: string;
  delivery: "next-turn" | "next-step";
  status: "queued" | "steering";
}

export interface QueueDockProps {
  t: (key: string, params?: Record<string, unknown>) => string;
  items: QueueDockItem[];
  onRemove: (id: string) => void;
  onReplace: (id: string, text: string) => void;
  onPromote: (id: string) => void;
}

const COLLAPSE_AFTER = 3;

/**
 * The admitted-but-unstarted input queue. It renders `state().pendingInputs`
 * only: editing/removing/promoting goes through `input.*` and converges on the
 * events, so it never touches the transcript.
 */
export function QueueDock(props: QueueDockProps) {
  const t = props.t;
  const [expanded, setExpanded] = createSignal(false);
  const [editing, setEditing] = createSignal<string | undefined>(undefined);
  const [draft, setDraft] = createSignal("");

  const hiddenCount = () => Math.max(0, props.items.length - COLLAPSE_AFTER);
  const visible = () =>
    expanded() || hiddenCount() === 0
      ? props.items
      : props.items.slice(0, COLLAPSE_AFTER);

  function beginEdit(id: string, text: string) {
    setDraft(text);
    setEditing(id);
  }

  function commitEdit(id: string) {
    const text = draft().trim();
    if (text) props.onReplace(id, text);
    setEditing(undefined);
  }

  return (
    <Show when={props.items.length > 0}>
      <div class={styles.dock}>
        <div class={styles.head}>
          <span class={styles.title}>
            {t("queue.title", { count: props.items.length })}
          </span>
          <Show when={hiddenCount() > 0}>
            <button
              type="button"
              class={styles.toggle}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded()
                ? t("queue.collapse")
                : t("queue.expand", { count: hiddenCount() })}
            </button>
          </Show>
        </div>
        <For each={visible()}>
          {(item) => (
            <div class={styles.row} data-status={item.status}>
              <span class={styles.chip}>
                {item.delivery === "next-step"
                  ? t("queue.waitingInject")
                  : t("queue.queued")}
              </span>
              <Show
                when={editing() === item.id}
                fallback={
                  <span class={styles.text} title={item.text}>
                    {item.text}
                  </span>
                }
              >
                <input
                  class={styles.edit}
                  value={draft()}
                  autofocus
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitEdit(item.id);
                    } else if (event.key === "Escape") {
                      setEditing(undefined);
                    }
                  }}
                />
              </Show>
              <div class={styles.actions}>
                <Show when={item.delivery === "next-turn"}>
                  <button
                    type="button"
                    class={styles.action}
                    onClick={() => props.onPromote(item.id)}
                    title={t("queue.promoteTitle")}
                  >
                    {t("queue.promote")}
                  </button>
                </Show>
                <Show
                  when={editing() === item.id}
                  fallback={
                    <button
                      type="button"
                      class={styles.action}
                      onClick={() => beginEdit(item.id, item.text)}
                      title={t("queue.editTitle")}
                    >
                      {t("queue.edit")}
                    </button>
                  }
                >
                  <button
                    type="button"
                    class={styles.action}
                    onClick={() => commitEdit(item.id)}
                    title={t("queue.saveTitle")}
                  >
                    {t("queue.save")}
                  </button>
                </Show>
                <button
                  type="button"
                  class={styles.action}
                  data-danger="true"
                  onClick={() => props.onRemove(item.id)}
                  title={t("queue.deleteTitle")}
                >
                  {t("queue.delete")}
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

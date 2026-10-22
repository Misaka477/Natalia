import { Show, onCleanup, onMount, For } from "solid-js";

type ActionId = "pin" | "snapshot" | "rollback" | "delete";

const actions: Array<{
  id: ActionId;
  labelKey: string;
  descKey: string;
}> = [
  { id: "pin", labelKey: "session.pin", descKey: "session.pinDesc" },
  {
    id: "snapshot",
    labelKey: "session.snapshot",
    descKey: "session.snapshotDesc",
  },
  {
    id: "rollback",
    labelKey: "session.rollback",
    descKey: "session.rollbackDesc",
  },
  { id: "delete", labelKey: "session.delete", descKey: "session.deleteDesc" },
];

export function SessionActionsPanel(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  open: boolean;
  session: string;
  onClose: () => void;
  onPin?: () => unknown;
  onSnapshot?: () => unknown;
  onRollback?: () => unknown;
  onDelete?: () => unknown;
}) {
  const t = props.t;
  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", handleKeydown);
    onCleanup(() => window.removeEventListener("keydown", handleKeydown));
  });

  return (
    <Show when={props.open}>
      <div class="neu-settings-backdrop" onClick={props.onClose}>
        <div
          class="neu-session-window"
          onClick={(event) => event.stopPropagation()}
        >
          <div class="neu-settings-header">
            <span class="neu-settings-title">{t("session.title")}</span>
            <button
              type="button"
              class="neu-settings-close"
              onClick={props.onClose}
              aria-label={t("session.closeAria")}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3 3l10 10M13 3L3 13"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </div>
          <div class="neu-session-current">
            {t("session.current", { name: props.session })}
            <strong>{props.session}</strong>
          </div>
          <div class="neu-session-actions">
            <For each={actions}>
              {(action) => (
                <button
                  type="button"
                  class="neu-session-action-row"
                  onClick={() => {
                    if (action.id === "pin") props.onPin?.();
                    else if (action.id === "snapshot") props.onSnapshot?.();
                    else if (action.id === "rollback") props.onRollback?.();
                    else if (action.id === "delete") props.onDelete?.();
                  }}
                >
                  <span class="neu-session-action-label">
                    {t(action.labelKey)}
                  </span>
                  <span class="neu-session-action-description">
                    {t(action.descKey)}
                  </span>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
}

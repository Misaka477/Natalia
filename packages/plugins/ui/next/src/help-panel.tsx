import styles from "./styles/help-panel.module.css";
import { Show, For, onCleanup, onMount } from "solid-js";

// ONLY what the shell actually handles. The list used to advertise
// Ctrl+K (a command palette that does not exist) and Ctrl+/ (settings,
// which has no hotkey) — two rows a user could try and find dead, which
// is worse than not listing them. The handlers live in app-neu.tsx; when
// one is added there it belongs here, and not before.
const shortcuts = [
  { keys: ["Ctrl", "B"], descriptionKey: "help.toggleLeft" },
  { keys: ["Ctrl", "J"], descriptionKey: "help.toggleRight" },
  { keys: ["Ctrl", "Shift", "P"], descriptionKey: "help.searchWorkspace" },
];

const sections = [
  {
    titleKey: "help.mainAgentTitle",
    textKey: "help.mainAgent",
  },
  { titleKey: "help.naviChatTitle", textKey: "help.naviChat" },
  { titleKey: "help.rightToolbarTitle", textKey: "help.rightToolbar" },
  {
    titleKey: "help.sessionCheckpointTitle",
    textKey: "help.sessionCheckpoint",
  },
];

export function HelpPanel(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  open: boolean;
  onClose: () => void;
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
        <div class={styles.window} onClick={(event) => event.stopPropagation()}>
          <div class="neu-settings-header">
            <span class="neu-settings-title">{t("help.title")}</span>
            <button
              type="button"
              class="neu-settings-close"
              onClick={props.onClose}
              aria-label={t("help.closeAria")}
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
          <div class={styles.body}>
            <div class={styles.sectionTitle}>{t("help.quickstart")}</div>
            <For each={sections}>
              {(section) => (
                <div class={styles.item}>
                  <span class={styles.itemTitle}>{t(section.titleKey)}</span>
                  <span class={styles.itemText}>{t(section.textKey)}</span>
                </div>
              )}
            </For>
            <div class={styles.sectionTitle}>{t("help.shortcuts")}</div>
            <For each={shortcuts}>
              {(shortcut) => (
                <div class={styles.shortcut}>
                  <span class={styles.shortcutKeys}>
                    {shortcut.keys.join(" + ")}
                  </span>
                  <span class={styles.shortcutDesc}>
                    {t(shortcut.descriptionKey)}
                  </span>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
}

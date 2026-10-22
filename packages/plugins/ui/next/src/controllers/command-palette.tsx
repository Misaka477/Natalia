/** The Ctrl+K command palette: one surface for the shell's commands and
 *  every plugin's. */

import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type { CommandRegistry } from "../commands/registry";
import styles from "../styles/palette.module.css";

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  registry: CommandRegistry;
  t: (key: string, params?: Record<string, unknown>) => string;
}

/** The palette. Focus lands in the filter, arrows move, Enter runs. */
export function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  let inputEl: HTMLInputElement | undefined;

  const results = () => props.registry.search(query());
  // A query that empties the list must not leave a stale cursor.
  createEffect(() => {
    if (active() >= results().length) setActive(0);
  });
  createEffect(() => {
    if (props.open) {
      setQuery("");
      setActive(0);
      inputEl?.focus();
    }
  });
  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!props.open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((index) => Math.min(index + 1, results().length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => Math.max(index - 1, 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const command = results()[active()];
        if (!command) return;
        props.onClose();
        command.run();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));
  });

  return (
    <Show when={props.open}>
      <div class="neu-settings-backdrop" onClick={props.onClose}>
        <div
          class={styles.palette}
          role="dialog"
          aria-modal="true"
          onClick={(event) => event.stopPropagation()}
        >
          <input
            ref={inputEl}
            class={styles.input}
            type="text"
            value={query()}
            placeholder={props.t("palette.placeholder")}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setActive(0);
            }}
          />
          <div class={styles.list}>
            <For each={results()}>
              {(command, index) => (
                <button
                  type="button"
                  class={styles.item}
                  data-active={index() === active() ? "true" : undefined}
                  onClick={() => {
                    props.onClose();
                    command.run();
                  }}
                >
                  <span class={styles.title}>{command.title}</span>
                  <Show when={command.hint}>
                    <span class={styles.hint}>{command.hint}</span>
                  </Show>
                </button>
              )}
            </For>
            <Show when={results().length === 0}>
              <div class={styles.empty}>{props.t("palette.empty")}</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}

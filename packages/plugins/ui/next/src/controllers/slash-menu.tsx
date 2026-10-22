/**
 * The slash menu: the composer's own command surface.
 *
 * A draft that starts with "/" opens the menu above the composer, and
 * what follows the slash is the filter — the same registry the Ctrl+K
 * palette reads, so a command is reachable from the keyboard and from
 * the draft without the shell knowing two lists. The menu never runs a
 * command on click-through: Enter or a click fills the draft with the
 * command's title, and the human sends it.
 */

import { For, Show, createEffect, createSignal } from "solid-js";
import type { CommandRegistry } from "../commands/registry";
import styles from "../styles/slash.module.css";

/** The filter a draft carries, or undefined when the menu is closed. */
export function slashQuery(draft: string): string | undefined {
  if (!draft.startsWith("/")) return undefined;
  // A slash inside a sentence is not a command; only a leading one is.
  if (draft.length > 1 && !/^\/\S*$/u.test(draft)) return undefined;
  return draft.slice(1).trim();
}

export interface SlashMenuProps {
  /** The draft's filter; undefined keeps the menu closed. */
  query: string | undefined;
  registry: CommandRegistry;
  t: (key: string, params?: Record<string, unknown>) => string;
  /** Fills the draft with the chosen command's title. */
  onPick: (title: string) => void;
  onClose: () => void;
}

export function SlashMenu(props: SlashMenuProps) {
  const [active, setActive] = createSignal(0);
  const results = () =>
    props.query === undefined ? [] : props.registry.search(props.query);
  createEffect(() => {
    if (active() >= results().length) setActive(0);
  });
  createEffect(() => {
    if (props.query !== undefined) setActive(0);
  });

  return (
    <Show when={props.query !== undefined && results().length > 0}>
      <div class={styles.menu} role="listbox">
        <For each={results()}>
          {(command, index) => (
            <button
              type="button"
              class={styles.item}
              role="option"
              aria-selected={index() === active() ? "true" : "false"}
              data-active={index() === active() ? "true" : undefined}
              onClick={() => {
                props.onPick(command.title);
                props.onClose();
              }}
            >
              <span class={styles.title}>{command.title}</span>
              <Show when={command.hint}>
                <span class={styles.hint}>{command.hint}</span>
              </Show>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

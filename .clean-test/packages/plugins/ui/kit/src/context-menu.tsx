import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";

export type ContextMenuItem =
  | { type: "separator" }
  | {
      type: "item";
      label: string;
      icon?: JSX.Element;
      danger?: boolean;
      disabled?: boolean;
      shortcut?: string;
      children?: ContextMenuItem[];
      onClick: () => void | Promise<void>;
    };

export type ContextMenuProps = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
};

export function ContextMenu(props: ContextMenuProps) {
  const [activeIndex, setActiveIndex] = createSignal(-1);

  const enabledItems = () =>
    props.items
      .map((entry, index) => ({ entry, index }))
      .filter(
        (
          candidate,
        ): candidate is {
          entry: Extract<ContextMenuItem, { type: "item" }>;
          index: number;
        } => candidate.entry.type !== "separator" && !candidate.entry.disabled,
      )
      .map(({ entry, index }) => ({ item: entry, index }));

  function moveActive(delta: number) {
    const list = enabledItems();
    if (!list.length) return;
    const currentIndex = list.findIndex(
      (entry) => entry.index === activeIndex(),
    );
    const nextIndex = (currentIndex + delta + list.length) % list.length;
    setActiveIndex(list[nextIndex]!.index);
  }

  function activateCurrent() {
    const list = enabledItems();
    const current = list.find((entry) => entry.index === activeIndex());
    if (!current) return;
    void current.item.onClick();
    props.onClose();
  }

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveActive(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveActive(-1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        activateCurrent();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return (
    <Portal mount={document.body}>
      <div
        class="ui-kit-context-backdrop"
        onClick={props.onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onClose();
        }}
      >
        <div
          class="ui-kit-context-menu"
          style={{ left: `${props.x}px`, top: `${props.y}px` }}
          onClick={(event) => event.stopPropagation()}
        >
          <For each={props.items}>
            {(item, index) =>
              item.type === "separator" ? (
                <div class="ui-kit-context-separator" />
              ) : (
                <MenuItem
                  item={item}
                  active={activeIndex() === index()}
                  onHover={() => setActiveIndex(index())}
                  onClose={props.onClose}
                />
              )
            }
          </For>
        </div>
      </div>
    </Portal>
  );
}

function MenuItem(props: {
  item: Extract<ContextMenuItem, { type: "item" }>;
  active: boolean;
  onHover: () => void;
  onClose: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  return (
    <div
      class="ui-kit-context-item-wrap"
      onMouseEnter={() => {
        props.onHover();
        setOpen(true);
      }}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        class="ui-kit-context-item"
        data-active={props.active}
        data-danger={props.item.danger || undefined}
        disabled={props.item.disabled}
        onClick={() => {
          void props.item.onClick();
          props.onClose();
        }}
      >
        <Show when={props.item.icon}>
          <span class="ui-kit-context-icon">{props.item.icon}</span>
        </Show>
        <span class="ui-kit-context-label">{props.item.label}</span>
        <Show when={props.item.shortcut}>
          <span class="ui-kit-context-shortcut">{props.item.shortcut}</span>
        </Show>
        <Show when={props.item.children?.length}>
          <span class="ui-kit-context-arrow">›</span>
        </Show>
      </button>
      <Show when={open() && props.item.children?.length}>
        <div class="ui-kit-context-submenu">
          <For each={props.item.children!}>
            {(child) =>
              child.type === "separator" ? (
                <div class="ui-kit-context-separator" />
              ) : (
                <button
                  type="button"
                  class="ui-kit-context-item"
                  data-danger={child.danger || undefined}
                  disabled={child.disabled}
                  onClick={() => {
                    void child.onClick();
                    props.onClose();
                  }}
                >
                  <Show when={child.icon}>
                    <span class="ui-kit-context-icon">{child.icon}</span>
                  </Show>
                  <span class="ui-kit-context-label">{child.label}</span>
                </button>
              )
            }
          </For>
        </div>
      </Show>
    </div>
  );
}

export const contextMenuStyles = `
.ui-kit-context-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2000;
}
.ui-kit-context-menu {
  position: fixed;
  min-width: 180px;
  background: var(--neu-bg-light);
  border-radius: 12px;
  padding: 6px;
  box-shadow: 4px 4px 12px var(--neu-shadow-dark), -4px -4px 12px var(--neu-shadow-light);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ui-kit-context-item-wrap {
  position: relative;
}
.ui-kit-context-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--neu-text);
  font-size: 12px;
  cursor: pointer;
}
.ui-kit-context-item:hover,
.ui-kit-context-item[data-active="true"] {
  background: var(--neu-bg);
  color: var(--neu-accent);
}
.ui-kit-context-item[data-danger="true"] {
  color: var(--neu-error);
}
.ui-kit-context-item:disabled {
  opacity: 0.4;
  cursor: default;
}
.ui-kit-context-icon {
  display: inline-flex;
  width: 16px;
  flex-shrink: 0;
}
.ui-kit-context-label {
  flex: 1;
  min-width: 0;
}
.ui-kit-context-shortcut {
  color: var(--neu-muted);
  font-size: 11px;
}
.ui-kit-context-arrow {
  color: var(--neu-muted);
  font-size: 12px;
}
.ui-kit-context-separator {
  height: 1px;
  margin: 4px 6px;
  background: var(--neu-hairline-accent);
}
.ui-kit-context-submenu {
  position: absolute;
  left: calc(100% + 2px);
  top: -4px;
  min-width: 150px;
  background: var(--neu-bg-light);
  border-radius: 12px;
  padding: 6px;
  box-shadow: 4px 4px 12px var(--neu-shadow-dark), -4px -4px 12px var(--neu-shadow-light);
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 2001;
}
`;

import { For, Show, createSignal } from "solid-js";
import type {
  PendingAction,
  PendingControl,
  PendingDraft,
  PendingItem,
  PendingPresenter,
} from "@natalia/ui-model";
import { ensurePendingBadgeStyles } from "./pending-styles";

// The badge's style rides with the component: the rail renders it before
// any panel exists, so the sheet is injected when THIS module loads —
// not when some plugin that happens to own a stylesheet loads.
ensurePendingBadgeStyles();

/** Small count badge for a side tab. */
export function PendingBadge(props: { count: number }) {
  return (
    <Show when={props.count > 0}>
      <span class="natalia-pending-badge">
        {props.count > 99 ? "99+" : props.count}
      </span>
    </Show>
  );
}

/** Read-only list of pending items; the host owns focus/dismiss state. */
export function PendingList(props: {
  items: PendingItem[];
  activeId?: string;
  presenterFor(kind: string): PendingPresenter | undefined;
  onFocus?(id: string): void;
  onDismiss?(id: string): void;
}) {
  return (
    <ul class="natalia-pending-list">
      <For each={props.items}>
        {(item) => (
          <li class="natalia-pending-list-item">
            <button
              type="button"
              class="natalia-pending-row"
              data-active={props.activeId === item.id}
              onClick={() => props.onFocus?.(item.id)}
            >
              <span class="natalia-pending-row-kind">{item.kind}</span>
              <span class="natalia-pending-row-title">
                {props.presenterFor(item.kind)?.label(item) ?? item.title}
              </span>
            </button>
            <Show when={props.onDismiss}>
              <button
                type="button"
                class="natalia-pending-dismiss"
                onClick={() => props.onDismiss?.(item.id)}
              >
                稍后
              </button>
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}

/**
 * Generic detail renderer: a presenter's fields and controls are data, so any
 * UI can render approval/question/new kinds without knowing the kind.
 */
export function PendingDetail(props: {
  item: PendingItem;
  presenter: PendingPresenter;
  onRespond(response: unknown): void;
  onDismiss?(): void;
}) {
  const [draft, setDraft] = createSignal<PendingDraft>({});

  function value(control: PendingControl): unknown {
    const current = draft()[control.field];
    return control.index === undefined
      ? current
      : (current as unknown[] | undefined)?.[control.index];
  }

  function write(control: PendingControl, next: unknown) {
    setDraft((current) => {
      if (control.index === undefined)
        return { ...current, [control.field]: next };
      const list = [...((current[control.field] as unknown[]) ?? [])];
      list[control.index] = next;
      return { ...current, [control.field]: list };
    });
  }

  function toggleOption(control: PendingControl, label: string) {
    if (control.kind !== "options") return;
    const selected = (value(control) as string[] | undefined) ?? [];
    write(
      control,
      control.multiple
        ? selected.includes(label)
          ? selected.filter((entry) => entry !== label)
          : [...selected, label]
        : [label],
    );
  }

  function respond(action: PendingAction) {
    const next = { ...draft(), action: action.id };
    setDraft(next);
    props.onRespond(props.presenter.buildResponse(props.item, next));
  }

  return (
    <div class="natalia-pending-detail">
      <div class="natalia-pending-detail-header">
        <span class="natalia-pending-detail-title">
          {props.presenter.label(props.item)}
        </span>
        <Show when={props.onDismiss}>
          <button
            type="button"
            class="natalia-pending-dismiss"
            onClick={() => props.onDismiss?.()}
          >
            稍后处理
          </button>
        </Show>
      </div>
      <div class="natalia-pending-fields">
        <For each={props.presenter.fields(props.item)}>
          {(field) => (
            <div class="natalia-pending-field">
              <span class="natalia-pending-field-label">{field.label}</span>
              <Show
                when={field.kind === "pre" || field.kind === "list"}
                fallback={
                  <div class="natalia-pending-field-value">{field.value}</div>
                }
              >
                <pre class="natalia-pending-field-pre">{field.value}</pre>
              </Show>
            </div>
          )}
        </For>
      </div>
      <div class="natalia-pending-controls">
        <For each={props.presenter.controls(props.item)}>
          {(control) => (
            <div class="natalia-pending-control">
              <span class="natalia-pending-control-label">{control.label}</span>
              <Show
                when={control.kind === "options"}
                fallback={
                  <input
                    class="natalia-pending-input"
                    placeholder={
                      control.kind === "text" ? control.placeholder : undefined
                    }
                    value={String(value(control) ?? "")}
                    onInput={(event) =>
                      write(control, event.currentTarget.value)
                    }
                  />
                }
              >
                <div class="natalia-pending-options">
                  <For each={control.kind === "options" ? control.options : []}>
                    {(option) => (
                      <button
                        type="button"
                        class="natalia-pending-option"
                        data-active={(
                          (value(control) as string[] | undefined) ?? []
                        ).includes(option.label)}
                        onClick={() => toggleOption(control, option.label)}
                      >
                        <span>{option.label}</span>
                        <Show when={option.description}>
                          <span class="natalia-pending-option-desc">
                            {option.description}
                          </span>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>
      <div class="natalia-pending-actions">
        <For each={props.presenter.actions(props.item)}>
          {(action) => (
            <button
              type="button"
              class="natalia-pending-action"
              data-tone={action.tone ?? "default"}
              onClick={() => respond(action)}
            >
              {action.label}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

/** List + detail composition; a side panel mounts this directly. */
export function PendingPanel(props: {
  items: PendingItem[];
  controller: {
    activeID(): string | undefined;
    focus(id: string): void;
    dismiss(id: string): void;
  };
  presenterFor(kind: string): PendingPresenter | undefined;
  onRespond(item: PendingItem, response: unknown): void;
}) {
  return (
    <div class="natalia-pending-panel">
      <PendingList
        items={props.items}
        activeId={props.controller.activeID()}
        presenterFor={props.presenterFor}
        onFocus={(id) => props.controller.focus(id)}
        onDismiss={(id) => props.controller.dismiss(id)}
      />
      <Show
        keyed
        when={props.controller.activeID() ?? props.items[0]?.id}
        fallback={<div class="natalia-pending-empty">没有待处理事项</div>}
      >
        {(id) => {
          const item = () => props.items.find((entry) => entry.id === id);
          return (
            <Show when={item()}>
              {(current) => (
                <Show when={props.presenterFor(current().kind)}>
                  {(presenter) => (
                    <PendingDetail
                      item={current()}
                      presenter={presenter()}
                      onRespond={(response) =>
                        props.onRespond(current(), response)
                      }
                      onDismiss={() => props.controller.dismiss(current().id)}
                    />
                  )}
                </Show>
              )}
            </Show>
          );
        }}
      </Show>
    </div>
  );
}

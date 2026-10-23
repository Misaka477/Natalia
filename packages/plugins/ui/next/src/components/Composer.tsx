import styles from "../styles/composer.module.css";
import {
  For,
  Show,
  type JSX,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

export interface ComposerAttachment {
  path: string;
  previewUrl?: string;
  name?: string;
}

export interface ComposerProps {
  t: (key: string, params?: Record<string, unknown>) => string;
  value: string;
  placeholder?: string;
  busy?: boolean;
  disabled?: boolean;
  onInput: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  attachments?: ComposerAttachment[];
  onAddAttachment?: () => void;
  onRemoveAttachment?: (path: string) => void;
  onPaste?: (event: ClipboardEvent) => void;
  /** Left-side mode/permission/reasoning controls in the bottom control bar. */
  children?: JSX.Element;
  /** Right-side controls (e.g. model selector) immediately before the send button. */
  trailing?: JSX.Element;
}

export function Composer(props: ComposerProps) {
  const t = props.t;
  let textareaRef: HTMLTextAreaElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  const [isFocused, setIsFocused] = createSignal(false);
  const canSubmit = () =>
    Boolean(props.value.trim() || props.attachments?.length);

  function adjustHeight() {
    if (!textareaRef) return;
    textareaRef.style.height = "auto";
    // The textarea is width-sensitive: single-pane and dual-pane layouts give
    // it different wrapping widths, so the same content has different line
    // counts. Re-measure from the current scrollHeight every time the width
    // changes instead of leaving the mount-time height behind.
    const next = `${Math.min(textareaRef.scrollHeight, 160)}px`;
    if (textareaRef.style.height !== next) textareaRef.style.height = next;
  }

  function scheduleAdjustHeight() {
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(() => adjustHeight());
    else adjustHeight();
  }

  onMount(() => {
    scheduleAdjustHeight();
    if (textareaRef && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => scheduleAdjustHeight());
      resizeObserver.observe(textareaRef);
    }
    if (typeof window !== "undefined")
      window.addEventListener("resize", scheduleAdjustHeight);
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
    if (typeof window !== "undefined")
      window.removeEventListener("resize", scheduleAdjustHeight);
  });

  function handleInput(event: Event) {
    const target = event.currentTarget as HTMLTextAreaElement;
    props.onInput(target.value);
    adjustHeight();
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      // Enter submits even while busy: app-neu sends that as `next-step`, so
      // the running turn claims it. Stop is its own control, not this key.
      if (canSubmit() && !props.disabled) {
        props.onSubmit();
        setTimeout(() => adjustHeight(), 0);
      }
    }
  }

  function handleSubmit() {
    if (canSubmit() && !props.disabled) {
      props.onSubmit();
      setTimeout(() => adjustHeight(), 0);
    }
  }

  function handleAddClick() {
    if (props.disabled) return;
    if (props.onAddAttachment) {
      props.onAddAttachment();
      return;
    }
    textareaRef?.focus();
    if (!props.value.startsWith("/")) {
      props.onInput(`/${props.value}`);
      adjustHeight();
    }
  }

  const showStop = () =>
    Boolean(props.busy && props.onStop && !props.value.trim());

  return (
    <div class={styles.composer} data-focused={isFocused()}>
      <Show when={props.attachments && props.attachments.length > 0}>
        <div class="natalia-composer-attachments">
          <For each={props.attachments}>
            {(attachment) => (
              <div
                class={styles.attachmentChip}
                data-image={Boolean(attachment.previewUrl)}
              >
                <Show
                  when={attachment.previewUrl}
                  fallback={
                    <svg
                      class={styles.attachmentIcon}
                      viewBox="0 0 16 16"
                      fill="none"
                    >
                      <path
                        d="M8.5 3.5L11.5 6.5L8.5 9.5M4.5 6.5H11.5"
                        stroke="currentColor"
                        stroke-width="1.2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  }
                >
                  <img
                    class={styles.attachmentThumb}
                    src={attachment.previewUrl}
                    alt={attachment.name ?? ""}
                  />
                </Show>
                <span class={styles.attachmentName}>
                  {attachment.name ?? attachment.path.split("/").pop()}
                </span>
                <button
                  type="button"
                  class={styles.attachmentRemove}
                  onClick={() => props.onRemoveAttachment?.(attachment.path)}
                  aria-label="Remove attachment"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path
                      d="M2 2L8 8M8 2L2 8"
                      stroke="currentColor"
                      stroke-width="1.2"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>

      <textarea
        ref={textareaRef}
        class={styles.textarea}
        value={props.value}
        placeholder={props.placeholder ?? t("composer.placeholder")}
        disabled={props.disabled}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        onPaste={props.onPaste}
      />

      <div class={styles.toolbar}>
        <div class={styles.controls}>
          <button
            type="button"
            class={styles.addBtn}
            onClick={handleAddClick}
            disabled={props.disabled}
            title={t("composer.attachTitle")}
            aria-label={t("composer.attachTitle")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
            >
              <path d="M8 2V14" />
              <path d="M2 8H14" />
            </svg>
          </button>
          {props.children}
        </div>
        <div class={styles.actions}>
          <Show when={props.trailing}>
            <div class={styles.trailing}>{props.trailing}</div>
          </Show>
          <Show when={showStop()}>
            <button
              type="button"
              class={styles.stop}
              onClick={props.onStop}
              disabled={props.disabled}
              title={t("composer.stopTitle")}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect
                  x="2"
                  y="2"
                  width="10"
                  height="10"
                  rx="1.5"
                  fill="currentColor"
                />
              </svg>
            </button>
          </Show>
          <Show when={!showStop()}>
            <button
              type="button"
              class={styles.submit}
              data-busy={props.busy}
              onClick={handleSubmit}
              disabled={props.disabled || !canSubmit()}
              title={
                props.busy
                  ? t("composer.sendInjectTitle")
                  : t("composer.sendTitle")
              }
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z"
                  fill="currentColor"
                />
              </svg>
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}

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
  children?: JSX.Element;
}

export function Composer(props: ComposerProps) {
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

  const showStop = () =>
    Boolean(props.busy && props.onStop && !props.value.trim());

  return (
    <div class="natalia-composer" data-focused={isFocused()}>
      <Show when={props.attachments && props.attachments.length > 0}>
        <div class="natalia-composer-attachments">
          <For each={props.attachments}>
            {(attachment) => (
              <div
                class="natalia-attachment-chip"
                data-image={Boolean(attachment.previewUrl)}
              >
                <Show
                  when={attachment.previewUrl}
                  fallback={
                    <svg
                      class="natalia-attachment-icon"
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
                    class="natalia-attachment-thumb"
                    src={attachment.previewUrl}
                    alt={attachment.name ?? ""}
                  />
                </Show>
                <span class="natalia-attachment-name">
                  {attachment.name ?? attachment.path.split("/").pop()}
                </span>
                <button
                  type="button"
                  class="natalia-attachment-remove"
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
        class="natalia-composer-textarea"
        value={props.value}
        placeholder={props.placeholder ?? "输入消息..."}
        disabled={props.disabled}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        onPaste={props.onPaste}
      />

      <div class="natalia-composer-toolbar">
        <div class="natalia-composer-controls">{props.children}</div>
        <div class="natalia-composer-actions">
          <Show when={props.onAddAttachment}>
            <button
              type="button"
              class="natalia-composer-icon-btn"
              onClick={props.onAddAttachment}
              disabled={props.disabled}
              title="添加附件"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path
                  d="M13.5 7.5V11.5C13.5 13.1569 12.1569 14.5 10.5 14.5H5.5C3.84315 14.5 2.5 13.1569 2.5 11.5V5.5C2.5 3.84315 3.84315 2.5 5.5 2.5H9"
                  stroke="currentColor"
                  stroke-width="1.2"
                  stroke-linecap="round"
                />
                <path
                  d="M11 2.5H13.5M13.5 2.5V5M13.5 2.5L9 6.5"
                  stroke="currentColor"
                  stroke-width="1.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </Show>
          <Show when={showStop()}>
            <button
              type="button"
              class="natalia-composer-stop"
              onClick={props.onStop}
              disabled={props.disabled}
              title="停止"
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
              class="natalia-composer-submit"
              data-busy={props.busy}
              onClick={handleSubmit}
              disabled={props.disabled || !canSubmit()}
              title={props.busy ? "发送并注入当前轮" : "发送"}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path
                  d="M16.5 8.5L2.5 15V2L16.5 8.5Z"
                  fill="currentColor"
                  stroke="currentColor"
                  stroke-width="1.2"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}

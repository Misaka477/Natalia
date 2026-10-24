import styles from "../styles/composer.module.css";
import {
  For,
  Show,
  type JSX,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type { RuntimeWorkspaceFileEntry } from "@anthelia/contracts";

export interface ComposerAttachment {
  path: string;
  previewUrl?: string;
  name?: string;
}

export interface ComposerSlashCommand {
  /** Slash trigger, e.g. `/goal`, `/new`, `/search`. */
  slash: string;
  /** Short description shown on the right. */
  description: string;
  /** What to insert when selected (`insertText`), or `execute` to run directly. */
  insertText?: string;
  execute?: () => void;
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
  /** Optional slash command items for `/` autocomplete. */
  slashCommands?: () => ComposerSlashCommand[];
  /** Optional workspace file search callback for `@` mention autocomplete. */
  onSearchFiles?: (query: string) => Promise<RuntimeWorkspaceFileEntry[]>;
  /** Left-side mode/permission/reasoning controls in the bottom control bar. */
  children?: JSX.Element;
  /** Right-side controls (e.g. model selector) immediately before the send button. */
  trailing?: JSX.Element;
}

type ActiveTrigger =
  | {
      kind: "slash";
      query: string;
      start: number;
      end: number;
    }
  | {
      kind: "mention";
      query: string;
      start: number;
      end: number;
    };

function detectTrigger(text: string, caret: number): ActiveTrigger | null {
  const before = text.slice(0, caret);
  // 1. Slash trigger: at start of draft (`/foo`)
  const slashMatch = /^\/([^\s]*)$/u.exec(before);
  if (slashMatch) {
    return {
      kind: "slash",
      query: slashMatch[1] ?? "",
      start: 0,
      end: caret,
    };
  }
  // 2. `@` file mention trigger: at start of draft or preceded by whitespace
  const mentionMatch = /(?:^|\s)@([^\s@]*)$/u.exec(before);
  if (mentionMatch) {
    const query = mentionMatch[1] ?? "";
    const start = caret - query.length - 1;
    return {
      kind: "mention",
      query,
      start,
      end: caret,
    };
  }
  return null;
}

export function Composer(props: ComposerProps) {
  const t = props.t;
  let textareaRef: HTMLTextAreaElement | undefined;
  let menuRef: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  const [isFocused, setIsFocused] = createSignal(false);
  const [caretPos, setCaretPos] = createSignal(0);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [dismissedKey, setDismissedKey] = createSignal<string | null>(null);
  const [fileEntries, setFileEntries] = createSignal<
    RuntimeWorkspaceFileEntry[]
  >([]);
  const [fileLoading, setFileLoading] = createSignal(false);
  let fileSearchSeq = 0;
  let fileSearchTimer: ReturnType<typeof setTimeout> | undefined;

  const canSubmit = () =>
    Boolean(props.value.trim() || props.attachments?.length);

  const builtInSlashCommands = createMemo<ComposerSlashCommand[]>(() => {
    const custom = props.slashCommands?.() ?? [];
    if (custom.length > 0) return custom;
    return [
      {
        slash: "/goal",
        description: t("composer.cmd.goal"),
        insertText: "/goal ",
      },
      {
        slash: "/goal status",
        description: t("composer.cmd.goalStatus"),
        insertText: "/goal status",
      },
      {
        slash: "/goal pause",
        description: t("composer.cmd.goalPause"),
        insertText: "/goal pause",
      },
      {
        slash: "/goal resume",
        description: t("composer.cmd.goalResume"),
        insertText: "/goal resume",
      },
      {
        slash: "/goal clear",
        description: t("composer.cmd.goalClear"),
        insertText: "/goal clear",
      },
    ];
  });

  const activeTrigger = createMemo<ActiveTrigger | null>(() => {
    if (!isFocused()) return null;
    const raw = props.value;
    if (!raw) return null;
    const pos = Math.min(caretPos(), raw.length);
    const trig = detectTrigger(raw, pos);
    if (!trig) return null;
    const key = `${trig.kind}:${trig.start}:${trig.query}`;
    if (dismissedKey() === key) return null;
    return trig;
  });

  const filteredSlashCommands = createMemo<ComposerSlashCommand[]>(() => {
    const trig = activeTrigger();
    if (!trig || trig.kind !== "slash") return [];
    const q = trig.query.trim().toLowerCase();
    return builtInSlashCommands().filter((item) => {
      if (!q) return true;
      return (
        item.slash.slice(1).toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q)
      );
    });
  });

  createEffect(() => {
    const trig = activeTrigger();
    if (fileSearchTimer) clearTimeout(fileSearchTimer);
    if (!trig || trig.kind !== "mention" || !props.onSearchFiles) {
      setFileEntries([]);
      setFileLoading(false);
      return;
    }
    const query = trig.query.trim();
    const seq = ++fileSearchSeq;
    setFileLoading(true);
    fileSearchTimer = setTimeout(() => {
      void Promise.resolve(props.onSearchFiles?.(query))
        .then((items) => {
          if (seq !== fileSearchSeq) return;
          setFileEntries((items ?? []).slice(0, 12));
        })
        .catch(() => {
          if (seq !== fileSearchSeq) return;
          setFileEntries([]);
        })
        .finally(() => {
          if (seq !== fileSearchSeq) return;
          setFileLoading(false);
        });
    }, 80);
  });

  createEffect(() => {
    // Reset highlight index when trigger query or list length changes
    activeTrigger();
    setSelectedIndex(0);
  });

  createEffect(() => {
    const idx = selectedIndex();
    if (!menuOpen() || !menuRef) return;
    requestAnimationFrame(() => {
      const options = menuRef?.querySelectorAll<HTMLElement>('[role="option"]');
      const activeEl = options?.[idx];
      activeEl?.scrollIntoView({ block: "nearest" });
    });
  });

  const menuItemsCount = createMemo(() => {
    const trig = activeTrigger();
    if (!trig) return 0;
    if (trig.kind === "slash") return filteredSlashCommands().length;
    return fileEntries().length;
  });

  const menuOpen = createMemo(() => {
    const trig = activeTrigger();
    if (!trig) return false;
    if (trig.kind === "slash") return filteredSlashCommands().length > 0;
    return Boolean(props.onSearchFiles);
  });

  function applySlashCommand(cmd: ComposerSlashCommand) {
    if (cmd.execute) {
      props.onInput("");
      setDismissedKey(null);
      cmd.execute();
      adjustHeight();
      return;
    }
    const nextText = cmd.insertText ?? `${cmd.slash} `;
    props.onInput(nextText);
    setDismissedKey(null);
    requestAnimationFrame(() => {
      if (!textareaRef) return;
      textareaRef.focus();
      textareaRef.setSelectionRange(nextText.length, nextText.length);
      setCaretPos(nextText.length);
      adjustHeight();
    });
  }

  function applyFileMention(entry: RuntimeWorkspaceFileEntry) {
    const trig = activeTrigger();
    if (!trig || trig.kind !== "mention") return;
    const raw = props.value;
    const normalizedPath = entry.path.replace(/\\/gu, "/");
    const token = normalizedPath.includes(" ")
      ? `@"${normalizedPath}" `
      : `@${normalizedPath} `;
    const nextText = `${raw.slice(0, trig.start)}${token}${raw.slice(trig.end)}`;
    const nextCaret = trig.start + token.length;
    props.onInput(nextText);
    setDismissedKey(null);
    requestAnimationFrame(() => {
      if (!textareaRef) return;
      textareaRef.focus();
      textareaRef.setSelectionRange(nextCaret, nextCaret);
      setCaretPos(nextCaret);
      adjustHeight();
    });
  }

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
    if (fileSearchTimer) clearTimeout(fileSearchTimer);
    resizeObserver?.disconnect();
    if (typeof window !== "undefined")
      window.removeEventListener("resize", scheduleAdjustHeight);
  });

  function handleInput(event: Event) {
    const target = event.currentTarget as HTMLTextAreaElement;
    setDismissedKey(null);
    const nextVal = target.value;
    const rawPos = target.selectionStart;
    setCaretPos(rawPos && rawPos > 0 ? rawPos : nextVal.length);
    props.onInput(nextVal);
    adjustHeight();
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (menuOpen()) {
      const count = menuItemsCount();
      if (event.key === "ArrowDown" && count > 0) {
        event.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % count);
        return;
      }
      if (event.key === "ArrowUp" && count > 0) {
        event.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + count) % count);
        return;
      }
      if (
        (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) &&
        count > 0
      ) {
        const trig = activeTrigger();
        if (trig?.kind === "slash") {
          const item = filteredSlashCommands()[selectedIndex()];
          if (item) {
            // If user already typed the exact slash command with an argument or
            // pressed Enter on an exact match that takes no args, let Enter submit
            // unless Tab was pressed or the input is still an incomplete prefix.
            const trimmedVal = props.value.trim();
            if (
              event.key === "Tab" ||
              item.execute ||
              trimmedVal !== item.slash
            ) {
              event.preventDefault();
              applySlashCommand(item);
              return;
            }
          }
        } else if (trig?.kind === "mention") {
          const entry = fileEntries()[selectedIndex()];
          if (entry) {
            event.preventDefault();
            applyFileMention(entry);
            return;
          }
        }
      }
      if (event.key === "Escape") {
        const trig = activeTrigger();
        if (trig) {
          event.preventDefault();
          setDismissedKey(`${trig.kind}:${trig.start}:${trig.query}`);
          return;
        }
      }
    }

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
      const next = `/${props.value}`;
      props.onInput(next);
      setCaretPos(1);
      adjustHeight();
    }
  }

  const showStop = () =>
    Boolean(props.busy && props.onStop && !props.value.trim());

  return (
    <div class={styles.composer} data-focused={isFocused()}>
      <Show when={menuOpen()}>
        <div
          ref={menuRef}
          class={styles.autocompleteMenu}
          role="listbox"
          onMouseDown={(e) => e.preventDefault()}
        >
          <Show when={activeTrigger()?.kind === "slash"}>
            <div class={styles.autocompleteHeader}>
              {t("composer.slashCommandsHeader")}
            </div>
            <For each={filteredSlashCommands()}>
              {(cmd, idx) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedIndex() === idx()}
                  class={styles.autocompleteItem}
                  data-active={selectedIndex() === idx()}
                  onMouseEnter={() => setSelectedIndex(idx())}
                  onClick={() => applySlashCommand(cmd)}
                >
                  <span class={styles.autocompletePrimary}>{cmd.slash}</span>
                  <span class={styles.autocompleteSecondary}>
                    {cmd.description}
                  </span>
                </button>
              )}
            </For>
          </Show>
          <Show when={activeTrigger()?.kind === "mention"}>
            <div class={styles.autocompleteHeader}>
              {t("composer.fileMentionsHeader")}
            </div>
            <Show
              when={!fileLoading() || fileEntries().length > 0}
              fallback={
                <div class={styles.autocompleteEmpty}>
                  {t("composer.searchingFiles")}
                </div>
              }
            >
              <Show
                when={fileEntries().length > 0}
                fallback={
                  <div class={styles.autocompleteEmpty}>
                    {t("composer.noMatchingFiles")}
                  </div>
                }
              >
                <For each={fileEntries()}>
                  {(entry, idx) => {
                    const norm = entry.path
                      .replace(/\\/gu, "/")
                      .replace(/\/+$/u, "");
                    const base = norm.slice(norm.lastIndexOf("/") + 1) || norm;
                    const dir =
                      norm.lastIndexOf("/") > 0
                        ? norm.slice(0, norm.lastIndexOf("/"))
                        : "";
                    const isDir = entry.type === "directory";
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={selectedIndex() === idx()}
                        class={styles.autocompleteItem}
                        data-active={selectedIndex() === idx()}
                        onMouseEnter={() => setSelectedIndex(idx())}
                        onClick={() => applyFileMention(entry)}
                      >
                        <span class={styles.autocompletePrimary}>
                          @{base}
                          {isDir ? "/" : ""}
                        </span>
                        <Show when={dir}>
                          <span class={styles.autocompleteSecondary}>
                            {dir}
                          </span>
                        </Show>
                      </button>
                    );
                  }}
                </For>
              </Show>
            </Show>
          </Show>
        </div>
      </Show>

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
        onClick={(e) =>
          setCaretPos(e.currentTarget.selectionStart ?? props.value.length)
        }
        onKeyUp={(e) => {
          if (
            e.key === "ArrowLeft" ||
            e.key === "ArrowRight" ||
            e.key === "Home" ||
            e.key === "End"
          ) {
            setCaretPos(e.currentTarget.selectionStart ?? props.value.length);
          }
        }}
        onFocus={(e) => {
          setIsFocused(true);
          setCaretPos(e.currentTarget.selectionStart ?? props.value.length);
        }}
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

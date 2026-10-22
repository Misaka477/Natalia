import { Show, createSignal, onCleanup, onMount } from "solid-js";
import type { RuntimeClient } from "@anthelia/contracts";
import { PathBrowseButton } from "./path-browse-button";

export function WorkspacePanel(props: {
  open: boolean;
  onClose: () => void;
  onAdd?: (path: string) => Promise<void> | void;
  /**
   * The runtime, so the chooser is the SHARED button every other panel uses.
   *
   * This used to be an `onBrowse` callback the parent wired up, which put one
   * more hop between the button and the runtime than the settings panel has —
   * and that hop is where the bug lived (`<Show when={props.onBrowse}>` calls a
   * function `when`, so the chooser ran on every render). One component, one
   * call site.
   */
  runtime?: RuntimeClient;
  error?: string;
}) {
  const [path, setPath] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [localError, setLocalError] = createSignal("");

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
          class="neu-workspace-window"
          onClick={(event) => event.stopPropagation()}
        >
          <div class="neu-settings-header">
            <span class="neu-settings-title">添加工作区</span>
            <button
              type="button"
              class="neu-settings-close"
              onClick={props.onClose}
              aria-label="关闭添加工作区"
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
          <div class="neu-workspace-body">
            <Show when={props.error || localError()}>
              <div class="neu-workspace-error">
                {props.error || localError()}
              </div>
            </Show>
            <input
              class="neu-form-input"
              value={path()}
              placeholder="工作区路径，例如 /home/user/project"
              onInput={(event) => setPath(event.currentTarget.value)}
            />
            <Show when={busy()}>
              <div class="neu-workspace-error">正在添加工作区…</div>
            </Show>
            <div class="neu-form-actions">
              {/* The chooser rides the SAME action row as 取消/添加, not a row of
                  its own: a second `neu-form-actions` between the field and the
                  buttons added a whole line to the dialog. */}
              <PathBrowseButton
                runtime={props.runtime}
                disabled={busy()}
                onPick={(chosen) => setPath(chosen)}
              />
              <button
                type="button"
                class="neu-form-btn neu-form-cancel"
                onClick={props.onClose}
                disabled={busy()}
              >
                取消
              </button>
              <button
                type="button"
                class="neu-form-btn neu-form-primary"
                onClick={() => {
                  if (busy()) return;
                  const trimmed = path().trim();
                  if (!trimmed) return;
                  setBusy(true);
                  setLocalError("");
                  const result = props.onAdd?.(trimmed);
                  if (
                    !result ||
                    typeof (result as Promise<void>).then !== "function"
                  ) {
                    setBusy(false);
                    setLocalError(
                      "内部错误：添加请求未返回 Promise，请查看控制台",
                    );
                    return;
                  }
                  void (result as Promise<void>)
                    .then(() => {
                      setBusy(false);
                      props.onClose();
                      setPath("");
                    })
                    .catch(() => {
                      setBusy(false);
                      // Keep the panel open so the error prop can render.
                    });
                }}
              >
                添加
              </button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}

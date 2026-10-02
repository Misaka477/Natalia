import {
  createSignal,
  createEffect,
  Show,
  onCleanup,
  onMount,
  For,
} from "solid-js";

type StashItem = { id: string; title: string; content: string; time: string };

const STASH_KEY = "natalia.web.stash";

function loadStash(): StashItem[] {
  try {
    const raw = localStorage.getItem(STASH_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is StashItem =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as StashItem).id === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function StashPanel(props: { open: boolean; onClose: () => void }) {
  const [items, setItems] = createSignal<StashItem[]>(loadStash());

  createEffect(() => {
    try {
      localStorage.setItem(STASH_KEY, JSON.stringify(items()));
    } catch {
      // local storage unavailable; keep in-memory only
    }
  });
  const [adding, setAdding] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const [content, setContent] = createSignal("");

  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", handleKeydown);
    onCleanup(() => window.removeEventListener("keydown", handleKeydown));
  });

  function save() {
    const t = title().trim();
    const c = content().trim();
    if (!t || !c) return;
    setItems((prev) => [
      {
        id: String(Date.now()),
        title: t,
        content: c,
        time: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      },
      ...prev,
    ]);
    setTitle("");
    setContent("");
    setAdding(false);
  }

  return (
    <Show when={props.open}>
      <div class="neu-settings-backdrop" onClick={props.onClose}>
        <div
          class="neu-stash-window"
          onClick={(event) => event.stopPropagation()}
        >
          <div class="neu-settings-header">
            <span class="neu-settings-title">Prompt 暂存</span>
            <button
              type="button"
              class="neu-settings-close"
              onClick={props.onClose}
              aria-label="关闭暂存"
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
          <div class="neu-stash-body">
            <For each={items()}>
              {(item) => (
                <div class="neu-stash-item">
                  <div class="neu-stash-item-main">
                    <span class="neu-stash-title">{item.title}</span>
                    <span class="neu-stash-content">{item.content}</span>
                  </div>
                  <span class="neu-stash-time">{item.time}</span>
                  <button type="button" class="neu-stash-btn">
                    复制
                  </button>
                  <button
                    type="button"
                    class="neu-stash-btn neu-stash-remove"
                    onClick={() =>
                      setItems((prev) =>
                        prev.filter((row) => row.id !== item.id),
                      )
                    }
                  >
                    删除
                  </button>
                </div>
              )}
            </For>
            <Show when={adding()}>
              <div class="neu-stash-form">
                <input
                  class="neu-form-input"
                  value={title()}
                  placeholder="标题"
                  onInput={(event) => setTitle(event.currentTarget.value)}
                />
                <textarea
                  class="neu-form-input neu-stash-textarea"
                  value={content()}
                  placeholder="暂存内容"
                  onInput={(event) => setContent(event.currentTarget.value)}
                />
                <div class="neu-form-actions">
                  <button
                    type="button"
                    class="neu-form-btn neu-form-cancel"
                    onClick={() => setAdding(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    class="neu-form-btn neu-form-primary"
                    onClick={save}
                  >
                    保存
                  </button>
                </div>
              </div>
            </Show>
            <div class="neu-extension-actions">
              <button
                type="button"
                class="neu-extension-add"
                onClick={() => setAdding(true)}
              >
                新建暂存
              </button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}

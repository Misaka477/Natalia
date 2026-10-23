import styles from "./styles/search-panel.module.css";
import { createSignal, Show, onCleanup, onMount, For } from "solid-js";
import type { RuntimeWorkspaceMatch } from "@anthelia/contracts";

type SearchResult = RuntimeWorkspaceMatch & {
  path: string;
  line: number;
  text: string;
};

export function SearchPanel(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  open: boolean;
  onClose: () => void;
  onSearch?: (query: string) => Promise<RuntimeWorkspaceMatch[]> | void;
  onSelect?: (result: SearchResult) => void;
}) {
  const t = props.t;
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<RuntimeWorkspaceMatch[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let searchSequence = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  function runSearch(value: string) {
    setQuery(value);
    const trimmed = value.trim();
    const sequence = ++searchSequence;
    if (debounce) clearTimeout(debounce);
    if (!trimmed) {
      setResults([]);
      setError(undefined);
      setLoading(false);
      return;
    }
    if (!props.onSearch) {
      setResults([]);
      setError(t("search.unsupported"));
      setLoading(false);
      return;
    }
    debounce = setTimeout(() => {
      setLoading(true);
      setError(undefined);
      void Promise.resolve(props.onSearch?.(trimmed))
        .then((next) => {
          if (sequence !== searchSequence) return;
          setResults(next ?? []);
        })
        .catch((reason: unknown) => {
          if (sequence !== searchSequence) return;
          setResults([]);
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (sequence !== searchSequence) return;
          setLoading(false);
        });
    }, 180);
  }

  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", handleKeydown);
    onCleanup(() => window.removeEventListener("keydown", handleKeydown));
  });
  onCleanup(() => {
    if (debounce) clearTimeout(debounce);
  });

  return (
    <Show when={props.open}>
      <div class="neu-settings-backdrop" onClick={props.onClose}>
        <div class={styles.window} onClick={(event) => event.stopPropagation()}>
          <div class="neu-settings-header">
            <span class="neu-settings-title">{t("search.title")}</span>
            <button
              type="button"
              class="neu-settings-close"
              onClick={props.onClose}
              aria-label={t("search.closeAria")}
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
            <input
              ref={(element) => queueMicrotask(() => element.focus())}
              class={`neu-form-input ${styles.input}`}
              value={query()}
              placeholder={t("search.placeholder")}
              onInput={(event) => runSearch(event.currentTarget.value)}
            />
            <div class={styles.results} aria-live="polite">
              <Show when={loading()}>
                <div class={styles.status}>{t("search.searching")}</div>
              </Show>
              <Show when={!loading() && error()}>
                <div class={`${styles.status} ${styles.error}`}>{error()}</div>
              </Show>
              <Show
                when={
                  !loading() &&
                  !error() &&
                  query().trim() &&
                  results().length === 0
                }
              >
                <div class={styles.status}>{t("search.noResults")}</div>
              </Show>
              <For each={results()}>
                {(result) => (
                  <button
                    type="button"
                    class={styles.result}
                    onClick={() => props.onSelect?.(result)}
                  >
                    <span class={styles.path}>
                      {result.path}:{result.line}
                    </span>
                    <span class={styles.snippet}>{result.text}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}

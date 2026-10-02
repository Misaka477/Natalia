import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onMount,
  onCleanup,
} from "solid-js";
import { highlightLine, type SyntaxPart } from "./syntax";
import { highlightInWorker } from "./syntax-client";

export type DiffRow = {
  type: string;
  sign: string;
  text: string;
  oldNo?: number | string;
  newNo?: number | string;
  highlights?: Array<{ start: number; end: number; kind: "added" | "deleted" }>;
  syntax?: Array<{ text: string; cls: string }>;
};

function highlightedText(
  line: DiffRow,
  language?: string,
  precomputed?: SyntaxPart[],
) {
  const parts: Array<{
    text: string;
    highlight: boolean;
    kind: string;
    cls: string;
  }> = [];
  if (!line.highlights?.length) {
    for (const part of line.syntax ??
      precomputed ??
      highlightLine(line.text, language))
      parts.push({ ...part, highlight: false, kind: "" });
    return parts;
  }
  let cursor = 0;
  const sorted = [...line.highlights].sort((a, b) => a.start - b.start);
  for (const range of sorted) {
    if (range.start > cursor)
      parts.push({
        text: line.text.slice(cursor, range.start),
        highlight: false,
        kind: "",
        cls: "",
      });
    if (range.end > range.start)
      parts.push({
        text: line.text.slice(range.start, range.end),
        highlight: true,
        kind: range.kind,
        cls: "",
      });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < line.text.length)
    parts.push({
      text: line.text.slice(cursor),
      highlight: false,
      kind: "",
      cls: "",
    });
  return parts;
}

const ROW_HEIGHT = 22;
const OVERSCAN = 12;

function isContext(row: DiffRow) {
  return row.type === "" && row.sign === " ";
}

/**
 * A lightweight virtualized unified-diff renderer.
 *
 * It only mounts the rows that intersect the current viewport, so a large
 * structured diff (or a fallback patch diff) can scroll without creating tens
 * of thousands of DOM nodes.
 */
export function UnifiedDiffView(props: { rows: DiffRow[]; language?: string }) {
  let container: HTMLDivElement | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [collapsedHunks, setCollapsedHunks] = createSignal<Set<number>>(
    new Set(),
  );
  const [syntaxCache, setSyntaxCache] = createSignal<Map<string, SyntaxPart[]>>(
    new Map(),
  );

  const rowKey = (row: DiffRow) =>
    `${row.oldNo ?? ""}:${row.newNo ?? ""}:${row.text}`;

  createEffect(() => {
    const rows = visible();
    const cache = syntaxCache();
    const missing = rows
      .map((item) => ({ item, key: rowKey(item.row) }))
      .filter(
        ({ item, key }) =>
          !item.row.syntax && !cache.has(key) && item.row.text.length > 0,
      );
    if (!missing.length) return;
    void Promise.all(
      missing.map(({ item, key }) =>
        highlightInWorker(item.row.text, props.language)
          .then((parts) => {
            setSyntaxCache((prev) => {
              const next = new Map(prev);
              next.set(key, parts);
              return next;
            });
          })
          .catch(() => undefined),
      ),
    );
  });

  type RenderedRow = { row: DiffRow; hunkIndex: number };
  const displayRows = createMemo<RenderedRow[]>(() => {
    const rendered: RenderedRow[] = [];
    let hunkIndex = -1;
    for (const row of props.rows) {
      if (row.type === "is-header" && row.text.startsWith("@@")) {
        hunkIndex++;
        rendered.push({ row, hunkIndex });
        continue;
      }
      if (hunkIndex >= 0 && collapsedHunks().has(hunkIndex)) continue;
      rendered.push({ row, hunkIndex });
    }
    // Collapse long unchanged context runs, preserving hunkIndex metadata.
    const result: RenderedRow[] = [];
    let i = 0;
    while (i < rendered.length) {
      const item = rendered[i]!;
      if (item.row.type === "" && item.row.sign === " ") {
        let j = i;
        while (
          j < rendered.length &&
          rendered[j]!.row.type === "" &&
          rendered[j]!.row.sign === " "
        )
          j++;
        const count = j - i;
        if (count > 6) {
          result.push({
            row: {
              type: "is-header",
              sign: "",
              text: `··· ${count} unchanged lines ···`,
              oldNo: "",
              newNo: "",
            },
            hunkIndex: item.hunkIndex,
          });
          i = j;
          continue;
        }
      }
      result.push(item);
      i++;
    }
    return result;
  });
  const total = () => displayRows().length;
  const start = () =>
    Math.max(0, Math.floor(scrollTop() / ROW_HEIGHT) - OVERSCAN);
  const end = () =>
    Math.min(
      total(),
      Math.ceil((scrollTop() + viewportHeight()) / ROW_HEIGHT) + OVERSCAN,
    );
  const visible = createMemo(() => displayRows().slice(start(), end()));
  const hunkPositions = createMemo(() =>
    displayRows()
      .map((item, index) =>
        item.row.type === "is-header" && item.row.text.startsWith("@@")
          ? index
          : -1,
      )
      .filter((index) => index >= 0),
  );
  const currentHunk = createMemo(() => {
    const positions = hunkPositions();
    if (!positions.length) return -1;
    const viewportMid = scrollTop() + ROW_HEIGHT / 2;
    let current = 0;
    for (const position of positions) {
      if (position * ROW_HEIGHT <= viewportMid) current = position;
      else break;
    }
    return current;
  });
  function jumpTo(index: number) {
    if (index < 0 || index >= total()) return;
    setScrollTop(index * ROW_HEIGHT);
    container?.scrollTo({ top: index * ROW_HEIGHT, behavior: "smooth" });
  }
  function jumpPrevious() {
    const positions = hunkPositions();
    const current = currentHunk();
    const prev = [...positions].reverse().find((pos) => pos < current);
    if (prev !== undefined) jumpTo(prev);
  }
  function jumpNext() {
    const positions = hunkPositions();
    const current = currentHunk();
    const next = positions.find((pos) => pos > current);
    if (next !== undefined) jumpTo(next);
  }

  function measureViewport() {
    if (!container) return;
    const max = typeof window === "undefined" ? 800 : window.innerHeight;
    // Never trust a flex-grown content-height as the viewport: if the scroll
    // container expands to its content, this would make the virtual list mount
    // every row. Clamp to the real window height.
    setViewportHeight(Math.min(container.clientHeight || 0, max || 800));
  }

  onMount(() => {
    measureViewport();
    const observer = new ResizeObserver(measureViewport);
    if (container) observer.observe(container);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div
      ref={container}
      class="review-diff-content diff-virtual"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div class="diff-hunk-nav">
        <button
          type="button"
          class="review-icon-btn"
          title="上一 hunk"
          onClick={jumpPrevious}
        >
          ↑
        </button>
        <button
          type="button"
          class="review-icon-btn"
          title="下一 hunk"
          onClick={jumpNext}
        >
          ↓
        </button>
      </div>
      <div style={{ height: `${start() * ROW_HEIGHT}px` }} />
      <For each={visible()}>
        {({ row, hunkIndex }) => {
          const isHunk = row.type === "is-header" && row.text.startsWith("@@");
          return (
            <div
              class={`review-diff-line ${row.type}`}
              style={{ height: `${ROW_HEIGHT}px` }}
              onClick={() => {
                if (isHunk && hunkIndex >= 0) {
                  setCollapsedHunks((prev) => {
                    const next = new Set(prev);
                    if (next.has(hunkIndex)) next.delete(hunkIndex);
                    else next.add(hunkIndex);
                    return next;
                  });
                }
              }}
            >
              <span class="review-diff-pos">{row.oldNo}</span>
              <span class="review-diff-pos">{row.newNo}</span>
              <span class="review-diff-sign">
                {isHunk && collapsedHunks().has(hunkIndex) ? "+" : row.sign}
              </span>
              <span class="review-diff-text">
                <For
                  each={highlightedText(
                    row,
                    props.language,
                    syntaxCache().get(rowKey(row)),
                  )}
                >
                  {(part) =>
                    part.highlight ? (
                      <span
                        class={
                          part.kind === "added"
                            ? "diff-word-added"
                            : "diff-word-deleted"
                        }
                      >
                        {part.text}
                      </span>
                    ) : (
                      <span class={part.cls}>{part.text}</span>
                    )
                  }
                </For>
              </span>
            </div>
          );
        }}
      </For>
      <div style={{ height: `${(total() - end()) * ROW_HEIGHT}px` }} />
      <Show when={!total()}>
        <div class="review-empty">
          <div class="review-empty-title">暂无内容级 diff</div>
        </div>
      </Show>
    </div>
  );
}

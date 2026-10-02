import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onMount,
  onCleanup,
} from "solid-js";
import type { StructuredDiffResult } from "@anthelia/diff-wasm";
import { highlightLine, type SyntaxPart } from "./syntax";
import { highlightInWorker } from "./syntax-client";

export type SplitRow = {
  type: "context" | "add" | "delete" | "modify" | "empty";
  oldText: string;
  newText: string;
  oldNo?: number | string;
  newNo?: number | string;
  oldHighlights?: Array<{ start: number; end: number }>;
  newHighlights?: Array<{ start: number; end: number }>;
  oldSyntax?: Array<{ text: string; cls: string }>;
  newSyntax?: Array<{ text: string; cls: string }>;
};

const ROW_HEIGHT = 22;
const OVERSCAN = 12;

function renderSegments(
  text: string,
  highlights?: Array<{ start: number; end: number }>,
  syntax?: Array<{ text: string; cls: string }>,
  language?: string,
) {
  if (!highlights?.length)
    return (syntax ?? highlightLine(text, language)).map((part) => ({
      ...part,
      highlight: false,
    }));
  const parts: Array<{ text: string; highlight: boolean; cls: string }> = [];
  let cursor = 0;
  const sorted = [...highlights].sort((a, b) => a.start - b.start);
  for (const range of sorted) {
    if (range.start > cursor)
      parts.push({
        text: text.slice(cursor, range.start),
        highlight: false,
        cls: "",
      });
    if (range.end > range.start)
      parts.push({
        text: text.slice(range.start, range.end),
        highlight: true,
        cls: "",
      });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < text.length)
    parts.push({ text: text.slice(cursor), highlight: false, cls: "" });
  if (!parts.length) parts.push({ text: "", highlight: false, cls: "" });
  return parts;
}

export function buildSplitRows(result: StructuredDiffResult): SplitRow[] {
  if (!result || !Array.isArray(result.hunks)) return [];
  try {
    const rows: SplitRow[] = [];
    for (const hunk of result.hunks) {
      if (!hunk || !Array.isArray(hunk.lines)) continue;
      const lines = hunk.lines;
      let i = 0;
      while (i < lines.length) {
        const line = lines[i]!;
        if (line.type === "context") {
          let end = i;
          while (end < lines.length && lines[end]!.type === "context") end++;
          const count = end - i;
          if (count > 6) {
            // Keep split mode light for patches with large unchanged regions,
            // matching the unified view's context collapsing behavior.
            const summary = `··· ${count} unchanged lines ···`;
            rows.push({
              type: "context",
              oldText: summary,
              newText: summary,
              oldNo: "",
              newNo: "",
            });
            i = end;
            continue;
          }
          for (; i < end; i++) {
            const current = lines[i]!;
            const wordRanges = Array.isArray(current.wordRanges)
              ? current.wordRanges
              : undefined;
            const syntaxParts = Array.isArray(current.syntaxParts)
              ? current.syntaxParts
              : undefined;
            rows.push({
              type: "context",
              oldText: current.text,
              newText: current.text,
              oldNo: current.oldLineNumber ?? "",
              newNo: current.newLineNumber ?? "",
              oldHighlights: wordRanges?.map((r) => ({
                start: r.start,
                end: r.end,
              })),
              newHighlights: wordRanges?.map((r) => ({
                start: r.start,
                end: r.end,
              })),
              oldSyntax: syntaxParts,
              newSyntax: syntaxParts,
            });
          }
          continue;
        }
        if (line.type !== "delete" && line.type !== "add") {
          i++;
          continue;
        }
        const deletes: typeof lines = [];
        const adds: typeof lines = [];
        while (i < lines.length && lines[i]!.type === "delete") {
          deletes.push(lines[i]!);
          i++;
        }
        while (i < lines.length && lines[i]!.type === "add") {
          adds.push(lines[i]!);
          i++;
        }
        const count = Math.max(deletes.length, adds.length);
        for (let k = 0; k < count; k++) {
          const del = deletes[k];
          const add = adds[k];
          rows.push({
            type: del && add ? "modify" : del ? "delete" : "add",
            oldText: del?.text ?? "",
            newText: add?.text ?? "",
            oldNo: del?.oldLineNumber ?? "",
            newNo: add?.newLineNumber ?? "",
            oldHighlights: Array.isArray(del?.wordRanges)
              ? del!.wordRanges!.map((r) => ({ start: r.start, end: r.end }))
              : undefined,
            newHighlights: Array.isArray(add?.wordRanges)
              ? add!.wordRanges!.map((r) => ({ start: r.start, end: r.end }))
              : undefined,
            oldSyntax: Array.isArray(del?.syntaxParts)
              ? del!.syntaxParts
              : undefined,
            newSyntax: Array.isArray(add?.syntaxParts)
              ? add!.syntaxParts
              : undefined,
          });
        }
      }
    }
    return rows;
  } catch {
    return [];
  }
}

export function SplitDiffView(props: { rows: SplitRow[]; language?: string }) {
  let container: HTMLDivElement | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [syntaxCache, setSyntaxCache] = createSignal<
    Map<string, { oldSyntax?: SyntaxPart[]; newSyntax?: SyntaxPart[] }>
  >(new Map());

  const rowKey = (row: SplitRow) =>
    `${row.oldNo ?? ""}:${row.newNo ?? ""}:${row.oldText}:${row.newText}`;

  createEffect(() => {
    const rows = visible();
    const cache = syntaxCache();
    const missing = rows
      .filter((row) => !row.oldSyntax && !row.newSyntax)
      .map((row) => ({ row, key: rowKey(row) }))
      .filter(({ row, key }) => !cache.has(key) && row.oldText.length > 0);
    if (!missing.length) return;
    void Promise.all(
      missing.map(({ row, key }) =>
        Promise.all([
          highlightInWorker(row.oldText, props.language),
          row.newText === row.oldText
            ? Promise.resolve(undefined)
            : highlightInWorker(row.newText, props.language),
        ]).then(([oldSyntax, newSyntax]) => {
          setSyntaxCache((prev) => {
            const next = new Map(prev);
            next.set(key, {
              oldSyntax,
              newSyntax: newSyntax ?? oldSyntax,
            });
            return next;
          });
        }),
      ),
    );
  });

  const total = () => props.rows.length;
  const start = () =>
    Math.max(0, Math.floor(scrollTop() / ROW_HEIGHT) - OVERSCAN);
  const end = () =>
    Math.min(
      total(),
      Math.ceil((scrollTop() + viewportHeight()) / ROW_HEIGHT) + OVERSCAN,
    );
  const visible = createMemo(() => props.rows.slice(start(), end()));

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
      class="review-diff-content diff-virtual diff-split"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: `${start() * ROW_HEIGHT}px` }} />
      <For each={visible()}>
        {(row) => (
          <div
            class={`review-diff-split-row ${row.type}`}
            style={{ height: `${ROW_HEIGHT}px` }}
          >
            <span class="review-diff-pos">{row.oldNo}</span>
            <span class="review-diff-split-cell">
              <For
                each={renderSegments(
                  row.oldText,
                  row.oldHighlights,
                  row.oldSyntax ?? syntaxCache().get(rowKey(row))?.oldSyntax,
                  props.language,
                )}
              >
                {(part) =>
                  part.highlight ? (
                    <span class="diff-word-deleted">{part.text}</span>
                  ) : (
                    <>{part.text}</>
                  )
                }
              </For>
            </span>
            <span class="review-diff-pos">{row.newNo}</span>
            <span class="review-diff-split-cell">
              <For
                each={renderSegments(
                  row.newText,
                  row.newHighlights,
                  row.newSyntax ?? syntaxCache().get(rowKey(row))?.newSyntax,
                  props.language,
                )}
              >
                {(part) =>
                  part.highlight ? (
                    <span class="diff-word-added">{part.text}</span>
                  ) : (
                    <>{part.text}</>
                  )
                }
              </For>
            </span>
          </div>
        )}
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

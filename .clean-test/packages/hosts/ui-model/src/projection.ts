import { splitMarkdownAtSafeBoundary } from "./markdown";
import { resultView, type ToolResultView } from "./tools";

export type ProjectedMarkdownSegment = {
  key: string;
  text: string;
  safe: boolean;
};

export type ProjectionCacheStats = {
  markdownHits: number;
  markdownMisses: number;
  toolHits: number;
  toolMisses: number;
};

export type ProjectionSchedulerOptions = {
  modalActive?: boolean;
  now?: number;
  foregroundIntervalMs?: number;
  modalBackgroundIntervalMs?: number;
};

export class ProjectionCache {
  private markdown = new Map<string, ProjectedMarkdownSegment>();
  private tools = new Map<string, ToolResultView>();
  readonly stats: ProjectionCacheStats = {
    markdownHits: 0,
    markdownMisses: 0,
    toolHits: 0,
    toolMisses: 0,
  };

  markdownSegment(id: string, revision: number, text: string) {
    const key = `${id}:${revision}:${text.length}`;
    const cached = this.markdown.get(key);
    if (cached) {
      this.stats.markdownHits += 1;
      return cached;
    }
    this.stats.markdownMisses += 1;
    const split = splitMarkdownAtSafeBoundary(text);
    const segment = {
      key,
      text: split.committed || split.tail,
      safe: Boolean(split.committed),
    };
    this.markdown.set(key, segment);
    return segment;
  }

  toolResult(id: string, revision: number, result: string) {
    const key = `${id}:${revision}:${result.length}`;
    const cached = this.tools.get(key);
    if (cached) {
      this.stats.toolHits += 1;
      return cached;
    }
    this.stats.toolMisses += 1;
    const projected = resultView(result);
    this.tools.set(key, projected);
    return projected;
  }
}

export class EventBatcher<T> {
  private pending: T[] = [];
  private lastFlush: number | undefined;

  push(event: T) {
    this.pending.push(event);
  }

  shouldFlush(options: ProjectionSchedulerOptions = {}) {
    if (this.pending.length === 0) return false;
    const now = options.now ?? Date.now();
    const interval = options.modalActive
      ? (options.modalBackgroundIntervalMs ?? 100)
      : (options.foregroundIntervalMs ?? 16);
    return this.lastFlush === undefined || now - this.lastFlush >= interval;
  }

  flush(now = Date.now()) {
    const events = this.pending;
    this.pending = [];
    this.lastFlush = now;
    return events;
  }
}

export function shouldLazyRenderDetail(detail: string, thresholdChars = 4000) {
  return Array.from(detail).length > thresholdChars;
}

export type CheckpointProgressView = {
  title: string;
  detail: string;
  severity: "info" | "warning" | "error";
};

export function checkpointProgressView(event: {
  type: string;
}): CheckpointProgressView | undefined {
  switch (event.type) {
    case "checkpoint.created":
      const created = event as unknown as {
        id: string;
        files: number;
        changes: number;
        step: number;
        tokenEstimate: number;
        complete: boolean;
      };
      return {
        title: `Checkpoint ${created.id}`,
        detail: `${created.files} tracked files, ${created.changes} changes, step ${created.step}, ${created.tokenEstimate} tokens`,
        severity: created.complete ? "info" : "warning",
      };
    case "checkpoint.unavailable":
      const unavailable = event as unknown as {
        reason: string;
        suggestion: string;
        disabledByConfig?: boolean;
      };
      return {
        title: "Checkpoint unavailable",
        detail: `${unavailable.reason}. ${unavailable.suggestion}`,
        severity: unavailable.disabledByConfig ? "warning" : "error",
      };
    case "rollback.previewed":
      const previewed = event as unknown as {
        preview: {
          checkpointID: string;
          changes: unknown[];
          context: { truncateMessages: number };
          resources: unknown[];
          complete: boolean;
        };
      };
      return {
        title: `Rollback preview ${previewed.preview.checkpointID}`,
        detail: `${previewed.preview.changes.length} file changes, ${previewed.preview.context.truncateMessages} context messages truncated, ${previewed.preview.resources.length} resources affected`,
        severity: previewed.preview.complete ? "info" : "warning",
      };
    case "rollback.end":
      const ended = event as unknown as {
        checkpointID: string;
        restoredFiles: number;
        deletedFiles: number;
        step: number;
      };
      return {
        title: `Rollback ${ended.checkpointID}`,
        detail: `${ended.restoredFiles} files restored, ${ended.deletedFiles} files deleted, context step ${ended.step}`,
        severity: "info",
      };
    case "rollback.failed":
      const failed = event as unknown as {
        checkpointID: string;
        message: string;
        recovered: boolean;
      };
      return {
        title: `Rollback failed ${failed.checkpointID}`,
        detail: `${failed.message}. ${failed.recovered ? "Safety checkpoint restored." : "Safety checkpoint restore failed."}`,
        severity: "error",
      };
    default:
      return undefined;
  }
}

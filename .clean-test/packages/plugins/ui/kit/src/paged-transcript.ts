export type PagedTranscriptCursor = {
  previous?: string;
  next?: string;
};

export type PagedTranscriptPage<T> = {
  data: T[];
  cursor: PagedTranscriptCursor;
};

export type PagedTranscriptSource<T> = (input: {
  cursor?: string;
  limit: number;
  signal: AbortSignal;
}) => Promise<PagedTranscriptPage<T>>;

export type PagedTranscriptPageDirection = "initial" | "older" | "newer";

export type PagedTranscriptState = {
  initialized: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  error?: unknown;
};

export type PagedTranscriptOptions<T> = {
  pageSize?: number;
  onPage: (
    page: PagedTranscriptPage<T>,
    direction: PagedTranscriptPageDirection,
  ) => void;
};

/**
 * Framework-free paging lifecycle shared by every transcript-like surface.
 *
 * It owns only cursor + loading state. The caller decides what a page means
 * (projection merge, replacement, scroll restore), which keeps Natalia turns,
 * Navi/Nia Chat and subagent history on one implementation.
 */
export class PagedTranscriptController<T> {
  private source: PagedTranscriptSource<T> | undefined;
  private cursor: PagedTranscriptCursor = {};
  private state: PagedTranscriptState = {
    initialized: false,
    loadingOlder: false,
    loadingNewer: false,
    hasOlder: false,
    hasNewer: false,
  };
  private abort: AbortController | undefined;
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: PagedTranscriptOptions<T>) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): PagedTranscriptState {
    return { ...this.state };
  }

  setSource(source: PagedTranscriptSource<T>): void {
    this.source = source;
    this.reset();
  }

  reset(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = undefined;
    this.cursor = {};
    this.state = {
      initialized: false,
      loadingOlder: false,
      loadingNewer: false,
      hasOlder: false,
      hasNewer: false,
    };
    this.emit();
  }

  async loadInitial(): Promise<void> {
    await this.load("initial");
  }

  async loadOlder(): Promise<void> {
    if (this.state.loadingOlder || !this.state.hasOlder) return;
    await this.load("older");
  }

  async loadNewer(): Promise<void> {
    if (this.state.loadingNewer || !this.state.hasNewer) return;
    await this.load("newer");
  }

  dispose(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = undefined;
    this.listeners.clear();
  }

  private async load(direction: PagedTranscriptPageDirection): Promise<void> {
    const source = this.source;
    if (!source) return;
    const cursor =
      direction === "older"
        ? this.cursor.previous
        : direction === "newer"
          ? this.cursor.next
          : undefined;
    const generation = this.generation;
    const abort = new AbortController();
    this.abort?.abort();
    this.abort = abort;
    this.state = {
      ...this.state,
      ...(direction === "initial"
        ? { loadingOlder: false, loadingNewer: false }
        : direction === "older"
          ? { loadingOlder: true }
          : { loadingNewer: true }),
      error: undefined,
    };
    this.emit();
    try {
      const page = await source({
        ...(cursor ? { cursor } : {}),
        limit: this.options.pageSize ?? 100,
        signal: abort.signal,
      });
      if (generation !== this.generation) return;
      this.cursor = page.cursor;
      this.state = {
        initialized: true,
        loadingOlder: false,
        loadingNewer: false,
        hasOlder: Boolean(page.cursor.previous),
        hasNewer: Boolean(page.cursor.next),
      };
      this.options.onPage(page, direction);
      this.emit();
    } catch (error) {
      if (generation !== this.generation) return;
      this.state = {
        ...this.state,
        loadingOlder: false,
        loadingNewer: false,
        error,
      };
      this.emit();
      throw error;
    } finally {
      if (generation === this.generation) this.abort = undefined;
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

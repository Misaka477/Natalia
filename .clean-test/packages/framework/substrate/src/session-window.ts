/**
 * One contiguous, paged session window.
 *
 * This is the shared window/pagination primitive for every session surface
 * (main transcript, Navi, Nia, subagent, trajectory). It deliberately owns
 * only the data-window rules: tail install, older-page prepend, live append,
 * gap buffering, and resync. Rendering, virtualisation and scroll ownership
 * stay outside this module so there is exactly one window implementation.
 *
 * The loader contract is sequence based. A page is accepted only when it is
 * internally contiguous and, for an older page, its tail touches the current
 * `baseSeq`. A live event is accepted only when it extends the window tail by
 * exactly one sequence; anything ahead is buffered and repaired by reloading
 * the tail page.
 */

import type {
  RuntimeClient,
  RuntimeEvent,
  RuntimeEventWindow,
} from "@anthelia/contracts";

export type SessionWindowOpenState = "cold" | "loading" | "open" | "error";

/** One ordered window entry; renderers consume the event, pagers consume the seq. */
export interface SessionWindowEntry<TEvent> {
  readonly seq: number;
  readonly event: TEvent;
}

export interface SessionWindowPage<TEvent extends { seq: number }> {
  readonly events: readonly TEvent[];
  readonly hasMore: boolean;
}

export interface SessionWindowLoader<TEvent extends { seq: number }> {
  /** Load the newest page. Called on open and gap repair. */
  loadTail(): Promise<SessionWindowPage<TEvent>>;
  /** Load the page immediately before `beforeSeq`. */
  loadBefore(beforeSeq: number): Promise<SessionWindowPage<TEvent>>;
}

function eventWindowPage(
  page: RuntimeEventWindow,
): SessionWindowPage<SessionWindowEntry<RuntimeEvent>> {
  let next = 1;
  return {
    events: page.events.map((item) => {
      const seq = item.sessionSeq ?? next;
      next = seq + 1;
      return { seq, event: item.event };
    }),
    hasMore: page.hasMore,
  };
}

/**
 * Adapt the runtime's `session.eventWindow` RPC to the shared window primitive.
 *
 * The returned loader is the only paging adapter UI surfaces should use. It
 * preserves the server's per-session cursor and fails closed when the runtime
 * does not expose the window API.
 */
export function createRuntimeEventWindowLoader(
  runtime: Pick<RuntimeClient, "eventWindow">,
  sessionID: string,
  pageSize = 50,
): SessionWindowLoader<SessionWindowEntry<RuntimeEvent>> {
  const load = async (options: {
    beforeSeq?: number;
    limit: number;
  }): Promise<SessionWindowPage<SessionWindowEntry<RuntimeEvent>>> => {
    if (runtime.eventWindow === undefined)
      throw new Error("runtime does not expose session.eventWindow");
    return eventWindowPage(
      await runtime.eventWindow({
        sessionID,
        limit: options.limit,
        ...(options.beforeSeq === undefined
          ? {}
          : { beforeSeq: options.beforeSeq }),
      }),
    );
  };
  return {
    loadTail: () => load({ limit: pageSize }),
    loadBefore: (beforeSeq) => load({ beforeSeq, limit: pageSize }),
  };
}

export interface SessionWindowSnapshot<TEvent extends { seq: number }> {
  readonly events: readonly TEvent[];
  readonly baseSeq: number | null;
  readonly tailSeq: number | null;
  readonly hasMore: boolean;
  readonly loadingOlder: boolean;
  readonly openState: SessionWindowOpenState;
  readonly error: unknown;
}

export interface SessionWindowOptions<TEvent extends { seq: number }> {
  readonly loader: SessionWindowLoader<TEvent>;
  /**
   * Notified when a live event arrives ahead of the window tail. The host can
   * use this to reproject or surface a repair indicator; the repair itself is
   * owned by this window.
   */
  readonly onGap?: (event: TEvent) => void;
}

function isContiguous<TEvent extends { seq: number }>(
  events: readonly TEvent[],
): boolean {
  for (let index = 1; index < events.length; index++) {
    if (events[index]!.seq !== events[index - 1]!.seq + 1) return false;
  }
  return true;
}

/**
 * Shared session event window.
 *
 * All methods are serialised by an internal promise chain so a caller cannot
 * start a second open/load/repair while one is in flight.
 */
export class SessionWindow<TEvent extends { seq: number }> {
  private events: TEvent[] = [];
  private baseSeqValue: number | null = null;
  private hasMoreValue = false;
  private loadingOlderValue = false;
  private openStateValue: SessionWindowOpenState = "cold";
  private errorValue: unknown;
  private liveBuffer: TEvent[] = [];
  private repairInFlight: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: SessionWindowOptions<TEvent>) {}

  get eventsView(): readonly TEvent[] {
    return this.events;
  }

  get baseSeq(): number | null {
    return this.baseSeqValue;
  }

  get tailSeq(): number | null {
    return this.events.at(-1)?.seq ?? null;
  }

  get hasMore(): boolean {
    return this.hasMoreValue;
  }

  get loadingOlder(): boolean {
    return this.loadingOlderValue;
  }

  get openState(): SessionWindowOpenState {
    return this.openStateValue;
  }

  get error(): unknown {
    return this.errorValue;
  }

  /** Number of live events waiting for a tail repair. */
  get bufferedCount(): number {
    return this.liveBuffer.length;
  }

  snapshot(): SessionWindowSnapshot<TEvent> {
    return {
      events: this.events,
      baseSeq: this.baseSeqValue,
      tailSeq: this.tailSeq,
      hasMore: this.hasMoreValue,
      loadingOlder: this.loadingOlderValue,
      openState: this.openStateValue,
      error: this.errorValue,
    };
  }

  /** Open (or re-open) the window by installing one tail page. */
  open(): Promise<void> {
    return this.enqueue(() => this.openLocked());
  }

  private async openLocked(): Promise<void> {
    this.openStateValue = "loading";
    this.errorValue = undefined;
    try {
      const page = await this.options.loader.loadTail();
      this.installTail(page);
      this.openStateValue = "open";
    } catch (error) {
      this.openStateValue = "error";
      this.errorValue = error;
      throw error;
    }
  }

  /** Pull one older page and prepend it when it touches the current head. */
  loadOlder(): Promise<boolean> {
    return this.enqueue(async () => {
      if (
        this.openStateValue !== "open" ||
        !this.hasMoreValue ||
        this.loadingOlderValue ||
        this.baseSeqValue === null
      )
        return false;
      this.loadingOlderValue = true;
      try {
        const page = await this.options.loader.loadBefore(this.baseSeqValue);
        const events = [...page.events];
        if (events.length === 0) {
          this.hasMoreValue = page.hasMore;
          return false;
        }
        if (!isContiguous(events)) {
          // Fail soft: never render a discontinuous or out-of-order stream.
          this.hasMoreValue = false;
          return false;
        }
        const tail = events.at(-1)!;
        if (tail.seq + 1 !== this.baseSeqValue) {
          this.hasMoreValue = false;
          return false;
        }
        this.events = [...events, ...this.events];
        this.baseSeqValue = events[0]!.seq;
        this.hasMoreValue = page.hasMore;
        return true;
      } finally {
        this.loadingOlderValue = false;
      }
    });
  }

  /**
   * Accept one live event.
   *
   * @returns `true` when the window appended it, `false` when it was buffered
   * for the next repair or dropped as an overlap.
   */
  acceptLive(event: TEvent): boolean {
    if (this.openStateValue !== "open") {
      this.buffer(event);
      return false;
    }
    const tail = this.tailSeq;
    if (tail !== null && event.seq <= tail) return false;
    if (tail !== null && event.seq > tail + 1) {
      this.buffer(event);
      this.options.onGap?.(event);
      void this.repair();
      return false;
    }
    this.events.push(event);
    return true;
  }

  /** Re-pull the tail page and stitch buffered live events in sequence order. */
  repair(): Promise<void> {
    if (this.repairInFlight !== null) return this.repairInFlight;
    const repair = this.enqueue(async () => {
      try {
        const page = await this.options.loader.loadTail();
        this.installTail(page);
      } catch (error) {
        this.errorValue = error;
        return;
      } finally {
        this.repairInFlight = null;
      }
    });
    this.repairInFlight = repair;
    return repair;
  }

  /** Reset to cold and load the current tail page again. */
  resync(): Promise<void> {
    return this.enqueue(async () => {
      this.events = [];
      this.baseSeqValue = null;
      this.hasMoreValue = false;
      this.liveBuffer = [];
      this.openStateValue = "cold";
      this.errorValue = undefined;
      await this.openLocked();
    });
  }

  private installTail(page: SessionWindowPage<TEvent>): void {
    const events = [...page.events];
    if (!isContiguous(events)) {
      // The loader must return a contiguous page; fail closed rather than
      // installing a broken window.
      this.events = [];
      this.baseSeqValue = null;
      this.hasMoreValue = false;
      return;
    }
    this.events = events;
    this.baseSeqValue = events[0]?.seq ?? null;
    this.hasMoreValue = page.hasMore;
    this.stitchBuffered();
  }

  private stitchBuffered(): void {
    const buffered = this.liveBuffer;
    this.liveBuffer = [];
    for (const event of buffered) {
      const tail = this.tailSeq;
      if (tail !== null && event.seq <= tail) continue;
      if (tail !== null && event.seq > tail + 1) {
        this.buffer(event);
        continue;
      }
      this.events.push(event);
    }
  }

  private buffer(event: TEvent): void {
    if (this.liveBuffer.some((candidate) => candidate.seq === event.seq))
      return;
    this.liveBuffer.push(event);
    this.liveBuffer.sort((left, right) => left.seq - right.seq);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

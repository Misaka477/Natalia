import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeHeapSnapshot } from "node:v8";
import type { RuntimeEvent } from "@anthelia/contracts";

type TraceSample = {
  processID: number;
  runID: string;
  at: string;
  elapsedMs: number;
  eventLoopLagMs: number;
  events: Record<string, number>;
  publishCount: number;
  publishTotalMs: number;
  publishMaxMs: number;
  phaseTotalMs: number;
  phaseMaxMs: number;
  sinkTotalMs: number;
  sinkMaxMs: number;
  pluginTotalMs: number;
  pluginMaxMs: number;
  memory: Pick<
    NodeJS.MemoryUsage,
    "rss" | "heapTotal" | "heapUsed" | "external" | "arrayBuffers"
  >;
  activeResources?: Record<string, number>;
  heapSnapshot?: string;
};

/**
 * Opt-in, bounded runtime telemetry for diagnosing UI starvation. It emits one
 * aggregate JSON line per interval rather than retaining or logging terminal
 * payloads, so enabling it cannot copy interactive process output into
 * diagnostics.
 */
export class RuntimePerformanceTrace {
  private readonly enabled: boolean;
  private readonly destination?: string;
  private readonly startedAt = performance.now();
  private readonly runID = randomUUID();
  private readonly heapSnapshotDirectory =
    process.env.NATALIA_HEAP_SNAPSHOT_DIR;
  private heapSnapshots = 0;
  private expectedAt = performance.now() + 1_000;
  private timer?: ReturnType<typeof setInterval>;
  private writes = Promise.resolve();
  private events = new Map<string, number>();
  private publishCount = 0;
  private publishTotalMs = 0;
  private publishMaxMs = 0;
  private phaseTotalMs = 0;
  private phaseMaxMs = 0;
  private sinkTotalMs = 0;
  private sinkMaxMs = 0;
  private pluginTotalMs = 0;
  private pluginMaxMs = 0;

  constructor(input: { destination?: string } = {}) {
    this.destination = input.destination ?? process.env.NATALIA_PERF_TRACE_FILE;
    this.enabled = Boolean(this.destination);
    if (this.enabled) this.timer = setInterval(() => this.flush(), 1_000);
  }

  record(
    event: RuntimeEvent,
    timings: { publishMs: number; sinkMs: number; pluginMs: number },
  ) {
    if (!this.enabled) return;
    this.events.set(event.type, (this.events.get(event.type) ?? 0) + 1);
    this.publishCount += 1;
    this.publishTotalMs += timings.publishMs;
    this.publishMaxMs = Math.max(this.publishMaxMs, timings.publishMs);
    this.sinkTotalMs += timings.sinkMs;
    this.sinkMaxMs = Math.max(this.sinkMaxMs, timings.sinkMs);
    this.pluginTotalMs += timings.pluginMs;
    this.pluginMaxMs = Math.max(this.pluginMaxMs, timings.pluginMs);
  }

  mark(name: string, durationMs: number) {
    if (!this.enabled) return;
    this.events.set(
      `phase:${name}`,
      (this.events.get(`phase:${name}`) ?? 0) + 1,
    );
    this.phaseTotalMs += durationMs;
    this.phaseMaxMs = Math.max(this.phaseMaxMs, durationMs);
  }

  stop() {
    if (!this.enabled) return Promise.resolve();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.flush();
    return this.writes;
  }

  private flush() {
    if (!this.enabled || !this.destination) {
      this.expectedAt += 1_000;
      return;
    }
    const now = performance.now();
    const memory = process.memoryUsage();
    const sample: TraceSample = {
      at: new Date().toISOString(),
      processID: process.pid,
      runID: this.runID,
      elapsedMs: Math.round(now - this.startedAt),
      eventLoopLagMs: Math.max(
        0,
        Math.round((now - this.expectedAt) * 100) / 100,
      ),
      events: Object.fromEntries(this.events),
      publishCount: this.publishCount,
      publishTotalMs: round(this.publishTotalMs),
      publishMaxMs: round(this.publishMaxMs),
      phaseTotalMs: round(this.phaseTotalMs),
      phaseMaxMs: round(this.phaseMaxMs),
      sinkTotalMs: round(this.sinkTotalMs),
      sinkMaxMs: round(this.sinkMaxMs),
      pluginTotalMs: round(this.pluginTotalMs),
      pluginMaxMs: round(this.pluginMaxMs),
      memory,
      activeResources: activeResourceCounts(),
    };
    if (
      this.heapSnapshotDirectory &&
      this.heapSnapshots < 3 &&
      memory.heapUsed >= 256 * 1024 * 1024
    ) {
      try {
        sample.heapSnapshot = writeHeapSnapshot(
          join(
            this.heapSnapshotDirectory,
            `natalia-${process.pid}-${this.runID}-${++this.heapSnapshots}.heapsnapshot`,
          ),
        );
      } catch {
        // Heap evidence is opt-in diagnostics; trace collection must continue
        // even where the runtime cannot write a snapshot.
      }
    }
    // Rebase after recording a late tick. Otherwise one long synchronous task
    // makes every later sample look progressively later than it really is.
    this.expectedAt = now + 1_000;
    this.events.clear();
    this.publishCount = 0;
    this.publishTotalMs = 0;
    this.publishMaxMs = 0;
    this.phaseTotalMs = 0;
    this.phaseMaxMs = 0;
    this.sinkTotalMs = 0;
    this.sinkMaxMs = 0;
    this.pluginTotalMs = 0;
    this.pluginMaxMs = 0;
    this.writes = this.writes
      .then(async () => {
        await mkdir(dirname(this.destination!), {
          recursive: true,
          mode: 0o700,
        });
      })
      .then(() => appendFile(this.destination!, `${JSON.stringify(sample)}\n`))
      .catch(() => undefined);
  }
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function activeResourceCounts() {
  const counts: Record<string, number> = {};
  for (const resource of process.getActiveResourcesInfo?.() ?? [])
    counts[resource] = (counts[resource] ?? 0) + 1;
  return counts;
}
